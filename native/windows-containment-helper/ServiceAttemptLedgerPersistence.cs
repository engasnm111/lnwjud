using System.Text.Json;
using System.Text.Json.Serialization;
using System.Security.AccessControl;
using System.Security.Principal;

namespace Lnwjud.Containment;

internal sealed record PersistedServiceAttempt(
    ServiceAttemptRequest Request,
    ServiceAttemptPhase Phase,
    int? TargetPid,
    ServiceProcessOutcome? Outcome,
    int? ExitCode,
    int? ActiveProcesses,
    string? Reason,
    bool ReservationHeld);

internal sealed record ServiceAttemptLedgerDocument(int SchemaVersion, PersistedServiceAttempt[] Attempts);

/// <summary>
/// Crash-safe snapshot storage. The caller must place this file in a directory whose
/// ACL permits writes only to the service identity and administrators.
/// </summary>
internal sealed class ServiceAttemptLedgerPersistence
{
    private const int SchemaVersion = 1;
    private const int MaximumStoreBytes = 32 * 1024 * 1024;
    private const int MaximumAttempts = 100_000;
    private static readonly JsonSerializerOptions Json = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow,
    };

    private readonly string filename;
    internal string OutputStoreDirectory => Path.Combine(Path.GetDirectoryName(filename)!, "output");

    internal ServiceAttemptLedgerPersistence(string filename)
    {
        if (!Path.IsPathFullyQualified(filename)) throw new IOException("ATTEMPT_STORE_PATH_INVALID");
        this.filename = Path.GetFullPath(filename);
        var parent = Path.GetDirectoryName(this.filename);
        if (parent is null || !Directory.Exists(parent)) throw new IOException("ATTEMPT_STORE_DIRECTORY_UNAVAILABLE");
        EnsureNoReparsePoints(this.filename);
    }

    internal PersistedServiceAttempt[] Load()
    {
        EnsureNoReparsePoints(filename);
        if (!File.Exists(filename)) return [];

        try
        {
            using var stream = new FileStream(filename, FileMode.Open, FileAccess.Read, FileShare.Read);
            if (stream.Length is < 2 or > MaximumStoreBytes) throw new InvalidDataException("ATTEMPT_STORE_SIZE_INVALID");
            using var memory = new MemoryStream((int)stream.Length);
            stream.CopyTo(memory);
            var document = JsonSerializer.Deserialize<ServiceAttemptLedgerDocument>(memory.ToArray(), Json)
                ?? throw new InvalidDataException("ATTEMPT_STORE_EMPTY");
            if (document.SchemaVersion != SchemaVersion || document.Attempts is null || document.Attempts.Length > MaximumAttempts)
                throw new InvalidDataException("ATTEMPT_STORE_SCHEMA_INVALID");
            return document.Attempts;
        }
        catch (Exception exception) when (exception is JsonException or InvalidDataException or IOException or UnauthorizedAccessException or ArgumentException)
        {
            throw new IOException("ATTEMPT_STORE_CORRUPT", exception);
        }
    }

    internal void Save(IReadOnlyCollection<PersistedServiceAttempt> attempts)
    {
        if (attempts.Count > MaximumAttempts) throw new IOException("ATTEMPT_HISTORY_LIMIT");
        EnsureNoReparsePoints(filename);
        var bytes = JsonSerializer.SerializeToUtf8Bytes(new ServiceAttemptLedgerDocument(SchemaVersion, attempts.ToArray()), Json);
        if (bytes.Length > MaximumStoreBytes) throw new IOException("ATTEMPT_STORE_SIZE_LIMIT");
        var temporary = filename + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            using (var stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None, 4096, FileOptions.WriteThrough))
            {
                stream.Write(bytes);
                stream.Flush(true);
            }
            File.Move(temporary, filename, true);
            EnsureNoReparsePoints(filename);
            if (!File.ReadAllBytes(filename).AsSpan().SequenceEqual(bytes)) throw new IOException("ATTEMPT_STORE_READBACK_FAILED");
        }
        finally
        {
            if (File.Exists(temporary)) File.Delete(temporary);
        }
    }

    internal static void EnsureNoReparsePoints(string target)
    {
        var current = Path.GetFullPath(target);
        while (true)
        {
            try
            {
                if ((File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0) throw new IOException("ATTEMPT_STORE_REPARSE_PATH_REFUSED");
            }
            catch (FileNotFoundException) { }
            catch (DirectoryNotFoundException) { }
            var parent = Directory.GetParent(current);
            if (parent is null) return;
            current = parent.FullName;
        }
    }
}

internal sealed record ServiceOutputSnapshot(
    int SchemaVersion,
    ServiceAttemptIdentity Identity,
    string AuthenticatedCallerSid,
    byte[] Stdout,
    byte[] Stderr,
    bool StdoutTruncated,
    bool StderrTruncated,
    bool Complete,
    string? IncompleteReason);

internal sealed record ServiceOutputEnvelope(ServiceOutputSnapshot Snapshot, string Sha256);

internal sealed class ServiceOutputStore
{
    internal const int MaximumStreamBytes = 262_144;
    internal const int MaximumSnapshots = 256;
    internal const long MaximumStoreBytes = 128L * 1024 * 1024;
    private const int MaximumSnapshotBytes = 768 * 1024;
    private static readonly object Gate = new();
    private static readonly JsonSerializerOptions Json = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow,
    };
    private readonly string directory;
    private readonly SecurityIdentifier serviceSid = CurrentServiceSid();

    private static SecurityIdentifier CurrentServiceSid()
    {
        using var identity = WindowsIdentity.GetCurrent();
        return identity.User ?? throw new IOException("SERVICE_OUTPUT_IDENTITY_UNAVAILABLE");
    }

    internal ServiceOutputStore(string directory)
    {
        this.directory = Path.GetFullPath(directory);
        ServiceAttemptLedgerPersistence.EnsureNoReparsePoints(this.directory);
        var security = new DirectorySecurity();
        security.SetAccessRuleProtection(isProtected: true, preserveInheritance: false);
        security.SetOwner(serviceSid);
        foreach (var sid in new[] { serviceSid, new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null), new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null) }.Distinct())
            security.AddAccessRule(new FileSystemAccessRule(sid, FileSystemRights.FullControl,
                InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
        security.CreateDirectory(this.directory);
        ServiceAttemptLedgerPersistence.EnsureNoReparsePoints(this.directory);
        ValidateAcl(new DirectoryInfo(this.directory).GetAccessControl(AccessControlSections.Owner | AccessControlSections.Access));
    }

    private string Filename(ServiceAttemptIdentity identity) => Path.Combine(directory,
        Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(
            System.Text.Encoding.UTF8.GetBytes(identity.AttemptId))).ToLowerInvariant() + ".json");

    internal void Save(ServiceOutputSnapshot snapshot)
    {
        lock (Gate)
        {
            var filename = Filename(snapshot.Identity);
            ServiceAttemptLedgerPersistence.EnsureNoReparsePoints(filename);
            ValidatePaths(filename);
            var digest = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(
                JsonSerializer.SerializeToUtf8Bytes(snapshot, Json)));
            var bytes = JsonSerializer.SerializeToUtf8Bytes(new ServiceOutputEnvelope(snapshot, digest), Json);
            if (bytes.Length > MaximumSnapshotBytes) throw new IOException("SERVICE_OUTPUT_SIZE_LIMIT");
            var temporary = Path.Combine(directory, "snapshot.tmp");
            ServiceAttemptLedgerPersistence.EnsureNoReparsePoints(temporary);
            if (File.Exists(temporary))
                ValidateAcl(new FileInfo(temporary).GetAccessControl(AccessControlSections.Owner | AccessControlSections.Access));
            Prune(filename, bytes.Length);
            try
            {
                using (var stream = new FileStream(temporary, FileMode.Create, FileAccess.Write, FileShare.None, 4096, FileOptions.WriteThrough))
                {
                    stream.Write(bytes);
                    stream.Flush(true);
                }
                File.Move(temporary, filename, true);
                ServiceAttemptLedgerPersistence.EnsureNoReparsePoints(filename);
                if (!File.ReadAllBytes(filename).AsSpan().SequenceEqual(bytes))
                    throw new IOException("SERVICE_OUTPUT_READBACK_FAILED");
            }
            finally
            {
                ServiceAttemptLedgerPersistence.EnsureNoReparsePoints(temporary);
                if (File.Exists(temporary)) File.Delete(temporary);
            }
        }
    }

    internal ServiceOutputSnapshot Load(ServiceAttemptIdentity identity, string callerSid)
    {
        lock (Gate)
        {
            var filename = Filename(identity);
            ServiceAttemptLedgerPersistence.EnsureNoReparsePoints(filename);
            if (!File.Exists(filename)) throw new IOException("SERVICE_OUTPUT_UNAVAILABLE");
            ValidatePaths(filename);
            try
            {
                using var stream = new FileStream(filename, FileMode.Open, FileAccess.Read, FileShare.Read);
                if (stream.Length is < 2 or > MaximumSnapshotBytes) throw new InvalidDataException();
                var envelope = JsonSerializer.Deserialize<ServiceOutputEnvelope>(stream, Json) ?? throw new InvalidDataException();
                var snapshot = envelope.Snapshot ?? throw new InvalidDataException();
                var digest = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(
                    JsonSerializer.SerializeToUtf8Bytes(snapshot, Json)));
                if (!string.Equals(envelope.Sha256, digest, StringComparison.Ordinal)
                    || snapshot.SchemaVersion != 1 || snapshot.Identity != identity
                    || !string.Equals(snapshot.AuthenticatedCallerSid, callerSid, StringComparison.Ordinal)
                    || snapshot.Stdout is null || snapshot.Stderr is null
                    || snapshot.Stdout.Length > MaximumStreamBytes || snapshot.Stderr.Length > MaximumStreamBytes
                    || snapshot.Complete && snapshot.IncompleteReason is not null
                    || !snapshot.Complete && string.IsNullOrWhiteSpace(snapshot.IncompleteReason))
                    throw new InvalidDataException();
                return snapshot;
            }
            catch (Exception exception) when (exception is JsonException or InvalidDataException or IOException or UnauthorizedAccessException or ArgumentException)
            {
                throw new IOException("SERVICE_OUTPUT_CORRUPT", exception);
            }
        }
    }

    private void ValidatePaths(string filename)
    {
        ValidateAcl(new DirectoryInfo(directory).GetAccessControl(AccessControlSections.Owner | AccessControlSections.Access));
        if (File.Exists(filename))
            ValidateAcl(new FileInfo(filename).GetAccessControl(AccessControlSections.Owner | AccessControlSections.Access));
    }

    private void ValidateAcl(FileSystemSecurity security)
    {
        var system = new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null);
        var administrators = new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null);
        bool Trusted(SecurityIdentifier sid) => sid.Equals(serviceSid) || sid.Equals(system) || sid.Equals(administrators);
        if (security.GetOwner(typeof(SecurityIdentifier)) is not SecurityIdentifier owner || !Trusted(owner))
            throw new IOException("SERVICE_OUTPUT_OWNER_REFUSED");
        const FileSystemRights mutation = FileSystemRights.Write | FileSystemRights.Delete
            | FileSystemRights.DeleteSubdirectoriesAndFiles | FileSystemRights.ChangePermissions | FileSystemRights.TakeOwnership
            | (FileSystemRights)0x40000000 | (FileSystemRights)0x10000000;
        foreach (FileSystemAccessRule rule in security.GetAccessRules(true, true, typeof(SecurityIdentifier)))
        {
            if (rule.AccessControlType == AccessControlType.Allow && !Trusted((SecurityIdentifier)rule.IdentityReference)
                && (rule.FileSystemRights & mutation) != 0)
                throw new IOException("SERVICE_OUTPUT_WRITE_ACL_REFUSED");
        }
    }

    private void Prune(string replacing, int incomingBytes)
    {
        ServiceAttemptLedgerPersistence.EnsureNoReparsePoints(directory);
        var files = new DirectoryInfo(directory).GetFiles("*.json").OrderBy(file => file.LastWriteTimeUtc).ToList();
        foreach (var file in files) ServiceAttemptLedgerPersistence.EnsureNoReparsePoints(file.FullName);
        files.RemoveAll(file => string.Equals(file.FullName, replacing, StringComparison.OrdinalIgnoreCase));
        var bytes = files.Sum(file => file.Length);
        var count = files.Count;
        foreach (var file in files)
        {
            if (count < MaximumSnapshots && bytes + incomingBytes <= MaximumStoreBytes) break;
            File.Delete(file.FullName);
            bytes -= file.Length;
            count--;
        }
    }
}
