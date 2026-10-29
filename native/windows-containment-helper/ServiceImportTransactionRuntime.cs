using System.Diagnostics;
using System.IO.Pipes;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using Microsoft.Win32.SafeHandles;

namespace Lnwjud.Containment;

internal sealed record ServiceImportReceipt(int Version, string State, string NativeIdentity, string Commit);
internal sealed record ServiceControlObservation(ServiceAttemptIdentity Identity, string Command, ServiceImportReceipt Result, bool Verified = true);
internal sealed record ServiceImportArguments(string WorkspaceRoot, string Destination, string? StagePath, string Commit, string? PrivateHome, string? ExpectedStageIdentity = null);
internal enum ServiceImportPhase { CreatingStage, Prepared, PublicationIntent, Published }
internal sealed record ServiceImportRecord(int Version, ServiceAttemptIdentity Identity, string CallerSid,
    ServiceImportArguments Arguments, ServiceImportPhase Phase, string? ParentIdentity, string? StageIdentity);

internal sealed class ServiceImportTransactionRuntime
{
    private static readonly JsonSerializerOptions Json = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow,
    };
    private static readonly Regex NativeIdentity = new("^[0-9A-F]{16}-[0-9A-F]{32}$", RegexOptions.CultureInvariant);
    private readonly ServiceAttemptLedger ledger;
    private readonly string? storeDirectory;
    private readonly bool useCurrentUserTestLauncher;
    private readonly object gate = new();

#if NATIVE_CONTAINMENT_TESTS
    internal static Action<string>? Fault { get; set; }
#endif

    internal ServiceImportTransactionRuntime(ServiceAttemptLedger ledger, string? storeDirectory, bool useCurrentUserTestLauncher = false)
    {
        this.ledger = ledger;
        this.useCurrentUserTestLauncher = useCurrentUserTestLauncher;
        if (storeDirectory is not null)
        {
            if (!Path.IsPathFullyQualified(storeDirectory)) throw new IOException("SERVICE_IMPORT_STORE_INVALID");
            this.storeDirectory = Path.GetFullPath(storeDirectory);
            Directory.CreateDirectory(this.storeDirectory);
            EnsurePlainPath(this.storeDirectory);
        }
    }

    internal ServiceControlObservation Control(string command, ServiceAttemptIdentity identity, string callerSid,
        JsonElement request, SafeAccessTokenHandle callerToken)
    {
        ValidateCaller(identity, callerSid, callerToken);
        var args = ParseArguments(request, command);
        lock (gate)
        {
            var existing = Load(identity, callerSid);
            if (command == "inspect_publication")
            {
                var entry = existing ?? throw new IOException("SERVICE_IMPORT_TRANSACTION_MISSING");
                if (!SamePublicationRequest(entry.Arguments, args)) throw new IOException("SERVICE_IMPORT_REQUEST_CONFLICT");
                return InspectEntry("publish_import", entry, callerToken) with { Command = command };
            }
            if (command is not ("prepare_import" or "publish_import")) throw new IOException("SERVICE_IMPORT_COMMAND_INVALID");
            if (existing is not null && existing.Arguments != args with { ExpectedStageIdentity = null })
                throw new IOException("SERVICE_IMPORT_REQUEST_CONFLICT");
            if (command == "prepare_import")
            {
                if (existing is not null) return InspectEntry(command, existing, callerToken);
                ledger.AcquireImportReservation(identity, callerSid);
                var creating = new ServiceImportRecord(1, identity, callerSid, args, ServiceImportPhase.CreatingStage, null, null);
                Save(creating);
                var prepared = WindowsIdentity.RunImpersonated(callerToken, () =>
                {
                    using var anchor = new RepositoryImportAnchor(args.WorkspaceRoot, args.Destination, false);
                    var stageId = RepositoryImportAnchor.CreatePrivateStage(args.StagePath!);
                    if (anchor.PrepareStage(args.StagePath!) != stageId) throw new IOException("SERVICE_IMPORT_STAGE_CHANGED");
                    return creating with { Phase = ServiceImportPhase.Prepared, ParentIdentity = anchor.ParentIdentity, StageIdentity = stageId };
                });
                Save(prepared);
                return Receipt(command, prepared);
            }
            var publication = existing ?? throw new IOException("SERVICE_IMPORT_TRANSACTION_MISSING");
            if (args.ExpectedStageIdentity != publication.StageIdentity) throw new IOException("SERVICE_IMPORT_STAGE_CHANGED");
            if (publication.Phase != ServiceImportPhase.Prepared) return InspectEntry(command, publication, callerToken);
            ledger.CheckImportValidation(identity, callerSid);
            using (WindowsIdentity.RunImpersonated(callerToken, () => OpenPreparedAnchor(publication, false)))
            {
                ImportOperations.ValidateCheckout(args.StagePath!, args.Commit, args.PrivateHome!,
                    (executable, arguments, cwd, environment) => CaptureAsCaller(identity, callerSid, callerToken, executable, arguments, cwd, environment));
            }
            using var pinned = WindowsIdentity.RunImpersonated(callerToken, () => OpenPreparedAnchor(publication));
            var intent = publication with { Phase = ServiceImportPhase.PublicationIntent };
#if NATIVE_CONTAINMENT_TESTS
            Fault?.Invoke("before_publication_commit");
#endif
            ledger.CommitImportPublication(identity, callerSid, () => Save(intent));
#if NATIVE_CONTAINMENT_TESTS
            Fault?.Invoke("after_publication_intent");
#endif
            WindowsIdentity.RunImpersonated(callerToken, () =>
            {
                pinned.Publish();
                if (pinned.ReadPublishedIdentity() != intent.StageIdentity) throw new IOException("SERVICE_IMPORT_PUBLISHED_IDENTITY_CHANGED");
            });
#if NATIVE_CONTAINMENT_TESTS
            Fault?.Invoke("after_native_publish");
#endif
            var published = intent with { Phase = ServiceImportPhase.Published };
            Save(published);
            ledger.CompleteImportReservation(identity, callerSid);
            return Receipt(command, published);
        }
    }

    internal ServiceControlObservation Inspect(string command, ServiceAttemptIdentity identity, string callerSid, SafeAccessTokenHandle callerToken)
    {
        ValidateCaller(identity, callerSid, callerToken);
        if (command is not ("prepare_import" or "publish_import" or "inspect_publication")) throw new IOException("SERVICE_IMPORT_COMMAND_INVALID");
        lock (gate) return InspectEntry(command, Load(identity, callerSid) ?? throw new IOException("SERVICE_IMPORT_TRANSACTION_MISSING"), callerToken);
    }

    private ServiceControlObservation InspectEntry(string command, ServiceImportRecord entry, SafeAccessTokenHandle callerToken)
    {
        if (entry.Phase == ServiceImportPhase.CreatingStage) throw new IOException("SERVICE_IMPORT_PREPARATION_UNKNOWN");
        if (command == "prepare_import" && entry.Phase == ServiceImportPhase.Prepared)
        {
            using var anchor = WindowsIdentity.RunImpersonated(callerToken, () => OpenPreparedAnchor(entry));
            return Receipt(command, entry);
        }
        if (command == "prepare_import" && entry.Phase == ServiceImportPhase.Published) return Receipt(command, entry);
        if (entry.Phase is not (ServiceImportPhase.PublicationIntent or ServiceImportPhase.Published))
            throw new IOException("SERVICE_IMPORT_PUBLICATION_NOT_OBSERVED");
        var matches = WindowsIdentity.RunImpersonated(callerToken, () =>
        {
            using var anchor = new RepositoryImportAnchor(entry.Arguments.WorkspaceRoot, entry.Arguments.Destination, false);
            return anchor.ParentIdentity == entry.ParentIdentity && anchor.ReadPublishedIdentity() == entry.StageIdentity;
        });
        if (!matches) throw new IOException("SERVICE_IMPORT_PUBLISHED_IDENTITY_CHANGED");
        if (entry.Phase == ServiceImportPhase.PublicationIntent)
        {
            entry = entry with { Phase = ServiceImportPhase.Published };
            Save(entry);
        }
        ledger.CompleteImportReservation(entry.Identity, entry.CallerSid);
        return Receipt(command, entry);
    }

    private static RepositoryImportAnchor OpenPreparedAnchor(ServiceImportRecord entry, bool forPublication = true)
    {
        var anchor = new RepositoryImportAnchor(entry.Arguments.WorkspaceRoot, entry.Arguments.Destination, true);
        try
        {
            if (anchor.ParentIdentity != entry.ParentIdentity || anchor.PrepareStage(entry.Arguments.StagePath!, forPublication) != entry.StageIdentity)
                throw new IOException("SERVICE_IMPORT_STAGE_CHANGED");
            return anchor;
        }
        catch { anchor.Dispose(); throw; }
    }

    private void ValidateCaller(ServiceAttemptIdentity identity, string callerSid, SafeAccessTokenHandle token)
    {
        _ = ledger.Inspect(identity, callerSid);
        if (token.IsInvalid || token.IsClosed) throw new UnauthorizedAccessException("SERVICE_IMPORT_TOKEN_INVALID");
        using var native = new WindowsIdentity(token.DangerousGetHandle());
        if (native.User?.Value != callerSid) throw new UnauthorizedAccessException("SERVICE_IMPORT_TOKEN_MISMATCH");
        if (storeDirectory is null) throw new IOException("SERVICE_IMPORT_STORE_UNAVAILABLE");
    }

    internal static ServiceImportArguments ParseArguments(JsonElement request, string command)
    {
        ServiceImportArguments args;
        try { args = request.Deserialize<ServiceImportArguments>(Json) ?? throw new IOException(); }
        catch { throw new IOException("SERVICE_IMPORT_REQUEST_INVALID"); }
        if (String.IsNullOrWhiteSpace(args.WorkspaceRoot) || !Path.IsPathFullyQualified(args.WorkspaceRoot)
            || String.IsNullOrWhiteSpace(args.Destination) || args.Destination.Contains('\0')
            || args.Commit is null || !Regex.IsMatch(args.Commit, "^(?:[a-f0-9]{40}|[a-f0-9]{64})$", RegexOptions.CultureInvariant))
            throw new IOException("SERVICE_IMPORT_REQUEST_INVALID");
        if (command != "inspect_publication")
        {
            if (String.IsNullOrWhiteSpace(args.StagePath) || !Path.IsPathFullyQualified(args.StagePath)
                || String.IsNullOrWhiteSpace(args.PrivateHome) || !Path.IsPathFullyQualified(args.PrivateHome)
                || !String.Equals(Path.GetDirectoryName(Path.GetFullPath(args.StagePath)), Path.GetDirectoryName(Path.GetFullPath(args.WorkspaceRoot)), StringComparison.OrdinalIgnoreCase)
                || !Regex.IsMatch(Path.GetFileName(args.StagePath), "^\\.lnwjud-import-stage-[0-9a-f-]{36}$", RegexOptions.CultureInvariant)
                || command == "publish_import" && (args.ExpectedStageIdentity is null || !NativeIdentity.IsMatch(args.ExpectedStageIdentity))
                || command == "prepare_import" && args.ExpectedStageIdentity is not null)
                throw new IOException("SERVICE_IMPORT_REQUEST_INVALID");
        }
        return args;
    }

    private static bool SamePublicationRequest(ServiceImportArguments stored, ServiceImportArguments requested) =>
        stored.WorkspaceRoot == requested.WorkspaceRoot && stored.Destination == requested.Destination && stored.Commit == requested.Commit;

    private static ServiceControlObservation Receipt(string command, ServiceImportRecord entry) => new(entry.Identity, command,
        new ServiceImportReceipt(2, command == "prepare_import" ? "prepared" : "published", entry.StageIdentity!, entry.Arguments.Commit));

    private string Filename(ServiceAttemptIdentity identity) => Path.Combine(storeDirectory!, Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(identity.AttemptId))).ToLowerInvariant() + ".json");

    private ServiceImportRecord? Load(ServiceAttemptIdentity identity, string callerSid)
    {
        var filename = Filename(identity);
        EnsurePlainPath(filename);
        if (!File.Exists(filename)) return null;
        ServiceImportRecord entry;
        try
        {
            using var stream = new FileStream(filename, FileMode.Open, FileAccess.Read, FileShare.Read);
            if (stream.Length is < 2 or > 131072) throw new IOException();
            entry = JsonSerializer.Deserialize<ServiceImportRecord>(stream, Json) ?? throw new IOException();
            if (entry.Version != 1 || !Enum.IsDefined(entry.Phase)
                || entry.Arguments != ParseArguments(JsonSerializer.SerializeToElement(entry.Arguments, Json), "prepare_import")
                || entry.Phase != ServiceImportPhase.CreatingStage && (entry.StageIdentity is null || !NativeIdentity.IsMatch(entry.StageIdentity)
                    || entry.ParentIdentity is null || !NativeIdentity.IsMatch(entry.ParentIdentity))) throw new IOException();
        }
        catch { throw new IOException("SERVICE_IMPORT_STORE_CORRUPT"); }
        if (entry.Identity != identity || entry.CallerSid != callerSid) throw new UnauthorizedAccessException("SERVICE_IMPORT_OWNER_MISMATCH");
        return entry;
    }

    private void Save(ServiceImportRecord entry)
    {
        var filename = Filename(entry.Identity);
        EnsurePlainPath(filename);
        var temporary = filename + "." + Guid.NewGuid().ToString("N") + ".tmp";
        var bytes = JsonSerializer.SerializeToUtf8Bytes(entry, Json);
        try
        {
            using (var stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None, 4096, FileOptions.WriteThrough))
            {
                stream.Write(bytes);
                stream.Flush(true);
            }
            File.Move(temporary, filename, true);
            EnsurePlainPath(filename);
            if (!File.ReadAllBytes(filename).AsSpan().SequenceEqual(bytes)) throw new IOException("SERVICE_IMPORT_STORE_READBACK_FAILED");
        }
        finally { if (File.Exists(temporary)) File.Delete(temporary); }
    }

    private static void EnsurePlainPath(string filename)
    {
        for (var current = Path.GetFullPath(filename); ;)
        {
            if ((Directory.Exists(current) || File.Exists(current)) && (File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0)
                throw new IOException("SERVICE_IMPORT_STORE_REPARSE_REFUSED");
            var parent = Directory.GetParent(current);
            if (parent is null) return;
            current = parent.FullName;
        }
    }

    private string CaptureAsCaller(ServiceAttemptIdentity identity, string callerSid, SafeAccessTokenHandle callerToken,
        string executable, string[] args, string cwd, IReadOnlyDictionary<string, string> environment)
    {
        using var launchToken = AuthenticatedPipeCaller.CreateLaunchToken(callerToken);
        using var output = new AnonymousPipeServerStream(PipeDirection.In, HandleInheritability.None);
        using var error = new AnonymousPipeServerStream(PipeDirection.In, HandleInheritability.None);
        ContainedProcess Start()
        {
#if NATIVE_CONTAINMENT_TESTS
            if (useCurrentUserTestLauncher) return ContainedProcess.Start(executable, args, cwd, false, environment,
                output.ClientSafePipeHandle.DangerousGetHandle(), error.ClientSafePipeHandle.DangerousGetHandle());
#endif
            return ContainedProcess.StartAsUser(launchToken.DangerousGetHandle(), executable, args, cwd, false, environment,
                output.ClientSafePipeHandle.DangerousGetHandle(), error.ClientSafePipeHandle.DangerousGetHandle());
        }
        var child = ledger.StartImportValidation(identity, callerSid, Start);
        using (child)
        {
            output.DisposeLocalCopyOfClientHandle();
            error.DisposeLocalCopyOfClientHandle();
            var stdout = Task.Run(() => ReadBounded(output));
            var stderr = Task.Run(() => ReadBounded(error));
            var watch = Stopwatch.StartNew();
#if NATIVE_CONTAINMENT_TESTS
            Fault?.Invoke("validation_started");
#endif
            try { ledger.CheckImportValidation(identity, callerSid); }
            catch { CancelValidation(child, stdout, stderr); throw; }
            while (child.ActiveProcesses != 0)
            {
                try { ledger.CheckImportValidation(identity, callerSid); }
                catch { CancelValidation(child, stdout, stderr); throw; }
                if (watch.ElapsedMilliseconds >= 30000 || stdout.IsFaulted || stderr.IsFaulted)
                {
                    child.Cancel();
                    throw new IOException("SERVICE_IMPORT_VALIDATION_LIMIT");
                }
                Thread.Sleep(10);
            }
            ledger.CheckImportValidation(identity, callerSid);
            if (!Task.WaitAll([stdout, stderr], 5000)) throw new IOException("SERVICE_IMPORT_VALIDATION_FAILED");
            if (child.ExitCode != 0)
            {
#if NATIVE_CONTAINMENT_TESTS
                if (useCurrentUserTestLauncher) Console.Error.WriteLine("TEST_IMPORT_VALIDATION_STDERR " + Encoding.UTF8.GetString(stderr.GetAwaiter().GetResult()));
#endif
                throw new IOException("SERVICE_IMPORT_VALIDATION_FAILED");
            }
            return new UTF8Encoding(false, true).GetString(stdout.GetAwaiter().GetResult());
        }
    }

    private static void CancelValidation(ContainedProcess child, Task<byte[]> stdout, Task<byte[]> stderr)
    {
        if (child.ActiveProcesses != 0) child.Cancel();
        var deadline = Stopwatch.StartNew();
        while (child.ActiveProcesses != 0 && deadline.ElapsedMilliseconds < 10000) Thread.Sleep(10);
        if (child.ActiveProcesses != 0 || !Task.WaitAll([stdout, stderr], 5000))
            throw new IOException("SERVICE_IMPORT_VALIDATION_TERMINATION_UNKNOWN");
    }

    private static byte[] ReadBounded(Stream stream)
    {
        using var output = new MemoryStream();
        var buffer = new byte[8192];
        while (true)
        {
            var count = stream.Read(buffer);
            if (count == 0) return output.ToArray();
            if (output.Length + count > 16 * 1024 * 1024) throw new IOException("SERVICE_IMPORT_VALIDATION_LIMIT");
            output.Write(buffer, 0, count);
        }
    }
}
