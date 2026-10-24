using System.Diagnostics;
using System.IO.Pipes;

namespace Lnwjud.Containment;

internal sealed record ServiceProcessOperation(
    string? Kind,
    string? Executable,
    string[]? Args,
    string? Cwd,
    int TimeoutMs,
    bool WindowsVerbatimArguments,
    Dictionary<string, string>? Environment,
    int MaximumOutputBytes);

internal sealed record ServiceOutputCursor(long StdoutOffset, long StderrOffset);

internal sealed record ServiceOutputObservation(
    string StdoutBase64,
    string StderrBase64,
    bool StdoutTruncated,
    bool StderrTruncated,
    bool Complete,
    ServiceOutputCursor NextCursor,
    ServiceOutputCursor? FinalCursor,
    bool Persisted,
    string PersistenceStatus,
    string? IncompleteReason,
    ServiceAttemptIdentity Identity);

/// <summary>
/// Owns every Windows Job handle, process handle, and output pipe for service-launched work.
/// A terminal ledger transition is recorded only after the owned Job reports zero active processes.
/// </summary>
internal sealed class WindowsServiceProcessRuntime
{
    private const int MaximumConcurrentProcesses = 64;
    private const int MaximumRetainedOutputs = 128;
    private readonly ServiceAttemptLedger ledger;
    private readonly ServiceOutputStore? outputStore;
    private readonly bool useCurrentUserTestLauncher;
    private readonly object gate = new();
    private readonly Dictionary<string, RuntimeAttempt> attempts = new(StringComparer.Ordinal);
    private readonly Queue<string> completedAttempts = new();

    internal WindowsServiceProcessRuntime(ServiceAttemptLedger ledger, bool useCurrentUserTestLauncher = false)
    {
        this.ledger = ledger ?? throw new ArgumentNullException(nameof(ledger));
        this.useCurrentUserTestLauncher = useCurrentUserTestLauncher;
        if (ledger.OutputStoreDirectory is { } directory)
        {
            try { outputStore = new ServiceOutputStore(directory); }
            catch (Exception exception) when (exception is IOException or UnauthorizedAccessException) { }
        }
    }

    internal ServiceAttemptObservation Run(
        ServiceAttemptIdentity identity,
        string callerSid,
        string operationDigest,
        ServiceProcessOperation operation,
        nint primaryToken)
    {
        var current = ledger.Inspect(identity, callerSid);
        if (current.Phase != ServiceAttemptPhase.Prepared)
            return current;

        var stdoutPipe = new AnonymousPipeServerStream(PipeDirection.In, HandleInheritability.None);
        AnonymousPipeServerStream stderrPipe;
        try { stderrPipe = new AnonymousPipeServerStream(PipeDirection.In, HandleInheritability.None); }
        catch { stdoutPipe.Dispose(); throw; }

        var attempt = new RuntimeAttempt(identity, callerSid, operation, stdoutPipe, stderrPipe, outputStore);
        lock (gate)
        {
            if (attempts.TryGetValue(identity.AttemptId, out _))
            {
                attempt.DisposePipes();
                return ledger.Inspect(identity, callerSid);
            }
            if (attempts.Values.Count(value => !value.IsTerminal) >= MaximumConcurrentProcesses)
            {
                attempt.DisposePipes();
                throw new IOException("SERVICE_CAPACITY_REACHED");
            }
            if (!ledger.TryCommitDispatch(identity, callerSid, operationDigest))
            {
                attempt.DisposePipes();
                return ledger.Inspect(identity, callerSid);
            }
            attempts.Add(identity.AttemptId, attempt);
            attempt.PersistOutput();
        }

        try
        {
            ContainedProcess process;
            var jobName = ContainedProcess.GetJobName(identity.AttemptId);
#if NATIVE_CONTAINMENT_TESTS
            if (useCurrentUserTestLauncher)
            {
                process = ContainedProcess.Start(
                    operation.Executable!,
                    operation.Args!,
                    operation.Cwd!,
                    operation.WindowsVerbatimArguments,
                    operation.Environment!,
                    stdoutPipe.ClientSafePipeHandle.DangerousGetHandle(),
                    stderrPipe.ClientSafePipeHandle.DangerousGetHandle(),
                    () => attempt.CancelRequested,
                    pid => _ = ledger.MarkRunning(identity, callerSid, checked((int)pid)),
                    jobName);
            }
            else
#endif
            {
                process = ContainedProcess.StartAsUser(
                    primaryToken,
                    operation.Executable!,
                    operation.Args!,
                    operation.Cwd!,
                    operation.WindowsVerbatimArguments,
                    operation.Environment!,
                    stdoutPipe.ClientSafePipeHandle.DangerousGetHandle(),
                    stderrPipe.ClientSafePipeHandle.DangerousGetHandle(),
                    () => attempt.CancelRequested,
                    pid => _ = ledger.MarkRunning(identity, callerSid, checked((int)pid)),
                    jobName);
            }

            attempt.Attach(process);
            attempt.DisposeLocalClientHandles();
            attempt.StartOutputReaders();
            attempt.MonitorTask = Task.Run(() => MonitorAsync(attempt));
            return ledger.Inspect(identity, callerSid);
        }
        catch
        {
            attempt.DisposeLocalClientHandles();
            attempt.DisposePipes();
            try { _ = ledger.MarkUnknown(identity, callerSid, "SERVICE_LAUNCH_OUTCOME_UNKNOWN"); }
            catch { }
            return ledger.Inspect(identity, callerSid);
        }
    }

    internal ServiceAttemptObservation Inspect(ServiceAttemptIdentity identity, string callerSid)
    {
        var observation = ledger.Inspect(identity, callerSid);
        if (observation.Phase is ServiceAttemptPhase.TerminalVerified or ServiceAttemptPhase.LaunchNotStarted)
            return observation;

        RuntimeAttempt? activeAttempt;
        lock (gate) attempts.TryGetValue(identity.AttemptId, out activeAttempt);

        if (activeAttempt is not null && !activeAttempt.IsTerminal)
            return observation;

        if (observation.Phase == ServiceAttemptPhase.TerminationUnknown)
        {
            var jobName = ContainedProcess.GetJobName(identity.AttemptId);
            var probe = ContainedProcess.QueryJob(jobName);
            if (probe.Status is ContainedProcess.JobProbeStatus.NotFound or ContainedProcess.JobProbeStatus.Empty)
            {
                // The PID is recorded only after verified Job membership. A committed
                // dispatch without that marker could have failed before containment;
                // missing Job state alone does not prove no target survived.
                if (observation.TargetPid is null)
                    return observation with { Reason = "SERVICE_RESTART_LAUNCH_UNVERIFIED" };
                // Kill-on-close and zero-active Job evidence prove termination, not
                // the process exit status. Never fabricate successful exit code 0.
                _ = ledger.RecordTerminal(identity, callerSid, ServiceProcessOutcome.Interrupted, 125, 0);
                _ = ledger.Release(identity, callerSid);
                return ledger.Inspect(identity, callerSid);
            }
            if (probe.Status == ContainedProcess.JobProbeStatus.Active)
            {
                return observation with { ActiveProcesses = checked((int)probe.ActiveProcesses), Reason = "ACTIVE_PROCESSES_REMAIN" };
            }
        }

        return observation;
    }

    internal ServiceAttemptObservation Cancel(ServiceAttemptIdentity identity, string callerSid)
    {
        var observation = ledger.RequestCancellation(identity, callerSid);
        if (observation.Phase is not (ServiceAttemptPhase.DispatchCommitted or ServiceAttemptPhase.Running or ServiceAttemptPhase.TerminationUnknown))
            return observation;

        RuntimeAttempt? attempt;
        lock (gate) attempts.TryGetValue(identity.AttemptId, out attempt);
        if (attempt is not null)
        {
            attempt.RequestCancellation();
            var process = attempt.Process;
            if (process is not null)
            {
                try { process.Cancel(); }
                catch
                {
                    if (process.ActiveProcesses != 0) throw;
                }
            }
            return ledger.Inspect(identity, callerSid);
        }

        var jobName = ContainedProcess.GetJobName(identity.AttemptId);
        var probe = ContainedProcess.QueryJob(jobName);
        if (probe.Status == ContainedProcess.JobProbeStatus.Active)
        {
            if (ContainedProcess.TerminateJobByName(jobName, 15000))
            {
                _ = ledger.RecordTerminal(identity, callerSid, ServiceProcessOutcome.Cancelled, 1, 0);
                _ = ledger.Release(identity, callerSid);
            }
            else
            {
                _ = ledger.MarkUnknown(identity, callerSid, "SERVICE_TERMINATION_UNVERIFIED");
            }
        }
        else if (probe.Status is ContainedProcess.JobProbeStatus.NotFound or ContainedProcess.JobProbeStatus.Empty
            && observation.TargetPid is > 0)
        {
            // A cancellation requested after the Job vanished does not prove
            // that cancellation caused termination or that the target exited 0.
            _ = ledger.RecordTerminal(identity, callerSid, ServiceProcessOutcome.Interrupted, 125, 0);
            _ = ledger.Release(identity, callerSid);
        }

        return ledger.Inspect(identity, callerSid);
    }

    internal ServiceOutputObservation ReadOutput(ServiceAttemptIdentity identity, string callerSid, ServiceOutputCursor? cursor = null)
    {
        _ = ledger.Inspect(identity, callerSid);
        RuntimeAttempt? attempt;
        lock (gate) attempts.TryGetValue(identity.AttemptId, out attempt);
        var persisted = attempt?.OutputPersisted ?? outputStore is not null;
        var snapshot = persisted
            ? outputStore!.Load(identity, callerSid)
            : attempt?.SnapshotOutput() ?? throw new IOException("SERVICE_OUTPUT_UNAVAILABLE");
        cursor ??= new ServiceOutputCursor(0, 0);
        if (cursor.StdoutOffset < 0 || cursor.StderrOffset < 0
            || cursor.StdoutOffset > snapshot.Stdout.Length || cursor.StderrOffset > snapshot.Stderr.Length)
            throw new IOException("SERVICE_OUTPUT_CURSOR_INVALID");
        var next = new ServiceOutputCursor(snapshot.Stdout.Length, snapshot.Stderr.Length);
        var complete = snapshot.Complete && persisted;
        return new ServiceOutputObservation(
            Convert.ToBase64String(snapshot.Stdout.AsSpan((int)cursor.StdoutOffset)),
            Convert.ToBase64String(snapshot.Stderr.AsSpan((int)cursor.StderrOffset)),
            snapshot.StdoutTruncated,
            snapshot.StderrTruncated,
            complete,
            next,
            complete ? next : null,
            persisted,
            persisted ? "persisted" : "unavailable",
            persisted ? snapshot.IncompleteReason : "SERVICE_OUTPUT_PERSISTENCE_FAILED",
            identity);
    }

    internal async Task StopAsync()
    {
        RuntimeAttempt[] running;
        lock (gate) running = attempts.Values.Where(value => !value.IsTerminal).ToArray();

        foreach (var attempt in running)
        {
            _ = ledger.RequestCancellation(attempt.Identity, attempt.CallerSid);
            attempt.RequestCancellation();
            try { attempt.Process?.Cancel(); }
            catch { }
        }

        var monitors = running.Select(value => value.MonitorTask).Where(value => value is not null).Cast<Task>().ToArray();
        if (monitors.Length > 0)
        {
            try { await Task.WhenAll(monitors).WaitAsync(TimeSpan.FromSeconds(15)).ConfigureAwait(false); }
            catch { }
        }

        foreach (var attempt in running.Where(value => !value.IsTerminal))
        {
            try { _ = ledger.MarkUnknown(attempt.Identity, attempt.CallerSid, "SERVICE_STOP_TERMINATION_UNVERIFIED"); }
            catch { }
            attempt.DisposeProcessAndPipes();
        }
    }

#if NATIVE_CONTAINMENT_TESTS
    internal static bool FailOutputReadsForTest { get; set; }
#endif

    private async Task MonitorAsync(RuntimeAttempt attempt)
    {
        var stopwatch = Stopwatch.StartNew();
        var terminationStartedAt = -1L;
        try
        {
            var process = attempt.Process ?? throw new IOException("SERVICE_PROCESS_HANDLE_UNAVAILABLE");
            while (true)
            {
                var active = process.ActiveProcesses;
                if (active == 0) break;

                if (attempt.CancelRequested || stopwatch.ElapsedMilliseconds >= attempt.Operation.TimeoutMs)
                {
                    if (!attempt.CancelRequested) attempt.MarkTimedOut();
                    if (terminationStartedAt < 0)
                    {
                        _ = ledger.RequestCancellation(attempt.Identity, attempt.CallerSid);
                        terminationStartedAt = stopwatch.ElapsedMilliseconds;
                        try { process.Cancel(); }
                        catch
                        {
                            if (process.ActiveProcesses != 0)
                            {
                                _ = ledger.MarkUnknown(attempt.Identity, attempt.CallerSid, "SERVICE_TERMINATION_REQUEST_UNRESOLVED");
                                return;
                            }
                        }
                    }
                    else if (stopwatch.ElapsedMilliseconds - terminationStartedAt >= 15_000)
                    {
                        _ = ledger.MarkUnknown(attempt.Identity, attempt.CallerSid, "SERVICE_TERMINATION_UNVERIFIED");
                        return;
                    }
                }

                await Task.Delay(20).ConfigureAwait(false);
            }

            if (process.ActiveProcesses != 0)
                throw new IOException("ACTIVE_PROCESSES_REMAIN");

            var outcome = attempt.TimedOut
                ? ServiceProcessOutcome.TimedOut
                : attempt.CancelRequested
                    ? ServiceProcessOutcome.Cancelled
                    : ServiceProcessOutcome.Completed;
            _ = ledger.RecordTerminal(attempt.Identity, attempt.CallerSid, outcome, process.ExitCode, 0);
            var release = ledger.Release(attempt.Identity, attempt.CallerSid);
            if (release is not (ReservationRelease.Released or ReservationRelease.AlreadyReleased or ReservationRelease.Retained))
                throw new IOException("SERVICE_RESERVATION_RELEASE_UNRESOLVED");

            try
            {
                var readers = Task.WhenAll(attempt.StdoutReader!, attempt.StderrReader!);
                await readers.WaitAsync(TimeSpan.FromSeconds(5)).ConfigureAwait(false);
            }
            catch { attempt.FailOutputReaders(); }
            attempt.MarkTerminal();
            attempt.DisposeProcessAndPipes();
            RetainCompletedOutput(attempt);
        }
        catch
        {
            try { _ = ledger.MarkUnknown(attempt.Identity, attempt.CallerSid, "SERVICE_TERMINAL_OUTCOME_UNRESOLVED"); }
            catch { }
        }
    }

    private void RetainCompletedOutput(RuntimeAttempt attempt)
    {
        lock (gate)
        {
            completedAttempts.Enqueue(attempt.Identity.AttemptId);
            while (completedAttempts.Count > MaximumRetainedOutputs)
            {
                var expiredId = completedAttempts.Dequeue();
                if (attempts.TryGetValue(expiredId, out var expired) && expired.IsTerminal)
                    attempts.Remove(expiredId);
            }
        }
    }

    private sealed class RuntimeAttempt(
        ServiceAttemptIdentity identity,
        string callerSid,
        ServiceProcessOperation operation,
        AnonymousPipeServerStream stdoutPipe,
        AnonymousPipeServerStream stderrPipe,
        ServiceOutputStore? outputStore)
    {
        private int cancelRequested;
        private int timedOut;
        private int terminal;
        private int localClientHandlesDisposed;
        private readonly object outputGate = new();
        private bool stdoutComplete;
        private bool stderrComplete;
        private bool outputFailed;
        private bool persistenceFailed;
        private bool outputPersisted;

        internal ServiceAttemptIdentity Identity { get; } = identity;
        internal string CallerSid { get; } = callerSid;
        internal ServiceProcessOperation Operation { get; } = operation;
        internal BoundedOutput Stdout { get; } = new(operation.MaximumOutputBytes);
        internal BoundedOutput Stderr { get; } = new(operation.MaximumOutputBytes);
        internal ContainedProcess? Process { get; private set; }
        internal Task? StdoutReader { get; private set; }
        internal Task? StderrReader { get; private set; }
        internal Task? MonitorTask { get; set; }
        internal bool CancelRequested => Volatile.Read(ref cancelRequested) != 0;
        internal bool TimedOut => Volatile.Read(ref timedOut) != 0;
        internal bool IsTerminal => Volatile.Read(ref terminal) != 0;
        internal bool OutputPersisted { get { lock (outputGate) return outputPersisted; } }

        internal ServiceOutputSnapshot SnapshotOutput()
        {
            lock (outputGate)
            {
                var complete = stdoutComplete && stderrComplete && !outputFailed;
                return new ServiceOutputSnapshot(1, Identity, CallerSid, Stdout.Snapshot(), Stderr.Snapshot(),
                    Stdout.Truncated, Stderr.Truncated, complete,
                    complete ? null : outputFailed ? "SERVICE_OUTPUT_READ_FAILED" : "SERVICE_OUTPUT_READERS_INCOMPLETE");
            }
        }

        internal void PersistOutput()
        {
            lock (outputGate)
            {
                if (persistenceFailed || outputStore is null) return;
                try
                {
                    outputStore.Save(SnapshotOutput());
                    outputPersisted = true;
                }
                catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
                {
                    persistenceFailed = true;
                    outputPersisted = false;
                }
            }
        }

        internal void FailOutputReaders()
        {
            lock (outputGate)
            {
                outputFailed = true;
                PersistOutput();
            }
        }

        internal void Attach(ContainedProcess process) => Process = process;
        internal void RequestCancellation() => Interlocked.Exchange(ref cancelRequested, 1);
        internal void MarkTimedOut() => Interlocked.Exchange(ref timedOut, 1);
        internal void MarkTerminal() => Interlocked.Exchange(ref terminal, 1);

        internal void DisposeLocalClientHandles()
        {
            if (Interlocked.Exchange(ref localClientHandlesDisposed, 1) != 0) return;
            stdoutPipe.DisposeLocalCopyOfClientHandle();
            stderrPipe.DisposeLocalCopyOfClientHandle();
        }

        internal void StartOutputReaders()
        {
            StdoutReader = Task.Run(() => DrainAsync(stdoutPipe, Stdout, true));
            StderrReader = Task.Run(() => DrainAsync(stderrPipe, Stderr, false));
        }

        private async Task DrainAsync(Stream stream, BoundedOutput output, bool stdout)
        {
            var buffer = new byte[8192];
            try
            {
                while (true)
                {
#if NATIVE_CONTAINMENT_TESTS
                    if (FailOutputReadsForTest) throw new IOException("INJECTED_OUTPUT_READ_FAILURE");
#endif
                    var count = await stream.ReadAsync(buffer.AsMemory()).ConfigureAwait(false);
                    lock (outputGate)
                    {
                        if (count == 0)
                        {
                            if (stdout) stdoutComplete = true; else stderrComplete = true;
                            PersistOutput();
                            return;
                        }
                        if (output.Append(buffer.AsSpan(0, count))) PersistOutput();
                    }
                }
            }
            catch (Exception exception) when (exception is IOException or ObjectDisposedException)
            {
                FailOutputReaders();
            }
        }

        internal void DisposePipes()
        {
            try { stdoutPipe.Dispose(); } catch { }
            try { stderrPipe.Dispose(); } catch { }
        }

        internal void DisposeProcessAndPipes()
        {
            try { Process?.Dispose(); } catch { }
            Process = null;
            DisposePipes();
        }
    }

    private sealed class BoundedOutput(int maximumBytes)
    {
        private readonly object gate = new();
        private readonly MemoryStream buffer = new(Math.Clamp(maximumBytes, 0, ServiceOutputStore.MaximumStreamBytes));
        private bool truncated;

        internal bool Truncated { get { lock (gate) return truncated; } }

        internal bool Append(ReadOnlySpan<byte> value)
        {
            lock (gate)
            {
                var wasTruncated = truncated;
                var remaining = Math.Max(0, Math.Min(maximumBytes, ServiceOutputStore.MaximumStreamBytes) - checked((int)buffer.Length));
                var accepted = Math.Min(remaining, value.Length);
                if (accepted > 0) buffer.Write(value[..accepted]);
                if (accepted < value.Length) truncated = true;
                return accepted > 0 || truncated != wasTruncated;
            }
        }

        internal byte[] Snapshot()
        {
            lock (gate) return buffer.ToArray();
        }
    }
}
