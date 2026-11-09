using System.Diagnostics;
using System.IO.Pipes;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Lnwjud.Containment;

internal static class McpStdioProxy
{
    internal const string ConfigurationVariable = "LNWJUD_MCP_STDIO_PROXY_CONFIG";
    private const int MaximumConfigurationBytes = 64 * 1024;
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow,
    };

    private sealed record Request(string Command, string[] Args, string Cwd, Dictionary<string, string> Environment, bool WindowsVerbatimArguments = false);

    internal static async Task<int> RunAsync()
    {
        var request = ReadRequest();
        var executable = ResolveExecutable(request.Command, request.Cwd, request.Environment);
        using var input = Console.OpenStandardInput();
        using var output = Console.OpenStandardOutput();
        using var error = Console.OpenStandardError();
        using var targetInput = new AnonymousPipeServerStream(PipeDirection.Out, HandleInheritability.Inheritable);
        using var targetOutput = new AnonymousPipeServerStream(PipeDirection.In, HandleInheritability.Inheritable);
        using var targetError = new AnonymousPipeServerStream(PipeDirection.In, HandleInheritability.Inheritable);
        using var child = ContainedProcess.StartRedirected(
            executable,
            request.Args,
            request.Cwd,
            request.WindowsVerbatimArguments,
            request.Environment,
            targetInput.ClientSafePipeHandle.DangerousGetHandle(),
            targetOutput.ClientSafePipeHandle.DangerousGetHandle(),
            targetError.ClientSafePipeHandle.DangerousGetHandle());
        targetInput.DisposeLocalCopyOfClientHandle();
        targetOutput.DisposeLocalCopyOfClientHandle();
        targetError.DisposeLocalCopyOfClientHandle();

        var inputCopy = CopyInputToTarget(input, targetInput);
        var outputCopy = targetOutput.CopyToAsync(output);
        var errorCopy = targetError.CopyToAsync(error);
        try
        {
            while (!inputCopy.IsCompleted && !child.WaitForRootExit(20))
            {
                if (outputCopy.IsFaulted || errorCopy.IsFaulted) throw new IOException("MCP_PROXY_PIPE_FAILED");
            }
            if (inputCopy.IsFaulted && !child.WaitForRootExit(0)) await inputCopy.ConfigureAwait(false);
            if (inputCopy.IsCompleted && !child.WaitForRootExit(0))
            {
                var gracefulExit = Stopwatch.StartNew();
                while (!child.WaitForRootExit(20) && gracefulExit.Elapsed < TimeSpan.FromSeconds(1))
                {
                    if (outputCopy.IsFaulted || errorCopy.IsFaulted) throw new IOException("MCP_PROXY_PIPE_FAILED");
                }
            }
            // Preserve a naturally exited target's status before Job cleanup can change it.
            // A still-running target cancelled after client EOF is normal proxy shutdown.
            var rootExitedBeforeCleanup = child.WaitForRootExit(0);
            var terminalExitCode = rootExitedBeforeCleanup ? child.ExitCode : 0;
            if (child.ActiveProcesses > 0) child.Cancel();
            await WaitForEmptyJob(child).ConfigureAwait(false);
            if (!inputCopy.IsCompleted) input.Dispose();
            try { await inputCopy.WaitAsync(TimeSpan.FromSeconds(5)).ConfigureAwait(false); }
            catch when (child.ActiveProcesses == 0 && child.WaitForRootExit(0)) { }
            await Task.WhenAll(outputCopy, errorCopy).WaitAsync(TimeSpan.FromSeconds(5)).ConfigureAwait(false);
            // A drained Job proves cleanup, not success; propagate only a naturally observed root exit.
            return terminalExitCode;
        }
        catch
        {
            if (child.ActiveProcesses > 0) child.Cancel();
            await WaitForEmptyJob(child).ConfigureAwait(false);
            return 125;
        }
    }

    private static async Task CopyInputToTarget(Stream input, Stream target)
    {
        try { await input.CopyToAsync(target).ConfigureAwait(false); }
        finally { await target.DisposeAsync().ConfigureAwait(false); }
    }

    private static Request ReadRequest()
    {
        var text = System.Environment.GetEnvironmentVariable(ConfigurationVariable);
        if (text is null || Encoding.UTF8.GetByteCount(text) is 0 or > MaximumConfigurationBytes)
            throw new IOException("MCP_PROXY_CONFIGURATION_INVALID");
        var bytes = Encoding.UTF8.GetBytes(text);
        using var document = JsonDocument.Parse(bytes, new JsonDocumentOptions { MaxDepth = 8 });
        var root = document.RootElement;
        if (root.ValueKind != JsonValueKind.Object || HasDuplicateProperties(root)) throw new IOException("MCP_PROXY_CONFIGURATION_INVALID");
        var request = JsonSerializer.Deserialize<Request>(bytes, JsonOptions) ?? throw new IOException("MCP_PROXY_CONFIGURATION_INVALID");
        ValidateRequest(request);
        return request;
    }

    private static void ValidateRequest(Request request)
    {
        if (string.IsNullOrWhiteSpace(request.Command) || request.Command.Length > 32_000 || request.Command.Contains('\0')
            || request.Args is null || request.Environment is null
            || !Path.IsPathFullyQualified(request.Cwd) || request.Cwd.Length > 32_000 || !Directory.Exists(request.Cwd)
            || request.Args.Length > 512 || request.Environment.Count > 512)
            throw new IOException("MCP_PROXY_CONFIGURATION_INVALID");
        var totalCharacters = request.Command.Length + request.Cwd.Length;
        foreach (var argument in request.Args)
        {
            if (argument is null || argument.Contains('\0')) throw new IOException("MCP_PROXY_CONFIGURATION_INVALID");
            totalCharacters = checked(totalCharacters + argument.Length + 1);
        }
        var keys = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var pair in request.Environment)
        {
            if (pair.Key.Length is 0 or > 32_000 || pair.Key.Contains('=') || pair.Key.Contains('\0')
                || pair.Value.Contains('\0') || !keys.Add(pair.Key)) throw new IOException("MCP_PROXY_CONFIGURATION_INVALID");
            totalCharacters = checked(totalCharacters + pair.Key.Length + pair.Value.Length + 2);
        }
        if (totalCharacters >= 32_000) throw new IOException("MCP_PROXY_CONFIGURATION_TOO_LARGE");
    }

    private static string ResolveExecutable(string command, string cwd, IReadOnlyDictionary<string, string> environment)
    {
        if (Path.IsPathFullyQualified(command)) return RequireExecutable(Path.GetFullPath(command));
        if (command.Contains(Path.DirectorySeparatorChar) || command.Contains(Path.AltDirectorySeparatorChar))
            return RequireExecutable(Path.GetFullPath(command, cwd));
        var searchPath = environment.FirstOrDefault(pair => string.Equals(pair.Key, "PATH", StringComparison.OrdinalIgnoreCase)).Value ?? string.Empty;
        foreach (var directory in searchPath.Split(Path.PathSeparator).Prepend(cwd))
        {
            var candidate = Path.Combine(directory.Length == 0 ? cwd : directory, Path.HasExtension(command) ? command : command + ".exe");
            if (File.Exists(candidate) && string.Equals(Path.GetExtension(candidate), ".exe", StringComparison.OrdinalIgnoreCase))
                return Path.GetFullPath(candidate);
        }
        throw new IOException("MCP_TARGET_EXECUTABLE_UNAVAILABLE");
    }

    private static string RequireExecutable(string filename)
    {
        if (string.Equals(Path.GetExtension(filename), ".exe", StringComparison.OrdinalIgnoreCase) && File.Exists(filename)) return filename;
        throw new IOException("MCP_TARGET_EXECUTABLE_UNAVAILABLE");
    }

    private static bool HasDuplicateProperties(JsonElement value)
    {
        if (value.ValueKind == JsonValueKind.Object)
        {
            var properties = new HashSet<string>(StringComparer.Ordinal);
            foreach (var property in value.EnumerateObject())
                if (!properties.Add(property.Name) || HasDuplicateProperties(property.Value)) return true;
        }
        else if (value.ValueKind == JsonValueKind.Array)
        {
            foreach (var item in value.EnumerateArray()) if (HasDuplicateProperties(item)) return true;
        }
        return false;
    }

    private static async Task WaitForEmptyJob(ContainedProcess process)
    {
        var timer = Stopwatch.StartNew();
        while (process.ActiveProcesses != 0)
        {
            if (timer.Elapsed >= TimeSpan.FromSeconds(10)) throw new IOException("MCP_PROXY_TERMINATION_UNVERIFIED");
            await Task.Delay(10).ConfigureAwait(false);
        }
    }
}
