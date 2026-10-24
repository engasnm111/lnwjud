using System.Buffers.Binary;
using System.Diagnostics;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Runtime.InteropServices;
using System.IO.Pipes;
using Microsoft.Win32.SafeHandles;

namespace Lnwjud.Containment;

internal static class WindowsContainmentServiceClient
{
    private const int MaximumFrameBytes = 1024 * 1024;
    private static readonly JsonSerializerOptions Json = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow,
    };

    private sealed record WatchRequest(int Protocol, string Command, ServiceAttemptIdentity Identity);

    internal static async Task<byte[]> SendAsync(string expectedSha256, byte[] requestBytes, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(requestBytes);
        if (!OperatingSystem.IsWindows()) throw new IOException("SERVICE_ENDPOINT_WINDOWS_REQUIRED");
        ValidateSha256(expectedSha256);
        if (requestBytes.Length is < 2 or > MaximumFrameBytes) throw new IOException("SERVICE_REQUEST_SIZE_INVALID");

        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(RequestTimeout(requestBytes));
        using var pipe = await ServicePipeSecurity.ConnectClientAsync(WindowsContainmentService.PipeName, timeout.Token).ConfigureAwait(false);
        using var endpoint = VerifyServerIdentity(pipe.SafePipeHandle, expectedSha256);

        var header = new byte[sizeof(int)];
        BinaryPrimitives.WriteInt32LittleEndian(header, requestBytes.Length);
        await pipe.WriteAsync(header, timeout.Token).ConfigureAwait(false);
        await pipe.WriteAsync(requestBytes, timeout.Token).ConfigureAwait(false);
        await pipe.FlushAsync(timeout.Token).ConfigureAwait(false);
        var response = await ReadFrameAsync(pipe, timeout.Token).ConfigureAwait(false);
        endpoint.Revalidate();
        return response;
    }

    internal static bool ShouldWaitForOutput(ServiceAttemptPhase phase) =>
        phase is ServiceAttemptPhase.Prepared or ServiceAttemptPhase.DispatchCommitted;

    internal static async Task<int> RunWatcherAsync(string expectedSha256, Stream input, Stream stdout, Stream stderr)
    {
        try
        {
            ValidateSha256(expectedSha256);
            var payload = await ReadFrameAsync(input, CancellationToken.None).ConfigureAwait(false);
            var watch = JsonSerializer.Deserialize<WatchRequest>(payload, Json)
                ?? throw new IOException("SERVICE_WATCH_REQUEST_INVALID");
            if (watch.Protocol != 3 || watch.Command != "watch" || watch.Identity is null)
                throw new IOException("SERVICE_WATCH_REQUEST_INVALID");

            var ownerDisconnected = WaitForOwnerDisconnectAsync(input);
            var stdoutOffset = 0;
            var stderrOffset = 0;
            while (true)
            {
                if (ownerDisconnected.IsCompleted)
                {
                    await CancelAndWaitAsync(expectedSha256, watch.Identity).ConfigureAwait(false);
                    return 125;
                }

                var observation = await CallResultAsync<ServiceAttemptObservation>(expectedSha256, new
                {
                    protocol = 3,
                    command = "inspect",
                    identity = watch.Identity,
                }).ConfigureAwait(false);
                if (ShouldWaitForOutput(observation.Phase))
                {
                    await Task.Delay(50).ConfigureAwait(false);
                    continue;
                }
                if (observation.Phase == ServiceAttemptPhase.LaunchNotStarted) return 125;
                if (observation.Phase == ServiceAttemptPhase.TerminationUnknown)
                    throw new IOException("SERVICE_TERMINATION_UNKNOWN");
                var output = await CallResultAsync<ServiceOutputObservation>(expectedSha256, new
                {
                    protocol = 3,
                    command = "read_output",
                    identity = watch.Identity,
                }).ConfigureAwait(false);

                stdoutOffset = await WriteDeltaAsync(stdout, output.StdoutBase64, stdoutOffset).ConfigureAwait(false);
                stderrOffset = await WriteDeltaAsync(stderr, output.StderrBase64, stderrOffset).ConfigureAwait(false);

                if (observation.Phase == ServiceAttemptPhase.TerminalVerified)
                {
                    await stdout.FlushAsync().ConfigureAwait(false);
                    await stderr.FlushAsync().ConfigureAwait(false);
                    return 0;
                }
                await Task.Delay(50).ConfigureAwait(false);
            }
        }
        catch
        {
            try
            {
                var bytes = Encoding.UTF8.GetBytes("NATIVE_CONTAINMENT_UNRESOLVED" + Environment.NewLine);
                await stderr.WriteAsync(bytes).ConfigureAwait(false);
                await stderr.FlushAsync().ConfigureAwait(false);
            }
            catch { }
            return 125;
        }
    }

    private static async Task CancelAndWaitAsync(string expectedSha256, ServiceAttemptIdentity identity)
    {
        try
        {
            _ = await CallResultAsync<ServiceAttemptObservation>(expectedSha256, new { protocol = 3, command = "cancel", identity }).ConfigureAwait(false);
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(15));
            while (!timeout.IsCancellationRequested)
            {
                var observation = await CallResultAsync<ServiceAttemptObservation>(expectedSha256, new { protocol = 3, command = "inspect", identity }, timeout.Token).ConfigureAwait(false);
                if (observation.Phase == ServiceAttemptPhase.TerminalVerified) return;
                await Task.Delay(50, timeout.Token).ConfigureAwait(false);
            }
        }
        catch { }
    }

    private static async Task<T> CallResultAsync<T>(string expectedSha256, object request, CancellationToken cancellationToken = default)
    {
        var bytes = JsonSerializer.SerializeToUtf8Bytes(request, Json);
        var responseBytes = await SendAsync(expectedSha256, bytes, cancellationToken).ConfigureAwait(false);
        using var response = JsonDocument.Parse(responseBytes);
        var root = response.RootElement;
        if (!root.GetProperty("ok").GetBoolean())
            throw new IOException(root.TryGetProperty("error", out var error) ? error.GetString() ?? "SERVICE_RPC_FAILED" : "SERVICE_RPC_FAILED");
        return root.GetProperty("result").Deserialize<T>(Json) ?? throw new IOException("SERVICE_RESPONSE_INVALID");
    }

    private static async Task<int> WriteDeltaAsync(Stream stream, string base64, int previousOffset)
    {
        byte[] bytes;
        try { bytes = Convert.FromBase64String(base64); }
        catch (FormatException exception) { throw new IOException("SERVICE_OUTPUT_INVALID", exception); }
        if (bytes.Length < previousOffset) throw new IOException("SERVICE_OUTPUT_REWOUND");
        if (bytes.Length > previousOffset)
        {
            await stream.WriteAsync(bytes.AsMemory(previousOffset)).ConfigureAwait(false);
            await stream.FlushAsync().ConfigureAwait(false);
        }
        return bytes.Length;
    }

    private static async Task<bool> WaitForOwnerDisconnectAsync(Stream input)
    {
        var probe = new byte[1];
        try { return await input.ReadAsync(probe.AsMemory()).ConfigureAwait(false) == 0; }
        catch { return true; }
    }

    private static ServiceEndpointIdentity.VerifiedEndpoint VerifyServerIdentity(SafePipeHandle pipe, string expectedSha256) =>
        ServiceEndpointIdentity.VerifyConnectedServer(pipe, expectedSha256);

    internal static void ValidateServerImage(string imagePath, string programFilesRoot, string expectedSha256) =>
        ServiceEndpointIdentity.ValidateImage(imagePath, programFilesRoot, expectedSha256);

    internal static void ValidateServerAccount(string? sid)
    {
        if (!string.Equals(sid, "S-1-5-18", StringComparison.Ordinal)) throw new IOException("SERVICE_ENDPOINT_NOT_SYSTEM");
    }

    internal static TimeSpan RequestTimeout(byte[] requestBytes)
    {
        using var document = JsonDocument.Parse(requestBytes);
        var request = document.RootElement;
        if (request.ValueKind != JsonValueKind.Object || !request.TryGetProperty("protocol", out var protocol)
            || protocol.ValueKind != JsonValueKind.Number || !protocol.TryGetInt32(out var version) || version != 3 || !request.TryGetProperty("command", out var command)
            || command.ValueKind != JsonValueKind.String) throw new IOException("SERVICE_REQUEST_INVALID");
        if (command.GetString() == "control" && request.TryGetProperty("controlCommand", out var control)
            && control.ValueKind == JsonValueKind.String && control.GetString() == "publish_import")
        {
            if (!request.TryGetProperty("controlRequest", out var arguments)) throw new IOException("SERVICE_IMPORT_REQUEST_INVALID");
            _ = ServiceImportTransactionRuntime.ParseArguments(arguments, "publish_import");
            return TimeSpan.FromSeconds(115);
        }
        // SCM validates and launches under the caller's token. Leave a bounded
        // window for slow Windows profile/AV initialization, without making
        // observation or preflight RPCs indefinitely block the gateway.
        if (command.GetString() == "run") return TimeSpan.FromSeconds(25);
        return TimeSpan.FromSeconds(10);
    }

    private static void ValidateSha256(string value)
    {
        if (value is null || value.Length != 64 || value.Any(character => !Uri.IsHexDigit(character)))
            throw new IOException("SERVICE_CLIENT_PACKAGE_ID_INVALID");
    }

    private static async Task<byte[]> ReadFrameAsync(Stream stream, CancellationToken cancellationToken)
    {
        var header = new byte[sizeof(int)];
        await stream.ReadExactlyAsync(header, cancellationToken).ConfigureAwait(false);
        var length = BinaryPrimitives.ReadInt32LittleEndian(header);
        if (length is < 2 or > MaximumFrameBytes) throw new IOException("SERVICE_FRAME_SIZE_INVALID");
        var payload = new byte[length];
        await stream.ReadExactlyAsync(payload, cancellationToken).ConfigureAwait(false);
        return payload;
    }
}
