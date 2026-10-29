using System.Buffers.Binary;
using System.ComponentModel;
using System.Diagnostics;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.Json;
using Microsoft.Win32.SafeHandles;

namespace Lnwjud.Containment;

internal static class InstalledUpdaterAuthorityFixture
{
    private static readonly JsonSerializerOptions Json = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };
    private static readonly string Executable = Environment.ProcessPath!;
    private static readonly string[] Boundaries = ["before_process_create", "after_create_before_membership", "before_resume", "after_registration_before_resume", "after_resume_before_reply"];
    private sealed record BinaryIdentity(string Name, long Size, string Sha256);
    private sealed record Installation(string Name, string Root, string Image, string Sid, int Session, string Profile, BinaryIdentity[] Files);
    private sealed record Scenario(Installation Installation, string Stage, string Mode, ServiceAttemptIdentity Identity, ServiceProcessOperation Operation);
    private sealed record ProcessEvidence(int Pid, long StartTicks, string Image, string Sid, int Session, BinaryIdentity? Binary, bool Elevated, int ElevationType, int IntegrityLevel);
    private static bool elevatedClientObserved;
    private static ProcessEvidence? lastCeasedAuthority;
    private sealed record ChildEvidence(ProcessEvidence Process, string Profile, string Station, string Desktop, long Window, bool StdinAtEof);
    private static Installation? hosting;
    private static CancellationTokenSource? stopping;
    private static nint statusHandle;
    private static readonly ServiceMainCallback MainCallback = ServiceMain;
    private static readonly ControlCallback Handler = Control;

    internal static int Prerequisites()
    {
        if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException("INSTALLED_FIXTURE_WINDOWS_REQUIRED");
        using var identity = WindowsIdentity.GetCurrent();
        using var pipe = ServicePipeSecurity.CreateServer("lnwjud-updater-prerequisite-" + Guid.NewGuid().ToString("N"), true);
        VerifyPipeAcl(pipe.SafePipeHandle);
        VerifyCopyRejections();
        VerifyCleanupBoundary();
        var processEvidence = Observe(Environment.ProcessId);
        var normalParentTokenBoundary = !processEvidence.Elevated && InstalledFixtureSessionClient.VerifyNormalParentSource();
        Console.WriteLine(JsonSerializer.Serialize(new
        {
            windows = true, elevated = new WindowsPrincipal(identity).IsInRole(WindowsBuiltInRole.Administrator),
            tokenElevationObserved = processEvidence.Elevated, tokenElevationType = processEvidence.ElevationType,
            tokenIntegrityLevel = processEvidence.IntegrityLevel, imageIdentity = processEvidence.Binary,
            session = Process.GetCurrentProcess().SessionId, executable = Executable,
            desktop = ObjectName(GetThreadDesktop(GetCurrentThreadId())), station = ObjectName(GetProcessWindowStation()),
            productionPipeAclReadback = true, copyIntegrityRejections = true, cleanupBoundaryRejections = true,
            normalParentTokenBoundary, acceptanceRun = false, productionPackageEnrollment = false,
            invocation = "installed-updater-authority <new absolute evidence directory>",
        }, Json));
        return 0;
    }

    internal static int Run(string[] args)
    {
        if (args.Length is not (2 or 5) || !Path.IsPathFullyQualified(args[1])) throw new ArgumentException("Expected new absolute evidence directory");
        using var identity = WindowsIdentity.GetCurrent();
        if (Process.GetCurrentProcess().SessionId == 0) throw new IOException("INSTALLED_FIXTURE_INTERACTIVE_SESSION_REQUIRED");
        if (!new WindowsPrincipal(identity).IsInRole(WindowsBuiltInRole.Administrator))
        {
            if (args.Length != 2) throw new IOException("INSTALLED_FIXTURE_NORMAL_COORDINATOR_REQUIRED");
            InstalledFixtureSessionClient.ValidateCurrent(identity.User!.Value, Process.GetCurrentProcess().SessionId);
            using var parent = Process.GetCurrentProcess();
            using var bridge = NormalClientBridge.Listen(args[1], identity.User!.Value, parent.SessionId);
            var start = new ProcessStartInfo(Executable) { UseShellExecute = true, Verb = "runas", WindowStyle = ProcessWindowStyle.Hidden,
                WorkingDirectory = Path.GetDirectoryName(Executable)! };
            foreach (var argument in new[] { args[0], args[1], parent.Id.ToString(System.Globalization.CultureInfo.InvariantCulture),
                parent.StartTime.ToUniversalTime().Ticks.ToString(System.Globalization.CultureInfo.InvariantCulture), bridge.Name }) start.ArgumentList.Add(argument);
            Console.WriteLine("INSTALLED_FIXTURE_ELEVATION_REQUESTED");
            using var elevated = Process.Start(start) ?? throw new IOException("INSTALLED_FIXTURE_ELEVATION_START_FAILED");
            return bridge.Serve(elevated);
        }
        if (args.Length != 5
            || !int.TryParse(args[2], System.Globalization.NumberStyles.None, System.Globalization.CultureInfo.InvariantCulture, out var parentPid) || parentPid <= 0
            || !long.TryParse(args[3], System.Globalization.NumberStyles.None, System.Globalization.CultureInfo.InvariantCulture, out var parentTicks) || parentTicks <= 0
            || !ClientPipeName(args[4]))
            throw new IOException("INSTALLED_FIXTURE_EXPLICIT_NORMAL_PARENT_REQUIRED");
        using var source = InstalledFixtureSessionClient.NormalParentSource.Open(parentPid, parentTicks, Executable,
            identity.User!.Value, Process.GetCurrentProcess().SessionId);
        using var relay = FullClientRelay.Connect(args[4], source);
        return RunAsAuthority(args[1], relay);
    }

    private static int RunAsAuthority(string evidenceDirectory, FullClientRelay relay)
    {
        using var identity = WindowsIdentity.GetCurrent();
        var root = Path.TrimEndingDirectorySeparator(Path.GetFullPath(evidenceDirectory));
        if (Directory.Exists(root) || File.Exists(root)) throw new IOException("INSTALLED_FIXTURE_NEW_DIRECTORY_REQUIRED");
        ServiceAttemptLedgerPersistence.EnsureNoReparsePoints(root);
        Directory.CreateDirectory(root);
        var security = new DirectorySecurity();
        security.SetAccessRuleProtection(true, false);
        security.SetOwner(new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null));
        foreach (var sid in new[] { WellKnownSidType.LocalSystemSid, WellKnownSidType.BuiltinAdministratorsSid })
            security.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(sid, null), FileSystemRights.FullControl,
                InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
        security.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(WellKnownSidType.AuthenticatedUserSid, null), FileSystemRights.ReadAndExecute,
            InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
        new DirectoryInfo(root).SetAccessControl(security);
        var bin = Directory.CreateDirectory(Path.Combine(root, "bin")).FullName;
        var files = CaptureFiles(AppContext.BaseDirectory);
        CopyVerified(AppContext.BaseDirectory, bin, files);
        var install = new Installation("LnwjudUpdaterFixture-" + Guid.NewGuid().ToString("N"), root,
            Path.Combine(bin, Path.GetFileName(Executable)), identity.User!.Value, Process.GetCurrentProcess().SessionId,
            Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), files);
        Write(Path.Combine(root, "installation.json"), install);
        var config = Path.Combine(root, "installation.json");
        var command = $"\"{install.Image}\" installed-updater-service \"{config}\"";
        var manager = OpenSCManager(null, null, 3);
        Check(manager != 0, "SCM_OPEN");
        nint service = 0;
        lastCeasedAuthority = null;
        var passed = false;
        Exception? scenarioFailure = null;
        var cleanup = new CleanupReceipt();
        try
        {
            service = CreateService(manager, install.Name, install.Name, 0xF01FF, 0x10, 3, 1, command, null, 0, null, null, null);
            Check(service != 0, "SERVICE_CREATE");
            foreach (var stage in Boundaries) RunScenario(install, service, stage, "stdio", relay);
            var failures = new List<Exception>();
            foreach (var mode in new[] { "stdio", "gui" })
            {
                try { RunScenario(install, service, "normal", mode, relay); }
                catch (Exception failure) { failures.Add(failure); }
            }
            if (elevatedClientObserved) failures.Add(new IOException("STANDARD_USER_ACCEPTANCE_UNRUN_ELEVATED_CLIENTS"));
            if (failures.Count > 0) throw new AggregateException("Installed GUI/STDIO acceptance failed", failures);
            passed = true;
        }
        catch (Exception failure) { scenarioFailure = failure; }
        finally
        {
            try
            {
                if (service != 0)
                {
                    CleanupBoundary(
                        () => { RequireOwnedService(service, command); VerifyFiles(bin, install.Files); cleanup.OwnershipVerified = true; },
                        () => StopOwnedService(service, install, cleanup),
                        () => { Check(DeleteService(service), "SERVICE_DELETE"); cleanup.DeletionMarked = true; },
                        cleanup.Errors);
                    CloseServiceHandle(service);
                    service = 0;
                    if (cleanup.DeletionMarked)
                    {
                        try
                        {
                            Wait(() =>
                            {
                                var remaining = OpenService(manager, install.Name, 1);
                                if (remaining != 0) { CloseServiceHandle(remaining); return false; }
                                var error = Marshal.GetLastWin32Error();
                                if (error == 1060) return true;
                                Check(error == 1072, "SERVICE_DISAPPEARANCE_QUERY_" + error);
                                return false;
                            }, "SERVICE_DISAPPEARANCE_TIMEOUT");
                            cleanup.ScmAbsent = true;
                        }
                        catch (Exception failure) { cleanup.Errors.Add(failure); }
                    }
                }
            }
            finally
            {
                if (service != 0) CloseServiceHandle(service);
                CloseServiceHandle(manager);
                Write(Path.Combine(root, "cleanup.json"), new
                {
                    cleanup.OwnershipVerified, cleanup.StopRequested, cleanup.StopError,
                    cleanup.Stopped, cleanup.DeletionMarked, cleanup.Process, cleanup.Terminated,
                    cleanup.ProcessCeased, cleanup.ScmAbsent,
                    clean = cleanup.OwnershipVerified && cleanup.DeletionMarked && cleanup.ProcessCeased && cleanup.ScmAbsent,
                    errors = cleanup.Errors.Select(error => error.ToString()).ToArray(),
                });
                Write(Path.Combine(root, "result.json"), new { passed = passed && cleanup.Errors.Count == 0,
                    standardUserAcceptance = passed && !elevatedClientObserved && cleanup.Errors.Count == 0,
                    elevatedClientObserved, productionPackageEnrollment = false, retainedEvidenceDirectory = root });
            }
        }
        if (scenarioFailure != null || cleanup.Errors.Count != 0)
            throw new AggregateException("Installed fixture or cleanup failed",
                (scenarioFailure == null ? Enumerable.Empty<Exception>() : new[] { scenarioFailure }).Concat(cleanup.Errors));
        Console.WriteLine("PASS installed disposable SCM authority; evidence " + root);
        return 0;
    }

    private static void RunScenario(Installation install, nint service, string stage, string mode, FullClientRelay relay)
    {
        var directory = Directory.CreateDirectory(Path.Combine(install.Root, stage + "-" + mode)).FullName;
        var id = Guid.NewGuid().ToString("D");
        var environment = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            ["SystemRoot"] = Environment.GetFolderPath(Environment.SpecialFolder.Windows),
            ["USERPROFILE"] = install.Profile,
        };
        var sessionDirectory = Directory.CreateDirectory(Path.Combine(directory, "session")).FullName;
        var sessionSecurity = new DirectoryInfo(sessionDirectory).GetAccessControl();
        sessionSecurity.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(install.Sid), FileSystemRights.Modify,
            InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
        new DirectoryInfo(sessionDirectory).SetAccessControl(sessionSecurity);
        var operation = new ServiceProcessOperation("run_process", install.Image,
            ["installed-updater-child", Path.Combine(sessionDirectory, "child.jsonl"), mode], sessionDirectory, 30_000, false, environment, 4096);
        var digest = Convert.ToHexString(SHA256.HashData(JsonSerializer.SerializeToUtf8Bytes(operation, Json))).ToLowerInvariant();
        var scenario = new Scenario(install, stage, mode, new ServiceAttemptIdentity(id, id, id, 1, digest,
            "installed-fixture", install.Sid + "-session-" + install.Session, install.Name), operation);
        Write(Path.Combine(install.Root, "scenario.json"), scenario);
        Exception? scenarioFailure = null;
        try
        {
        Start(service);
        using var firstAuthority = OpenObservedProcess(checked((int)Status(service).Pid), install);
        ObserveAuthority(install, directory, firstAuthority.Id);
        RunClient(install, "launch", relay);
        if (stage != "normal")
        {
            Check(firstAuthority.WaitForExit(15_000), "AUTHORITY_CRASH_NOT_OBSERVED");
            Wait(() => Status(service).State == 1, "SCM_CRASH_NOT_OBSERVED");
            var crash = Read<ProcessEvidence>(Path.Combine(AuthorityDirectory(scenario), "crash.json"));
            if (crash.Pid > 0)
            {
                try
                {
                    using var target = OpenObservedProcess(crash.Pid, install);
                    Check(target.StartTime.ToUniversalTime().Ticks == crash.StartTicks, "TARGET_PID_REUSED");
                    Check(target.WaitForExit(10_000), "TARGET_SURVIVED_SERVICE_CRASH");
                }
                catch (ArgumentException) { }
            }
            Start(service);
            Check(Status(service).Pid != firstAuthority.Id, "AUTHORITY_NOT_RESTARTED");
            ObserveAuthority(install, directory, checked((int)Status(service).Pid));
            RunClient(install, "recover", relay);
        }
        else
        {
            Wait(() => File.Exists(scenario.Operation.Args![1]), "CHILD_EVIDENCE_MISSING");
            var child = JsonSerializer.Deserialize<ChildEvidence>(File.ReadAllLines(scenario.Operation.Args![1]).Single(), Json)!;
            var observed = Observe(child.Process.Pid);
            RequireProcessBinary(observed, install);
            Check(observed == child.Process && observed.Sid == install.Sid && observed.Session == install.Session && !observed.Elevated, "CHILD_PARENT_IDENTITY");
            Check(observed == Read<ProcessEvidence>(Path.Combine(directory, "child.service-independent.json")), "CHILD_SERVICE_IDENTITY");
            Write(Path.Combine(directory, "child.parent-independent.json"), observed);
            RunClient(install, "observe", relay);
        }
        Console.WriteLine("PASS installed authority " + stage + " " + mode);
        }
        catch (Exception failure)
        {
            scenarioFailure = failure;
            File.WriteAllText(Path.Combine(directory, "scenario-error.txt"), failure.ToString());
        }
        var cleanup = new CleanupReceipt();
        try { StopOwnedService(service, install, cleanup); }
        catch (Exception failure) { cleanup.Errors.Add(failure); }
        Write(Path.Combine(directory, "stop.json"), new
        {
            cleanup.StopRequested, cleanup.StopError, cleanup.Stopped, cleanup.Process,
            cleanup.Terminated, cleanup.ProcessCeased, errors = cleanup.Errors.Select(error => error.ToString()).ToArray(),
        });
        if (scenarioFailure != null || cleanup.Errors.Count != 0)
            throw new AggregateException("Scenario or stop failed",
                (scenarioFailure == null ? Enumerable.Empty<Exception>() : new[] { scenarioFailure }).Concat(cleanup.Errors));
    }

    private sealed class CleanupReceipt
    {
        internal bool OwnershipVerified, StopRequested, Stopped, DeletionMarked, Terminated, ProcessCeased, ScmAbsent;
        internal ProcessEvidence? Process;
        internal string? StopError;
        internal List<Exception> Errors { get; } = [];
    }

    private static void CleanupBoundary(Action requireOwnership, Action stop, Action delete, List<Exception> errors)
    {
        try { requireOwnership(); }
        catch (Exception failure) { errors.Add(failure); return; }
        try { stop(); }
        catch (Exception failure) { errors.Add(failure); }
        try { delete(); }
        catch (Exception failure) { errors.Add(failure); }
    }

    private static void StopOwnedService(nint service, Installation install, CleanupReceipt receipt)
    {
        var command = $"\"{install.Image}\" installed-updater-service \"{Path.Combine(install.Root, "installation.json")}\"";
        RequireOwnedService(service, command);
        VerifyFiles(Path.Combine(install.Root, "bin"), install.Files);
        var status = Status(service);
        if (status.State == 1 && status.Pid == 0)
        {
            receipt.Stopped = true;
            Check(lastCeasedAuthority != null, "CLEANUP_NO_PROCESS_CESSATION_EVIDENCE");
            RequireProcessBinary(lastCeasedAuthority!, install);
            receipt.Process = lastCeasedAuthority;
            receipt.ProcessCeased = true;
            return;
        }
        Check(status.Type == 0x10 && status.Pid != 0, "CLEANUP_PROCESS_IDENTITY_UNAVAILABLE");
        using var process = OpenProcess(0x101001, false, checked((int)status.Pid));
        Check(!process.IsInvalid, "CLEANUP_PROCESS_HANDLE");
        var evidence = Observe(checked((int)status.Pid));
        RequireProcessBinary(evidence, install);
        Check(evidence.Sid == "S-1-5-18" && evidence.Session == 0, "CLEANUP_NOT_SYSTEM_SESSION_ZERO");
        Check(GetProcessTimes(process, out var created, out _, out _, out _)
            && DateTime.FromFileTimeUtc(created).Ticks == evidence.StartTicks, "CLEANUP_PID_REUSED");
        using var pinnedImage = new FileStream(install.Image, FileMode.Open, FileAccess.Read, FileShare.Read);
        Check(pinnedImage.Length == evidence.Binary!.Size
            && Convert.ToHexString(SHA256.HashData(pinnedImage)).ToLowerInvariant() == evidence.Binary.Sha256, "CLEANUP_IMAGE_CHANGED");
        receipt.Process = evidence;
        RequireOwnedService(service, command);
        Check(Status(service).Pid == status.Pid, "CLEANUP_SERVICE_RESTARTED");
        receipt.StopRequested = true;
        if (!ControlService(service, 1, out _)) receipt.StopError = "SERVICE_STOP_" + Marshal.GetLastWin32Error();
        if (WaitForSingleObject(process, 15_000) != 0)
        {
            RequireOwnedService(service, command);
            Check(Status(service).Pid == status.Pid, "CLEANUP_SERVICE_RESTARTED");
            Check(TerminateProcess(process, 92), "CLEANUP_TERMINATE");
            receipt.Terminated = true;
            Check(WaitForSingleObject(process, 10_000) == 0, "CLEANUP_PROCESS_CESSATION_UNPROVEN");
        }
        receipt.ProcessCeased = true;
        lastCeasedAuthority = evidence;
        Wait(() => Status(service).State == 1 && Status(service).Pid == 0, "CLEANUP_SCM_STOP_TIMEOUT");
        receipt.Stopped = true;
        if (receipt.StopError != null || receipt.Terminated)
            throw new IOException(receipt.StopError ?? "CLEANUP_STOP_TIMEOUT_REQUIRED_TERMINATION");
    }

    private static void VerifyCleanupBoundary()
    {
        foreach (var stopFailure in new[] { "CONTROL_REFUSED_START_PENDING", "STOP_TIMEOUT" })
        {
            var deletes = 0;
            var errors = new List<Exception>();
            CleanupBoundary(() => { }, () => throw new IOException(stopFailure), () => deletes++, errors);
            Check(deletes == 1 && errors.Count == 1 && errors[0].Message == stopFailure, "CLEANUP_DELETE_SKIPPED_OR_ERROR_LOST");
        }
        var effects = 0;
        var refused = new List<Exception>();
        CleanupBoundary(() => throw new IOException("OWNERSHIP"), () => effects++, () => effects++, refused);
        Check(effects == 0 && refused.Count == 1, "CLEANUP_OWNERSHIP_REFUSAL_FAILED");
        var failed = new List<Exception>();
        CleanupBoundary(() => { }, () => { }, () => throw new IOException("DELETE"), failed);
        Check(failed.Count == 1 && failed[0].Message == "DELETE", "CLEANUP_DELETE_ERROR_LOST");
    }

    private static void RunClient(Installation install, string action, FullClientRelay relay)
    {
        VerifyFiles(Path.Combine(install.Root, "bin"), install.Files);
        var scenario = Read<Scenario>(Path.Combine(install.Root, "scenario.json"));
        var exit = relay.RunClient(install, action, (pid, ticks) =>
        {
            var observed = Observe(pid);
            RequireProcessBinary(observed, install);
            elevatedClientObserved |= observed.Elevated;
            Check(observed.StartTicks == ticks && !observed.Elevated && observed.ElevationType == 3
                && observed.IntegrityLevel == 8192 && observed.Sid == install.Sid && observed.Session == install.Session, "CLIENT_NOT_STANDARD_USER");
            Write(Path.Combine(AuthorityDirectory(scenario), "client-" + action + ".independent.json"), observed);
        });
        Check(exit == 0, "SESSION_CLIENT_FAILED_" + exit + "_SEE_" + Path.Combine(scenario.Operation.Cwd!, "client-" + action + ".stderr.txt"));
    }

    private static bool ClientPipeName(string name) => name.StartsWith("lnwjud-fixture-client-", StringComparison.Ordinal)
        && name.Length == "lnwjud-fixture-client-".Length + 32 && Guid.TryParseExact(name["lnwjud-fixture-client-".Length..], "N", out _);

    private static void SendFrame(PipeStream pipe, string frame)
    {
        var bytes = Encoding.ASCII.GetBytes(frame);
        Check(bytes.Length is > 0 and <= 256 && bytes.All(value => value is >= 32 and <= 126), "CLIENT_FRAME_INVALID");
        var header = new byte[4]; BinaryPrimitives.WriteInt32LittleEndian(header, bytes.Length);
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(15));
        pipe.WriteAsync(header, timeout.Token).AsTask().GetAwaiter().GetResult();
        pipe.WriteAsync(bytes, timeout.Token).AsTask().GetAwaiter().GetResult();
        pipe.FlushAsync(timeout.Token).GetAwaiter().GetResult();
    }

    private static string[] ReceiveFrame(PipeStream pipe, int seconds = 120)
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(seconds));
        var header = new byte[4]; pipe.ReadExactlyAsync(header, timeout.Token).AsTask().GetAwaiter().GetResult();
        var length = BinaryPrimitives.ReadInt32LittleEndian(header);
        Check(length is > 0 and <= 256, "CLIENT_FRAME_SIZE");
        var bytes = new byte[length]; pipe.ReadExactlyAsync(bytes, timeout.Token).AsTask().GetAwaiter().GetResult();
        Check(bytes.All(value => value is >= 32 and <= 126), "CLIENT_FRAME_ENCODING");
        return Encoding.ASCII.GetString(bytes).Split('|');
    }

    private static (int Sequence, string Action, string Installation) ParseClientRequest(string[] request, int previous)
    {
        var next = 0;
        Check(request.Length == 4 && request[0] == "R"
            && int.TryParse(request[1], System.Globalization.NumberStyles.None, System.Globalization.CultureInfo.InvariantCulture, out next)
            && next == previous + 1 && request[2] is "launch" or "recover" or "observe"
            && request[3].StartsWith("LnwjudUpdaterFixture-", StringComparison.Ordinal)
            && Guid.TryParseExact(request[3]["LnwjudUpdaterFixture-".Length..], "N", out _), "CLIENT_REQUEST_INVALID");
        return (next, request[2], request[3]);
    }

    private sealed class NormalClientBridge : IDisposable
    {
        internal readonly NamedPipeServerStream pipe;
        private readonly string root;
        private readonly string sid;
        private readonly int session;
        private readonly BinaryIdentity[] files;
        private int sequence;
        internal string Name { get; }

        private NormalClientBridge(string root, string sid, int session, BinaryIdentity[] files, string name, NamedPipeServerStream pipe)
        { this.root = root; this.sid = sid; this.session = session; this.files = files; Name = name; this.pipe = pipe; }

        internal static NormalClientBridge Listen(string evidenceDirectory, string sid, int session)
        {
            var root = Path.TrimEndingDirectorySeparator(Path.GetFullPath(evidenceDirectory));
            Check(!Directory.Exists(root) && !File.Exists(root), "CLIENT_EVIDENCE_DIRECTORY_EXISTS");
            var files = CaptureFiles(AppContext.BaseDirectory);
            Check(files.Length == 5, "CLIENT_SOURCE_MANIFEST_COUNT");
            var name = "lnwjud-fixture-client-" + Guid.NewGuid().ToString("N");
            var sddl = "D:P(A;;GA;;;" + sid + ")";
            Check(ConvertStringSecurityDescriptorToSecurityDescriptor(sddl, 1, out var descriptor, out _), "CLIENT_PIPE_DESCRIPTOR");
            try
            {
                var attributes = new SecurityAttributes { Length = Marshal.SizeOf<SecurityAttributes>(), Descriptor = descriptor };
                var handle = CreateNamedPipe(@"\\.\pipe\" + name, 0x00000003 | 0x40000000 | 0x00080000,
                    0x00000000 | 0x00000008, 1, 4096, 4096, 0, ref attributes);
                Check(handle != 0 && handle != -1, "CLIENT_PIPE_CREATE");
                var safe = new SafePipeHandle(handle, true);
                try { return new NormalClientBridge(root, sid, session, files, name, new NamedPipeServerStream(PipeDirection.InOut, true, false, safe)); }
                catch { safe.Dispose(); throw; }
            }
            finally { LocalFree(descriptor); }
        }

        internal int Serve(Process elevated)
        {
            using var connect = new CancellationTokenSource(TimeSpan.FromSeconds(30));
            pipe.WaitForConnectionAsync(connect.Token).GetAwaiter().GetResult();
            VerifyElevated(elevated);
            SendFrame(pipe, "H");
            while (true)
            {
                string[] request;
                try { request = ReceiveFrame(pipe); }
                catch (EndOfStreamException)
                {
                    Check(elevated.WaitForExit(15_000) && elevated.ExitCode == 0, "CLIENT_FULL_EXIT_UNVERIFIED");
                    return elevated.ExitCode;
                }
                var parsed = ParseClientRequest(request, sequence);
                var next = parsed.Sequence;
                sequence = next;
                VerifyElevated(elevated);
                var scenarioPath = Path.Combine(root, "scenario.json");
                var scenario = Read<Scenario>(scenarioPath);
                var install = scenario.Installation;
                Check(install.Name == parsed.Installation && install.Root.Equals(root, StringComparison.OrdinalIgnoreCase)
                    && install.Image.Equals(Path.Combine(root, "bin", Path.GetFileName(Executable)), StringComparison.OrdinalIgnoreCase)
                    && install.Sid == sid && install.Session == session && install.Files.SequenceEqual(files)
                    && scenario.Identity.WorkspaceId == install.Name, "CLIENT_INSTALLATION_CHANGED");
                VerifyFiles(AppContext.BaseDirectory, files);
                VerifyFiles(Path.Combine(root, "bin"), files);
                using var self = Process.GetCurrentProcess();
                using var source = InstalledFixtureSessionClient.NormalParentSource.Open(Environment.ProcessId,
                    self.StartTime.ToUniversalTime().Ticks, Executable, sid, session);
                using var job = new InstalledFixtureSessionClient.OwnedClientJob();
                try
                {
                    job.Start(source, install.Image, scenarioPath, parsed.Action, sid, session, (pid, ticks) =>
                    {
                        VerifyElevated(elevated);
                        SendFrame(pipe, $"P|{next}|{pid}|{ticks}");
                        var ack = ReceiveFrame(pipe, 15);
                        Check(ack.Length == 2 && ack[0] == "A" && ack[1] == request[1], "CLIENT_ACK_INVALID");
                        VerifyElevated(elevated);
                    });
                    var exit = job.WaitForExit(() => elevated.HasExited || !PipeConnected());
                    SendFrame(pipe, $"D|{next}|{exit}");
                }
                catch
                {
                    job.TerminateAndProveZero();
                    try { SendFrame(pipe, $"E|{next}"); } catch { }
                    throw;
                }
            }
        }

        private bool PipeConnected() => PeekNamedPipe(pipe.SafePipeHandle, 0, 0, 0, out _, out _, out _);

        internal void VerifyElevated(Process elevated)
        {
            Check(GetNamedPipeClientProcessId(pipe.SafePipeHandle, out var peer) && peer == elevated.Id
                && GetProcessId(elevated.SafeHandle) == peer, "CLIENT_FULL_PEER_PID");
            InstalledFixtureSessionClient.VerifyProcess(elevated.SafeHandle, elevated.StartTime.ToUniversalTime().Ticks, Executable);
            Check(ProcessIdToSessionId(peer, out var peerSession) && peerSession == session, "CLIENT_FULL_SESSION");
            Check(OpenProcessToken(elevated.SafeHandle.DangerousGetHandle(), 8, out var token), "CLIENT_FULL_TOKEN");
            using (token)
            using (var identity = new WindowsIdentity(token.DangerousGetHandle()))
                Check(identity.User?.Value == sid && InstalledFixtureSessionClient.Integer(token, 8) == 1
                    && InstalledFixtureSessionClient.Integer(token, 12) == session
                    && InstalledFixtureSessionClient.Integer(token, 18) == 2
                    && InstalledFixtureSessionClient.Integer(token, 20) == 1
                    && InstalledFixtureSessionClient.Integrity(token) >= 12288, "CLIENT_FULL_IDENTITY");
        }

        public void Dispose() => pipe.Dispose();
    }

    private sealed class FullClientRelay : IDisposable
    {
        private readonly NamedPipeClientStream pipe;
        private readonly InstalledFixtureSessionClient.NormalParentSource source;
        private int sequence;

        private FullClientRelay(NamedPipeClientStream pipe, InstalledFixtureSessionClient.NormalParentSource source)
        { this.pipe = pipe; this.source = source; }

        internal static FullClientRelay Connect(string name, InstalledFixtureSessionClient.NormalParentSource source)
        {
            var pipe = new NamedPipeClientStream(".", name, PipeDirection.InOut, PipeOptions.Asynchronous);
            try
            {
                pipe.Connect(15_000);
                source.VerifyPipeServer(pipe.SafePipeHandle);
                var hello = ReceiveFrame(pipe, 15);
                Check(hello.Length == 1 && hello[0] == "H", "CLIENT_HELLO_INVALID");
                return new FullClientRelay(pipe, source);
            }
            catch { pipe.Dispose(); throw; }
        }

        internal int RunClient(Installation install, string action, Action<int, long> observe)
        {
            Check(action is "launch" or "recover" or "observe", "CLIENT_ACTION");
            source.VerifyPipeServer(pipe.SafePipeHandle);
            var next = ++sequence;
            SendFrame(pipe, $"R|{next}|{action}|{install.Name}");
            var ready = ReceiveFrame(pipe, 30);
            var pid = 0; long ticks = 0;
            Check(ready.Length == 4 && ready[0] == "P" && ready[1] == next.ToString(System.Globalization.CultureInfo.InvariantCulture)
                && int.TryParse(ready[2], out pid) && pid > 0 && long.TryParse(ready[3], out ticks) && ticks > 0, "CLIENT_READY_INVALID");
            source.VerifyPipeServer(pipe.SafePipeHandle);
            using var client = OpenProcess(0x101000, false, pid);
            Check(!client.IsInvalid && GetProcessId(client) == pid, "CLIENT_PROCESS_HANDLE");
            InstalledFixtureSessionClient.VerifyProcess(client, ticks, install.Image);
            observe(pid, ticks);
            InstalledFixtureSessionClient.VerifyProcess(client, ticks, install.Image);
            SendFrame(pipe, $"A|{next}");
            var done = ReceiveFrame(pipe, 50);
            var exit = VerifyClientDone(done, ready[1], client);
            source.VerifyPipeServer(pipe.SafePipeHandle);
            return exit;
        }

        public void Dispose() => pipe.Dispose();
    }

    private static int VerifyClientDone(string[] done, string sequence, SafeProcessHandle client)
    {
        var exit = -1;
        Check(done.Length == 3 && done[0] == "D" && done[1] == sequence
            && int.TryParse(done[2], out exit), "CLIENT_DONE_INVALID");
        var wait = WaitForSingleObject(client, 0);
        Check(wait == 0, wait == 258 ? "CLIENT_STILL_ACTIVE" : "CLIENT_WAIT_FAILED");
        Check(GetExitCodeProcess(client, out var actual), "CLIENT_EXIT_UNAVAILABLE");
        Check(exit == unchecked((int)actual), "CLIENT_EXIT_MISMATCH");
        return exit;
    }

    internal static int ClientBoundaryTests()
    {
        using var identity = WindowsIdentity.GetCurrent();
        var sid = identity.User!.Value;
        var session = Process.GetCurrentProcess().SessionId;
        InstalledFixtureSessionClient.ValidateCurrent(sid, session);
        Check(InstalledFixtureSessionClient.VerifyNormalParentSource(), "CLIENT_PARENT_SOURCE_TEST");
        var installation = "LnwjudUpdaterFixture-" + Guid.NewGuid().ToString("N");
        _ = ParseClientRequest(["R", "1", "launch", installation], 0);
        foreach (var bad in new[]
        {
            new[] { "R", "1", "launch", installation },
            new[] { "R", "2", "delete", installation },
            new[] { "R", "2", "launch", "other" },
            new[] { "R", "2", "launch", installation, "extra" },
        })
        {
            try { _ = ParseClientRequest(bad, 1); }
            catch (IOException) { continue; }
            throw new IOException("CLIENT_INVALID_REQUEST_ACCEPTED");
        }
        using (var bridge = NormalClientBridge.Listen(Path.Combine(Path.GetTempPath(), "lnwjud-client-test-" + Guid.NewGuid().ToString("N")), sid, session))
        using (var peer = new NamedPipeClientStream(".", bridge.Name, PipeDirection.InOut, PipeOptions.Asynchronous))
        {
            peer.Connect(5000);
            bridge.pipe.WaitForConnectionAsync().GetAwaiter().GetResult();
            using (var wrong = Process.Start(new ProcessStartInfo(Executable) { UseShellExecute = false, ArgumentList = { "noop" } })
                ?? throw new IOException("CLIENT_TEST_PROCESS_START"))
            {
                try { bridge.VerifyElevated(wrong); }
                catch (IOException error) when (error.Message.StartsWith("INSTALLED_FIXTURE_CLIENT_FULL_PEER_PID", StringComparison.Ordinal)) { goto WrongPeerRejected; }
                throw new IOException("CLIENT_WRONG_PEER_ACCEPTED");
            WrongPeerRejected:;
            }
            var header = new byte[4]; BinaryPrimitives.WriteInt32LittleEndian(header, 257);
            peer.Write(header);
            try { _ = ReceiveFrame(bridge.pipe, 1); }
            catch (IOException) { goto OversizedRejected; }
            throw new IOException("CLIENT_OVERSIZED_FRAME_ACCEPTED");
        OversizedRejected:;
        }
        using (var bridge = NormalClientBridge.Listen(Path.Combine(Path.GetTempPath(), "lnwjud-client-test-" + Guid.NewGuid().ToString("N")), sid, session))
        using (var peer = new NamedPipeClientStream(".", bridge.Name, PipeDirection.InOut, PipeOptions.Asynchronous))
        {
            peer.Connect(5000);
            bridge.pipe.WaitForConnectionAsync().GetAwaiter().GetResult();
            var header = new byte[4]; BinaryPrimitives.WriteInt32LittleEndian(header, 2);
            peer.Write(header); peer.Write([0, 255]); peer.Flush();
            try { _ = ReceiveFrame(bridge.pipe, 1); }
            catch (IOException) { goto MalformedRejected; }
            throw new IOException("CLIENT_MALFORMED_FRAME_ACCEPTED");
        MalformedRejected:;
        }
        using (var bridge = NormalClientBridge.Listen(Path.Combine(Path.GetTempPath(), "lnwjud-client-test-" + Guid.NewGuid().ToString("N")), sid, session))
        using (var peer = new NamedPipeClientStream(".", bridge.Name, PipeDirection.InOut, PipeOptions.Asynchronous))
        {
            peer.Connect(5000);
            bridge.pipe.WaitForConnectionAsync().GetAwaiter().GetResult();
            var header = new byte[4]; BinaryPrimitives.WriteInt32LittleEndian(header, 4);
            peer.Write(header); peer.WriteByte((byte)'R'); peer.Flush();
            try { _ = ReceiveFrame(bridge.pipe, 1); }
            catch (OperationCanceledException) { goto StalledRejected; }
            throw new IOException("CLIENT_STALLED_FRAME_ACCEPTED");
        StalledRejected:;
        }
        VerifyCopyRejections();
        using var current = Process.GetCurrentProcess();
        using var source = InstalledFixtureSessionClient.NormalParentSource.Open(current.Id, current.StartTime.ToUniversalTime().Ticks,
            Executable, sid, session);
        var unusedScenario = Path.Combine(Path.GetTempPath(), "lnwjud-unused-scenario.json");
        using (var job = new InstalledFixtureSessionClient.OwnedClientJob())
        {
            job.Start(source, Executable, unusedScenario, "noop", sid, session, (_, _) => { });
            Check(job.WaitForExit() == 0, "CLIENT_NOOP_EXIT");
            job.TerminateAndProveZero();
        }
        using (var job = new InstalledFixtureSessionClient.OwnedClientJob())
        {
            try { job.Start(source, Executable, unusedScenario, "noop", sid, session, (_, _) => throw new IOException("CLIENT_TEST_DISCONNECT")); }
            catch (IOException error) when (error.Message == "CLIENT_TEST_DISCONNECT") { goto SuspendedRejected; }
            throw new IOException("CLIENT_SUSPENDED_DISCONNECT_ACCEPTED");
        SuspendedRejected:
            job.TerminateAndProveZero();
        }
        using (var job = new InstalledFixtureSessionClient.OwnedClientJob())
        {
            job.Start(source, Executable, unusedScenario, "hold", sid, session, (_, _) => { });
            try { _ = job.WaitForExit(() => true); }
            catch (IOException error) when (error.Message == "CLIENT_PEER_DISCONNECTED") { goto DisconnectStopped; }
            throw new IOException("CLIENT_DISCONNECT_DID_NOT_STOP_JOB");
        DisconnectStopped:
            job.TerminateAndProveZero();
        }
        SafeProcessHandle? held = null;
        try
        {
            using var job = new InstalledFixtureSessionClient.OwnedClientJob();
            job.Start(source, Executable, unusedScenario, "hold", sid, session, (pid, ticks) =>
            {
                held = OpenProcess(0x101000, false, pid);
                Check(!held.IsInvalid, "CLIENT_TEST_PROCESS_HANDLE");
                InstalledFixtureSessionClient.VerifyProcess(held, ticks, Executable);
            });
            var child = held ?? throw new IOException("CLIENT_TEST_PROCESS_MISSING");
            try { _ = VerifyClientDone(["D", "1", "0"], "1", child); }
            catch (IOException error) when (error.Message.Contains("CLIENT_STILL_ACTIVE", StringComparison.Ordinal)) { goto LiveDoneRejected; }
            throw new IOException("CLIENT_LIVE_DONE_ACCEPTED");
        LiveDoneRejected:
            job.TerminateAndProveZero();
            try { _ = VerifyClientDone(["D", "1", "0"], "1", child); }
            catch (IOException error) when (error.Message.Contains("CLIENT_EXIT_MISMATCH", StringComparison.Ordinal)) { goto WrongExitRejected; }
            throw new IOException("CLIENT_WRONG_EXIT_ACCEPTED");
        WrongExitRejected:
            Check(VerifyClientDone(["D", "1", "92"], "1", child) == 92, "CLIENT_MATCHED_EXIT_REJECTED");
        }
        finally { held?.Dispose(); }
        Console.WriteLine("PASS installed client boundary framing, source, protected manifest, peer refusal, noop Job zero, disconnect cleanup and retained completion proof");
        return 0;
    }

    internal static int Service(string[] args)
    {
        if (args.Length != 2) throw new ArgumentException("Expected fixture installation");
        hosting = Read<Installation>(args[1]);
        RequireInstallation(hosting);
        using var identity = WindowsIdentity.GetCurrent();
        Check(identity.IsSystem && Process.GetCurrentProcess().SessionId == 0, "SERVICE_NOT_SYSTEM_SESSION_ZERO");
        var entries = new[] { new ServiceEntry { Name = hosting.Name, Main = MainCallback }, new ServiceEntry() };
        Check(StartServiceCtrlDispatcher(entries), "SERVICE_DISPATCHER");
        return 0;
    }

    private static void ServiceMain(uint argc, nint argv)
    {
        var install = hosting!;
        statusHandle = RegisterServiceCtrlHandlerEx(install.Name, Handler, 0);
        if (statusHandle == 0) return;
        using var cancellation = new CancellationTokenSource();
        stopping = cancellation;
        SetStatus(2);
        try
        {
            GrantFixtureProcessQuery();
            var scenario = Read<Scenario>(Path.Combine(install.Root, "scenario.json"));
            var directory = AuthorityDirectory(scenario);
            var crashFile = Path.Combine(AuthorityDirectory(scenario), "crash.json");
            ContainedProcess.Fault = (stage, pid) =>
            {
                if (scenario.Stage == "normal" && stage == "after_resume_before_reply" && pid != 0)
                {
                    var child = Observe(checked((int)pid));
                    RequireProcessBinary(child, install);
                    Write(Path.Combine(directory, "child.service-independent.json"), child);
                    return;
                }
                if (stage != scenario.Stage || File.Exists(crashFile)) return;
                var evidence = pid == 0 ? new ProcessEvidence(0, 0, "", "", 0, null, false, 0, 0) : Observe(checked((int)pid));
                if (pid != 0) RequireProcessBinary(evidence, install);
                Write(crashFile, evidence);
                if (stage == "after_resume_before_reply") Wait(() => File.Exists(scenario.Operation.Args![1]), "CHILD_DID_NOT_START");
                Environment.Exit(91);
            };
            var ledger = new ServiceAttemptLedger(new ServiceAttemptLedgerPersistence(Path.Combine(directory, "attempts.json")));
            var server = WindowsContainmentService.RunPipeServerAsync(install.Name, ledger, cancellation.Token);
            SetStatus(4);
            server.GetAwaiter().GetResult();
            SetStatus(1);
        }
        catch (OperationCanceledException) when (cancellation.IsCancellationRequested) { SetStatus(1); }
        catch (Exception error)
        {
            File.WriteAllText(Path.Combine(install.Root, "service-error.txt"), error.ToString());
            SetStatus(1, 1);
        }
        finally { stopping = null; }
    }

    private static string AuthorityDirectory(Scenario scenario) => Path.Combine(scenario.Installation.Root, scenario.Stage + "-" + scenario.Mode);

    private static void ObserveAuthority(Installation install, string directory, int pid)
    {
        var evidence = Observe(pid);
        RequireProcessBinary(evidence, install);
        Check(evidence.Sid == "S-1-5-18" && evidence.Session == 0, "PARENT_SERVICE_NOT_SYSTEM_SESSION_ZERO");
        Write(Path.Combine(directory, "service-" + evidence.Pid + "-" + evidence.StartTicks + ".independent.json"), evidence);
        Write(Path.Combine(directory, "service.independent.json"), evidence);
    }

    internal static int Client(string[] args)
    {
        if (args.Length != 3) throw new ArgumentException("Expected scenario and action");
        var scenario = Read<Scenario>(args[1]);
        using var output = new StreamWriter(Path.Combine(scenario.Operation.Cwd!, "client-" + args[2] + ".stdout.txt")) { AutoFlush = true };
        using var error = new StreamWriter(Path.Combine(scenario.Operation.Cwd!, "client-" + args[2] + ".stderr.txt")) { AutoFlush = true };
        Console.SetOut(output);
        Console.SetError(error);
        try { return ClientCore(args); }
        catch (Exception failure) { error.WriteLine(failure); return 1; }
    }

    private static int ClientCore(string[] args)
    {
        if (args.Length != 3) throw new ArgumentException("Expected scenario and action");
        var scenario = Read<Scenario>(args[1]);
        RequireInstallation(scenario.Installation);
        var install = scenario.Installation;
        InstalledFixtureSessionClient.ValidateCurrent(install.Sid, install.Session);
        var own = Observe(Environment.ProcessId);
        RequireProcessBinary(own, install);
        Check(own.Sid == install.Sid && own.Session == install.Session, "CLIENT_SESSION_CHANGED");
        var directory = scenario.Operation.Cwd!;
        Write(Path.Combine(directory, "client-" + args[2] + ".json"), own);
        if (args[2] == "launch")
        {
            _ = Result(Rpc(scenario, "prepare"));
            try { _ = Result(Rpc(scenario, "run")); }
            catch (Exception error) when (scenario.Stage != "normal" && error is IOException or OperationCanceledException)
            {
                Check(File.Exists(Path.Combine(AuthorityDirectory(scenario), "crash.json")), "EXPECTED_CRASH_EVIDENCE_MISSING");
                return 0;
            }
            Check(scenario.Stage == "normal", "EXPECTED_LOST_REPLY");
            return 0;
        }
        if (args[2] == "recover")
        {
            var expected = scenario.Stage is "after_registration_before_resume" or "after_resume_before_reply"
                ? ServiceAttemptPhase.TerminalVerified : ServiceAttemptPhase.TerminationUnknown;
            var observation = Result(Rpc(scenario, "inspect"));
            Check(observation.GetProperty("phase").GetInt32() == (int)expected, "RECOVERY_PHASE");
            Check(observation.GetProperty("identity").GetProperty("ownerSessionId").GetString() == scenario.Identity.OwnerSessionId, "RECOVERY_OWNER");
            var wrong = Rpc(scenario, "inspect", scenario.Identity with { OwnerSessionId = "other-session" });
            Check(!wrong.GetProperty("ok").GetBoolean() && wrong.GetProperty("error").GetString() == "SERVICE_OWNER_MISMATCH", "WRONG_OWNER_ACCEPTED");
            _ = Result(Rpc(scenario, "prepare"));
            Check(Result(Rpc(scenario, "run")).GetProperty("phase").GetInt32() == (int)expected, "RETRY_RELAUNCHED");
            var lines = File.Exists(scenario.Operation.Args![1]) ? File.ReadAllLines(scenario.Operation.Args[1]) : [];
            Check(lines.Length == (scenario.Stage == "after_resume_before_reply" ? 1 : 0), "DUPLICATE_CHILD");
            if (lines.Length == 1)
            {
                var childEvidence = JsonSerializer.Deserialize<ChildEvidence>(lines[0], Json)!;
                ValidateChild(scenario, childEvidence);
                Check(childEvidence.Process == Read<ProcessEvidence>(Path.Combine(AuthorityDirectory(scenario), "crash.json")), "CRASH_CHILD_OS_IDENTITY");
            }
            Write(Path.Combine(directory, "recovery.json"), observation);
            return 0;
        }
        if (args[2] != "observe") throw new ArgumentException("Unknown fixture client action");
        Wait(() => File.Exists(scenario.Operation.Args![1]), "CHILD_EVIDENCE_MISSING");
        var child = JsonSerializer.Deserialize<ChildEvidence>(File.ReadAllLines(scenario.Operation.Args![1]).Single(), Json)!;
        ValidateChild(scenario, child);
        var independentChild = Observe(child.Process.Pid);
        Write(Path.Combine(directory, "child.independent.json"), independentChild);
        Check(independentChild == child.Process, "CHILD_INDEPENDENT_TOKEN_IDENTITY");
        using var process = OpenObservedProcess(child.Process.Pid, install);
        Check(process.StartTime.ToUniversalTime().Ticks == child.Process.StartTicks && process.SessionId == install.Session, "CHILD_OS_IDENTITY");
        if (scenario.Mode == "gui")
        {
            Check(child.Station.Equals("WinSta0", StringComparison.OrdinalIgnoreCase) && child.Desktop.Equals("Default", StringComparison.OrdinalIgnoreCase), "GUI_NOT_INTERACTIVE_DESKTOP");
            Check(child.Window != 0 && IsWindowVisible((nint)child.Window), "GUI_NOT_VISIBLE");
            GetWindowThreadProcessId((nint)child.Window, out var windowPid);
            Check(windowPid == child.Process.Pid, "GUI_WINDOW_OWNER");
        }
        _ = Result(Rpc(scenario, "cancel"));
        Check(process.WaitForExit(10_000), "CHILD_CANCEL_NOT_TERMINAL");
        Wait(() => Result(Rpc(scenario, "inspect")).GetProperty("phase").GetInt32() == (int)ServiceAttemptPhase.TerminalVerified, "CHILD_TERMINAL_LEDGER");
        JsonElement output = default;
        Wait(() => { output = Result(Rpc(scenario, "read_output")); return output.GetProperty("complete").GetBoolean(); }, "STDIO_EOF_MISSING");
        Check(Encoding.UTF8.GetString(Convert.FromBase64String(output.GetProperty("stdoutBase64").GetString()!)) == "fixture-stdout\n", "STDOUT_MISMATCH");
        Check(Encoding.UTF8.GetString(Convert.FromBase64String(output.GetProperty("stderrBase64").GetString()!)) == "fixture-stderr\n", "STDERR_MISMATCH");
        Check(output.GetProperty("complete").GetBoolean(), "STDIO_EOF_MISSING");
        Write(Path.Combine(directory, "output.json"), output);
        if (scenario.Mode == "stdio") Check(!child.StdinAtEof, "DUPLEX_STDIO_UNAVAILABLE_STDIN_IS_EOF");
        Check(!independentChild.Elevated, "STANDARD_USER_ACCEPTANCE_UNRUN_ELEVATED_CHILD");
        return 0;
    }

    private static void ValidateChild(Scenario scenario, ChildEvidence child)
    {
        RequireProcessBinary(child.Process, scenario.Installation);
        Check(child.Process.Sid == scenario.Installation.Sid && child.Process.Session == scenario.Installation.Session
            && child.Profile.Equals(scenario.Installation.Profile, StringComparison.OrdinalIgnoreCase), "CHILD_SESSION_PROFILE_MISMATCH");
    }

    internal static int Child(string[] args)
    {
        if (args.Length != 3 || args[2] is not ("gui" or "stdio")) throw new ArgumentException("Expected marker and child mode");
        nint window = 0;
        if (args[2] == "gui") window = CreateWindowEx(0, "STATIC", "Disposable lnwjud updater acceptance", 0x10000000 | 0x00CF0000, 40, 40, 360, 100, 0, 0, 0, 0);
        var evidence = new ChildEvidence(Observe(Environment.ProcessId), Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
            ObjectName(GetProcessWindowStation()), ObjectName(GetThreadDesktop(GetCurrentThreadId())), window.ToInt64(), Console.In.Read() == -1);
        File.AppendAllText(args[1], JsonSerializer.Serialize(evidence, Json) + "\n");
        Console.Out.Write("fixture-stdout\n"); Console.Out.Flush();
        Console.Error.Write("fixture-stderr\n"); Console.Error.Flush();
        var lifetime = Stopwatch.StartNew();
        while (lifetime.ElapsedMilliseconds < 30_000)
        {
            while (PeekMessage(out var message, 0, 0, 0, 1)) { TranslateMessage(ref message); DispatchMessage(ref message); }
            Thread.Sleep(10);
        }
        if (window != 0) DestroyWindow(window);
        return 0;
    }

    private static JsonElement Rpc(Scenario scenario, string command, ServiceAttemptIdentity? identity = null)
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(15));
        using var pipe = ServicePipeSecurity.ConnectClientAsync(scenario.Installation.Name, timeout.Token).GetAwaiter().GetResult();
        VerifyPipeAcl(pipe.SafePipeHandle);
        Check(GetNamedPipeServerProcessId(pipe.SafePipeHandle, out var pid), "PIPE_SERVER_PID");
        var manager = OpenSCManager(null, null, 1);
        Check(manager != 0, "CLIENT_SCM_OPEN");
        var service = OpenService(manager, scenario.Installation.Name, 5);
        CloseServiceHandle(manager);
        Check(service != 0, "CLIENT_SERVICE_OPEN");
        try
        {
            var install = scenario.Installation;
            RequireOwnedService(service, $"\"{install.Image}\" installed-updater-service \"{Path.Combine(install.Root, "installation.json")}\"");
            var state = Status(service);
            ServiceEndpointIdentity.ValidateServiceBinding(pid, state.Pid, state.State, state.Type);
            using var server = OpenProcess(0x1000, false, checked((int)pid));
            Check(!server.IsInvalid, "CLIENT_SERVICE_QUERY_HANDLE");
            var image = new StringBuilder(32768);
            var imageSize = image.Capacity;
            Check(QueryFullProcessImageName(server.DangerousGetHandle(), 0, image, ref imageSize)
                && image.ToString().Equals(install.Image, StringComparison.OrdinalIgnoreCase), "CLIENT_SERVICE_IMAGE");
            Check(ProcessIdToSessionId(pid, out var session) && session == 0, "CLIENT_SERVICE_SESSION");
            Check(GetProcessTimes(server, out var created, out _, out _, out _), "CLIENT_SERVICE_CREATION");
            var parent = Read<ProcessEvidence>(Path.Combine(AuthorityDirectory(scenario), "service.independent.json"));
            RequireProcessBinary(parent, install);
            Check(parent.Pid == pid && parent.StartTicks == DateTime.FromFileTimeUtc(created).Ticks
                && parent.Sid == "S-1-5-18" && parent.Session == 0, "CLIENT_PARENT_SERVICE_BINDING");
            using var pinnedImage = new FileStream(install.Image, FileMode.Open, FileAccess.Read, FileShare.Read);
            Check(pinnedImage.Length == parent.Binary!.Size
                && Convert.ToHexString(SHA256.HashData(pinnedImage)).ToLowerInvariant() == parent.Binary.Sha256, "CLIENT_SERVICE_IMAGE_HASH");
            Write(Path.Combine(scenario.Operation.Cwd!, "service-binding-" + command + ".json"), new
            {
                pid, session, creationTime = created, image = image.ToString(), binary = parent.Binary,
                authentication = "scm-config-local-system-live-pid-pipe-pid-pinned-image-parent-os-token",
                remoteTokenQueriedByMediumClient = false,
            });
            var payload = JsonSerializer.SerializeToUtf8Bytes(new { protocol = 3, command, identity = identity ?? scenario.Identity,
                reservationKey = Path.Combine(scenario.Operation.Cwd!, "reservation"), operationDigest = scenario.Identity.RequestDigest,
                operation = scenario.Operation, outputCursor = new ServiceOutputCursor(0, 0) }, Json);
            var header = new byte[4]; BinaryPrimitives.WriteInt32LittleEndian(header, payload.Length);
            state = Status(service);
            ServiceEndpointIdentity.ValidateServiceBinding(pid, state.Pid, state.State, state.Type);
            Check(GetNamedPipeServerProcessId(pipe.SafePipeHandle, out var currentPid) && currentPid == pid
                && GetExitCodeProcess(server, out var exitCode) && exitCode == 259, "CLIENT_SERVICE_RESTARTED");
            pipe.WriteAsync(header, timeout.Token).AsTask().GetAwaiter().GetResult();
            pipe.WriteAsync(payload, timeout.Token).AsTask().GetAwaiter().GetResult();
            pipe.ReadExactlyAsync(header, timeout.Token).AsTask().GetAwaiter().GetResult();
            var length = BinaryPrimitives.ReadInt32LittleEndian(header);
            Check(length is >= 2 and <= 1024 * 1024, "RPC_FRAME_SIZE");
            var bytes = new byte[length]; pipe.ReadExactlyAsync(bytes, timeout.Token).AsTask().GetAwaiter().GetResult();
            state = Status(service);
            ServiceEndpointIdentity.ValidateServiceBinding(pid, state.Pid, state.State, state.Type);
            Check(GetNamedPipeServerProcessId(pipe.SafePipeHandle, out currentPid) && currentPid == pid
                && GetExitCodeProcess(server, out exitCode) && exitCode == 259, "SERVICE_RESTARTED_DURING_RPC");
            using var document = JsonDocument.Parse(bytes);
            return document.RootElement.Clone();
        }
        finally { CloseServiceHandle(service); }
    }

    private static JsonElement Result(JsonElement response)
    {
        if (!response.GetProperty("ok").GetBoolean()) throw new IOException("FIXTURE_RPC_" + response.GetProperty("error").GetString());
        return response.GetProperty("result");
    }
    private static void GrantFixtureProcessQuery()
    {
        using var identity = WindowsIdentity.GetCurrent();
        Check(identity.IsSystem && Process.GetCurrentProcess().SessionId == 0, "QUERY_GRANT_NOT_OWNED_SYSTEM_SERVICE");
        var process = GetCurrentProcess();
        RawSecurityDescriptor ReadDescriptor()
        {
            _ = GetProcessSecurity(process, 7, null, 0, out var size);
            Check(size is >= 20 and < 65536, "SERVICE_PROCESS_DACL_SIZE");
            var bytes = new byte[size];
            Check(GetProcessSecurity(process, 7, bytes, size, out _), "SERVICE_PROCESS_DACL_READ");
            return new RawSecurityDescriptor(bytes, 0);
        }
        var expected = ServiceEndpointIdentity.AddQueryGrant(ReadDescriptor());
        var descriptor = new byte[expected.BinaryLength];
        expected.GetBinaryForm(descriptor, 0);
        Check(SetKernelObjectSecurity(process, 4, descriptor), "SERVICE_PROCESS_QUERY_GRANT");
        ServiceEndpointIdentity.ValidateGrantReadback(expected, ReadDescriptor());
    }
    private static void VerifyPipeAcl(SafePipeHandle pipe)
    {
        _ = GetKernelObjectSecurity(pipe, 4, null, 0, out var size);
        Check(size is > 0 and < 65536, "PIPE_ACL_SIZE");
        var bytes = new byte[size];
        Check(GetKernelObjectSecurity(pipe, 4, bytes, size, out _), "PIPE_ACL_READ");
        var descriptor = new RawSecurityDescriptor(bytes, 0);
        Check(descriptor.ControlFlags.HasFlag(ControlFlags.DiscretionaryAclProtected)
            && descriptor.DiscretionaryAcl?.Count == 3, "PIPE_ACL_NOT_PROTECTED");
        var expected = new Dictionary<string, int> { ["S-1-5-18"] = 0x1f01ff, ["S-1-5-32-544"] = 0x1f01ff, ["S-1-5-11"] = 0x12019b };
        foreach (GenericAce item in descriptor.DiscretionaryAcl!)
        {
            Check(item is CommonAce, "PIPE_ACL_ACE_TYPE");
            var ace = (CommonAce)item;
            Check(ace.AceQualifier == AceQualifier.AccessAllowed && expected.Remove(ace.SecurityIdentifier.Value, out var access)
                && (ace.AccessMask == access || (ace.SecurityIdentifier.Value != "S-1-5-11" && ace.AccessMask == 0x10000000)), "PIPE_ACL_RIGHTS");
        }
        Check(expected.Count == 0, "PIPE_ACL_MISSING_PRINCIPAL");
    }
    private static void RequireInstallation(Installation installation)
    {
        Check(installation.Name.StartsWith("LnwjudUpdaterFixture-", StringComparison.Ordinal)
            && Guid.TryParseExact(installation.Name[21..], "N", out _), "INSTALLATION_NAME");
        Check(Path.GetFullPath(Executable).Equals(installation.Image, StringComparison.OrdinalIgnoreCase), "INSTALLATION_IMAGE");
        ServiceAttemptLedgerPersistence.EnsureNoReparsePoints(installation.Root);
        VerifyFiles(Path.Combine(installation.Root, "bin"), installation.Files);
        RequireProcessBinary(Observe(Environment.ProcessId), installation);
    }
    private static Process OpenObservedProcess(int pid, Installation install)
    {
        var process = Process.GetProcessById(pid);
        try { RequireProcessBinary(Observe(pid), install); }
        catch { process.Dispose(); throw; }
        return process;
    }
    private static BinaryIdentity CaptureFile(string path)
    {
        ServiceAttemptLedgerPersistence.EnsureNoReparsePoints(path);
        using var file = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read);
        return new BinaryIdentity(Path.GetFileName(path), file.Length, Convert.ToHexString(SHA256.HashData(file)).ToLowerInvariant());
    }
    private static BinaryIdentity[] CaptureFiles(string directory) => Directory.GetFiles(directory)
        .Order(StringComparer.OrdinalIgnoreCase).Select(CaptureFile).ToArray();
    private static void VerifyFiles(string directory, BinaryIdentity[] expected)
    {
        Check(expected.Length > 0 && expected.All(file => file.Name == Path.GetFileName(file.Name))
            && expected.Select(file => file.Name).Distinct(StringComparer.OrdinalIgnoreCase).Count() == expected.Length, "BINARY_MANIFEST_INVALID");
        var actual = CaptureFiles(directory);
        Check(actual.Length == expected.Length && expected.All(file => actual.Contains(file)), "BINARY_MANIFEST_MISMATCH");
    }
    private static void CopyVerified(string source, string destination, BinaryIdentity[] expected)
    {
        VerifyFiles(source, expected);
        foreach (var binary in expected)
        {
            var path = Path.Combine(source, binary.Name);
            using var input = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read);
            Check(input.Length == binary.Size && Convert.ToHexString(SHA256.HashData(input)).ToLowerInvariant() == binary.Sha256, "SOURCE_BINARY_CHANGED");
            input.Position = 0;
            using (var output = new FileStream(Path.Combine(destination, binary.Name), FileMode.CreateNew, FileAccess.Write, FileShare.None))
            { input.CopyTo(output); output.Flush(true); }
            Check(CaptureFile(Path.Combine(destination, binary.Name)) == binary, "COPIED_BINARY_CHANGED");
        }
        VerifyFiles(source, expected);
        VerifyFiles(destination, expected);
    }
    private static void RequireProcessBinary(ProcessEvidence process, Installation install)
    {
        Check(process.Image.Equals(install.Image, StringComparison.OrdinalIgnoreCase)
            && process.Binary == install.Files.Single(file => file.Name == Path.GetFileName(install.Image)), "PROCESS_BINARY_MISMATCH");
    }
    private static void VerifyCopyRejections()
    {
        var root = Path.Combine(Path.GetTempPath(), "lnwjud-fixture-hash-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            var source = Directory.CreateDirectory(Path.Combine(root, "source")).FullName;
            var target = Directory.CreateDirectory(Path.Combine(root, "target")).FullName;
            var sourceFile = Path.Combine(source, "fixture.bin");
            var targetFile = Path.Combine(target, "fixture.bin");
            File.WriteAllText(sourceFile, "original");
            var expected = CaptureFiles(source);
            CopyVerified(source, target, expected);
            void Reject(Action action)
            {
                try { action(); }
                catch (IOException) { return; }
                throw new IOException("FIXTURE_HASH_REJECTION_MISSING");
            }
            File.WriteAllText(targetFile, "modified");
            Reject(() => VerifyFiles(target, expected));
            File.Delete(targetFile);
            Reject(() => VerifyFiles(target, expected));
            File.WriteAllText(targetFile, "original");
            File.WriteAllText(Path.Combine(target, "mixed.dll"), "unexpected");
            Reject(() => VerifyFiles(target, expected));
            File.WriteAllText(sourceFile, "modified");
            Reject(() => CopyVerified(source, target, expected));
        }
        finally
        {
            ServiceAttemptLedgerPersistence.EnsureNoReparsePoints(root);
            Directory.Delete(root, true);
        }
    }
    private static ProcessEvidence Observe(int pid)
    {
        using var process = Process.GetProcessById(pid);
        using var handle = OpenProcess(0x1000, false, pid);
        Check(!handle.IsInvalid, "PROCESS_QUERY_HANDLE");
        Check(OpenProcessToken(handle.DangerousGetHandle(), 8, out var token), "PROCESS_TOKEN");
        using (token)
        using (var identity = new WindowsIdentity(token.DangerousGetHandle()))
        {
            Check(GetTokenInformation(token, 20, out var elevated, sizeof(int), out var returned) && returned == sizeof(int), "PROCESS_TOKEN_ELEVATION");
            var imageBuffer = new StringBuilder(32768);
            var imageSize = imageBuffer.Capacity;
            Check(QueryFullProcessImageName(handle.DangerousGetHandle(), 0, imageBuffer, ref imageSize), "PROCESS_IMAGE");
            var image = imageBuffer.ToString();
            return new ProcessEvidence(pid, process.StartTime.ToUniversalTime().Ticks, image, identity.User!.Value, process.SessionId, CaptureFile(image), elevated != 0,
                InstalledFixtureSessionClient.Integer(token, 18), InstalledFixtureSessionClient.Integrity(token));
        }
    }
    private static void RequireOwnedService(nint service, string command)
    {
        _ = QueryServiceConfig(service, 0, 0, out var size);
        Check(size > 0 && size < 65536, "SERVICE_CONFIG_SIZE");
        var memory = Marshal.AllocHGlobal(checked((int)size));
        try
        {
            Check(QueryServiceConfig(service, memory, size, out _), "SERVICE_CONFIG");
            var config = Marshal.PtrToStructure<ServiceConfig>(memory);
            Check(config.Type == 0x10 && config.Start == 3 && Marshal.PtrToStringUni(config.BinaryPath) == command
                && Marshal.PtrToStringUni(config.Account) == "LocalSystem", "SERVICE_OWNERSHIP_CHANGED");
        }
        finally { Marshal.FreeHGlobal(memory); }
    }
    private static void Start(nint service) { lastCeasedAuthority = null; Check(StartService(service, 0, 0), "SERVICE_START"); Wait(() => Status(service).State == 4, "SERVICE_START_TIMEOUT"); }
    private static ServiceStatus Status(nint service) { Check(QueryServiceStatusEx(service, 0, out var status, (uint)Marshal.SizeOf<ServiceStatus>(), out _), "SERVICE_STATUS"); return status; }
    private static uint Control(uint control, uint type, nint data, nint context) { if (control == 1) { SetStatus(3); stopping?.Cancel(); } return 0; }
    private static void SetStatus(uint state, uint error = 0)
    {
        var status = new ServiceStatus { Type = 0x10, State = state, Accepted = state == 4 ? 1u : 0, Error = error, WaitHint = 30000 };
        Check(SetServiceStatus(statusHandle, ref status), "SERVICE_SET_STATUS");
    }
    private static void Wait(Func<bool> predicate, string error)
    {
        var watch = Stopwatch.StartNew();
        while (!predicate()) { if (watch.ElapsedMilliseconds > 15_000) throw new IOException(error); Thread.Sleep(25); }
    }
    private static void Check(bool condition, string code) { if (!condition) throw new IOException("INSTALLED_FIXTURE_" + code + "_" + Marshal.GetLastWin32Error()); }
    private static T Read<T>(string path) => JsonSerializer.Deserialize<T>(File.ReadAllBytes(path), Json) ?? throw new IOException("FIXTURE_JSON_INVALID");
    private static void Write<T>(string path, T value) { using var file = new FileStream(path, FileMode.Create, FileAccess.Write, FileShare.Read); JsonSerializer.Serialize(file, value, Json); file.Flush(true); }
    private static string ObjectName(nint handle)
    {
        var value = new StringBuilder(512);
        Check(GetUserObjectInformation(handle, 2, value, 1024, out _), "DESKTOP_NAME");
        return value.ToString();
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] private struct ServiceEntry { [MarshalAs(UnmanagedType.LPWStr)] public string? Name; public ServiceMainCallback? Main; }
    [StructLayout(LayoutKind.Sequential)] private struct ServiceStatus { public uint Type, State, Accepted, Error, SpecificError, Checkpoint, WaitHint, Pid, Flags; }
    [StructLayout(LayoutKind.Sequential)] private struct ServiceConfig { public uint Type, Start, Error; public nint BinaryPath, Group; public uint Tag; public nint Dependencies, Account, DisplayName; }
    [StructLayout(LayoutKind.Sequential)] private struct Message { public nint Window; public uint Id; public nuint WParam; public nint LParam; public uint Time; public int X, Y; public uint Private; }
    [StructLayout(LayoutKind.Sequential)] private struct SecurityAttributes { public int Length; public nint Descriptor; public int InheritHandle; }
    [UnmanagedFunctionPointer(CallingConvention.Winapi)] private delegate void ServiceMainCallback(uint argc, nint argv);
    [UnmanagedFunctionPointer(CallingConvention.Winapi)] private delegate uint ControlCallback(uint control, uint type, nint data, nint context);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern nint OpenSCManager(string? machine, string? database, uint access);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern nint CreateService(nint manager, string name, string display, uint access, uint type, uint start, uint error, string command, string? group, nint tag, string? dependencies, string? account, string? password);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern nint OpenService(nint manager, string name, uint access);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool CloseServiceHandle(nint service);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool DeleteService(nint service);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool QueryServiceStatusEx(nint service, int level, out ServiceStatus status, uint size, out uint needed);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool QueryServiceConfig(nint service, nint config, uint size, out uint needed);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool StartService(nint service, int argc, nint argv);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool ControlService(nint service, uint control, out ServiceStatus status);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool StartServiceCtrlDispatcher([In] ServiceEntry[] entries);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern nint RegisterServiceCtrlHandlerEx(string name, ControlCallback callback, nint context);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool SetServiceStatus(nint handle, ref ServiceStatus status);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool OpenProcessToken(nint process, uint access, out SafeAccessTokenHandle token);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern SafeProcessHandle OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool TerminateProcess(SafeProcessHandle process, uint code);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern uint WaitForSingleObject(SafeProcessHandle process, uint milliseconds);
    [DllImport("kernel32.dll")] private static extern nint GetCurrentProcess();
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool ProcessIdToSessionId(uint pid, out uint session);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetProcessTimes(SafeProcessHandle process, out long creation, out long exit, out long kernel, out long user);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetExitCodeProcess(SafeProcessHandle process, out uint code);
    [DllImport("advapi32.dll", EntryPoint = "GetKernelObjectSecurity", SetLastError = true)] private static extern bool GetProcessSecurity(nint process, uint information, byte[]? descriptor, uint size, out uint needed);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool SetKernelObjectSecurity(nint process, uint information, byte[] descriptor);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool QueryFullProcessImageName(nint process, uint flags, StringBuilder image, ref int size);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool GetTokenInformation(SafeAccessTokenHandle token, int informationClass, out int information, int size, out int returned);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetNamedPipeServerProcessId(SafePipeHandle pipe, out uint pid);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetNamedPipeClientProcessId(SafePipeHandle pipe, out uint pid);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern uint GetProcessId(SafeProcessHandle process);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool PeekNamedPipe(SafePipeHandle pipe, nint buffer, uint size, nint read, out uint available, out uint left, out uint bytesLeft);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern nint CreateNamedPipe(string name, uint openMode, uint pipeMode, uint instances, uint outputSize, uint inputSize, uint timeout, ref SecurityAttributes attributes);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "ConvertStringSecurityDescriptorToSecurityDescriptorW")]
    private static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(string sddl, uint revision, out nint descriptor, out uint size);
    [DllImport("kernel32.dll")] private static extern nint LocalFree(nint memory);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool GetKernelObjectSecurity(SafePipeHandle handle, uint information, byte[]? descriptor, uint size, out uint needed);
    [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] private static extern nint GetThreadDesktop(uint thread);
    [DllImport("user32.dll")] private static extern nint GetProcessWindowStation();
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool GetUserObjectInformation(nint handle, int index, StringBuilder value, uint size, out uint needed);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern nint CreateWindowEx(uint extendedStyle, string className, string title, uint style, int x, int y, int width, int height, nint parent, nint menu, nint instance, nint parameter);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(nint window);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(nint window, out uint pid);
    [DllImport("user32.dll")] private static extern bool DestroyWindow(nint window);
    [DllImport("user32.dll")] private static extern bool PeekMessage(out Message message, nint window, uint min, uint max, uint remove);
    [DllImport("user32.dll")] private static extern bool TranslateMessage(ref Message message);
    [DllImport("user32.dll")] private static extern nint DispatchMessage(ref Message message);
}
