using System.Diagnostics;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace Lnwjud.Containment;

internal sealed record ServiceMcpHandles(long Input, long Output, long Error);
internal sealed record ServiceMcpChildObservation(ServiceAttemptObservation Process, string Scope = "owned_job",
    string Containment = "unisolated_same_user", bool WriterDrainVerified = false);
internal sealed record ServiceMcpConnectionObservation(ServiceAttemptIdentity Connection, string State, ServiceMcpChildObservation[] Children,
    string Scope = "owned_job", string Containment = "unisolated_same_user", bool WriterDrainVerified = false);

internal sealed class ServiceMcpPipes : IDisposable
{
    internal SafeFileHandle Input { get; private init; } = null!;
    internal SafeFileHandle Output { get; private init; } = null!;
    internal SafeFileHandle Error { get; private init; } = null!;

    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetNamedPipeClientProcessId(SafePipeHandle pipe, out uint pid);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern SafeProcessHandle OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool DuplicateHandle(SafeProcessHandle source, nint handle, nint target, out SafeFileHandle copy, uint access, bool inherit, uint options);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern uint GetFileType(SafeFileHandle handle);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern uint WaitForSingleObject(SafeProcessHandle handle, uint timeout);

    internal static ServiceMcpPipes Capture(NamedPipeServerStream control, ServiceMcpHandles source)
    {
        if (!GetNamedPipeClientProcessId(control.SafePipeHandle, out var pid) || pid == 0)
            throw new IOException("SERVICE_MCP_PEER_UNAVAILABLE");
        using var peer = OpenProcess(0x40 | 0x100000, false, pid);
        if (peer.IsInvalid || WaitForSingleObject(peer, 0) != 0x102)
            throw new IOException("SERVICE_MCP_PEER_UNAVAILABLE");
        SafeFileHandle Copy(long value)
        {
            if (value <= 0 || !DuplicateHandle(peer, checked((nint)value), -1, out var handle, 0, false, 2))
                throw new IOException("SERVICE_MCP_PIPE_UNAVAILABLE");
            if (GetFileType(handle) != 3) { handle.Dispose(); throw new IOException("SERVICE_MCP_PIPE_REQUIRED"); }
            return handle;
        }
        var input = Copy(source.Input);
        SafeFileHandle? output = null;
        try
        {
            output = Copy(source.Output);
            var error = Copy(source.Error);
            if (WaitForSingleObject(peer, 0) != 0x102) { error.Dispose(); throw new IOException("SERVICE_MCP_PEER_UNAVAILABLE"); }
            return new() { Input = input, Output = output, Error = error };
        }
        catch { input.Dispose(); output?.Dispose(); throw; }
    }

    public void Dispose() { Input.Dispose(); Output.Dispose(); Error.Dispose(); }
}

internal sealed partial class WindowsServiceProcessRuntime
{
    private readonly Dictionary<string, McpAttempt> mcpAttempts = new(StringComparer.Ordinal);
    private readonly HashSet<string> mcpConnections = new(StringComparer.Ordinal);

    internal async Task OwnMcpConnectionAsync(string sid, string digest, uint sessionId, Stream control,
        Func<object, Task> reply, CancellationToken stopping)
    {
        ServiceAttemptIdentity connection;
        lock (gate)
        {
            if (mcpConnections.Count >= MaximumConcurrentProcesses) throw new IOException("SERVICE_MCP_CONNECTION_LIMIT");
            connection = ledger.PrepareMcpConnection(sid, digest, sessionId);
            mcpConnections.Add(connection.AttemptId);
        }
        try
        {
            await reply(connection).ConfigureAwait(false);
            using var input = CancellationTokenSource.CreateLinkedTokenSource(stopping);
            var owner = WaitMcpOwnerAsync(control, input.Token);
            while (!owner.IsCompleted && !stopping.IsCancellationRequested
                && ledger.Inspect(connection, sid).Phase == ServiceAttemptPhase.Prepared)
                await Task.Delay(20, stopping).ConfigureAwait(false);
            input.Cancel();
            try { await owner.ConfigureAwait(false); } catch { }
        }
        finally
        {
            _ = await CloseMcpConnectionAsync(connection, sid).ConfigureAwait(false);
            lock (gate) mcpConnections.Remove(connection.AttemptId);
        }
    }

    internal ServiceAttemptIdentity PrepareMcpChild(ServiceAttemptIdentity connection, string sid) => ledger.PrepareMcpChild(connection, sid);

    internal async Task RunMcpAsync(ServiceAttemptIdentity connection, ServiceAttemptIdentity identity, string sid,
        string digest, ServiceProcessOperation operation, nint token, ServiceMcpPipes pipes, Stream control,
        Func<object, Task> reply, CancellationToken stopping)
    {
        var attempt = new McpAttempt(identity, sid);
        lock (gate)
        {
            if (mcpAttempts.Count + attempts.Values.Count(value => !value.IsTerminal) >= MaximumConcurrentProcesses || mcpAttempts.ContainsKey(identity.AttemptId))
                throw new IOException("SERVICE_MCP_ATTEMPT_UNAVAILABLE");
            if (!ledger.TryCommitMcpDispatch(connection, identity, sid, digest))
                throw new IOException("SERVICE_MCP_DISPATCH_FENCED");
            mcpAttempts.Add(identity.AttemptId, attempt);
        }
        using var ownerCancellation = CancellationTokenSource.CreateLinkedTokenSource(stopping);
        Task? owner = null;
        var naturalExit = false;
        var exitCode = 125;
        try
        {
            var name = ContainedProcess.GetJobName(identity.AttemptId);
#if NATIVE_CONTAINMENT_TESTS
            if (useCurrentUserTestLauncher)
                attempt.Process = ContainedProcess.Start(operation.Executable!, operation.Args!, operation.Cwd!, operation.WindowsVerbatimArguments,
                    operation.Environment!, pipes.Output.DangerousGetHandle(), pipes.Error.DangerousGetHandle(), () => attempt.CancelRequested,
                    pid => _ = ledger.MarkRunning(identity, sid, checked((int)pid)), name, identity, pipes.Input.DangerousGetHandle());
            else
#endif
                attempt.Process = ContainedProcess.StartAsUser(token, operation.Executable!, operation.Args!, operation.Cwd!, operation.WindowsVerbatimArguments,
                    operation.Environment!, pipes.Output.DangerousGetHandle(), pipes.Error.DangerousGetHandle(), () => attempt.CancelRequested,
                    pid => _ = ledger.MarkRunning(identity, sid, checked((int)pid)), name, identity, pipes.Input.DangerousGetHandle());
            pipes.Dispose();
            await reply(new ServiceMcpChildObservation(ledger.Inspect(identity, sid))).ConfigureAwait(false);
            owner = WaitMcpOwnerAsync(control, ownerCancellation.Token);
            while (!attempt.Process.WaitForRootExit(0) && !attempt.CancelRequested && !owner.IsCompleted && !stopping.IsCancellationRequested)
                await Task.Delay(20, stopping).ConfigureAwait(false);
            naturalExit = !attempt.CancelRequested && !stopping.IsCancellationRequested && attempt.Process.WaitForRootExit(0);
            if (naturalExit) exitCode = attempt.Process.ExitCode;
            else _ = ledger.RequestCancellation(identity, sid);
            if (attempt.Process.ActiveProcesses != 0) attempt.Process.Cancel();
            var wait = Stopwatch.StartNew();
            while (attempt.Process.ActiveProcesses != 0)
            {
                if (wait.Elapsed > TimeSpan.FromSeconds(15)) throw new IOException("SERVICE_MCP_TERMINATION_UNVERIFIED");
                await Task.Delay(10).ConfigureAwait(false);
            }
            if (!attempt.Process.WaitForRootExit(0)) throw new IOException("SERVICE_MCP_ROOT_TERMINATION_UNVERIFIED");
            if (!naturalExit) exitCode = attempt.Process.ExitCode;
            _ = ledger.RecordTerminal(identity, sid, naturalExit ? ServiceProcessOutcome.Completed : ServiceProcessOutcome.Cancelled, exitCode, 0);
            _ = ledger.Release(identity, sid);
            await reply(new ServiceMcpChildObservation(ledger.Inspect(identity, sid))).ConfigureAwait(false);
        }
        catch
        {
            if (attempt.Process is not null)
            {
                try { attempt.Process.Cancel(); } catch { }
            }
            var current = ledger.Inspect(identity, sid);
            if (current.Phase != ServiceAttemptPhase.TerminalVerified)
                _ = ledger.MarkUnknown(identity, sid, "SERVICE_MCP_TERMINATION_UNVERIFIED");
            throw;
        }
        finally
        {
            ownerCancellation.Cancel();
            if (owner is not null) { try { await owner.ConfigureAwait(false); } catch { } }
            attempt.Process?.Dispose();
            lock (gate) mcpAttempts.Remove(identity.AttemptId);
        }
    }

    internal async Task<ServiceAttemptObservation> CloseMcpChildAsync(ServiceAttemptIdentity connection, ServiceAttemptIdentity identity, string sid)
    {
        _ = ledger.AbortMcpChild(connection, identity, sid);
        var deadline = Stopwatch.StartNew();
        do
        {
            var observation = Inspect(identity, sid);
            if (observation.Phase is ServiceAttemptPhase.LaunchNotStarted or ServiceAttemptPhase.TerminalVerified) return observation;
            _ = ledger.RequestCancellation(identity, sid);
            lock (gate)
            {
                if (mcpAttempts.TryGetValue(identity.AttemptId, out var active))
                {
                    active.Cancel();
                    try { active.Process?.Cancel(); } catch { }
                }
            }
            await Task.Delay(20).ConfigureAwait(false);
        } while (deadline.Elapsed < TimeSpan.FromSeconds(15));
        return Inspect(identity, sid);
    }

    internal async Task<ServiceMcpConnectionObservation> CloseMcpConnectionAsync(ServiceAttemptIdentity connection, string sid)
    {
        ledger.CloseMcpConnection(connection, sid);
        await Task.WhenAll(ledger.McpChildren(connection, sid)
            .Select(child => CloseMcpChildAsync(connection, child.Identity, sid))).ConfigureAwait(false);
        var children = ledger.McpChildren(connection, sid).Select(child => Inspect(child.Identity, sid)).ToArray();
        var verified = children.All(child => !child.ReservationHeld
            && (child.Phase == ServiceAttemptPhase.LaunchNotStarted || child.Phase == ServiceAttemptPhase.TerminalVerified && child.ActiveProcesses == 0));
        return new(connection, verified ? "closed_verified" : "termination_unknown", children.Select(child => new ServiceMcpChildObservation(child)).ToArray());
    }

    private async Task StopMcpAsync()
    {
        McpAttempt[] active;
        lock (gate) active = mcpAttempts.Values.ToArray();
        foreach (var attempt in active)
        {
            attempt.Cancel();
            try { attempt.Process?.Cancel(); } catch { }
        }
        if (active.Length != 0) await Task.Delay(20).ConfigureAwait(false);
    }

    private static async Task WaitMcpOwnerAsync(Stream stream, CancellationToken token)
    {
        var byteBuffer = new byte[1];
        try { _ = await stream.ReadAsync(byteBuffer, token).ConfigureAwait(false); }
        catch (Exception exception) when (exception is IOException or OperationCanceledException or ObjectDisposedException) { }
    }

    private sealed class McpAttempt(ServiceAttemptIdentity identity, string sid)
    {
        private int cancelled;
        internal ServiceAttemptIdentity Identity { get; } = identity;
        internal string Sid { get; } = sid;
        internal ContainedProcess? Process { get; set; }
        internal bool CancelRequested => Volatile.Read(ref cancelled) != 0;
        internal void Cancel() => Interlocked.Exchange(ref cancelled, 1);
    }
}
