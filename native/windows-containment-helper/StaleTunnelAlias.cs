using System.Globalization;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using Microsoft.Win32.SafeHandles;

namespace Lnwjud.Containment;

internal static class StaleTunnelAlias
{
    private const int MaximumStateBytes = 4 * 1024 * 1024;
    internal const string JournalName = ".lnwjud-stale-alias.json";
    private static readonly JsonSerializerOptions Json = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow,
    };
    internal sealed record Request(string StateRoot, string Alias, string ProfileDirectory, bool RecoveryOnly = false,
        string? ExpectedTunnelId = null, int ExpectedPid = 0, string? ExpectedAliasesSha256 = null, string? ExpectedProcessesSha256 = null);
    internal sealed record Result(bool Recovered, string? AliasesSha256, string? ProcessesSha256);
    private sealed record Journal(int Protocol, Request Binding, byte[] Aliases, byte[] Processes);
#if NATIVE_CONTAINMENT_TESTS
    internal static Action<string>? TestFault { get; set; }
#endif

    [StructLayout(LayoutKind.Sequential)]
    private struct FileInfo
    {
        internal uint Attributes;
        internal System.Runtime.InteropServices.ComTypes.FILETIME Creation, Access, Write;
        internal uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct SecurityAttributes { internal int Length; internal nint Descriptor; internal int Inherit; }
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "ConvertStringSecurityDescriptorToSecurityDescriptorW")]
    private static extern bool ConvertDescriptor(string text, uint revision, out nint descriptor, out uint size);
    [DllImport("kernel32.dll")]
    private static extern nint LocalFree(nint memory);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "CreateFileW")]
    private static extern SafeFileHandle CreatePrivate(string path, uint access, uint share, ref SecurityAttributes security, uint disposition, uint flags, nint template);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "CreateFileW")]
    private static extern SafeFileHandle OpenFile(string path, uint access, uint share, nint security, uint disposition, uint flags, nint template);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetFileInformationByHandle(SafeFileHandle file, out FileInfo info);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern SafeProcessHandle OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetProcessTimes(SafeProcessHandle process, out long creation, out long exit, out long kernel, out long user);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool QueryFullProcessImageName(SafeProcessHandle process, uint flags, StringBuilder path, ref uint length);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(SafeProcessHandle process, uint milliseconds);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "MoveFileExW")]
    private static extern bool ReplaceFile(string source, string destination, uint flags);

    internal static async Task<int> RunAsync(Stream input, Stream output)
    {
        object response;
        var exit = 125;
        try
        {
            using var bounded = new MemoryStream();
            var buffer = new byte[4096];
            int read;
            while ((read = await input.ReadAsync(buffer).ConfigureAwait(false)) != 0)
            {
                if (bounded.Length + read > 32 * 1024) throw Refuse("REQUEST_INVALID");
                bounded.Write(buffer, 0, read);
            }
            var bytes = bounded.ToArray();
            ValidateJson(bytes);
            var request = JsonSerializer.Deserialize<Request>(bytes, Json) ?? throw Refuse("REQUEST_INVALID");
            var result = await ClearAsync(request).ConfigureAwait(false);
            response = new { ok = true, recovered = result.Recovered, aliasesSha256 = result.AliasesSha256, processesSha256 = result.ProcessesSha256 };
            exit = 0;
        }
        catch (Exception exception)
        {
            var error = exception is IOException && exception.Message.StartsWith("TUNNEL_STALE_", StringComparison.Ordinal)
                ? exception.Message : "TUNNEL_STALE_REFUSED";
            response = new { ok = false, error };
        }
        await output.WriteAsync(JsonSerializer.SerializeToUtf8Bytes(response, Json)).ConfigureAwait(false);
        await output.FlushAsync().ConfigureAwait(false);
        return exit;
    }

    internal static async Task<Result> ClearAsync(Request request)
    {
        if (!OperatingSystem.IsWindows() || request.Alias != "lnwjud"
            || !Path.IsPathFullyQualified(request.StateRoot) || !Path.IsPathFullyQualified(request.ProfileDirectory))
            throw Refuse("REQUEST_INVALID");
        var root = Path.GetFullPath(request.StateRoot);
        var profile = Path.GetFullPath(request.ProfileDirectory);
        using var rootPin = PinnedDirectory.Open(root);
        Directory.CreateDirectory(Path.Combine(root, "locks"));
        using var locksPin = PinnedDirectory.Open(Path.Combine(root, "locks"));
        using var stateLock = OpenRegular(Path.Combine(root, "locks", "state.lock"), write: true, share: 3, create: true);
        var deadline = Environment.TickCount64 + 5000;
        while (true)
        {
            try { stateLock.Lock(0, 1); break; }
            catch (IOException exception) when ((exception.HResult & 0xffff) == 33 && Environment.TickCount64 < deadline)
            { await Task.Delay(25).ConfigureAwait(false); }
            catch (IOException) { throw Refuse("LOCK_UNAVAILABLE"); }
        }
        try
        {
            var aliasesPath = Path.Combine(root, "aliases.yaml");
            var processesPath = Path.Combine(root, "processes.yaml");
            var journalPath = Path.Combine(root, JournalName);
            var recovering = File.Exists(journalPath);
            if (request.RecoveryOnly && !recovering) return new Result(false, null, null);
            if (request.RecoveryOnly && (request.ExpectedTunnelId is not null || request.ExpectedPid != 0
                || request.ExpectedAliasesSha256 is not null || request.ExpectedProcessesSha256 is not null))
                throw Refuse("REQUEST_INVALID");
            Journal journal;
            if (recovering)
            {
                var journalBytes = ReadState(journalPath, 16 * 1024 * 1024, requirePrivate: true);
                ValidateJson(journalBytes);
                journal = JsonSerializer.Deserialize<Journal>(journalBytes, Json) ?? throw Refuse("JOURNAL_INVALID");
                if (journal.Protocol != 1 || journal.Binding.RecoveryOnly
                    || !SamePath(journal.Binding.StateRoot, root) || !SamePath(journal.Binding.ProfileDirectory, profile)
                    || journal.Binding.Alias != request.Alias || (!request.RecoveryOnly && journal.Binding != request))
                    throw Refuse("JOURNAL_BINDING_CHANGED");
            }
            else journal = new Journal(1, request, ReadState(aliasesPath), ReadState(processesPath));
            var binding = journal.Binding;
            if (binding.ExpectedPid <= 0 || String.IsNullOrWhiteSpace(binding.ExpectedTunnelId) || binding.ExpectedTunnelId.Length > 135
                || !ValidHash(binding.ExpectedAliasesSha256) || !ValidHash(binding.ExpectedProcessesSha256)
                || journal.Aliases.Length > MaximumStateBytes || journal.Processes.Length > MaximumStateBytes)
                throw Refuse("REQUEST_INVALID");
            var aliasesBytes = journal.Aliases;
            var processesBytes = journal.Processes;
            if (Hash(aliasesBytes) != binding.ExpectedAliasesSha256 || Hash(processesBytes) != binding.ExpectedProcessesSha256)
                throw Refuse("SNAPSHOT_CHANGED");
            var aliases = ParseMap(aliasesBytes);
            var processes = ParseMap(processesBytes);
            if (aliases[request.Alias] is not JsonObject alias || processes[request.Alias] is not JsonObject process
                || Text(alias, "tunnel_id") != binding.ExpectedTunnelId || Text(process, "tunnel_id") != binding.ExpectedTunnelId
                || Text(process, "alias") != request.Alias || Text(process, "mode") != "process"
                || process["pid"]?.GetValue<int>() != binding.ExpectedPid
                || !SamePath(Text(process, "profile_dir"), profile) || !SamePath(Text(alias, "profile_dir"), profile))
                throw Refuse("IDENTITY_CHANGED");
            var started = Text(process, "pid_start_time");
            var executable = Text(process, "pid_executable");
            if (!long.TryParse(started, NumberStyles.None, CultureInfo.InvariantCulture, out var start) || start <= 0
                || !Path.IsPathFullyQualified(executable.Trim())) throw Refuse("PROCESS_IDENTITY_INCOMPLETE");
            aliases.Remove(request.Alias);
            processes.Remove(request.Alias);
            var newAliases = JsonSerializer.SerializeToUtf8Bytes(aliases);
            var newProcesses = JsonSerializer.SerializeToUtf8Bytes(processes);
            var currentAliases = ReadState(aliasesPath);
            var currentProcesses = ReadState(processesPath);
            RequireOldOrNew(currentAliases, aliasesBytes, newAliases);
            RequireOldOrNew(currentProcesses, processesBytes, newProcesses);
            using var processPin = ProveStale(binding.ExpectedPid, started, executable);
            if (!recovering)
                Publish(root, journalPath, JsonSerializer.SerializeToUtf8Bytes(journal, Json), replace: false);
            Fault("journal");
            if (!currentAliases.AsSpan().SequenceEqual(newAliases)) Publish(root, aliasesPath, newAliases);
            Fault("aliases");
            if (!currentProcesses.AsSpan().SequenceEqual(newProcesses)) Publish(root, processesPath, newProcesses);
            Fault("processes");
            if (!ReadState(aliasesPath).AsSpan().SequenceEqual(newAliases)
                || !ReadState(processesPath).AsSpan().SequenceEqual(newProcesses)) throw Refuse("READBACK_CHANGED");
            File.Delete(journalPath);
            return new Result(recovering, Hash(newAliases), Hash(newProcesses));
        }
        finally { stateLock.Unlock(0, 1); }
    }

    private static void RequireOldOrNew(byte[] actual, byte[] oldBytes, byte[] newBytes)
    {
        if (!actual.AsSpan().SequenceEqual(oldBytes) && !actual.AsSpan().SequenceEqual(newBytes))
            throw Refuse("SNAPSHOT_CHANGED");
    }
    private static void Fault(string point)
    {
#if NATIVE_CONTAINMENT_TESTS
        TestFault?.Invoke(point);
#endif
    }
    private static void Publish(string root, string path, byte[] bytes, bool replace = true)
    {
        var temporary = Path.Combine(root, ".lnwjud-stale-" + Guid.NewGuid().ToString("N") + ".tmp");
        try
        {
            using (var file = NewPrivate(temporary)) { file.Write(bytes); file.Flush(flushToDisk: true); }
            using (var check = OpenRegular(temporary, write: false, share: 1)) { }
            if (!ReplaceFile(temporary, path, replace ? 0x9u : 0x8u)) throw Refuse("PUBLICATION_FAILED");
        }
        finally { if (File.Exists(temporary)) File.Delete(temporary); }
    }
    private static FileStream NewPrivate(string path)
    {
        var sid = System.Security.Principal.WindowsIdentity.GetCurrent().User?.Value ?? throw Refuse("OWNER_UNAVAILABLE");
        if (!ConvertDescriptor($"O:{sid}D:P(A;;FA;;;{sid})(A;;FA;;;SY)", 1, out var descriptor, out _))
            throw Refuse("DACL_UNAVAILABLE");
        try
        {
            var attributes = new SecurityAttributes { Length = Marshal.SizeOf<SecurityAttributes>(), Descriptor = descriptor };
            var handle = CreatePrivate(path, 0xC0000000, 0, ref attributes, 1, 0x00200000, 0);
            if (handle.IsInvalid) { handle.Dispose(); throw Refuse("CREATE_FAILED"); }
            try { return new FileStream(handle, FileAccess.ReadWrite); }
            catch { handle.Dispose(); throw; }
        }
        finally { _ = LocalFree(descriptor); }
    }

    private static SafeProcessHandle ProveStale(int pid, string expectedStart, string expectedExecutable)
    {
        var process = OpenProcess(0x00101000, false, (uint)pid);
        if (process.IsInvalid)
        {
            var error = Marshal.GetLastWin32Error();
            process.Dispose();
            if (error == 87) return new SafeProcessHandle(nint.Zero, ownsHandle: false);
            throw Refuse("PROCESS_UNVERIFIED");
        }
        try
        {
            var waited = WaitForSingleObject(process, 0);
            if (waited == 0) return process;
            if (waited != 258 || !GetProcessTimes(process, out var creation, out _, out _, out _))
                throw Refuse("PROCESS_UNVERIFIED");
            var path = new StringBuilder(32768);
            var length = (uint)path.Capacity;
            if (!QueryFullProcessImageName(process, 0, path, ref length)) throw Refuse("PROCESS_UNVERIFIED");
            var started = checked((creation - 116444736000000000L) * 100).ToString(CultureInfo.InvariantCulture);
            if (started == expectedStart && SamePath(path.ToString(), expectedExecutable)) throw Refuse("PROCESS_LIVE");
            return process;
        }
        catch { process.Dispose(); throw; }
    }

    private static FileStream OpenRegular(string path, bool write, uint share, bool create = false)
    {
        var handle = OpenFile(path, write ? 0xC0000000 : 0x80000000, share, 0, create ? 4u : 3u, 0x00200000, 0);
        if (handle.IsInvalid) { handle.Dispose(); throw Refuse("FILE_UNAVAILABLE"); }
        try
        {
            if (!GetFileInformationByHandle(handle, out var info) || (info.Attributes & 0x410) != 0 || info.Links != 1)
                throw Refuse("FILE_UNSAFE");
            return new FileStream(handle, write ? FileAccess.ReadWrite : FileAccess.Read);
        }
        catch { handle.Dispose(); throw; }
    }

    private static byte[] ReadState(string path, int maximum = MaximumStateBytes, bool requirePrivate = false)
    {
        using var file = OpenRegular(path, write: false, share: 1);
        if (requirePrivate)
        {
            var security = new System.IO.FileInfo(path).GetAccessControl();
            var sid = WindowsIdentity.GetCurrent().User?.Value ?? throw Refuse("OWNER_UNAVAILABLE");
            if (!security.AreAccessRulesProtected || security.GetOwner(typeof(SecurityIdentifier))?.Value != sid)
                throw Refuse("JOURNAL_DACL_INVALID");
            foreach (FileSystemAccessRule rule in security.GetAccessRules(true, true, typeof(SecurityIdentifier)))
                if (rule.IsInherited || rule.AccessControlType != AccessControlType.Allow
                    || (rule.IdentityReference.Value != sid && rule.IdentityReference.Value != "S-1-5-18"))
                    throw Refuse("JOURNAL_DACL_INVALID");
        }
        if (file.Length < 2 || file.Length > maximum) throw Refuse("STATE_TOO_LARGE");
        var bytes = new byte[(int)file.Length];
        file.ReadExactly(bytes);
        return bytes;
    }
    private static JsonObject ParseMap(byte[] bytes)
    {
        ValidateJson(bytes);
        return JsonNode.Parse(bytes)?.AsObject() ?? throw Refuse("STATE_INVALID");
    }
    private static void ValidateJson(byte[] bytes)
    {
        using var document = JsonDocument.Parse(bytes, new JsonDocumentOptions { MaxDepth = 32 });
        Check(document.RootElement);
        static void Check(JsonElement value)
        {
            if (value.ValueKind == JsonValueKind.Object)
            {
                var names = new HashSet<string>(StringComparer.Ordinal);
                foreach (var property in value.EnumerateObject())
                {
                    if (!names.Add(property.Name)) throw Refuse("STATE_INVALID");
                    Check(property.Value);
                }
            }
            else if (value.ValueKind == JsonValueKind.Array)
                foreach (var item in value.EnumerateArray()) Check(item);
        }
    }
    private static string Text(JsonObject value, string name) => value[name]?.GetValue<string>() ?? "";
    private static bool SamePath(string first, string second) => !String.IsNullOrWhiteSpace(first)
        && String.Equals(Path.TrimEndingDirectorySeparator(Path.GetFullPath(first.Trim())),
            Path.TrimEndingDirectorySeparator(Path.GetFullPath(second.Trim())), StringComparison.OrdinalIgnoreCase);
    private static string Hash(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
    private static bool ValidHash(string? value) => value is { Length: 64 } && value.All(character => character is >= '0' and <= '9' or >= 'a' and <= 'f');
    private static IOException Refuse(string code) => new("TUNNEL_STALE_" + code);
}
