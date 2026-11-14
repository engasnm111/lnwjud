using System.Buffers.Binary;
using System.Diagnostics;
using System.Security.Principal;
using System.Text.Json;

namespace Lnwjud.Containment;

internal static class ServiceMcpTests
{
    private static readonly JsonSerializerOptions Json = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };
    private static readonly string Executable = Environment.ProcessPath!;
    private static int assertions;
    private static void Check(bool value, string reason) { assertions++; if (!value) throw new Exception("MCP service: " + reason); }

    internal static async Task RunAsync()
    {
        await LocalUpdateAdmissionAsync();
        var root = Path.Combine(Path.GetTempPath(), "lnwjud-service-mcp-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        var ledger = new ServiceAttemptLedger(new ServiceAttemptLedgerPersistence(Path.Combine(root, "attempts.json")));
        var pipeName = "lnwjud-service-mcp-" + Guid.NewGuid().ToString("N");
        using var stopping = new CancellationTokenSource();
        var server = WindowsContainmentService.RunPipeServerAsync(pipeName, ledger, stopping.Token, useCurrentUserTestLauncher: true);
        var processes = new List<Process>();
        try
        {
            var evidence = Path.Combine(root, "evidence.json");
            var operation = new ServiceProcessOperation("run_mcp_stdio", Executable, ["mcp-proxy-target", evidence], root, 0, false,
                Environment.GetEnvironmentVariables().Cast<System.Collections.DictionaryEntry>()
                    .ToDictionary(entry => (string)entry.Key, entry => (string)(entry.Value ?? "")), 0);
            var (owner, connection) = await OpenOwner(pipeName, operation);
            processes.Add(owner);
            var child = await Rpc<ServiceAttemptIdentity>(pipeName, new { protocol = 3, command = "mcp_child", connection });
            Check(child.Generation == 2 && child.TaskId == connection.TaskId, "service issues first generation before spawn");
            try { _ = await Rpc<ServiceAttemptIdentity>(pipeName, new { protocol = 3, command = "mcp_child", connection }); throw new Exception("overlapping sibling accepted"); }
            catch (IOException) { assertions++; }
            try { _ = await Rpc<ServiceAttemptObservation>(pipeName, new { protocol = 3, command = "inspect", identity = child }); throw new Exception("MCP job accepted as managed-writer proof"); }
            catch (IOException) { assertions++; }
            var before = await Rpc<ServiceMcpChildObservation>(pipeName, new { protocol = 3, command = "mcp_close_child", connection, identity = child });
            Check(before.Process.Phase == ServiceAttemptPhase.LaunchNotStarted, "abort before dispatch is durable");
            using (var late = StartProxy(pipeName, connection, child, operation))
            {
                processes.Add(late);
                await late.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(10));
                Check(late.ExitCode != 0 && !File.Exists(evidence), "late proxy cannot launch aborted ticket");
            }
            child = await Rpc<ServiceAttemptIdentity>(pipeName, new { protocol = 3, command = "mcp_child", connection });
            using (var proxy = StartProxy(pipeName, connection, child, operation))
            {
                processes.Add(proxy);
                await WaitFile(evidence);
                using var observed = JsonDocument.Parse(await File.ReadAllBytesAsync(evidence));
                using var target = Process.GetProcessById(observed.RootElement.GetProperty("rootPid").GetInt32());
                using var descendant = Process.GetProcessById(observed.RootElement.GetProperty("descendantPid").GetInt32());
                await proxy.StandardInput.BaseStream.WriteAsync(new byte[] { 0, 1, 254, 255 });
                await proxy.StandardInput.BaseStream.FlushAsync();
                var response = await proxy.StandardOutput.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(10));
                Check(response?.Contains("AAH+/w==", StringComparison.Ordinal) == true, "duplex service pipes preserve binary input and stdout");
                Check(await proxy.StandardError.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(10)) == "MCP_PROXY_CLEANUP_VERIFIED", "stderr remains separate");
                var ended = await Rpc<ServiceMcpChildObservation>(pipeName, new { protocol = 3, command = "mcp_close_child", connection, identity = child });
                Check(ended.Process.Phase == ServiceAttemptPhase.TerminalVerified && ended.Process.ActiveProcesses == 0,
                    "service kernel Job observes terminal membership");
                Check(ended.Scope == "owned_job" && ended.Containment == "unisolated_same_user" && !ended.WriterDrainVerified,
                    "Job-empty cannot be promoted to global descendant or writer-drain proof");
                await target.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(5));
                await descendant.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(5));
                proxy.StandardInput.Close();
                await proxy.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(10));
            }
            File.Delete(evidence);
            child = await Rpc<ServiceAttemptIdentity>(pipeName, new { protocol = 3, command = "mcp_child", connection });
            using (var dishonest = StartProxy(pipeName, connection, child, operation, "mcp-service-zero-exit"))
            {
                processes.Add(dishonest);
                await dishonest.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(10));
                Check(dishonest.ExitCode == 0, "hostile relay zero exit injected");
                var independent = await Rpc<ServiceMcpChildObservation>(pipeName, new { protocol = 3, command = "mcp_close_child", connection, identity = child });
                Check(independent.Process.Phase == ServiceAttemptPhase.TerminalVerified && independent.Process.ActiveProcesses == 0
                    && !independent.WriterDrainVerified, "relay exit hint does not replace scoped service observation");
            }
            var prepared = await Rpc<ServiceAttemptIdentity>(pipeName, new { protocol = 3, command = "mcp_child", connection });
            owner.Kill();
            await owner.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(5));
            var sid = WindowsIdentity.GetCurrent().User!.Value;
            var timer = Stopwatch.StartNew();
            while (ledger.Inspect(prepared, sid).Phase == ServiceAttemptPhase.Prepared && timer.Elapsed < TimeSpan.FromSeconds(10)) await Task.Delay(20);
            Check(ledger.Inspect(prepared, sid).Phase == ServiceAttemptPhase.LaunchNotStarted, "owner death fences unstarted tickets");
            var group = await Rpc<ServiceMcpConnectionObservation>(pipeName, new { protocol = 3, command = "mcp_close_connection", connection });
            Check(group.State == "closed_verified" && !group.WriterDrainVerified && group.Children.Length == 4,
                "service registry includes every SDK sibling and remains scoped");
            try { _ = await Rpc<ServiceAttemptIdentity>(pipeName, new { protocol = 3, command = "mcp_child", connection }); throw new Exception("closed connection reopened"); }
            catch (IOException) { assertions++; }
            var substitution = prepared with { Generation = prepared.Generation + 1 };
            try { _ = await Rpc<ServiceMcpChildObservation>(pipeName, new { protocol = 3, command = "mcp_close_child", connection, identity = substitution }); throw new Exception("stale generation accepted"); }
            catch (IOException) { assertions++; }
            var foreign = prepared with { TaskId = "other" };
            try { _ = await Rpc<ServiceMcpChildObservation>(pipeName, new { protocol = 3, command = "mcp_close_child", connection, identity = foreign }); throw new Exception("foreign ticket accepted"); }
            catch (IOException) { assertions++; }
            var recovered = new ServiceAttemptLedger(new ServiceAttemptLedgerPersistence(Path.Combine(root, "attempts.json")));
            Check(recovered.Inspect(connection, sid).Phase == ServiceAttemptPhase.LaunchNotStarted, "closed connection survives restart");
            var restartPath = Path.Combine(root, "restart.json");
            var first = new ServiceAttemptLedger(new ServiceAttemptLedgerPersistence(restartPath));
            var oldConnection = first.PrepareMcpConnection(sid, new string('a', 64));
            var oldChild = first.PrepareMcpChild(oldConnection, sid);
            var replacement = new ServiceAttemptLedger(new ServiceAttemptLedgerPersistence(restartPath));
            Check(replacement.Inspect(oldChild, sid).Phase == ServiceAttemptPhase.LaunchNotStarted,
                "service restart fences never-dispatched tickets instead of inferring from PID absence");
            using (var stored = JsonDocument.Parse(File.ReadAllBytes(restartPath)))
                Check(stored.RootElement.GetProperty("schemaVersion").GetInt32() == 2, "registry-only ledger uses explicit reader-v2 schema");
            var legacyPath = Path.Combine(root, "legacy.json");
            File.WriteAllText(legacyPath, "{\"schemaVersion\":1,\"attempts\":[]}");
            var migrated = new ServiceAttemptLedger(new ServiceAttemptLedgerPersistence(legacyPath));
            _ = migrated.PrepareMcpConnection(sid, new string('b', 64));
            using (var stored = JsonDocument.Parse(File.ReadAllBytes(legacyPath)))
                Check(stored.RootElement.GetProperty("schemaVersion").GetInt32() == 2, "v1 ledger reads and migrates on first write");
            File.Delete(evidence);
            var (secondOwner, secondConnection) = await OpenOwner(pipeName, operation);
            processes.Add(secondOwner);
            var activeChild = await Rpc<ServiceAttemptIdentity>(pipeName, new { protocol = 3, command = "mcp_child", connection = secondConnection });
            using (var proxy = StartProxy(pipeName, secondConnection, activeChild, operation))
            {
                processes.Add(proxy);
                await WaitFile(evidence);
                using var observed = JsonDocument.Parse(await File.ReadAllBytesAsync(evidence));
                using var target = Process.GetProcessById(observed.RootElement.GetProperty("rootPid").GetInt32());
                using var descendant = Process.GetProcessById(observed.RootElement.GetProperty("descendantPid").GetInt32());
                secondOwner.Kill();
                await secondOwner.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(5));
                var stopped = await Rpc<ServiceMcpConnectionObservation>(pipeName, new { protocol = 3, command = "mcp_close_connection", connection = secondConnection });
                Check(stopped.State == "closed_verified" && !stopped.WriterDrainVerified, "owner crash closes all registered owned Jobs without claiming global effects");
                await target.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(5));
                await descendant.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(5));
                proxy.StandardInput.Close();
                await proxy.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(10));
            }
            Console.WriteLine("SERVICE_MCP_OWNED_JOB_ASSERTIONS_PASSED=" + assertions);
        }
        finally
        {
            foreach (var process in processes) { try { if (!process.HasExited) process.Kill(); } catch { } }
            stopping.Cancel();
            try { await server.WaitAsync(TimeSpan.FromSeconds(20)); } catch { }
            var absolute = Path.GetFullPath(root);
            if (!absolute.StartsWith(Path.GetFullPath(Path.GetTempPath()), StringComparison.OrdinalIgnoreCase)
                || !Path.GetFileName(absolute).StartsWith("lnwjud-service-mcp-", StringComparison.Ordinal)) throw new Exception("Unsafe fixture cleanup");
            Directory.Delete(absolute, true);
        }
    }

    private static async Task LocalUpdateAdmissionAsync()
    {
        var calls = 0;
        Task<byte[]> Record() { calls++; return Task.FromResult(JsonSerializer.SerializeToUtf8Bytes(new
            { protocol = 3, ok = true, result = new { kind = "opaque_dispatch_recorded" } })); }
        await Program.AuthorizeLocalMcpDispatchAsync(new("unmanaged", "MANUAL_INSTALLATION"), Record);
        Check(calls == 0, "manual local MCP does not depend on an installed service or create enrollment");
        await Program.AuthorizeLocalMcpDispatchAsync(new("held", "UPDATE_ENROLLMENT_UNVERIFIED"), Record);
        Check(calls == 1, "managed local MCP requires service opaque activity admission before launch");
        await Program.AuthorizeLocalMcpDispatchAsync(new("unknown", "inspection unavailable"), Record);
        Check(calls == 2, "unknown local footprint cannot select the unmanaged path");
        try
        {
            await Program.AuthorizeLocalMcpDispatchAsync(new("held", "UPDATE_ENROLLMENT_UNVERIFIED"),
                () => Task.FromException<byte[]>(new IOException("lost admission reply")));
            throw new Exception("lost admission reply permitted local MCP dispatch");
        }
        catch (IOException) { assertions++; }
        try
        {
            await Program.AuthorizeLocalMcpDispatchAsync(new("held", "UPDATE_ENROLLMENT_UNVERIFIED"),
                () => Task.FromResult(JsonSerializer.SerializeToUtf8Bytes(new { protocol = 3, ok = false, result = new { kind = "opaque_dispatch_recorded" } })));
            throw new Exception("refused admission permitted local MCP dispatch");
        }
        catch (IOException) { assertions++; }
    }

    private static async Task<(Process, ServiceAttemptIdentity)> OpenOwner(string pipe, ServiceProcessOperation operation)
    {
        var start = Info(pipe, "mcp-stdio-owner");
        var process = Process.Start(start)!;
        var bytes = JsonSerializer.SerializeToUtf8Bytes(operation, Json);
        var header = new byte[4]; BinaryPrimitives.WriteInt32LittleEndian(header, bytes.Length);
        await process.StandardInput.BaseStream.WriteAsync(header);
        await process.StandardInput.BaseStream.WriteAsync(bytes);
        await process.StandardInput.BaseStream.FlushAsync();
        var response = await process.StandardOutput.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(10));
        return (process, JsonSerializer.Deserialize<ServiceAttemptIdentity>(response ?? "null", Json) ?? throw new Exception("Owner did not register"));
    }
    private static Process StartProxy(string pipe, ServiceAttemptIdentity connection, ServiceAttemptIdentity identity, ServiceProcessOperation operation, string command = "mcp-stdio-proxy")
    {
        var start = Info(pipe, command);
        start.Environment[McpStdioProxy.ConfigurationVariable] = JsonSerializer.Serialize(new { connection, identity, operation }, Json);
        return Process.Start(start)!;
    }
    private static ProcessStartInfo Info(string pipe, string command)
    {
        var start = new ProcessStartInfo(Executable)
        {
            UseShellExecute = false, CreateNoWindow = true,
            RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true,
        };
        start.ArgumentList.Add(command); start.ArgumentList.Add(new string('0', 64));
        start.Environment["LNWJUD_MCP_TEST_PIPE"] = pipe;
        return start;
    }
    private static async Task<T> Rpc<T>(string pipe, object request)
    {
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(25));
        using var channel = await WindowsContainmentServiceClient.OpenMcpTestChannelAsync(pipe, request, deadline.Token);
        return await channel.ReadResultAsync<T>(deadline.Token);
    }
    private static async Task WaitFile(string file)
    {
        var timer = Stopwatch.StartNew();
        while (!File.Exists(file) && timer.Elapsed < TimeSpan.FromSeconds(10)) await Task.Delay(20);
        if (!File.Exists(file)) throw new Exception("MCP target did not start");
    }

    internal static async Task RunServerAsync()
    {
        var directory = Path.Combine(Path.GetTempPath(), "lnwjud-service-mcp-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        var marker = Path.Combine(AppContext.BaseDirectory, "mcp-service-test.pipe");
        var pipe = "lnwjud-mcp-sdk-" + Guid.NewGuid().ToString("N");
        using var stopping = new CancellationTokenSource();
        var ledger = new ServiceAttemptLedger(new ServiceAttemptLedgerPersistence(Path.Combine(directory, "attempts.json")));
        var server = WindowsContainmentService.RunPipeServerAsync(pipe, ledger, stopping.Token, useCurrentUserTestLauncher: true);
        try
        {
            using (var file = new FileStream(marker, FileMode.CreateNew, FileAccess.Write))
                file.Write(System.Text.Encoding.UTF8.GetBytes(pipe));
            Console.WriteLine("READY"); Console.Out.Flush();
            _ = await Console.In.ReadLineAsync();
        }
        finally
        {
            stopping.Cancel();
            try { await server.WaitAsync(TimeSpan.FromSeconds(20)); } catch { }
            if (File.Exists(marker) && File.ReadAllText(marker) == pipe) File.Delete(marker);
            if (!Path.GetFileName(directory).StartsWith("lnwjud-service-mcp-", StringComparison.Ordinal)
                || !Path.GetFullPath(directory).StartsWith(Path.GetFullPath(Path.GetTempPath()), StringComparison.OrdinalIgnoreCase))
                throw new Exception("Unsafe MCP fixture cleanup");
            Directory.Delete(directory, true);
        }
    }

    internal static async Task<int> RunRpcAsync(string pipe)
    {
        using var input = Console.OpenStandardInput();
        var header = new byte[4]; await input.ReadExactlyAsync(header);
        var size = BinaryPrimitives.ReadInt32LittleEndian(header);
        if (size is < 2 or > 1048576) throw new IOException("Fixture RPC size invalid");
        var bytes = new byte[size]; await input.ReadExactlyAsync(bytes);
        using var request = JsonDocument.Parse(bytes);
        try
        {
            var result = await Rpc<JsonElement>(pipe, request.RootElement);
            Console.WriteLine(JsonSerializer.Serialize(new { protocol = 3, ok = true, result }, Json));
        }
        catch { Console.WriteLine("{\"protocol\":3,\"ok\":false,\"error\":\"SERVICE_MCP_TEST_FAILED\"}"); }
        return 0;
    }
}
