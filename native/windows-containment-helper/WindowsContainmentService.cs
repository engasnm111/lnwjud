using System.ComponentModel;
using System.IO.Pipes;
using Microsoft.Win32.SafeHandles;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Buffers.Binary;

namespace Lnwjud.Containment;

internal static class WindowsContainmentService
{
    internal const string ServiceName = "LnwjudContainment";
    internal const string PipeName = "lnwjud-containment-service-v3";
    private const uint ServiceWin32OwnProcess = 0x00000010;
    private const uint ServiceStartPending = 2;
    private const uint ServiceRunning = 4;
    private const uint ServiceStopPending = 3;
    private const uint ServiceStopped = 1;
    private const uint AcceptStop = 1;
    private const uint ControlStop = 1;
    private const uint ControlShutdown = 5;
    private const int MaxRequestBytes = 1024 * 1024;
    private static readonly JsonSerializerOptions Json = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow,
    };
    private static readonly ServiceMainCallback MainCallback = ServiceMain;
    private static readonly HandlerCallback ControlCallback = HandleControl;
    private static nint statusHandle;
    private static CancellationTokenSource? stopSource;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct ServiceTableEntry
    {
        [MarshalAs(UnmanagedType.LPWStr)] internal string? ServiceName;
        [MarshalAs(UnmanagedType.FunctionPtr)] internal ServiceMainCallback? ServiceMain;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ServiceStatus
    {
        internal uint ServiceType;
        internal uint CurrentState;
        internal uint ControlsAccepted;
        internal uint Win32ExitCode;
        internal uint ServiceSpecificExitCode;
        internal uint CheckPoint;
        internal uint WaitHint;
    }

    [UnmanagedFunctionPointer(CallingConvention.Winapi)]
    private delegate void ServiceMainCallback(uint argc, nint argv);
    [UnmanagedFunctionPointer(CallingConvention.Winapi)]
    private delegate uint HandlerCallback(uint control, uint eventType, nint eventData, nint context);
    private sealed record RpcRequest(int Protocol, string Command, ServiceAttemptIdentity? Identity, string? ReservationKey, string? OperationDigest, ServiceProcessOperation? Operation,
        string? ControlCommand = null, JsonElement? ControlRequest = null, ServiceOutputCursor? OutputCursor = null);
    private sealed record RpcResponse(int Protocol, bool Ok, object? Result, string? Error);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "StartServiceCtrlDispatcherW")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool StartServiceCtrlDispatcher([In] ServiceTableEntry[] serviceTable);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "RegisterServiceCtrlHandlerExW")]
    private static extern nint RegisterServiceCtrlHandlerEx(string serviceName, HandlerCallback handler, nint context);

    [DllImport("advapi32.dll", SetLastError = true, EntryPoint = "SetServiceStatus")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetServiceStatus(nint handle, ref ServiceStatus status);

    internal static void Run()
    {
        if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException("CONTAINMENT_SERVICE_WINDOWS_REQUIRED");
        var table = new[]
        {
            new ServiceTableEntry { ServiceName = ServiceName, ServiceMain = MainCallback },
            new ServiceTableEntry { ServiceName = null, ServiceMain = null },
        };
        if (!StartServiceCtrlDispatcher(table))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "CONTAINMENT_SERVICE_DISPATCHER_FAILED");
    }

#if NATIVE_CONTAINMENT_TESTS
    internal static Task RunPipeServerAsync(string pipeName, ServiceAttemptLedger ledger, CancellationToken cancellationToken, bool useCurrentUserTestLauncher = false) =>
        RunPipeServerCoreAsync(pipeName, ledger, cancellationToken, useCurrentUserTestLauncher);
#endif

    private static Task RunProductionPipeServerAsync(ServiceEndpointIdentity.ProductionServiceAuthority authority, ServiceAttemptLedger ledger, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(authority);
        authority.RequireActive();
        return RunPipeServerCoreAsync(PipeName, ledger, cancellationToken, false);
    }

    private static async Task RunPipeServerCoreAsync(string pipeName, ServiceAttemptLedger ledger, CancellationToken cancellationToken, bool useCurrentUserTestLauncher)
    {
        ArgumentNullException.ThrowIfNull(ledger);
        var runtime = new WindowsServiceProcessRuntime(ledger, useCurrentUserTestLauncher);
        var imports = new ServiceImportTransactionRuntime(ledger, ledger.ImportStoreDirectory, useCurrentUserTestLauncher);
        try
        {
            var workers = new List<Task>();
            var firstInstance = true;
            while (!cancellationToken.IsCancellationRequested)
            {
                workers.RemoveAll(task => task.IsCompleted);
                if (workers.Count >= 15)
                {
                    await Task.WhenAny(workers).WaitAsync(cancellationToken).ConfigureAwait(false);
                    continue;
                }

#if NATIVE_CONTAINMENT_TESTS
                var pipe = useCurrentUserTestLauncher
                    ? ServicePipeSecurity.CreateCurrentUserTestServer(pipeName, firstInstance)
                    : ServicePipeSecurity.CreateServer(pipeName, firstInstance);
#else
                var pipe = ServicePipeSecurity.CreateServer(pipeName, firstInstance);
#endif
                firstInstance = false;
                try
                {
                    await pipe.WaitForConnectionAsync(cancellationToken).ConfigureAwait(false);
                    workers.Add(HandleClientAndDisposeAsync(pipe, ledger, runtime, imports, cancellationToken));
                }
                catch
                {
                    pipe.Dispose();
                    if (cancellationToken.IsCancellationRequested) break;
                    throw;
                }
            }
            if (workers.Count > 0) await Task.WhenAll(workers).ConfigureAwait(false);
        }
        finally
        {
            await runtime.StopAsync().ConfigureAwait(false);
        }
    }

    private static async Task HandleClientAndDisposeAsync(NamedPipeServerStream pipe, ServiceAttemptLedger ledger, WindowsServiceProcessRuntime runtime,
        ServiceImportTransactionRuntime imports, CancellationToken serviceStopping)
    {
        using (pipe)
        using (var timeout = CancellationTokenSource.CreateLinkedTokenSource(serviceStopping))
        {
            timeout.CancelAfter(TimeSpan.FromSeconds(30));
            try
            {
                var requestBytes = await ReadFrameAsync(pipe, timeout.Token).ConfigureAwait(false);
                var request = JsonSerializer.Deserialize<RpcRequest>(requestBytes, Json)
                    ?? throw new IOException("SERVICE_REQUEST_INVALID");
                CryptographicOperations.ZeroMemory(requestBytes);
                if (request.Protocol != 3) throw new IOException("SERVICE_PROTOCOL_INVALID");
                if (request.Command == "control") timeout.CancelAfter(TimeSpan.FromSeconds(120));

                using var caller = AuthenticatedPipeCaller.Capture(pipe);
                object result = request.Command switch
                {
                    "prepare" => Prepare(ledger, request, caller.Sid),
                    "run" => Run(ledger, runtime, request, caller),
                    "inspect" => Inspect(runtime, request, caller.Sid),
                    "cancel" => Cancel(runtime, request, caller.Sid),
                    "read_output" => ReadOutput(runtime, request, caller.Sid),
                    "abort" => Abort(ledger, request, caller.Sid),
                    "control" => imports.Control(request.ControlCommand ?? throw new IOException("SERVICE_IMPORT_COMMAND_REQUIRED"),
                        request.Identity ?? throw new IOException("SERVICE_IDENTITY_REQUIRED"), caller.Sid,
                        request.ControlRequest ?? throw new IOException("SERVICE_IMPORT_REQUEST_REQUIRED"), caller.PrimaryToken),
                    "inspect_control" => imports.Inspect(request.ControlCommand ?? throw new IOException("SERVICE_IMPORT_COMMAND_REQUIRED"),
                        request.Identity ?? throw new IOException("SERVICE_IDENTITY_REQUIRED"), caller.Sid, caller.PrimaryToken),
                    _ => throw new IOException("SERVICE_COMMAND_UNSUPPORTED"),
                };
                await WriteFrameAsync(pipe, new RpcResponse(3, true, result, null), timeout.Token).ConfigureAwait(false);
            }
            catch (Exception exception)
            {
                try
                {
                    var safeError = exception switch
                    {
                        UnauthorizedAccessException => "SERVICE_OWNER_MISMATCH",
                        IOException io when io.Message.StartsWith("SERVICE_", StringComparison.Ordinal)
                            || io.Message.StartsWith("ATTEMPT_", StringComparison.Ordinal)
                            || io.Message.StartsWith("WRITER_", StringComparison.Ordinal)
                            || io.Message.StartsWith("TERMINAL_", StringComparison.Ordinal)
                            || io.Message.StartsWith("PIPE_", StringComparison.Ordinal)
                            || io.Message.StartsWith("ACTIVE_", StringComparison.Ordinal) => io.Message,
                        Win32Exception w32 when w32.Message.StartsWith("PIPE_", StringComparison.Ordinal)
                            || w32.Message.StartsWith("SERVICE_", StringComparison.Ordinal) => w32.Message,
                        _ => "SERVICE_REQUEST_FAILED",
                    };
                    await WriteFrameAsync(pipe, new RpcResponse(3, false, null, safeError), CancellationToken.None).ConfigureAwait(false);
                }
                catch { }
            }
        }
    }

    private static ServiceAttemptObservation Run(ServiceAttemptLedger ledger, WindowsServiceProcessRuntime runtime, RpcRequest request, AuthenticatedPipeCaller caller)
    {
        var identity = request.Identity ?? throw new IOException("SERVICE_IDENTITY_REQUIRED");
        var operation = ValidateOperation(request, out var operationDigest);
        return RunWithLaunchToken(ledger, runtime, identity, caller.Sid, operationDigest, operation,
            () => AuthenticatedPipeCaller.CreateLaunchToken(caller.PrimaryToken));
    }

    // Test injection never changes the authenticated production pipe-token path.
    internal static ServiceAttemptObservation RunWithLaunchToken(
        ServiceAttemptLedger ledger, WindowsServiceProcessRuntime runtime, ServiceAttemptIdentity identity,
        string callerSid, string operationDigest, ServiceProcessOperation operation,
        Func<SafeAccessTokenHandle> acquireToken)
    {
        SafeAccessTokenHandle launchToken;
        try { launchToken = acquireToken(); }
        catch
        {
            // No dispatch occurred here. Concurrently dispatched attempts remain fenced.
            var request = new ServiceAttemptRequest(identity, callerSid, ServiceAttemptLedger.GlobalReservationKey, operationDigest, Shared: true);
            var aborted = ledger.AbortBeforeLaunch(request);
            if (aborted.Phase == ServiceAttemptPhase.LaunchNotStarted)
                _ = ledger.Release(identity, callerSid);
            throw;
        }
        using (launchToken)
            return runtime.Run(identity, callerSid, operationDigest, operation, launchToken.DangerousGetHandle());
    }

    private static ServiceAttemptObservation Cancel(WindowsServiceProcessRuntime runtime, RpcRequest request, string sid) =>
        runtime.Cancel(request.Identity ?? throw new IOException("SERVICE_IDENTITY_REQUIRED"), sid);

    private static ServiceOutputObservation ReadOutput(WindowsServiceProcessRuntime runtime, RpcRequest request, string sid) =>
        runtime.ReadOutput(request.Identity ?? throw new IOException("SERVICE_IDENTITY_REQUIRED"), sid, request.OutputCursor);

    private static ServiceProcessOperation ValidateOperation(RpcRequest request, out string operationDigest)
    {
        var operation = request.Operation ?? throw new IOException("SERVICE_OPERATION_REQUIRED");
        if (operation.Kind != "run_process"
            || string.IsNullOrWhiteSpace(operation.Executable)
            || operation.Executable.Length > 32767
            || !Path.IsPathFullyQualified(operation.Executable)
            || operation.Executable.Contains('\0')
            || string.IsNullOrWhiteSpace(operation.Cwd)
            || operation.Cwd.Length > 32767
            || !Path.IsPathFullyQualified(operation.Cwd)
            || operation.Cwd.Contains('\0')
            || operation.TimeoutMs is < 1 or > 604_800_000
            || operation.MaximumOutputBytes is < 0 or > 1_048_576
            || operation.Args is null
            || operation.Args.Length > 2048
            || operation.Args.Any(argument => argument is null || argument.Contains('\0') || argument.Length > 32767)
            || operation.Environment is null
            || operation.Environment.Count > 4096)
            throw new IOException("SERVICE_OPERATION_INVALID");

        var environment = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var pair in operation.Environment.OrderBy(pair => pair.Key, StringComparer.OrdinalIgnoreCase))
        {
            if (string.IsNullOrWhiteSpace(pair.Key)
                || pair.Key.Contains('=') || pair.Key.Contains('\0')
                || pair.Value is null || pair.Value.Contains('\0')
                || pair.Key.Length > 32767 || pair.Value.Length > 32767
                || !environment.TryAdd(pair.Key, pair.Value))
                throw new IOException("SERVICE_ENVIRONMENT_INVALID");
        }

        var canonical = operation with
        {
            Args = operation.Args.ToArray(),
            Environment = environment,
        };
        var bytes = JsonSerializer.SerializeToUtf8Bytes(canonical, Json);
        operationDigest = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(bytes)).ToLowerInvariant();
        if (request.OperationDigest is { } suppliedDigest
            && !string.Equals(suppliedDigest, operationDigest, StringComparison.Ordinal))
            throw new IOException("SERVICE_OPERATION_DIGEST_INVALID");
        return canonical;
    }

    private static ServiceAttemptObservation Prepare(ServiceAttemptLedger ledger, RpcRequest request, string sid)
    {
        var identity = request.Identity ?? throw new IOException("SERVICE_IDENTITY_REQUIRED");
        _ = ValidateOperation(request, out var operationDigest);
        return ledger.Prepare(new ServiceAttemptRequest(identity, sid, ServiceAttemptLedger.GlobalReservationKey, operationDigest, Shared: true));
    }

    private static ServiceAttemptObservation Inspect(WindowsServiceProcessRuntime runtime, RpcRequest request, string sid) =>
        runtime.Inspect(request.Identity ?? throw new IOException("SERVICE_IDENTITY_REQUIRED"), sid);

    private static ServiceAttemptObservation Abort(ServiceAttemptLedger ledger, RpcRequest request, string sid)
    {
        var identity = request.Identity ?? throw new IOException("SERVICE_IDENTITY_REQUIRED");

        string operationDigest;
        if (request.Operation is not null)
        {
            _ = ValidateOperation(request, out operationDigest);
        }
        else
        {
            operationDigest = request.OperationDigest ?? throw new IOException("SERVICE_OPERATION_DIGEST_REQUIRED");
        }

        var observation = ledger.AbortBeforeLaunch(new ServiceAttemptRequest(identity, sid, ServiceAttemptLedger.GlobalReservationKey, operationDigest, Shared: true));
        if (observation.Phase == ServiceAttemptPhase.LaunchNotStarted)
            _ = ledger.Release(identity, sid);
        return ledger.Inspect(identity, sid);
    }

    private static async Task<byte[]> ReadFrameAsync(Stream stream, CancellationToken cancellationToken)
    {
        var header = new byte[sizeof(int)];
        await stream.ReadExactlyAsync(header, cancellationToken).ConfigureAwait(false);
        var length = BinaryPrimitives.ReadInt32LittleEndian(header);
        if (length is < 2 or > MaxRequestBytes) throw new IOException("SERVICE_REQUEST_SIZE_INVALID");
        var payload = new byte[length];
        await stream.ReadExactlyAsync(payload, cancellationToken).ConfigureAwait(false);
        return payload;
    }

    private static async Task WriteFrameAsync(Stream stream, object response, CancellationToken cancellationToken)
    {
        var payload = JsonSerializer.SerializeToUtf8Bytes(response, Json);
        if (payload.Length > MaxRequestBytes) throw new IOException("SERVICE_RESPONSE_SIZE_INVALID");
        var header = new byte[sizeof(int)];
        BinaryPrimitives.WriteInt32LittleEndian(header, payload.Length);
        await stream.WriteAsync(header, cancellationToken).ConfigureAwait(false);
        await stream.WriteAsync(payload, cancellationToken).ConfigureAwait(false);
        await stream.FlushAsync(cancellationToken).ConfigureAwait(false);
    }

    private static string EnsureStoreDirectory()
    {
        var root = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "lnwjud-containment");
        if (String.IsNullOrWhiteSpace(root) || !Path.IsPathFullyQualified(root))
            throw new IOException("SERVICE_STORE_PATH_INVALID");
        var system = new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null);
        var administrators = new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null);
        var secured = new DirectorySecurity();
        secured.SetAccessRuleProtection(isProtected: true, preserveInheritance: false);
        secured.SetOwner(system);
        var inheritance = InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit;
        secured.AddAccessRule(new FileSystemAccessRule(system, FileSystemRights.FullControl, inheritance, PropagationFlags.None, AccessControlType.Allow));
        secured.AddAccessRule(new FileSystemAccessRule(administrators, FileSystemRights.FullControl, inheritance, PropagationFlags.None, AccessControlType.Allow));
        return CreateStoreDirectory(root, secured);
    }

    private static string CreateStoreDirectory(string root, DirectorySecurity secured)
    {
        var directory = secured.CreateDirectory(root);
        if ((directory.Attributes & FileAttributes.ReparsePoint) != 0)
            throw new IOException("SERVICE_STORE_REPARSE_REFUSED");
        EnsureStoreAcl(directory.GetAccessControl(AccessControlSections.Owner | AccessControlSections.Access));
        directory.SetAccessControl(secured);
        if ((File.GetAttributes(root) & FileAttributes.ReparsePoint) != 0)
            throw new IOException("SERVICE_STORE_REPARSE_REFUSED");
        return root;
    }

    private static void EnsureStoreAcl(DirectorySecurity currentSecurity)
    {
        var owner = currentSecurity.GetOwner(typeof(SecurityIdentifier)) as SecurityIdentifier;
        var system = new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null);
        var administrators = new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null);
        if (owner is null || (!owner.Equals(system) && !owner.Equals(administrators)))
            throw new IOException("SERVICE_STORE_OWNER_REFUSED");

        const FileSystemRights genericWrite = (FileSystemRights)0x40000000;
        const FileSystemRights genericAll = (FileSystemRights)0x10000000;
        const FileSystemRights writeRights = FileSystemRights.WriteData | FileSystemRights.AppendData | FileSystemRights.WriteAttributes
            | FileSystemRights.WriteExtendedAttributes | FileSystemRights.Delete | FileSystemRights.DeleteSubdirectoriesAndFiles
            | FileSystemRights.ChangePermissions | FileSystemRights.TakeOwnership | genericWrite | genericAll;
        foreach (FileSystemAccessRule rule in currentSecurity.GetAccessRules(true, true, typeof(SecurityIdentifier)))
        {
            if (rule.AccessControlType != AccessControlType.Allow) continue;
            var sid = (SecurityIdentifier)rule.IdentityReference;
            if (sid.Equals(system) || sid.Equals(administrators)) continue;
            if ((rule.FileSystemRights & writeRights) != 0) throw new IOException("SERVICE_STORE_WRITE_ACL_REFUSED");
        }
    }

    private static void ServiceMain(uint argc, nint argv)
    {
        _ = argc;
        _ = argv;
        statusHandle = RegisterServiceCtrlHandlerEx(ServiceName, ControlCallback, 0);
        if (statusHandle == 0) return;

        using var stopping = new CancellationTokenSource();
        stopSource = stopping;
        SetStatus(ServiceStartPending, 0, 30000);
        try
        {
            using var authority = ServiceEndpointIdentity.ActivateProductionService();
            var directory = EnsureStoreDirectory();
            var ledger = new ServiceAttemptLedger(new ServiceAttemptLedgerPersistence(Path.Combine(directory, "attempts.json")), Path.Combine(directory, "imports"));
            SetStatus(ServiceRunning, AcceptStop, 0);
            RunProductionPipeServerAsync(authority, ledger, stopping.Token).GetAwaiter().GetResult();
            SetStatus(ServiceStopped, 0, 0);
        }
        catch
        {
            SetStatus(ServiceStopped, 0, 0, 1);
        }
        finally
        {
            stopSource = null;
            statusHandle = 0;
        }
    }

    private static uint HandleControl(uint control, uint eventType, nint eventData, nint context)
    {
        _ = eventType;
        _ = eventData;
        _ = context;
        if (control is ControlStop or ControlShutdown)
        {
            SetStatus(ServiceStopPending, 0, 30000);
            stopSource?.Cancel();
        }
        return 0;
    }

    private static void SetStatus(uint state, uint accepted, uint waitHint, uint serviceError = 0)
    {
        var handle = statusHandle;
        if (handle == 0) return;
        var status = new ServiceStatus
        {
            ServiceType = ServiceWin32OwnProcess,
            CurrentState = state,
            ControlsAccepted = accepted,
            Win32ExitCode = serviceError,
            ServiceSpecificExitCode = 0,
            CheckPoint = state is ServiceStartPending or ServiceStopPending ? 1u : 0u,
            WaitHint = waitHint,
        };
        _ = SetServiceStatus(handle, ref status);
    }
}
