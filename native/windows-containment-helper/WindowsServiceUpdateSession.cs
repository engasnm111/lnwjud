using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Win32.SafeHandles;
using Lnwjud.UpdateWorker;

namespace Lnwjud.Containment;

internal sealed partial class WindowsServiceUpdateRuntime
{
    internal async Task RunSessionAsync(JsonElement arguments, AuthenticatedPipeCaller caller, ServiceMcpPipes pipes,
        Stream control, Func<object, Task> reply, CancellationToken stopping)
    {
        using var ownerWatch = CancellationTokenSource.CreateLinkedTokenSource(stopping);
        var disconnected = WaitForControlEnd(control, ownerWatch.Token);
        NativeDesktopSession desktop;
        lock (gate)
        {
            RequireExisting(caller.Sid);
            if (session is not null) throw new Refusal("UPDATE_DESKTOP_ALREADY_RUNNING");
            var input = Wire.Object(JsonSerializer.SerializeToUtf8Bytes(arguments));
            Wire.Fields(input, "args", "electronRunAsNode");
            if (input["args"] is not JsonArray array || array.Count > 512) throw new Refusal("UPDATE_LAUNCH_ARGUMENTS_INVALID");
            var args = array.Select(value => value?.GetValue<string>() ?? throw new Refusal("UPDATE_LAUNCH_ARGUMENTS_INVALID")).ToArray();
            if (args.Sum(value => value.Length + 1) > 30000 || args.Any(value => value.Contains('\0'))) throw new Refusal("UPDATE_LAUNCH_ARGUMENTS_INVALID");
            var node = input["electronRunAsNode"]?.GetValue<bool>() ?? throw new Refusal("UPDATE_LAUNCH_ARGUMENTS_INVALID");
            EnsureManualBaseline(caller);
            var selected = transactions!.ReadSelection() ?? throw new Refusal("UPDATE_SLOT_SELECTION_MISSING");
            var current = transactions.ReadTransaction();
            if (current is { SafeToStart: true } && !TerminalSelectionMatches(current, selected)) throw new Refusal("UPDATE_TRANSACTION_RECOVERY_REQUIRED");
            if (current?.Phase == UpdateTransactionPhase.Committed) ReconcileCommittedInstallation(current);
            if (installed!.Accepted && args.Any(value => value.StartsWith("--user-data-dir", StringComparison.OrdinalIgnoreCase)))
                throw new Refusal("UPDATE_MANAGED_PROFILE_OVERRIDE_REFUSED");
            var opaque = node || args.Any(value => value.StartsWith("--inspect", StringComparison.OrdinalIgnoreCase)
                || value.StartsWith("--remote-debugging", StringComparison.OrdinalIgnoreCase)
                || value.StartsWith("--js-flags", StringComparison.OrdinalIgnoreCase));
            if (opaque) eligibility!.BeforeOpaqueDispatch(caller.Sid);
            desktop = new(AuthenticatedPipeCaller.CreateLaunchToken(caller.PrimaryToken), pipes, args, node,
                () => disconnected.IsCompleted || stopping.IsCancellationRequested);
            session = desktop;
            try
            {
                if (current is { SafeToStart: false })
                {
                    if (opaque) throw new Refusal("UPDATE_RECOVERY_REQUIRES_DESKTOP");
                    var seal = eligibility!.ResumeTransactionAfterColdBoot(caller.Sid, current.TransactionId, current.MaintenanceEpoch);
                    desktop.Updating = true;
                    StartRecoveredPrevious(desktop, current);
                    _ = CompleteRecoveredPreviousAsync(desktop, seal);
                }
                else
                {
                    var disposition = eligibility!.Inspect(caller.Sid);
                    if (disposition.Reason == "UPDATE_ADMISSION_CLOSED" && current is { SafeToStart: true })
                    {
                        var seal = eligibility.ResumeTransactionAfterColdBoot(caller.Sid, current.TransactionId, current.MaintenanceEpoch);
                        eligibility.ReopenAfterVerifiedTransaction(current.TransactionId, seal);
                    }
                    else if (disposition.Reason == "UPDATE_COLD_EPOCH_REQUIRED") eligibility.StartColdEpoch(caller.Sid);
                    else if (disposition.Writers != 0) throw new Refusal("UPDATE_WRITER_RECOVERY_REBOOT_REQUIRED");
                    StartDesktop(desktop, selected.Slot, installed.ReadLayout(), selected.DataGeneration, installed.Version, null, false);
                }
            }
            catch { session = null; desktop.Token.Dispose(); throw; }
        }
        try
        {
            await reply(new JsonObject { ["kind"] = "launched", ["launchId"] = desktop.LaunchId }).ConfigureAwait(false);
            var exitCode = 125;
            while (true)
            {
                var ownerGone = disconnected.IsCompleted || stopping.IsCancellationRequested;
                lock (gate)
                {
                    if (ownerGone) { desktop.Cancelled = true; desktop.Process?.Cancel(); }
                    if (desktop.Process is { } child && child.WaitForRootExit(0) && child.ActiveProcesses == 0)
                    {
                        exitCode = child.ExitCode;
                        if (desktop.Registered)
                        {
                            eligibility!.CompleteKnownWriter(desktop.Witness!.WriterId, desktop.Witness);
                            desktop.Registered = false;
                        }
                        desktop.Witness?.Dispose(); desktop.Witness = null;
                        child.Dispose(); desktop.Process = null;
                    }
                    if (desktop.Process is null && (!desktop.Updating || ownerGone)) break;
                }
                await Task.Delay(20).ConfigureAwait(false);
            }
            pipes.Dispose();
            if (!ownerWatch.IsCancellationRequested)
                await reply(new JsonObject { ["kind"] = "exited", ["jobZero"] = true, ["exitCode"] = exitCode }).ConfigureAwait(false);
        }
        finally
        {
            ownerWatch.Cancel();
            try { await disconnected.ConfigureAwait(false); } catch { }
            lock (gate)
            {
                desktop.Cancelled = true;
                if (desktop.Process is not null) { desktop.Process.Cancel(); failure = "UPDATE_DESKTOP_TERMINATION_UNVERIFIED"; }
                desktop.Token.Dispose();
                if (session == desktop) session = null;
            }
        }
    }

    private void StartDesktop(NativeDesktopSession desktop, string slot, WindowsBaselineLayout layout,
        DataGeneration data, string? version, UpdateTransactionJournal? transaction, bool previous)
    {
        if (desktop.Cancelled || desktop.OwnerGone() || installed is null || eligibility is null || slot is not ("A" or "B"))
            throw new Refusal("UPDATE_DESKTOP_OWNER_UNAVAILABLE");
        var directory = Path.Combine(installationRoot, "slots", slot);
        var image = Path.Combine(directory, "lnwjud.exe");
        NativeUpdatePayload.VerifyFile(image, layout.Application);
        var manifest = ReadProtected(Path.Combine(directory, "manifest.json"), WindowsBaselineLayout.MaximumManifestBytes);
        if (ReleaseTrustPolicy.Hash(manifest) != layout.Manifest.Sha256) throw new Refusal("UPDATE_SLOT_MANIFEST_MISMATCH");
        desktop.Ready.TrySetException(new IOException("UPDATE_DESKTOP_REPLACED"));
        desktop.Health = new(TaskCreationOptions.RunContinuationsAsynchronously);
        desktop.Ready = new(TaskCreationOptions.RunContinuationsAsynchronously);
        _ = desktop.Ready.Task.ContinueWith(task => { _ = task.Exception; }, TaskContinuationOptions.OnlyOnFaulted);
        desktop.LaunchId = Guid.NewGuid().ToString("D"); desktop.BootChallenge = Secret(); desktop.HealthChallenge = Secret();
        desktop.Data = data; desktop.Version = version; desktop.Previous = previous;
        desktop.Mode = transaction is null ? installed.Accepted ? "normal" : "manual" : previous ? "rollback" : "trial";
        var environment = UserEnvironment(desktop.Token);
        environment["LNWJUD_NATIVE_LAUNCH_ID"] = desktop.LaunchId;
        environment["LNWJUD_UPDATE_BOOT_CHALLENGE"] = desktop.BootChallenge;
        environment["LNWJUD_UPDATE_INSTALLATION_ID"] = installed.InstallationId;
        environment["LNWJUD_UPDATE_DATA_GENERATION_ID"] = data.Id;
        environment["LNWJUD_UPDATE_BOOT_MODE"] = desktop.Mode;
        environment["LNWJUD_DATA_PATH"] = installed.DataPath(data);
        if (desktop.Node) environment["ELECTRON_RUN_AS_NODE"] = "1";
        if (transaction is not null)
        {
            environment["LNWJUD_UPDATE_TRANSACTION_ID"] = transaction.TransactionId;
            environment["LNWJUD_UPDATE_HEALTH_CHALLENGE"] = desktop.HealthChallenge;
        }
        var jobName = "Local\\lnwjud-update-desktop-" + desktop.LaunchId;
        var ownership = new ContainedProcess.LaunchOwnership();
        try
        {
            desktop.Process = ContainedProcess.StartAsUser(desktop.Token.DangerousGetHandle(), image, desktop.Args,
                directory, false, environment, desktop.Pipes.Output.DangerousGetHandle(), desktop.Pipes.Error.DangerousGetHandle(),
                () => desktop.Cancelled || desktop.OwnerGone(), pid =>
                {
                    var writer = transaction is null ? eligibility.BeforeKnownWriterDispatch(installed.OwnerSid) : Guid.NewGuid().ToString("D");
                    desktop.Witness = NativeUpdateWriterWitness.Capture(writer, checked((int)pid), jobName, image, layout.Application);
                    desktop.Registered = transaction is null;
                    if (transaction is not null && !(previous && transaction.Phase == UpdateTransactionPhase.PreviousStarted))
                        _ = Advance(transaction, previous ? UpdateTransactionPhase.PreviousStarted : UpdateTransactionPhase.TrialStarted);
                }, jobName, standardInput: desktop.Pipes.Input.DangerousGetHandle(), interactive: !desktop.Node, ownership: ownership);
        }
        catch (ContainedProcess.JobNameInUseException) { failure = "UPDATE_DESKTOP_JOB_COLLISION"; throw; }
        catch
        {
            if (!ownership.CancelAndObserveZero(TimeSpan.FromSeconds(15))) failure = "UPDATE_DESKTOP_TERMINATION_UNVERIFIED";
            else ownership.ReleaseAfterZero();
            throw;
        }
    }

    private JsonObject Boot(JsonObject input, string sid)
    {
        Wire.Fields(input, "launchId", "challenge");
        var desktop = session ?? throw new Refusal("UPDATE_MANAGED_LAUNCH_REQUIRED");
        if (Wire.Text(input, "launchId") != desktop.LaunchId || Wire.Text(input, "challenge") != desktop.BootChallenge
            || desktop.Witness?.ObserveRunning() != true || desktop.Data is null) throw new Refusal("UPDATE_BOOT_IDENTITY_MISMATCH");
        return new() { ["kind"] = "managed_ready", ["safeToStart"] = true, ["installationId"] = installed!.InstallationId,
            ["version"] = desktop.Version, ["dataGenerationId"] = desktop.Data.Id, ["mode"] = desktop.Mode,
            ["dataPath"] = installed.DataPath(desktop.Data), ["healthRequired"] = desktop.Updating };
    }

    internal async Task<JsonObject> HealthAsync(JsonElement arguments, string sid)
    {
        Task<JsonObject> ready;
        string id;
        lock (gate)
        {
            RequireExisting(sid);
            var desktop = session ?? throw new Refusal("UPDATE_DESKTOP_OWNER_UNAVAILABLE");
            var transaction = transactions?.ReadTransaction() ?? throw new Refusal("UPDATE_TRANSACTION_MISSING");
            var report = Wire.Object(JsonSerializer.SerializeToUtf8Bytes(arguments));
            var proof = NativeUpdateHealthEvidence.Capture(transaction, desktop.Previous,
                desktop.Version ?? throw new Refusal("UPDATE_HEALTH_VERSION_UNAVAILABLE"),
                desktop.Witness ?? throw new Refusal("UPDATE_HEALTH_PROCESS_UNAVAILABLE"), desktop.HealthChallenge, report);
            desktop.Health.TrySetResult(proof); ready = desktop.Ready.Task; id = transaction.TransactionId;
        }
        _ = await ready.WaitAsync(TimeSpan.FromSeconds(30)).ConfigureAwait(false);
        return new() { ["kind"] = "healthy", ["transactionId"] = id };
    }

    private static bool TerminalSelectionMatches(UpdateTransactionJournal transaction, SlotSelection selection)
    {
        var committed = transaction.Phase == UpdateTransactionPhase.Committed;
        return transaction.SafeToStart && transaction.InstallationId == selection.InstallationId
            && selection.Generation == transaction.Generation && selection.TransactionId == transaction.TransactionId
            && selection.Slot == (committed ? transaction.CandidateSlot : transaction.PreviousSlot)
            && selection.SlotDigest == (committed ? transaction.CandidateSlotDigest : transaction.PreviousSlotDigest)
            && selection.DataGeneration == (committed ? transaction.CandidateDataGeneration : transaction.PreviousDataGeneration);
    }

    private static async Task WaitForControlEnd(Stream stream, CancellationToken token)
    {
        try { _ = await stream.ReadAsync(new byte[1], token).ConfigureAwait(false); }
        catch (Exception error) when (error is IOException or OperationCanceledException or ObjectDisposedException) { }
    }

    private static Dictionary<string, string> UserEnvironment(SafeAccessTokenHandle token)
    {
        if (!CreateEnvironmentBlock(out var environment, token, false)) throw new Refusal("UPDATE_USER_ENVIRONMENT_UNAVAILABLE");
        try
        {
            var allowed = new HashSet<string>(["SystemRoot", "WINDIR", "TEMP", "TMP", "USERPROFILE", "APPDATA", "LOCALAPPDATA",
                "HOMEDRIVE", "HOMEPATH", "USERNAME", "USERDOMAIN", "ProgramData", "ProgramFiles", "ProgramFiles(x86)",
                "CommonProgramFiles", "CommonProgramFiles(x86)", "COMSPEC", "PATHEXT"], StringComparer.OrdinalIgnoreCase);
            var result = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            var offset = 0;
            while (offset < 1024 * 1024)
            {
                var entry = Marshal.PtrToStringUni(environment + offset) ?? throw new Refusal("UPDATE_USER_ENVIRONMENT_INVALID");
                if (entry.Length == 0)
                {
                    if (!result.TryGetValue("SystemRoot", out var root)) throw new Refusal("UPDATE_USER_ENVIRONMENT_INVALID");
                    result["PATH"] = Path.Combine(root, "System32") + ";" + root;
                    return result;
                }
                var separator = entry.IndexOf('=');
                if (separator > 0 && allowed.Contains(entry[..separator])) result[entry[..separator]] = entry[(separator + 1)..];
                offset += checked((entry.Length + 1) * 2);
            }
            throw new Refusal("UPDATE_USER_ENVIRONMENT_INVALID");
        }
        finally { DestroyEnvironmentBlock(environment); }
    }

    [DllImport("userenv.dll", SetLastError = true)] private static extern bool CreateEnvironmentBlock(out nint environment, SafeAccessTokenHandle token, bool inherit);
    [DllImport("userenv.dll")] private static extern bool DestroyEnvironmentBlock(nint environment);

    private sealed class NativeDesktopSession(SafeAccessTokenHandle token, ServiceMcpPipes pipes, string[] args, bool node, Func<bool> ownerGone)
    {
        internal SafeAccessTokenHandle Token { get; } = token;
        internal ServiceMcpPipes Pipes { get; } = pipes;
        internal string[] Args { get; } = args;
        internal bool Node { get; } = node;
        internal Func<bool> OwnerGone { get; } = ownerGone;
        internal ContainedProcess? Process;
        internal NativeUpdateWriterWitness? Witness;
        internal bool Registered;
        internal bool Updating;
        internal bool Cancelled;
        internal bool Previous;
        internal string LaunchId = "";
        internal string BootChallenge = "";
        internal string HealthChallenge = "";
        internal string Mode = "";
        internal string? Version;
        internal DataGeneration? Data;
        internal TaskCompletionSource<NativeUpdateHealthEvidence> Health = new(TaskCreationOptions.RunContinuationsAsynchronously);
        internal TaskCompletionSource<JsonObject> Ready = new(TaskCreationOptions.RunContinuationsAsynchronously);
    }
}
