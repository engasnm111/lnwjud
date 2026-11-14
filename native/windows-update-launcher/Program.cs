using System.Diagnostics;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Security.Cryptography;
using System.Text.Json;
using Lnwjud.Containment;

namespace Lnwjud.UpdateLauncher;

internal static class Program
{
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int MessageBoxW(nint window, string text, string caption, uint type);

    private static async Task<int> Main(string[] args)
    {
        try
        {
            if (!OperatingSystem.IsWindows() || args.Length > 512 || args.Any(value => value.Length > 32767 || value.Contains('\0')))
                throw new IOException("UPDATE_LAUNCH_ARGUMENTS_INVALID");
            var root = AppContext.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar);
            var helperRoot = Path.Combine(root, "resources", "native-containment");
            using var helper = new FileStream(Path.Combine(helperRoot, "lnwjud-containment.exe"), FileMode.Open, FileAccess.Read, FileShare.Read);
            using var manifestFile = new FileStream(Path.Combine(helperRoot, "manifest.json"), FileMode.Open, FileAccess.Read, FileShare.Read);
            if (manifestFile.Length is < 2 or > 65536) throw new IOException("UPDATE_LAUNCH_HELPER_INVALID");
            using var manifest = JsonDocument.Parse(manifestFile);
            var digest = manifest.RootElement.GetProperty("sha256").GetString() ?? "";
            if (digest.Length != 64 || Convert.ToHexString(SHA256.HashData(helper)).ToLowerInvariant() != digest)
                throw new IOException("UPDATE_LAUNCH_HELPER_INVALID");
            try { return await LaunchManaged(digest, args).ConfigureAwait(false); }
            catch (Exception) when (UpdateStartupGate.InspectFootprint().Kind == "unmanaged")
            {
                return await LaunchManual(root, args).ConfigureAwait(false);
            }
        }
        catch (Exception error)
        {
            var message = error is IOException && error.Message.StartsWith("UPDATE_", StringComparison.Ordinal)
                ? error.Message : "UPDATE_LAUNCH_UNVERIFIED";
            try { Console.Error.WriteLine(message); } catch { }
            if (Environment.GetEnvironmentVariable("ELECTRON_RUN_AS_NODE") != "1")
                _ = MessageBoxW(0, message + "\nReinstall the official all-users package or inspect update recovery diagnostics.", "lnwjud", 0x10);
            return 125;
        }
    }

    [SupportedOSPlatform("windows")]
    private static async Task<int> LaunchManaged(string digest, string[] args)
    {
        using var input = new AnonymousPipeServerStream(PipeDirection.Out, HandleInheritability.None);
        using var output = new AnonymousPipeServerStream(PipeDirection.In, HandleInheritability.None);
        using var error = new AnonymousPipeServerStream(PipeDirection.In, HandleInheritability.None);
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(30));
        using var channel = await WindowsContainmentServiceClient.OpenMcpChannelAsync(digest, new
        {
            protocol = 3,
            command = "update_launch",
            update = new { args, electronRunAsNode = Environment.GetEnvironmentVariable("ELECTRON_RUN_AS_NODE") == "1" },
            mcpHandles = new ServiceMcpHandles(input.ClientSafePipeHandle.DangerousGetHandle().ToInt64(),
                output.ClientSafePipeHandle.DangerousGetHandle().ToInt64(), error.ClientSafePipeHandle.DangerousGetHandle().ToInt64()),
        }, deadline.Token).ConfigureAwait(false);
        var started = await channel.ReadResultAsync<JsonElement>(deadline.Token).ConfigureAwait(false);
        if (started.GetProperty("kind").GetString() != "launched") throw new IOException("UPDATE_LAUNCH_REFUSED");
        input.DisposeLocalCopyOfClientHandle(); output.DisposeLocalCopyOfClientHandle(); error.DisposeLocalCopyOfClientHandle();
        using var copying = new CancellationTokenSource();
        var copyInput = RelayInput(input, copying.Token);
        _ = copyInput.ContinueWith(task => { _ = task.Exception; }, TaskContinuationOptions.OnlyOnFaulted);
        var copyOutput = output.CopyToAsync(Console.OpenStandardOutput());
        var copyError = error.CopyToAsync(Console.OpenStandardError());
        var terminal = await channel.ReadResultAsync<JsonElement>(CancellationToken.None).ConfigureAwait(false);
        copying.Cancel();
        await Task.WhenAll(copyOutput, copyError).ConfigureAwait(false);
        if (terminal.GetProperty("kind").GetString() != "exited" || !terminal.GetProperty("jobZero").GetBoolean())
            throw new IOException("UPDATE_LAUNCH_TERMINATION_UNVERIFIED");
        return terminal.GetProperty("exitCode").GetInt32();
    }

    private static async Task RelayInput(AnonymousPipeServerStream destination, CancellationToken token)
    {
        try { await Console.OpenStandardInput().CopyToAsync(destination, token).ConfigureAwait(false); }
        finally { destination.Dispose(); }
    }

    private static async Task<int> LaunchManual(string root, string[] args)
    {
        var slot = Path.Combine(root, "slots", "A");
        var image = Path.Combine(slot, "lnwjud.exe");
        using var manifest = new FileStream(Path.Combine(slot, "manifest.json"), FileMode.Open, FileAccess.Read, FileShare.Read);
        if (manifest.Length is < 2 or > 8 * 1024 * 1024) throw new IOException("UPDATE_MANUAL_SLOT_INVALID");
        using var document = JsonDocument.Parse(manifest);
        var matches = document.RootElement.GetProperty("files").EnumerateArray()
            .Where(file => file.GetProperty("path").GetString() == "lnwjud.exe").ToArray();
        if (matches.Length != 1) throw new IOException("UPDATE_MANUAL_SLOT_INVALID");
        using var executable = new FileStream(image, FileMode.Open, FileAccess.Read, FileShare.Read);
        var expected = matches[0];
        if (executable.Length.ToString(System.Globalization.CultureInfo.InvariantCulture) != expected.GetProperty("sizeBytes").GetString()
            || Convert.ToHexString(SHA256.HashData(executable)).ToLowerInvariant() != expected.GetProperty("sha256").GetString())
            throw new IOException("UPDATE_MANUAL_SLOT_INVALID");
        var invocation = new ProcessStartInfo(image) { UseShellExecute = false, WorkingDirectory = slot };
        foreach (var argument in args) invocation.ArgumentList.Add(argument);
        invocation.Environment["LNWJUD_UPDATE_BOOT_MODE"] = "manual";
        using var process = Process.Start(invocation) ?? throw new IOException("UPDATE_MANUAL_LAUNCH_FAILED");
        await process.WaitForExitAsync().ConfigureAwait(false);
        return process.ExitCode;
    }
}
