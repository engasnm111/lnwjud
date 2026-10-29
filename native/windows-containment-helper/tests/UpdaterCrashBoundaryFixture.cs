using System.Diagnostics;
using System.Security.Principal;
using System.Text.Json;

namespace Lnwjud.Containment;

internal static class UpdaterCrashBoundaryFixture
{
    private const int ChildLifetimeMs = 30_000;
    private static readonly string Executable = Environment.ProcessPath ?? throw new Exception("No updater fixture executable");
    private static readonly Dictionary<string, string> EnvironmentBlock = Environment.GetEnvironmentVariables()
        .Cast<System.Collections.DictionaryEntry>()
        .ToDictionary(entry => (string)entry.Key, entry => (string)(entry.Value ?? ""));
    private static readonly JsonSerializerOptions Json = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };
    private static readonly string[] CrashBoundaries =
    [
        "before_process_create",
        "after_create_before_membership",
        "before_resume",
        "after_registration_before_resume",
        "after_resume_before_reply",
    ];

    internal static int RunChild(string[] args)
    {
        if (args.Length != 6) throw new ArgumentException("Expected marker, identity marker and caller session identity");
        using var current = WindowsIdentity.GetCurrent();
        var actual = new ChildSessionIdentity(Environment.ProcessId,
            current.User?.Value ?? throw new Exception("Fixture child SID unavailable"),
            Process.GetCurrentProcess().SessionId,
            Environment.GetFolderPath(Environment.SpecialFolder.UserProfile));
        var expectedSessionId = int.Parse(args[4], System.Globalization.NumberStyles.None, System.Globalization.CultureInfo.InvariantCulture);
        if (actual.UserSid != args[3] || actual.SessionId != expectedSessionId
            || !String.Equals(Path.GetFullPath(actual.UserProfile), Path.GetFullPath(args[5]), StringComparison.OrdinalIgnoreCase))
            throw new Exception("UPDATER_FIXTURE_CHILD_SESSION_MISMATCH");
        using (var stream = new FileStream(args[1], FileMode.Append, FileAccess.Write, FileShare.ReadWrite))
        using (var writer = new StreamWriter(stream))
        {
            writer.WriteLine(actual.ProcessId);
            writer.Flush();
        }
        using (var stream = new FileStream(args[2], FileMode.Append, FileAccess.Write, FileShare.ReadWrite))
        using (var writer = new StreamWriter(stream))
        {
            writer.WriteLine(JsonSerializer.Serialize(actual, Json));
            writer.Flush();
        }
        Console.WriteLine("UPDATER_FIXTURE_STDOUT");
        Console.Out.Flush();
        Console.Error.WriteLine("UPDATER_FIXTURE_STDERR");
        Console.Error.Flush();
        Thread.Sleep(ChildLifetimeMs);
        return 0;
    }

    internal static int RunAuthority(string[] args)
    {
        if (args.Length != 7) throw new ArgumentException("Expected crash stage, ledger path, attempt ID, marker path, pipe name, and ready path");
        var stage = args[1];
        var storePath = Path.GetFullPath(args[2]);
        var attemptId = args[3];
        var markerPath = Path.GetFullPath(args[4]);
        var pipeName = args[5];
        var readyPath = Path.GetFullPath(args[6]);
        _ = CreateAttempt(storePath, attemptId, markerPath);
        var ledger = new ServiceAttemptLedger(new ServiceAttemptLedgerPersistence(storePath));
        ContainedProcess.Fault = (faultStage, pid) =>
        {
            if (!String.Equals(faultStage, stage, StringComparison.Ordinal)) return;
            WriteTargetIdentity(pid);
            if (faultStage == "after_resume_before_reply") WaitForMarker(markerPath + ".session.jsonl");
            Environment.FailFast("Disposable updater authority crash at " + faultStage);
        };

        using var stopping = new CancellationTokenSource();
        var server = WindowsContainmentService.RunAuthenticatedTestPipeServerAsync(pipeName, ledger, stopping.Token);
        File.WriteAllText(readyPath, "ready");
        try { server.GetAwaiter().GetResult(); }
        finally { stopping.Cancel(); }
        Console.Error.WriteLine("UPDATER_FIXTURE_CRASH_BOUNDARY_NOT_REACHED " + stage);
        return 90;
    }

    internal static void RunSuite()
    {
        var root = Path.Combine(Path.GetTempPath(), "lnwjud-updater-crash-fixture-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        var complete = false;
        try
        {
            foreach (var stage in CrashBoundaries) RunBoundary(root, stage);
            complete = true;
        }
        finally
        {
            if (complete)
            {
                var absolute = Path.GetFullPath(root);
                var temporary = Path.GetFullPath(Path.GetTempPath()).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
                if (!absolute.StartsWith(temporary, StringComparison.OrdinalIgnoreCase)
                    || !Path.GetFileName(absolute).StartsWith("lnwjud-updater-crash-fixture-", StringComparison.Ordinal))
                    throw new Exception("Refusing updater fixture cleanup outside its temporary root");
                Directory.Delete(absolute, recursive: true);
            }
            else Console.Error.WriteLine("UPDATER_FIXTURE_EVIDENCE_RETAINED " + root);
        }
    }

    private static void RunBoundary(string root, string stage)
    {
        var scenarioRoot = Path.Combine(root, stage);
        Directory.CreateDirectory(scenarioRoot);
        var storePath = Path.Combine(scenarioRoot, "attempts.json");
        var markerPath = Path.Combine(scenarioRoot, "child-starts.txt");
        var readyPath = Path.Combine(scenarioRoot, "authority-ready.txt");
        var pipeName = "lnwjud-updater-" + Guid.NewGuid().ToString("N");
        var attemptId = Guid.NewGuid().ToString("D");
        var fixture = CreateAttempt(storePath, attemptId, markerPath);
        var start = new ProcessStartInfo(Executable)
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            WorkingDirectory = scenarioRoot,
        };
        start.ArgumentList.Add("updater-crash-authority");
        start.ArgumentList.Add(stage);
        start.ArgumentList.Add(storePath);
        start.ArgumentList.Add(attemptId);
        start.ArgumentList.Add(markerPath);
        start.ArgumentList.Add(pipeName);
        start.ArgumentList.Add(readyPath);
        using var authority = Process.Start(start) ?? throw new Exception("Disposable updater authority could not start");
        var stdoutTask = authority.StandardOutput.ReadToEndAsync();
        var stderrTask = authority.StandardError.ReadToEndAsync();
        var readyTimeout = Stopwatch.StartNew();
        while (!File.Exists(readyPath))
        {
            if (authority.HasExited) throw new Exception("Disposable updater authority exited before pipe readiness at " + stage);
            if (readyTimeout.ElapsedMilliseconds >= 10_000)
            {
                authority.Kill(entireProcessTree: true);
                throw new Exception("Disposable updater authority pipe did not become ready at " + stage);
            }
            Thread.Sleep(10);
        }

        byte[] Request(string command, ServiceAttemptIdentity? identity = null) =>
            JsonSerializer.SerializeToUtf8Bytes(new
            {
                protocol = 3,
                command,
                identity = identity ?? fixture.Request.Identity,
                reservationKey = fixture.Request.ReservationKey,
                operationDigest = fixture.Request.OperationDigest,
                operation = fixture.Operation,
            }, Json);
        using (var prepared = NativeTests.SendServiceRpcAsync(pipeName, Request("prepare")).GetAwaiter().GetResult())
        {
            if (!prepared.RootElement.GetProperty("ok").GetBoolean()
                || prepared.RootElement.GetProperty("result").GetProperty("phase").GetInt32() != (int)ServiceAttemptPhase.Prepared
                || !prepared.RootElement.GetProperty("result").GetProperty("reservationHeld").GetBoolean())
                throw new Exception("Authenticated updater RPC did not persist preparation before launch at " + stage);
        }

        var runTask = NativeTests.SendServiceRpcAsync(pipeName, Request("run"));
        if (!authority.WaitForExit(20_000))
        {
            authority.Kill(entireProcessTree: true);
            throw new Exception("Disposable updater authority did not exit at " + stage);
        }
        try
        {
            using var unexpected = runTask.GetAwaiter().GetResult();
            throw new Exception("Updater authority replied instead of crashing at " + stage);
        }
        catch (Exception error) when (error is IOException or OperationCanceledException or TimeoutException)
        {
            if (!authority.WaitForExit(5_000))
            {
                authority.Kill(entireProcessTree: true);
                _ = authority.WaitForExit(5_000);
                throw new Exception("UPDATER_FIXTURE_AUTHORITY_DID_NOT_CRASH_AFTER_RUN_RPC_DISCONNECT " + stage, error);
            }
        }
        if (!Task.WaitAll([stdoutTask, stderrTask], TimeSpan.FromSeconds(8)))
            throw new Exception("UPDATER_FIXTURE_STDIO_HANDLES_REMAIN_OPEN_AFTER_AUTHORITY_EXIT " + stage);
        if (authority.ExitCode == 0) throw new Exception("Updater authority crash was reported as success at " + stage);

        var identityLine = stdoutTask.Result.Split(["\r\n", "\n"], StringSplitOptions.RemoveEmptyEntries).SingleOrDefault();
        if (identityLine is null) throw new Exception("UPDATER_FIXTURE_TARGET_IDENTITY_MISSING " + stage + ": " + stderrTask.Result);
        var identity = identityLine.Split(':', StringSplitOptions.None);
        if (identity.Length != 2) throw new Exception("UPDATER_FIXTURE_TARGET_IDENTITY_INVALID " + stage);
        var targetPid = int.Parse(identity[0], System.Globalization.NumberStyles.None, System.Globalization.CultureInfo.InvariantCulture);
        var targetStartTicks = long.Parse(identity[1], System.Globalization.NumberStyles.None, System.Globalization.CultureInfo.InvariantCulture);
        var beforeCreate = stage == "before_process_create";
        var expectedStarted = stage == "after_resume_before_reply";
        if ((beforeCreate && (targetPid != 0 || targetStartTicks != 0))
            || (!beforeCreate && (targetPid <= 0 || targetStartTicks <= 0)))
            throw new Exception("UPDATER_FIXTURE_TARGET_PID_MISSING " + stage);
        if (targetPid != 0) WaitForExactProcessExit(targetPid, targetStartTicks);

        var starts = ReadStarts(markerPath);
        if (starts.Count != (expectedStarted ? 1 : 0))
            throw new Exception("UPDATER_FIXTURE_CHILD_START_COUNT_INVALID " + stage + " count=" + starts.Count);
        if (expectedStarted && starts[0] != targetPid)
            throw new Exception("UPDATER_FIXTURE_CHILD_PID_MISMATCH " + stage);
        var sessionIdentities = ReadSessionIdentities(markerPath + ".session.jsonl");
        if (sessionIdentities.Count != (expectedStarted ? 1 : 0))
            throw new Exception("UPDATER_FIXTURE_CHILD_SESSION_EVIDENCE_MISSING " + stage);
        if (expectedStarted)
        {
            var expectedSid = WindowsIdentity.GetCurrent().User?.Value ?? throw new Exception("Fixture caller SID unavailable");
            var expectedSessionId = Process.GetCurrentProcess().SessionId;
            var expectedProfile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            var actual = sessionIdentities[0];
            if (actual.ProcessId != targetPid || actual.UserSid != expectedSid || actual.SessionId != expectedSessionId
                || !String.Equals(Path.GetFullPath(actual.UserProfile), Path.GetFullPath(expectedProfile), StringComparison.OrdinalIgnoreCase))
                throw new Exception("UPDATER_FIXTURE_CHILD_SESSION_MISMATCH " + stage);
        }

        var recovered = new ServiceAttemptLedger(new ServiceAttemptLedgerPersistence(storePath));
        var recoveryPipeName = "lnwjud-updater-recovery-" + Guid.NewGuid().ToString("N");
        using var recoveryStopping = new CancellationTokenSource(TimeSpan.FromSeconds(30));
        var recoveryServer = WindowsContainmentService.RunAuthenticatedTestPipeServerAsync(recoveryPipeName, recovered, recoveryStopping.Token);
        try
        {
            using var afterRestartResponse = NativeTests.SendServiceRpcAsync(recoveryPipeName, Request("inspect")).GetAwaiter().GetResult();
            if (!afterRestartResponse.RootElement.GetProperty("ok").GetBoolean())
                throw new Exception("Updater RPC could not reauthenticate after authority restart at " + stage);
            var afterRestart = afterRestartResponse.RootElement.GetProperty("result");
            var recoveredIdentity = afterRestart.GetProperty("identity");
            if (recoveredIdentity.GetProperty("attemptId").GetString() != fixture.Request.Identity.AttemptId
                || recoveredIdentity.GetProperty("ownerSessionId").GetString() != fixture.Request.Identity.OwnerSessionId)
                throw new Exception("UPDATER_FIXTURE_REAUTHENTICATED_SESSION_IDENTITY_CHANGED " + stage);
            var differentSession = fixture.Request.Identity with { OwnerSessionId = "updater-fixture-other-session" };
            using var wrongSession = NativeTests.SendServiceRpcAsync(recoveryPipeName, Request("inspect", differentSession)).GetAwaiter().GetResult();
            if (wrongSession.RootElement.GetProperty("ok").GetBoolean()
                || wrongSession.RootElement.GetProperty("error").GetString() != "SERVICE_OWNER_MISMATCH")
                throw new Exception("UPDATER_FIXTURE_DIFFERENT_SESSION_REAUTHENTICATED " + stage);

            var registrationPersisted = stage is "after_registration_before_resume" or "after_resume_before_reply";
            var expectedPhase = registrationPersisted ? ServiceAttemptPhase.TerminalVerified : ServiceAttemptPhase.TerminationUnknown;
            if (afterRestart.GetProperty("phase").GetInt32() != (int)expectedPhase
                || afterRestart.GetProperty("activeProcesses").ValueKind != (registrationPersisted ? System.Text.Json.JsonValueKind.Number : System.Text.Json.JsonValueKind.Null)
                || (registrationPersisted && afterRestart.GetProperty("activeProcesses").GetInt32() != 0)
                || afterRestart.GetProperty("reservationHeld").GetBoolean() == registrationPersisted
                || (registrationPersisted && afterRestart.GetProperty("outcome").GetInt32() != (int)ServiceProcessOutcome.Interrupted))
                throw new Exception("UPDATER_FIXTURE_RESTART_STATE_NOT_RECONCILED " + stage);

            using var retryPrepared = NativeTests.SendServiceRpcAsync(recoveryPipeName, Request("prepare")).GetAwaiter().GetResult();
            if (!retryPrepared.RootElement.GetProperty("ok").GetBoolean())
                throw new Exception("UPDATER_FIXTURE_RETRY_PREPARATION_FAILED_CLOSED " + stage);
            using var retried = NativeTests.SendServiceRpcAsync(recoveryPipeName, Request("run")).GetAwaiter().GetResult();
            if (!retried.RootElement.GetProperty("ok").GetBoolean())
                throw new Exception("UPDATER_FIXTURE_RETRY_RUN_FAILED_CLOSED " + stage);
            using var retryInspection = NativeTests.SendServiceRpcAsync(recoveryPipeName, Request("inspect")).GetAwaiter().GetResult();
            if (!retryInspection.RootElement.GetProperty("ok").GetBoolean()
                || retryInspection.RootElement.GetProperty("result").GetProperty("phase").GetInt32() != (int)expectedPhase)
                throw new Exception("UPDATER_FIXTURE_RETRY_CHANGED_TERMINAL_STATE " + stage);
            if (ReadStarts(markerPath).Count != starts.Count)
                throw new Exception("UPDATER_FIXTURE_REPLAY_STARTED_DUPLICATE_CHILD " + stage);
            Console.WriteLine("PASS updater authenticated pipe crash boundary " + stage + " => " + expectedPhase);
        }
        finally
        {
            recoveryStopping.Cancel();
            try { recoveryServer.WaitAsync(TimeSpan.FromSeconds(5)).GetAwaiter().GetResult(); }
            catch (OperationCanceledException) { }
        }
    }

    private static CrashAttempt CreateAttempt(string storePath, string attemptId, string markerPath)
    {
        var workspace = Path.GetDirectoryName(Path.GetFullPath(storePath))!;
        var environment = EnvironmentBlock
            .OrderBy(pair => pair.Key, StringComparer.OrdinalIgnoreCase)
            .ToDictionary(pair => pair.Key, pair => pair.Value, StringComparer.OrdinalIgnoreCase);
        var callerSid = WindowsIdentity.GetCurrent().User?.Value ?? throw new Exception("Fixture caller SID unavailable");
        var callerSessionId = Process.GetCurrentProcess().SessionId;
        var callerProfile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        var operation = new ServiceProcessOperation("run_process", Executable,
            ["updater-crash-child", markerPath, markerPath + ".session.jsonl", callerSid,
                callerSessionId.ToString(System.Globalization.CultureInfo.InvariantCulture), callerProfile],
            workspace, ChildLifetimeMs, false, environment, 4096);
        var operationBytes = JsonSerializer.SerializeToUtf8Bytes(operation, Json);
        var digest = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(operationBytes)).ToLowerInvariant();
        var identity = new ServiceAttemptIdentity("updater-fixture-task-" + attemptId,
            "updater-fixture-reservation-" + attemptId, attemptId, 1, digest,
            "updater-fixture-client", "updater-fixture-session", "updater-fixture-workspace");
        var request = new ServiceAttemptRequest(identity, callerSid, Path.Combine(workspace, "writer-reservation"), digest, Shared: false);
        return new CrashAttempt(request, operation);
    }

    private static void WriteTargetIdentity(uint pid)
    {
        var startTicks = 0L;
        if (pid != 0)
        {
            using var process = Process.GetProcessById(checked((int)pid));
            startTicks = process.StartTime.ToUniversalTime().Ticks;
        }
        Console.WriteLine(pid.ToString(System.Globalization.CultureInfo.InvariantCulture) + ":"
            + startTicks.ToString(System.Globalization.CultureInfo.InvariantCulture));
        Console.Out.Flush();
    }

    private static void WaitForMarker(string markerPath)
    {
        var timeout = Stopwatch.StartNew();
        while (!File.Exists(markerPath) || new FileInfo(markerPath).Length == 0)
        {
            if (timeout.ElapsedMilliseconds >= 10_000) throw new IOException("UPDATER_FIXTURE_CHILD_START_NOT_OBSERVED");
            Thread.Sleep(10);
        }
    }

    private static List<int> ReadStarts(string markerPath)
    {
        if (!File.Exists(markerPath)) return [];
        return File.ReadAllLines(markerPath).Select(value => int.Parse(value, System.Globalization.CultureInfo.InvariantCulture)).ToList();
    }

    private static List<ChildSessionIdentity> ReadSessionIdentities(string markerPath)
    {
        if (!File.Exists(markerPath)) return [];
        return File.ReadAllLines(markerPath).Select(value => JsonSerializer.Deserialize<ChildSessionIdentity>(value, Json)
            ?? throw new Exception("UPDATER_FIXTURE_CHILD_SESSION_EVIDENCE_INVALID")).ToList();
    }

    private static void WaitForExactProcessExit(int pid, long expectedStartTicks)
    {
        var expectedImage = Path.GetFullPath(Executable);
        var timeout = Stopwatch.StartNew();
        Process process;
        try
        {
            process = Process.GetProcessById(pid);
        }
        catch (ArgumentException)
        {
            return;
        }

        using (process)
        {
            while (true)
            {
                if (process.HasExited) return;
                var actualStartTicks = process.StartTime.ToUniversalTime().Ticks;
                if (actualStartTicks != expectedStartTicks) return;
                var actualImage = Path.GetFullPath(process.MainModule?.FileName ?? "");
                if (!String.Equals(actualImage, expectedImage, StringComparison.OrdinalIgnoreCase))
                    throw new Exception("UPDATER_FIXTURE_TARGET_IMAGE_CHANGED");
                if (timeout.ElapsedMilliseconds >= 5_000)
                {
                    try
                    {
                        if (!process.HasExited && process.StartTime.ToUniversalTime().Ticks == expectedStartTicks
                            && String.Equals(Path.GetFullPath(process.MainModule?.FileName ?? ""), expectedImage, StringComparison.OrdinalIgnoreCase))
                        {
                            process.Kill(entireProcessTree: true);
                            _ = process.WaitForExit(5_000);
                        }
                    }
                    catch (Exception) { }
                    throw new Exception("UPDATER_FIXTURE_CONTAINED_CHILD_SURVIVED_AUTHORITY_CRASH");
                }
                Thread.Sleep(10);
            }
        }
    }

    private sealed record CrashAttempt(ServiceAttemptRequest Request, ServiceProcessOperation Operation);
    private sealed record ChildSessionIdentity(int ProcessId, string UserSid, int SessionId, string UserProfile);
}
