using System.Buffers.Binary;
using System.IO.Pipes;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Lnwjud.Containment;

internal static class ServiceMcpStdioProxy
{
#if NATIVE_CONTAINMENT_TESTS
    internal static Action? AfterStartedForTests;
#endif
    private static readonly JsonSerializerOptions Json = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow,
    };
    private sealed record Request(ServiceAttemptIdentity Connection, ServiceAttemptIdentity Identity, ServiceProcessOperation Operation);

    private static Task<WindowsContainmentServiceClient.McpChannel> Connect(string hash, object request, CancellationToken token)
    {
#if NATIVE_CONTAINMENT_TESTS
        if (Environment.GetEnvironmentVariable("LNWJUD_MCP_TEST_PIPE") is { } testPipe)
            return WindowsContainmentServiceClient.OpenMcpTestChannelAsync(testPipe, request, token);
#endif
        return WindowsContainmentServiceClient.OpenMcpChannelAsync(hash, request, token);
    }

    internal static async Task<int> OwnConnectionAsync(string hash)
    {
        using var input = Console.OpenStandardInput();
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(30));
        var header = new byte[4];
        await input.ReadExactlyAsync(header, deadline.Token).ConfigureAwait(false);
        var length = BinaryPrimitives.ReadInt32LittleEndian(header);
        if (length is < 2 or > 65536) throw new IOException("SERVICE_MCP_OPERATION_INVALID");
        var bytes = new byte[length];
        await input.ReadExactlyAsync(bytes, deadline.Token).ConfigureAwait(false);
        using var document = Lnwjud.UpdateWorker.ReleaseJson.Parse(bytes, 65536, 8);
        var operation = document.RootElement.Deserialize<ServiceProcessOperation>(Json) ?? throw new IOException("SERVICE_MCP_OPERATION_INVALID");
        using var channel = await Connect(hash, new { protocol = 3, command = "mcp_connection", operation }, deadline.Token).ConfigureAwait(false);
        var identity = await channel.ReadResultAsync<ServiceAttemptIdentity>(deadline.Token).ConfigureAwait(false);
        Console.WriteLine(JsonSerializer.Serialize(identity, Json));
        await Console.Out.FlushAsync().ConfigureAwait(false);
        var parent = WaitForInputEnd(input);
        var authority = channel.ReadResultAsync<JsonElement>(CancellationToken.None);
        _ = authority.ContinueWith(task => { _ = task.Exception; }, TaskContinuationOptions.OnlyOnFaulted);
        await Task.WhenAny(parent, authority).ConfigureAwait(false);
        if (authority.IsFaulted) _ = authority.Exception;
        return 0;
    }

    internal static async Task<int> RunAsync(string hash)
    {
        var configuration = Environment.GetEnvironmentVariable(McpStdioProxy.ConfigurationVariable);
        Environment.SetEnvironmentVariable(McpStdioProxy.ConfigurationVariable, null);
        if (configuration is null) throw new IOException("SERVICE_MCP_CONFIGURATION_REQUIRED");
        using var document = Lnwjud.UpdateWorker.ReleaseJson.Parse(Encoding.UTF8.GetBytes(configuration), 65536, 8);
        var request = document.RootElement.Deserialize<Request>(Json) ?? throw new IOException("SERVICE_MCP_CONFIGURATION_INVALID");
        using var input = Console.OpenStandardInput();
        using var output = Console.OpenStandardOutput();
        using var error = Console.OpenStandardError();
        using var targetInput = new AnonymousPipeServerStream(PipeDirection.Out, HandleInheritability.None);
        using var targetOutput = new AnonymousPipeServerStream(PipeDirection.In, HandleInheritability.None);
        using var targetError = new AnonymousPipeServerStream(PipeDirection.In, HandleInheritability.None);
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(30));
        var handles = new ServiceMcpHandles(targetInput.ClientSafePipeHandle.DangerousGetHandle().ToInt64(),
            targetOutput.ClientSafePipeHandle.DangerousGetHandle().ToInt64(), targetError.ClientSafePipeHandle.DangerousGetHandle().ToInt64());
        using var channel = await Connect(hash, new
        {
            protocol = 3, command = "mcp_attach", connection = request.Connection, identity = request.Identity,
            operation = request.Operation, mcpHandles = handles,
        }, deadline.Token).ConfigureAwait(false);
        var started = await channel.ReadResultAsync<ServiceMcpChildObservation>(deadline.Token).ConfigureAwait(false);
        RequireScoped(started, request.Identity, terminal: false);
#if NATIVE_CONTAINMENT_TESTS
        AfterStartedForTests?.Invoke();
#endif
        targetInput.DisposeLocalCopyOfClientHandle();
        targetOutput.DisposeLocalCopyOfClientHandle();
        targetError.DisposeLocalCopyOfClientHandle();
        var inputCopy = CopyInput(input, targetInput);
        var outputCopy = targetOutput.CopyToAsync(output);
        var errorCopy = targetError.CopyToAsync(error);
        var terminal = channel.ReadResultAsync<ServiceMcpChildObservation>(CancellationToken.None);
        try
        {
            while (!inputCopy.IsCompleted && !terminal.IsCompleted && !outputCopy.IsFaulted && !errorCopy.IsFaulted)
                await Task.Delay(20).ConfigureAwait(false);
            if (!terminal.IsCompleted)
            {
                if (inputCopy.IsCompleted) await Task.WhenAny(terminal, Task.Delay(1000)).ConfigureAwait(false);
                if (!terminal.IsCompleted) await channel.SignalCloseAsync(CancellationToken.None).ConfigureAwait(false);
            }
            var ended = await terminal.WaitAsync(TimeSpan.FromSeconds(20)).ConfigureAwait(false);
            RequireScoped(ended, request.Identity, terminal: true);
            input.Dispose();
            await Task.WhenAll(outputCopy, errorCopy).WaitAsync(TimeSpan.FromSeconds(5)).ConfigureAwait(false);
            if (inputCopy.IsFaulted) _ = inputCopy.Exception;
            return ended.Process.Outcome == ServiceProcessOutcome.Completed ? ended.Process.ExitCode!.Value : 0;
        }
        catch
        {
            try { await channel.SignalCloseAsync(CancellationToken.None).ConfigureAwait(false); } catch { }
            if (terminal.IsFaulted) _ = terminal.Exception;
            return 125;
        }
    }

    private static void RequireScoped(ServiceMcpChildObservation observation, ServiceAttemptIdentity identity, bool terminal)
    {
        if (observation.Scope != "owned_job" || observation.Containment != "unisolated_same_user" || observation.WriterDrainVerified
            || observation.Process.Identity != identity || (terminal && (observation.Process.Phase != ServiceAttemptPhase.TerminalVerified
                || observation.Process.ActiveProcesses != 0))) throw new IOException("SERVICE_MCP_OBSERVATION_UNVERIFIED");
    }

    private static async Task CopyInput(Stream input, Stream target)
    {
        try { await input.CopyToAsync(target).ConfigureAwait(false); }
        finally { target.Dispose(); }
    }
    private static async Task WaitForInputEnd(Stream input)
    {
        try { _ = await input.ReadAsync(new byte[1]).ConfigureAwait(false); }
        catch (Exception exception) when (exception is IOException or ObjectDisposedException) { }
    }
}
