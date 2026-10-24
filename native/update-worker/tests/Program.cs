using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Text.Json.Nodes;
using System.Security.AccessControl;
using System.Security.Principal;
using Lnwjud.UpdateWorker;

[SupportedOSPlatform("windows")]
internal static class Program
{
    private const string Installation = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private static int assertions;
    private static string worker = "";

    private static async Task<int> Main(string[] args)
    {
        if (args.Length == 2 && args[0] == "metadata-tests")
        {
            _ = ReleaseMetadataTests.Run();
            _ = ReleaseMetadataTests.RunInterop(args[1]);
            return 0;
        }
        if (args.Length > 0 && args[0] == "crash-child")
        {
            using var core = new UpdateWorkerCore(args[1], Installation, boundary =>
            {
                if (boundary != args[2]) return;
                Console.WriteLine("BOUNDARY"); Console.Out.Flush(); Console.ReadLine();
                Environment.Exit(91);
            });
            _ = core.Execute(new Command("crash", "request", "release-1", 1));
            return 92;
        }
        if (args.Length is < 1 or > 2) throw new Exception("UPDATE_WORKER_TEST_ARGUMENTS_INVALID");
        worker = args[0];
        var metadataFixture = Path.GetFullPath(args.Length == 2 ? args[1] : Path.Combine("tests", "fixtures", "update-release", "metadata-v1.json"));
        DefaultOwnerProbe();
        assertions += StoreCreationTests.Run();
        assertions += ReleaseMetadataTests.Run();
        assertions += ReleaseMetadataTests.RunInterop(metadataFixture);
        await OwnershipAndProtocol();
        foreach (var boundary in new[] { "stage-flushed", "publication-readback", "preauth-committed" }) await CrashRecovery(boundary);
        await TerminalStageRecovery();
        await JournalHolds();
        await Anchoring();
        await NullDaclRefusal();
        Console.WriteLine($"UPDATE_WORKER_NATIVE_ASSERTIONS_PASSED={assertions}");
        return 0;
    }

    private static string Root() => Path.Combine(Path.GetTempPath(), "lnwjud-update-worker-tests-" + Guid.NewGuid().ToString("N"), "state");
    private static void Check(bool condition, string message) { assertions++; if (!condition) throw new Exception(message); }
    private static string Kind(JsonObject value) => value["result"]!["kind"]!.GetValue<string>();
    private static string Reason(JsonObject value) => value["result"]!["reason"]!.GetValue<string>();
    private static string Describe(JsonObject value)
    {
        static string Symbol(JsonNode? node)
        {
            if (node is not JsonValue item || !item.TryGetValue<string>(out var text) || text.Length > 128
                || !text.All(c => char.IsAsciiLetterOrDigit(c) || c is '_' or '-' or '.')) return "UNKNOWN";
            return text;
        }
        return "kind=" + Symbol(value["result"]?["kind"]) + " reason=" + Symbol(value["result"]?["reason"])
            + " generation=" + Symbol(value["generation"]) + " revision=" + Symbol(value["revision"]);
    }
    private static void DefaultOwnerProbe()
    {
        using var identity = WindowsIdentity.GetCurrent();
        var root = Root();
        var startup = "READY";
        try { using var io = new WindowsStoreIO(root); }
        catch (Refusal error) { startup = error.Reason; }
        catch (Exception) { startup = "STORE_UNEXPECTED_FAILURE"; }
        var probe = Path.Combine(root, "default-owner-probe.txt");
        var rootExists = Directory.Exists(root);
        try { if (rootExists) File.WriteAllText(probe, "isolated-default-owner-probe"); }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
        static IdentityReference? ReadOwner(string filename)
        {
            try { return File.Exists(filename) ? new FileInfo(filename).GetAccessControl(AccessControlSections.Owner).GetOwner(typeof(SecurityIdentifier)) : null; }
            catch (IOException) { return null; }
            catch (UnauthorizedAccessException) { return null; }
        }
        static string Equal(IdentityReference? observed, IdentityReference? expected) => observed is null ? "UNKNOWN" : (observed == expected).ToString();
        var owner = ReadOwner(probe);
        var lockPath = Path.Combine(root, "owner.lock");
        var lockExists = File.Exists(lockPath);
        var lockOwner = ReadOwner(lockPath);
        var elevated = new WindowsPrincipal(identity).IsInRole(WindowsBuiltInRole.Administrator);
        Console.WriteLine($"UPDATE_WORKER_OWNER_PROBE tokenOwnerEqualsUser={identity.Owner == identity.User} rootExists={rootExists} defaultFileOwnerEqualsUser={Equal(owner, identity.User)} defaultFileOwnerEqualsTokenOwner={Equal(owner, identity.Owner)} lockExists={lockExists} lockOwnerEqualsUser={Equal(lockOwner, identity.User)} elevatedAdmin={elevated} nativeStore={startup}");
        if (owner is not null) Check(owner == identity.Owner, "native default file owner must match observed token default owner");
    }
    private static JsonObject Request(string id = "request-1", string generation = "0", string revision = "0", string release = "release-1") => new()
    { ["protocol"] = 1, ["requestId"] = id, ["command"] = "request", ["releaseId"] = release, ["policyRevision"] = 1,
        ["expectedGeneration"] = generation, ["expectedRevision"] = revision };
    private static JsonObject CommandLine(string command) => new() { ["protocol"] = 1, ["requestId"] = command, ["command"] = command };
    private sealed class Child : IDisposable
    {
        internal readonly Process Process;
        internal Child(string root)
        {
            var start = new ProcessStartInfo(worker) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true };
            foreach (var arg in new[] { "--stdio", "--state-root", root, "--installation-id", Installation }) start.ArgumentList.Add(arg);
            Process = Process.Start(start)!;
        }
        internal async Task<JsonObject> Send(JsonObject request) => await Raw(request.ToJsonString());
        internal async Task<JsonObject> Raw(string request)
        {
            await Process.StandardInput.WriteLineAsync(request); await Process.StandardInput.FlushAsync();
            var reply = await Process.StandardOutput.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(15));
            return JsonNode.Parse(reply ?? throw new Exception("child EOF " + Process.StandardError.ReadToEnd()))!.AsObject();
        }
        public void Dispose()
        {
            if (!Process.HasExited) { Process.StandardInput.Close(); if (!Process.WaitForExit(5000)) { Process.Kill(); Process.WaitForExit(); } }
            Process.Dispose();
        }
    }
    private static async Task OwnershipAndProtocol()
    {
        var root = Root();
        using (var first = new Child(root))
        {
            var empty = await first.Send(CommandLine("recover")); Check(Kind(empty) == "none" && empty["generation"]!.GetValue<string>() == "0", "fresh startup ready " + Describe(empty));
            Check(!File.Exists(Path.Combine(root, "journal.json")), "recover read-only empty");
            using (var second = new Child(root)) Check(Reason(await second.Send(CommandLine("recover"))) == "OWNER_BUSY", "separate OS lock owner");
            var capabilities = await first.Send(CommandLine("capabilities")); Check(Kind(capabilities) == "capabilities", "capabilities");
            Check(Kind(await first.Raw("{\"protocol\":1,\"requestId\":\"a\",\"command\":\"status\",\"command\":\"recover\"}")) == "error", "duplicate rejected");
            Check(Kind(await first.Raw(new string('a', 65537))) == "error", "bounded oversized request");
            var unsupported = Request(); unsupported["path"] = "C:\\untrusted.exe";
            Check(Kind(await first.Send(unsupported)) == "error", "path field rejected");
            var unavailable = await first.Send(Request()); Check(Kind(unavailable) == "unavailable", "unsupported terminal request");
            Check(unavailable["generation"]!.GetValue<string>() == "1" && unavailable["revision"]!.GetValue<string>() == "2", "durable positions");
            var bytes = File.ReadAllBytes(Path.Combine(root, "journal.json"));
            Check(Kind(await first.Send(Request())) == "unavailable", "duplicate idempotent despite stale CAS");
            Check(File.ReadAllBytes(Path.Combine(root, "journal.json")).SequenceEqual(bytes), "duplicate no rewrite");
            Check(Reason(await first.Send(Request(release: "release-2"))) == "REQUEST_ID_CONFLICT", "id conflict");
            Check(Reason(await first.Send(Request("next"))) == "POSITION_CONFLICT", "position conflict");
            Check(Kind(await first.Send(CommandLine("recover"))) == "none", "terminal refusal nonblocking");
            Check(Kind(await first.Send(Request("next", "1", "2"))) == "unavailable", "new CAS request");
            var historical = await first.Send(Request());
            Check(Kind(historical) == "unavailable" && historical["result"]!["transactionId"]!.GetValue<string>() == unavailable["result"]!["transactionId"]!.GetValue<string>(), "historical duplicate retains original transaction");
        }
        using var successor = new Child(root);
        Check(Kind(await successor.Send(CommandLine("recover"))) == "none", "new owner terminal safe");
    }
    private static async Task CrashRecovery(string boundary)
    {
        var root = Root();
        var start = new ProcessStartInfo(Environment.ProcessPath!) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardInput = true, RedirectStandardOutput = true };
        foreach (var arg in new[] { "crash-child", root, boundary }) start.ArgumentList.Add(arg);
        using var child = Process.Start(start)!;
        Check(await child.StandardOutput.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(15)) == "BOUNDARY", "fault boundary " + boundary);
        child.Kill(); await child.WaitForExitAsync();
        using var successor = new Child(root);
        var recovery = await successor.Send(CommandLine("recover"));
        Check(Kind(recovery) == "recovered", "preauth owner death recovered " + boundary + " " + recovery);
        Check(recovery["result"]!["safeToStart"]!.GetValue<bool>(), "preauth no effect safe");
        Check(ulong.Parse(recovery["generation"]!.GetValue<string>()) >= 2, "generation fenced owner loss");
        Check(!File.Exists(Path.Combine(root, "journal.pending.json")), "stage resolved");
        Check(Kind(await successor.Send(CommandLine("recover"))) == "none", "recovery idempotent");
    }
    private static async Task JournalHolds()
    {
        var root = Root();
        using (var io = new WindowsStoreIO(root)) { }
        var path = Path.Combine(root, "journal.json");
        PublishFixture(root, Wire.Utf8.GetBytes("{broken"));
        using (var child = new Child(root))
        {
            var result = await child.Send(CommandLine("recover"));
            Check(Kind(result) == "held" && result["generation"] is null && result["revision"] is null, "corrupt held unknown positions " + Describe(result));
            Check(File.ReadAllText(path) == "{broken", "corruption preserved");
        }
        var payload = new JsonObject { ["transactionId"] = Guid.NewGuid().ToString("D"), ["phase"] = "installing", ["effects"] = "unknown" };
        var journal = new Journal(2, 3, "none", WindowsStoreIO.CurrentOwner(), payload);
        PublishFixture(root, journal.Encode(Installation));
        using (var child = new Child(root))
        {
            var result = await child.Send(CommandLine("recover"));
            Check(Reason(result) == "UNSUPPORTED_PENDING_PHASE", "ambiguous effect held " + Describe(result));
        }
        payload["phase"] = "preauth"; payload["requestId"] = "pending"; payload["releaseId"] = "release"; payload["policyRevision"] = 1; payload["effects"] = "none"; payload["history"] = new JsonArray();
        PublishFixture(root, journal.Encode(Installation));
        using (var child = new Child(root))
        {
            var result = await child.Send(CommandLine("recover"));
            Check(Reason(result) == "PREVIOUS_OWNER_UNVERIFIED", "live previous PID failclosed " + Describe(result));
        }
        ((JsonArray)payload["history"]!).Add(new JsonObject { ["requestId"] = "request-1", ["releaseId"] = "release-1", ["policyRevision"] = 1, ["transactionId"] = Guid.NewGuid().ToString("D") });
        PublishFixture(root, journal.Encode(Installation));
        using (var child = new Child(root)) Check(Kind(await child.Send(Request())) == "held", "historical receipt cannot bypass pending transaction hold");
        var original = File.ReadAllBytes(path);
        var staged = new Journal(3, 4, new string('b', 64), WindowsStoreIO.CurrentOwner(), payload);
        using (var io = new WindowsStoreIO(root)) io.Stage(staged.Encode(Installation));
        CheckFixtureOwner(Path.Combine(root, "journal.pending.json"));
        using (var child = new Child(root))
        {
            var result = await child.Send(CommandLine("recover"));
            Check(Reason(result) == "PENDING_STATE_UNVERIFIED", "stage CAS conflict held " + Describe(result));
        }
        Check(File.ReadAllBytes(path).SequenceEqual(original), "conflict preserves current");
    }
    private static void PublishFixture(string root, byte[] bytes)
    {
        using (var io = new WindowsStoreIO(root))
        {
            var previous = io.Read("journal.json");
            io.Stage(bytes); io.PublishStage(previous?.Digest ?? "none");
        }
        CheckFixtureOwner(Path.Combine(root, "journal.json"));
    }
    private static void CheckFixtureOwner(string filename)
    {
        using var identity = WindowsIdentity.GetCurrent();
        var owner = new FileInfo(filename).GetAccessControl(AccessControlSections.Owner).GetOwner(typeof(SecurityIdentifier));
        Check(owner == identity.User, "semantic journal fixture must be owned by user before testing phase recovery");
    }
    private static async Task TerminalStageRecovery()
    {
        var root = Root();
        var first = Root();
        using (var child = new Child(first)) _ = await child.Send(Request());
        var terminal = Journal.Decode(File.ReadAllBytes(Path.Combine(first, "journal.json")), Installation);
        using (var io = new WindowsStoreIO(root))
        {
            var payload = (JsonObject)terminal.Payload.DeepClone(); payload["phase"] = "preauth"; payload.Remove("reason");
            var preauth = new Journal(1, 1, "none", terminal.Owner, payload);
            io.Stage(preauth.Encode(Installation)); io.PublishStage("none");
            var staged = terminal with { PreviousDigest = io.Read("journal.json")!.Digest };
            io.Stage(staged.Encode(Installation));
        }
        var pending = File.ReadAllBytes(Path.Combine(root, "journal.pending.json"));
        using var successor = new Child(root);
        Check(Reason(await successor.Send(CommandLine("status"))) == "PUBLICATION_PENDING", "status cannot publish stage");
        Check(Kind(await successor.Send(CommandLine("capabilities"))) == "capabilities", "capability reads remain available");
        Check(File.ReadAllBytes(Path.Combine(root, "journal.pending.json")).SequenceEqual(pending), "readonly calls preserve durable stage");
        Check(Kind(await successor.Send(CommandLine("recover"))) == "none", "terminal stage recovered nonblocking");
        Check(!File.Exists(Path.Combine(root, "journal.pending.json")), "terminal publication complete");
    }
    private static async Task Anchoring()
    {
        var root = Root();
        using (var child = new Child(root))
        {
            _ = await child.Send(CommandLine("recover"));
            var denied = false; try { Directory.Move(root, root + "-moved"); } catch (IOException) { denied = true; }
            Check(denied, "pinned root cannot rename");
            denied = false; try { File.Delete(Path.Combine(root, "owner.lock")); } catch (IOException) { denied = true; }
            Check(denied, "lock inode cannot replace");
        }
        var original = Path.Combine(root, "outside.json");
        PublishFixture(root, Wire.Utf8.GetBytes("sentinel"));
        Check(CreateHardLinkW(original, Path.Combine(root, "journal.json"), IntPtr.Zero), "hardlink fixture");
        using (var child = new Child(root)) Check(Reason(await child.Send(CommandLine("recover"))) == "JOURNAL_FILE_UNSAFE", "hardlink refused");
        Check(File.ReadAllText(original) == "sentinel", "hardlink target preserved");
        var junction = root + "-junction";
        var start = new ProcessStartInfo("cmd.exe") { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true };
        foreach (var arg in new[] { "/c", "mklink", "/J", junction, root }) start.ArgumentList.Add(arg);
        using var mklink = Process.Start(start)!; await mklink.WaitForExitAsync();
        Check(mklink.ExitCode == 0, "junction fixture");
        using (var child = new Child(junction)) Check(Reason(await child.Send(CommandLine("recover"))) == "STATE_ROOT_UNSAFE", "reparse root refused");
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CreateHardLinkW(string filename, string existing, IntPtr security);
    private static async Task NullDaclRefusal()
    {
        var root = Root();
        using (var io = new WindowsStoreIO(root)) { }
        Check(SetNamedSecurityInfoW(root, 1, 0x80000004, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero) == 0, "NULL DACL fixture");
        Check(GetNamedSecurityInfoW(root, 1, 4, out _, out _, out var dacl, out _, out var descriptor) == 0 && dacl == IntPtr.Zero, "native NULL DACL confirmed");
        if (descriptor != IntPtr.Zero) _ = LocalFree(descriptor);
        using var child = new Child(root);
        var result = await child.Send(CommandLine("recover"));
        Check(Kind(result) == "held" && Reason(result) == "STATE_ROOT_ACL_UNSAFE", "NULL DACL directory refused " + result);
        Check(!File.Exists(Path.Combine(root, "journal.json")), "NULL DACL no journal mutation");
    }
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode)] private static extern uint SetNamedSecurityInfoW(string name, int type, uint info, IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode)] private static extern uint GetNamedSecurityInfoW(string name, int type, uint info, out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr descriptor);
    [DllImport("kernel32.dll")] private static extern IntPtr LocalFree(IntPtr memory);
}
