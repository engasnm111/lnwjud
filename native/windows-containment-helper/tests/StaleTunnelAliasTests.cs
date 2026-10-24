using System.Diagnostics;
using System.Security.Cryptography;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Win32.SafeHandles;

namespace Lnwjud.Containment;

internal static class StaleTunnelAliasTests
{
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern SafeProcessHandle OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "CreateHardLinkW")]
    private static extern bool CreateHardLink(string path, string existing, nint security);

    internal static void Run()
    {
        using var fixture = new Fixture();
        var live = fixture.Write(Process.GetCurrentProcess().StartTime.ToUniversalTime().ToFileTimeUtc());
        Refused(live, "TUNNEL_STALE_PROCESS_LIVE");
        var liveMap = JsonNode.Parse(File.ReadAllBytes(fixture.Processes))!;
        liveMap["lnwjud"]!["pid_executable"] = "  " + Environment.ProcessPath!.ToUpperInvariant() + "  ";
        File.WriteAllBytes(fixture.Processes, JsonSerializer.SerializeToUtf8Bytes(liveMap));
        Refused(live with { ExpectedProcessesSha256 = Fixture.Hash(fixture.Processes) }, "TUNNEL_STALE_PROCESS_LIVE");
        var stale = fixture.Write(116444736000000001L);
        var oldProcesses = File.ReadAllBytes(fixture.Processes);
        File.AppendAllText(fixture.Processes, " ");
        Refused(stale, "TUNNEL_STALE_SNAPSHOT_CHANGED");
        File.WriteAllBytes(fixture.Processes, oldProcesses);
        StaleTunnelAlias.ClearAsync(stale).GetAwaiter().GetResult();
        foreach (var path in new[] { fixture.Aliases, fixture.Processes })
        {
            var map = JsonNode.Parse(File.ReadAllBytes(path))!.AsObject();
            if (map.ContainsKey("lnwjud")) throw new Exception("Stale alias retirement retained its own map entry");
            if (map["unrelated"]?.ToJsonString() != fixture.Sibling.ToJsonString())
                throw new Exception("Stale alias retirement changed unrelated metadata");
        }
        if (Process.GetCurrentProcess().HasExited) throw new Exception("Metadata retirement signalled a process");
        foreach (var point in new[] { "journal", "aliases", "processes" })
        {
            using var interrupted = new Fixture();
            var request = interrupted.Write(116444736000000001L);
            StaleTunnelAlias.TestFault = actual => { if (actual == point) throw new IOException("TEST_CRASH"); };
            try { Refused(request, "TEST_CRASH"); }
            finally { StaleTunnelAlias.TestFault = null; }
            var recovery = new StaleTunnelAlias.Request(interrupted.Root, "lnwjud", interrupted.Root, RecoveryOnly: true);
            var result = StaleTunnelAlias.ClearAsync(recovery).GetAwaiter().GetResult();
            if (!result.Recovered || File.Exists(Path.Combine(interrupted.Root, StaleTunnelAlias.JournalName)))
                throw new Exception("Native pair recovery did not finish its journal");
            if (JsonNode.Parse(File.ReadAllBytes(interrupted.Aliases))!["lnwjud"] is not null
                || JsonNode.Parse(File.ReadAllBytes(interrupted.Processes))!["lnwjud"] is not null)
                throw new Exception("Native pair recovery left one old map entry");
        }
        using (var changed = new Fixture())
        {
            var request = changed.Write(116444736000000001L);
            StaleTunnelAlias.TestFault = actual => { if (actual == "aliases") throw new IOException("TEST_CRASH"); };
            try { Refused(request, "TEST_CRASH"); }
            finally { StaleTunnelAlias.TestFault = null; }
            File.AppendAllText(changed.Processes, " ");
            var before = File.ReadAllBytes(changed.Processes);
            Refused(new StaleTunnelAlias.Request(changed.Root, "lnwjud", changed.Root, RecoveryOnly: true), "TUNNEL_STALE_SNAPSHOT_CHANGED");
            if (!before.AsSpan().SequenceEqual(File.ReadAllBytes(changed.Processes)))
                throw new Exception("Recovery replaced independently changed metadata");
        }
        using (var locked = new Fixture())
        {
            var request = locked.Write(116444736000000001L);
            using var owner = new FileStream(Path.Combine(locked.Root, "locks", "state.lock"), FileMode.Open, FileAccess.ReadWrite, FileShare.ReadWrite);
            owner.Lock(0, 1);
            var pending = StaleTunnelAlias.ClearAsync(request);
            if (pending.IsCompleted) throw new Exception("Native cleanup ignored the existing upstream state lock");
            File.AppendAllText(locked.Processes, " ");
            owner.Unlock(0, 1);
            try { pending.GetAwaiter().GetResult(); throw new Exception("Native cleanup missed a locked snapshot change"); }
            catch (IOException error) when (error.Message == "TUNNEL_STALE_SNAPSHOT_CHANGED") { }
        }
        using (var invalid = new Fixture())
        {
            var request = invalid.Write(116444736000000001L);
            var map = JsonNode.Parse(File.ReadAllBytes(invalid.Processes))!;
            map["lnwjud"]!.AsObject().Remove("pid_executable");
            File.WriteAllBytes(invalid.Processes, JsonSerializer.SerializeToUtf8Bytes(map));
            Refused(request with { ExpectedProcessesSha256 = Fixture.Hash(invalid.Processes) }, "TUNNEL_STALE_PROCESS_IDENTITY_INCOMPLETE");
            map["lnwjud"]!["pid_executable"] = Environment.ProcessPath;
            map["lnwjud"]!["tunnel_id"] = "foreign";
            File.WriteAllBytes(invalid.Processes, JsonSerializer.SerializeToUtf8Bytes(map));
            Refused(request with { ExpectedProcessesSha256 = Fixture.Hash(invalid.Processes) }, "TUNNEL_STALE_IDENTITY_CHANGED");
        }
        using (var gone = new Fixture())
        {
            var request = gone.Write(116444736000000001L);
            var launch = new ProcessStartInfo(Environment.ProcessPath!) { UseShellExecute = false, CreateNoWindow = true };
            launch.ArgumentList.Add("noop");
            using var child = Process.Start(launch) ?? throw new Exception("Isolated process did not start");
            child.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(5)).GetAwaiter().GetResult();
            var map = JsonNode.Parse(File.ReadAllBytes(gone.Processes))!;
            map["lnwjud"]!["pid"] = child.Id;
            File.WriteAllBytes(gone.Processes, JsonSerializer.SerializeToUtf8Bytes(map));
            StaleTunnelAlias.ClearAsync(request with { ExpectedPid = child.Id, ExpectedProcessesSha256 = Fixture.Hash(gone.Processes) }).GetAwaiter().GetResult();
        }
        using (var inaccessible = OpenProcess(0x00101000, false, 4))
        {
            if (inaccessible.IsInvalid && Marshal.GetLastWin32Error() == 5)
            {
                using var denied = new Fixture();
                var request = denied.Write(116444736000000001L);
                var map = JsonNode.Parse(File.ReadAllBytes(denied.Processes))!;
                map["lnwjud"]!["pid"] = 4;
                File.WriteAllBytes(denied.Processes, JsonSerializer.SerializeToUtf8Bytes(map));
                Refused(request with { ExpectedPid = 4, ExpectedProcessesSha256 = Fixture.Hash(denied.Processes) }, "TUNNEL_STALE_PROCESS_UNVERIFIED");
                Console.WriteLine("STALE_TUNNEL_INACCESSIBLE_PROCESS_REFUSED");
            }
            else Console.WriteLine("SKIP inaccessible PID proof because this token can query System");
        }
        using (var maximum = new Fixture())
        {
            var request = maximum.Write(116444736000000001L, "tunnel_" + new string('a', 128));
            StaleTunnelAlias.ClearAsync(request).GetAwaiter().GetResult();
            Refused(maximum.Write(116444736000000001L, "tunnel_" + new string('a', 129)), "TUNNEL_STALE_REQUEST_INVALID");
        }
        using (var unsafeLock = new Fixture())
        {
            var request = unsafeLock.Write(116444736000000001L);
            var sentinel = Path.Combine(unsafeLock.Root, "sentinel");
            File.WriteAllText(sentinel, "must remain unchanged");
            var lockPath = Path.Combine(unsafeLock.Root, "locks", "state.lock");
            File.Delete(lockPath);
            if (!CreateHardLink(lockPath, sentinel, 0)) throw new Exception("Isolated hardlink fixture failed");
            Refused(request, "TUNNEL_STALE_FILE_UNSAFE");
            if (File.ReadAllText(sentinel) != "must remain unchanged") throw new Exception("Unsafe lock modified its linked target");
        }
        foreach (var invalidRequest in new[] { new string(' ', 32769), "{\"alias\":\"lnwjud\",\"alias\":\"other\"}" })
        {
            using var input = new MemoryStream(System.Text.Encoding.UTF8.GetBytes(invalidRequest));
            using var output = new MemoryStream();
            if (StaleTunnelAlias.RunAsync(input, output).GetAwaiter().GetResult() != 125
                || JsonNode.Parse(output.ToArray())!["ok"]!.GetValue<bool>())
                throw new Exception("Native stale helper accepted an invalid protocol request");
        }
        using (var protocol = new Fixture())
        {
            File.Delete(Path.Combine(protocol.Root, "locks", "state.lock"));
            Directory.Delete(Path.Combine(protocol.Root, "locks"));
            var request = protocol.Write(116444736000000001L);
            var payload = JsonSerializer.SerializeToUtf8Bytes(request, new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase });
            using var input = new MemoryStream(payload);
            using var output = new MemoryStream();
            if (StaleTunnelAlias.RunAsync(input, output).GetAwaiter().GetResult() != 0)
                throw new Exception("Native valid protocol failed " + System.Text.Encoding.UTF8.GetString(output.ToArray()));
        }
        if (Environment.GetEnvironmentVariable("LNWJUD_STALE_TEST_HELPER") is { } published)
        {
            using var protocol = new Fixture();
            var request = protocol.Write(116444736000000001L);
            var payload = JsonSerializer.SerializeToNode(request, new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase })!.AsObject();
            payload.Remove("recoveryOnly");
            var start = new ProcessStartInfo(published) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true };
            var allowed = new HashSet<string>(new[] { "SystemRoot", "WINDIR", "TEMP", "TMP", "LOCALAPPDATA", "USERPROFILE" }, StringComparer.OrdinalIgnoreCase);
            foreach (var key in start.Environment.Keys.ToArray()) if (!allowed.Contains(key)) start.Environment.Remove(key);
            start.ArgumentList.Add("clear-stale-tunnel-alias");
            using var command = Process.Start(start) ?? throw new Exception("Published helper did not start");
            command.StandardInput.Write(payload.ToJsonString());
            command.StandardInput.Close();
            var output = command.StandardOutput.ReadToEnd();
            command.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(10)).GetAwaiter().GetResult();
            if (command.ExitCode != 0) throw new Exception("Published helper protocol failed " + output);
        }
        var cli = Environment.GetEnvironmentVariable("LNWJUD_TUNNEL_CLIENT_TEST_PATH");
        if (!String.IsNullOrEmpty(cli)) TestCliLock(cli);
        Console.WriteLine("STALE_TUNNEL_ALIAS_RETIRED_NO_SIGNALS");
    }

    private static void TestCliLock(string cli)
    {
        foreach (var lockedByte in new[] { 1L, 0L })
        {
            using var fixture = new Fixture();
            fixture.Write(116444736000000001L);
            var map = JsonNode.Parse(File.ReadAllBytes(fixture.Processes))!;
            map["lnwjud"]!["mode"] = "stopped";
            map["lnwjud"]!["pid"] = 0;
            map["lnwjud"]!["profile_dir"] = Path.Combine(fixture.Root, "profile");
            File.WriteAllBytes(fixture.Processes, JsonSerializer.SerializeToUtf8Bytes(map));
            var aliases = JsonNode.Parse(File.ReadAllBytes(fixture.Aliases))!;
            aliases["lnwjud"]!["profile_dir"] = Path.Combine(fixture.Root, "profile");
            File.WriteAllBytes(fixture.Aliases, JsonSerializer.SerializeToUtf8Bytes(aliases));
            var before = File.ReadAllBytes(fixture.Aliases);
            using var owner = new FileStream(Path.Combine(fixture.Root, "locks", "state.lock"), FileMode.Open, FileAccess.ReadWrite, FileShare.ReadWrite);
            owner.Lock(lockedByte, 1);
            var start = new ProcessStartInfo(cli) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true };
            foreach (var argument in new[] { "runtimes", "rm", "lnwjud", "--json" }) start.ArgumentList.Add(argument);
            start.Environment.Clear();
            foreach (var name in new[] { "SystemRoot", "WINDIR", "PATH", "TEMP", "TMP" })
                if (Environment.GetEnvironmentVariable(name) is { } value) start.Environment[name] = value;
            foreach (var name in new[] { "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "CODEX_HOME" }) start.Environment[name] = fixture.Root;
            start.Environment["TUNNEL_CLIENT_STATE_DIR"] = fixture.Root;
            start.Environment["TUNNEL_CLIENT_PROFILE_DIR"] = Path.Combine(fixture.Root, "profile");
            start.Environment["CONTROL_PLANE_BASE_URL"] = "http://127.0.0.1:9";
            using var command = Process.Start(start) ?? throw new Exception("Test CLI did not start");
            var output = command.StandardOutput.ReadToEndAsync();
            var error = command.StandardError.ReadToEndAsync();
            if (lockedByte == 0)
            {
                if (command.WaitForExit(1000) || !before.AsSpan().SequenceEqual(File.ReadAllBytes(fixture.Aliases)))
                    throw new Exception("Pinned Go CLI ignored native byte-zero state lock");
                owner.Unlock(lockedByte, 1);
            }
            command.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(8)).GetAwaiter().GetResult();
            if (lockedByte != 0) owner.Unlock(lockedByte, 1);
            if (command.ExitCode != 0) throw new Exception("Isolated CLI removal failed " + error.GetAwaiter().GetResult());
            if (JsonNode.Parse(File.ReadAllBytes(fixture.Aliases))!["lnwjud"] is not null)
                throw new Exception("Pinned CLI did not retire isolated alias after lock release");
            _ = output.GetAwaiter().GetResult();
        }
        Console.WriteLine("STALE_TUNNEL_LOCK_INTEROPERATES_WITH_PINNED_GO_CLI");
    }

    private static void Refused(StaleTunnelAlias.Request request, string expected)
    {
        var aliases = Path.Combine(request.StateRoot, "aliases.yaml");
        var processes = Path.Combine(request.StateRoot, "processes.yaml");
        var beforeAliases = File.ReadAllBytes(aliases);
        var beforeProcesses = File.ReadAllBytes(processes);
        try { _ = StaleTunnelAlias.ClearAsync(request).GetAwaiter().GetResult(); }
        catch (IOException error) when (error.Message == expected)
        {
            if (expected != "TEST_CRASH" && (!beforeAliases.AsSpan().SequenceEqual(File.ReadAllBytes(aliases))
                || !beforeProcesses.AsSpan().SequenceEqual(File.ReadAllBytes(processes))))
                throw new Exception("Refused native cleanup changed metadata");
            return;
        }
        throw new Exception("Stale alias cleanup did not refuse " + expected);
    }

    private sealed class Fixture : IDisposable
    {
        internal readonly string Root = Path.Combine(Path.GetTempPath(), "lnwjud-stale-test-" + Guid.NewGuid().ToString("N"));
        internal string Aliases => Path.Combine(Root, "aliases.yaml");
        internal string Processes => Path.Combine(Root, "processes.yaml");
        internal readonly JsonObject Sibling = new() { ["unknown"] = new JsonArray(1, "preserve", true), ["pid"] = 12345 };
        internal Fixture()
        {
            Directory.CreateDirectory(Path.Combine(Root, "locks"));
            File.WriteAllBytes(Path.Combine(Root, "locks", "state.lock"), []);
        }
        internal StaleTunnelAlias.Request Write(long creation, string tunnelId = "test-tunnel")
        {
            var record = new JsonObject
            {
                ["alias"] = "lnwjud", ["tunnel_id"] = tunnelId, ["profile_dir"] = Root,
                ["mode"] = "process", ["pid"] = Environment.ProcessId,
                ["pid_start_time"] = checked((creation - 116444736000000000L) * 100).ToString(System.Globalization.CultureInfo.InvariantCulture),
                ["pid_executable"] = Environment.ProcessPath,
                ["unknown"] = new JsonObject { ["preserve"] = true },
            };
            foreach (var path in new[] { Aliases, Processes })
            {
                var map = new JsonObject { ["lnwjud"] = record.DeepClone(), ["unrelated"] = Sibling.DeepClone() };
                File.WriteAllBytes(path, JsonSerializer.SerializeToUtf8Bytes(map));
            }
            return new StaleTunnelAlias.Request(Root, "lnwjud", Root, ExpectedTunnelId: tunnelId, ExpectedPid: Environment.ProcessId,
                ExpectedAliasesSha256: Hash(Aliases), ExpectedProcessesSha256: Hash(Processes));
        }
        internal static string Hash(string path) => Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(path))).ToLowerInvariant();
        public void Dispose() { Directory.Delete(Root, recursive: true); }
    }
}
