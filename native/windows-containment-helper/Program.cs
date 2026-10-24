using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Lnwjud.Containment;

internal static class Program
{
    internal const string BuildId = "lnwjud-containment-v2";
    private const int MaximumRequestBytes = 1024 * 1024;
#if NATIVE_CONTAINMENT_TESTS
    private static readonly JsonSerializerOptions Json = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase, UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow };
    private sealed record Request(int Protocol, string BuildId, string Directory, string KeyId, string AuthenticationKey, string OperationDigest, JsonElement Binding, Operation Operation);
    private sealed record Operation(string Kind, string? Executable, string[]? Args, string? Cwd, int TimeoutMs, bool WindowsVerbatimArguments, Dictionary<string, string>? Environment, JsonElement Request);
#endif

    internal static async Task<int> Main(string[] args)
    {
        try
        {
            using var executablePin = new FileStream(Environment.ProcessPath ?? throw new IOException("HELPER_PATH_UNAVAILABLE"), FileMode.Open, FileAccess.Read, FileShare.Read);
            if (args.Length == 1 && args[0] == "clear-stale-tunnel-alias")
                return await StaleTunnelAlias.RunAsync(Console.OpenStandardInput(), Console.OpenStandardOutput()).ConfigureAwait(false);
            if (args.Length == 2 && args[0] == "service-rpc") return await RunServiceRpcAsync(args[1]).ConfigureAwait(false);
            if (args.Length == 2 && args[0] == "service-watch") return await WindowsContainmentServiceClient.RunWatcherAsync(args[1], Console.OpenStandardInput(), Console.OpenStandardOutput(), Console.OpenStandardError()).ConfigureAwait(false);
#if !NATIVE_CONTAINMENT_TESTS
            if (args.Length == 1 && args[0] == "service") { WindowsContainmentService.Run(); return 0; }
            if (args.Length == 1 && args[0] == "service-install") { WindowsContainmentServiceInstaller.Install(); return 0; }
            if (args.Length == 1 && args[0] == "service-uninstall") { WindowsContainmentServiceInstaller.Uninstall(); return 0; }
#endif
#if NATIVE_CONTAINMENT_TESTS
            if (args.Length != 1 || args[0] != "run-v2") throw new IOException("HELPER_COMMAND_INVALID");
            using var input = Console.OpenStandardInput();
            var lengthBytes = new byte[4]; input.ReadExactly(lengthBytes);
            var length = System.Buffers.Binary.BinaryPrimitives.ReadInt32LittleEndian(lengthBytes);
            if (length is < 2 or > MaximumRequestBytes) throw new IOException("HELPER_REQUEST_TOO_LARGE");
            var bytes = new byte[length]; input.ReadExactly(bytes);
            var request = JsonSerializer.Deserialize<Request>(bytes, Json) ?? throw new IOException("HELPER_REQUEST_INVALID");
            using (var document = JsonDocument.Parse(bytes))
            {
                var operationBytes = Encoding.UTF8.GetBytes(document.RootElement.GetProperty("operation").GetRawText());
                var operationDigest = Convert.ToHexString(SHA256.HashData(operationBytes)).ToLowerInvariant();
                if (operationDigest != request.OperationDigest) throw new IOException("HELPER_OPERATION_DIGEST_INVALID");
            }
            CryptographicOperations.ZeroMemory(bytes);
            if (request.Protocol != 2 || request.BuildId != BuildId || !Path.IsPathFullyQualified(request.Directory)) throw new IOException("HELPER_PROTOCOL_INVALID");
            var keyBytes = Convert.FromBase64String(request.AuthenticationKey);
            if (keyBytes.Length != 32) throw new IOException("HELPER_KEY_INVALID");
            try { return Execute(request, keyBytes); } finally { CryptographicOperations.ZeroMemory(keyBytes); }
#else
            throw new IOException("HELPER_COMMAND_INVALID");
#endif
        }
        catch { Console.Error.WriteLine("NATIVE_CONTAINMENT_UNRESOLVED"); return 125; }
    }

    private static async Task<int> RunServiceRpcAsync(string expectedSha256)
    {
        var input = Console.OpenStandardInput();
        var header = new byte[sizeof(int)];
        await input.ReadExactlyAsync(header).ConfigureAwait(false);
        var length = System.Buffers.Binary.BinaryPrimitives.ReadInt32LittleEndian(header);
        if (length is < 2 or > MaximumRequestBytes) throw new IOException("HELPER_REQUEST_TOO_LARGE");
        var request = new byte[length];
        await input.ReadExactlyAsync(request).ConfigureAwait(false);
        byte[] response;
        try
        {
            response = await WindowsContainmentServiceClient.SendAsync(expectedSha256, request).ConfigureAwait(false);
        }
        finally
        {
            CryptographicOperations.ZeroMemory(request);
        }
        var output = Console.OpenStandardOutput();
        await output.WriteAsync(response).ConfigureAwait(false);
        await output.FlushAsync().ConfigureAwait(false);
        CryptographicOperations.ZeroMemory(response);
        return 0;
    }

#if NATIVE_CONTAINMENT_TESTS
    private static int Execute(Request request, byte[] key)
    {
        using var pinned = PinnedDirectory.Open(request.Directory);
        var op = request.Operation;
        if (op.Kind != "run_process")
        {
            if (op.Kind is not ("prepare_import" or "publish_import" or "inspect_publication")) throw new IOException("HELPER_OPERATION_INVALID");
            var result = ImportOperations.Execute(op.Kind, op.Request);
            WriteReceipt(request, key, "control", new { protocol = 2, buildId = BuildId, keyId = request.KeyId, operationDigest = request.OperationDigest, binding = request.Binding, operation = op.Kind, phase = "control", result });
            return 0;
        }
        if (op.Executable is null || op.Args is null || op.Cwd is null || op.Environment is null || op.TimeoutMs is < 1 or > 604800000) throw new IOException("HELPER_PROCESS_INVALID");
        if (op.Environment.Any(pair => pair.Key.Length == 0 || pair.Key.Contains('=') || pair.Key.Contains('\0') || pair.Value.Contains('\0'))) throw new IOException("HELPER_ENVIRONMENT_INVALID");
        ContainedProcess job;
        try { job = ContainedProcess.Start(op.Executable, op.Args, op.Cwd, op.WindowsVerbatimArguments, op.Environment, cancellationRequested: () => File.Exists(Path.Combine(request.Directory, "containment.cancel"))); }
        catch (OperationCanceledException)
        {
            WriteReceipt(request, key, "terminal", new { protocol = 2, buildId = BuildId, keyId = request.KeyId, operationDigest = request.OperationDigest, binding = request.Binding, operation = "run_process", phase = "terminal", outcome = "cancelled", exitCode = -1, activeProcesses = 0 });
            return 0;
        }
        using var jobLifetime = job;
        WriteReceipt(request, key, "started", new { protocol = 2, buildId = BuildId, keyId = request.KeyId, operationDigest = request.OperationDigest, binding = request.Binding, operation = "run_process", phase = "started", targetPid = job.ProcessId });
        var stopwatch = Stopwatch.StartNew();
        var outcome = "completed";
        while (job.ActiveProcesses != 0)
        {
            if (File.Exists(Path.Combine(request.Directory, "containment.cancel"))) { outcome = "cancelled"; job.Cancel(); break; }
            if (stopwatch.ElapsedMilliseconds >= op.TimeoutMs) { outcome = "timed_out"; job.Cancel(); break; }
            Thread.Sleep(20);
        }
        var wait = Stopwatch.StartNew();
        while (job.ActiveProcesses != 0)
        {
            if (wait.ElapsedMilliseconds > 10000) throw new IOException("HELPER_TERMINATION_UNKNOWN");
            Thread.Sleep(20);
        }
        var exitCode = job.ExitCode;
        WriteReceipt(request, key, "terminal", new { protocol = 2, buildId = BuildId, keyId = request.KeyId, operationDigest = request.OperationDigest, binding = request.Binding, operation = "run_process", phase = "terminal", outcome, exitCode, activeProcesses = 0 });
        return 0;
    }

    private static void WriteReceipt(Request request, byte[] key, string phase, object value)
    {
        var payload = JsonSerializer.SerializeToUtf8Bytes(value, Json);
        var envelope = JsonSerializer.SerializeToUtf8Bytes(new { payload = Convert.ToBase64String(payload), mac = Convert.ToHexString(HMACSHA256.HashData(key, payload)).ToLowerInvariant() }, Json);
        var filename = Path.Combine(request.Directory, phase == "terminal" ? "containment.receipt.json" : "containment." + phase + ".json");
        var temporary = filename + "." + Guid.NewGuid().ToString("N") + ".tmp";
        using (var stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None, 4096, FileOptions.WriteThrough)) { stream.Write(envelope); stream.Flush(true); }
        File.Move(temporary, filename, false);
        if (!File.ReadAllBytes(filename).AsSpan().SequenceEqual(envelope)) throw new IOException("HELPER_RECEIPT_READBACK_FAILED");
    }
#endif
}
