using System.Diagnostics;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;

namespace Lnwjud.Containment;

internal static class NativeTests
{
    [StructLayout(LayoutKind.Sequential)] private struct Startup { public uint Size; public nint Reserved, Desktop, Title; public uint X, Y, Width, Height, XChars, YChars, Fill, Flags; public ushort Show, ReservedSize; public nint ReservedPointer, Input, Output, Error; }
    [StructLayout(LayoutKind.Sequential)] private struct ProcessInfo { public nint Process, Thread; public uint ProcessId, ThreadId; }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool CreateProcess(string application, StringBuilder command, nint processSecurity, nint threadSecurity, bool inherit, uint flags, nint environment, string cwd, ref Startup startup, out ProcessInfo info);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(nint handle);
    [DllImport("kernel32.dll")] private static extern bool TerminateProcess(nint handle, uint exit);
    private static readonly string Executable = Environment.ProcessPath ?? throw new Exception("No test executable");
    private static readonly Dictionary<string, string> EnvironmentBlock = Environment.GetEnvironmentVariables().Cast<System.Collections.DictionaryEntry>().ToDictionary(entry => (string)entry.Key, entry => (string)(entry.Value ?? ""));

    private static int Main(string[] args)
    {
        if (args.Length > 0)
        {
            switch (args[0])
            {
                case "noop": return 0;
                case "pipe-acl": ServicePipeSecurityTests.Run(); return 0;
                case "stale-tunnel-alias": StaleTunnelAliasTests.Run(); return 0;
                case "endpoint-probe":
                    if (args.Length != 2) throw new ArgumentException("Expected installed service executable path");
                    try
                    {
                        var expectedHash = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(File.ReadAllBytes(args[1]))).ToLowerInvariant();
                        using var endpointPipe = new NamedPipeClientStream(".", WindowsContainmentService.PipeName, PipeDirection.InOut, PipeOptions.Asynchronous);
                        endpointPipe.Connect(5000);
                        using var verified = ServiceEndpointIdentity.VerifyConnectedServer(endpointPipe.SafePipeHandle, expectedHash);
                        verified.Revalidate();
                        Console.WriteLine("ENDPOINT_PROBE_OK");
                        return 0;
                    }
                    catch (Exception failure)
                    {
                        var code = System.Text.RegularExpressions.Regex.IsMatch(failure.Message, "^[A-Z][A-Z0-9_]{1,127}$") ? failure.Message : failure.GetType().Name;
                        Console.Error.WriteLine("ENDPOINT_PROBE_FAILED " + code);
                        return 125;
                    }
                case "rpc-probe":
                    if (args.Length != 2) throw new ArgumentException("Expected installed service executable path");
                    try
                    {
                        var sha = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(File.ReadAllBytes(args[1]))).ToLowerInvariant();
                        var identity = new ServiceAttemptIdentity(Guid.NewGuid().ToString("D"), Guid.NewGuid().ToString("D"), Guid.NewGuid().ToString("D"), 1,
                            new string('0', 64), "endpoint-probe", "endpoint-probe", "endpoint-probe");
                        var request = System.Text.Json.JsonSerializer.SerializeToUtf8Bytes(new { protocol = 3, command = "inspect", identity },
                            new System.Text.Json.JsonSerializerOptions { PropertyNamingPolicy = System.Text.Json.JsonNamingPolicy.CamelCase });
                        var response = WindowsContainmentServiceClient.SendAsync(sha, request).GetAwaiter().GetResult();
                        using var document = System.Text.Json.JsonDocument.Parse(response);
                        var error = document.RootElement.GetProperty("error").GetString();
                        if (document.RootElement.GetProperty("ok").GetBoolean()) throw new IOException("UNEXPECTED_PROBE_ATTEMPT");
                        Console.WriteLine("RPC_PROBE_REPLY " + (error is not null && System.Text.RegularExpressions.Regex.IsMatch(error, "^[A-Z][A-Z0-9_]{1,127}$") ? error : "SERVICE_REPLY_ERROR"));
                        return 0;
                    }
                    catch (Exception failure)
                    {
                        var code = System.Text.RegularExpressions.Regex.IsMatch(failure.Message, "^[A-Z][A-Z0-9_]{1,127}$") ? failure.Message : failure.GetType().Name;
                        Console.Error.WriteLine("RPC_PROBE_FAILED " + code);
                        return 125;
                    }
                case "exec-probe":
                    if (args.Length != 2) throw new ArgumentException("Expected installed service executable path");
                    try
                    {
                        var sha = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(File.ReadAllBytes(args[1]))).ToLowerInvariant();
                        var id = Guid.NewGuid().ToString("D");
                        var op = new ServiceProcessOperation("run_process", @"C:\Windows\System32\cmd.exe", new[] { "/c", "echo", "HELLO" }, @"C:\Windows\System32", 10000, false, new Dictionary<string, string>(), 128 * 1024);
                        var opBytes = System.Text.Json.JsonSerializer.SerializeToUtf8Bytes(op, new System.Text.Json.JsonSerializerOptions { PropertyNamingPolicy = System.Text.Json.JsonNamingPolicy.CamelCase });
                        var opDigest = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(opBytes)).ToLowerInvariant();
                        var identity = new ServiceAttemptIdentity(id, id, id, 1, opDigest, "endpoint-probe", "endpoint-probe", "endpoint-probe");
                        var prepReq = System.Text.Json.JsonSerializer.SerializeToUtf8Bytes(new { protocol = 3, command = "prepare", identity, reservationKey = "global-managed-writers", operation = op },
                            new System.Text.Json.JsonSerializerOptions { PropertyNamingPolicy = System.Text.Json.JsonNamingPolicy.CamelCase });
                        var prepRes = WindowsContainmentServiceClient.SendAsync(sha, prepReq).GetAwaiter().GetResult();
                        Console.WriteLine("PREP_REPLY: " + Encoding.UTF8.GetString(prepRes));
                        var runReq = System.Text.Json.JsonSerializer.SerializeToUtf8Bytes(new { protocol = 3, command = "run", identity, operation = op },
                            new System.Text.Json.JsonSerializerOptions { PropertyNamingPolicy = System.Text.Json.JsonNamingPolicy.CamelCase });
                        var runRes = WindowsContainmentServiceClient.SendAsync(sha, runReq).GetAwaiter().GetResult();
                        Console.WriteLine("RUN_REPLY: " + Encoding.UTF8.GetString(runRes));
                        return 0;
                    }
                    catch (Exception failure)
                    {
                        Console.Error.WriteLine("EXEC_PROBE_FAILED: " + failure);
                        return 125;
                    }
                case "import-suite":
                    var importRoot = Path.Combine(Path.GetTempPath(), "lnwjud-native-import-suite-" + Guid.NewGuid().ToString("N"));
                    Directory.CreateDirectory(importRoot);
                    try
                    {
                        TestSharedWriterImportPromotion();
                        Console.WriteLine("PASS isolated import shared-writer promotion");
                        TestServiceImportTransactions(importRoot);
                        Console.WriteLine("PASS isolated import stage, owner binding and restart persistence");
                        TestServiceImportPublicationRecovery(importRoot);
                        Console.WriteLine("PASS isolated import publication, cancellation, collision and recovery");
                        TestServiceImportRpcAsync(importRoot).GetAwaiter().GetResult();
                        Console.WriteLine("PASS isolated authenticated service import RPC");
                        return 0;
                    }
                    finally { Console.WriteLine("NATIVE_IMPORT_SUITE_PROTECTED_EVIDENCE_RETAINED " + importRoot); }
                case "output-tests":
                    TestOutputWaitsForReservationRelease().GetAwaiter().GetResult();
                    TestCancellationWaitsForReservationRelease().GetAwaiter().GetResult();
                    TestServiceRpcIdentityAndReservationsAsync();
                    TestOutputReaderFailure().GetAwaiter().GetResult();
                    TestOutputStoreRetention();
                    Console.WriteLine("PASS service output cursors, restart, bounds, corruption, owner binding and persistence failure");
                    return 0;
                case "output-pattern":
                    Console.Write("ก😀" + new string('x', 300_000));
                    Console.Error.Write(new string('e', 300_000));
                    return 0;
                case "sleep": Thread.Sleep(int.Parse(args[1], System.Globalization.CultureInfo.InvariantCulture)); return 0;
                case "emit-sleep": Console.Write("NATIVE_STDOUT"); Console.Out.Flush(); Console.Error.Write("NATIVE_STDERR"); Console.Error.Flush(); Thread.Sleep(int.Parse(args[1], System.Globalization.CultureInfo.InvariantCulture)); return 0;
                case "mark": File.WriteAllText(args[1], "unexpected target execution"); return 0;
                case "breakaway":
                    var startup = new Startup { Size = (uint)Marshal.SizeOf<Startup>() };
                    var accepted = CreateProcess(Executable, new StringBuilder("\"" + Executable + "\" noop"), 0, 0, false, 0x01000000 | 0x08000000, 0, Environment.CurrentDirectory, ref startup, out var escaped);
                    if (accepted) { TerminateProcess(escaped.Process, 1); CloseHandle(escaped.Process); CloseHandle(escaped.Thread); throw new Exception("BREAKAWAY_ACCEPTED"); }
                    if (Marshal.GetLastWin32Error() != 5) throw new Exception("Unexpected breakaway error");
                    Console.Write("BREAKAWAY_REFUSED"); return 0;
                case "nested":
                    var nested = ContainedProcess.Capture(Executable, ["noop"], Environment.CurrentDirectory, EnvironmentBlock, 5000, 1024);
                    if (nested != "") throw new Exception("Unexpected nested output"); Console.Write("NESTED_JOB_EMPTY"); return 0;
                case "crash":
                    ContainedProcess.Fault = (stage, pid) => { if (stage == args[1]) { Console.WriteLine(pid); Console.Out.Flush(); Environment.FailFast("Native test fault " + stage); } };
                    using (ContainedProcess.Start(Executable, ["mark", args[2]], Environment.CurrentDirectory, false, EnvironmentBlock)) { }
                    throw new Exception("Crash injection was not reached");
            }
        }
        var root = Path.Combine(Path.GetTempPath(), "lnwjud-native-fault-" + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(root);
        try
        {
            if (!WindowsContainmentServiceClient.ShouldWaitForOutput(ServiceAttemptPhase.Prepared)
                || !WindowsContainmentServiceClient.ShouldWaitForOutput(ServiceAttemptPhase.DispatchCommitted)
                || WindowsContainmentServiceClient.ShouldWaitForOutput(ServiceAttemptPhase.LaunchNotStarted)
                || WindowsContainmentServiceClient.ShouldWaitForOutput(ServiceAttemptPhase.Running)
                || WindowsContainmentServiceClient.ShouldWaitForOutput(ServiceAttemptPhase.TerminalVerified)
                || WindowsContainmentServiceClient.ShouldWaitForOutput(ServiceAttemptPhase.TerminationUnknown))
                throw new Exception("SERVICE_WATCHER_OUTPUT_PUBLICATION_ORDER_INVALID");
            Console.WriteLine("PASS service watcher waits for output publication after native dispatch");
            TestServiceStoreCreation(root);
            Console.WriteLine("PASS protected store DACL applies at creation and existing untrusted store remains unchanged");
            TestServiceAccessControl();
            Console.WriteLine("PASS service installer and store accept read-only ACLs and reject applicable untrusted mutation rights");
            TestServiceInstallPathValidation();
            Console.WriteLine("PASS protected service install layout and command quoting");
            TestServiceEndpointImagePolicy(root);
            Console.WriteLine("PASS protected service image may differ from the portable client and rejects hash or account mismatch");
            TestServiceAttemptLedger();
            Console.WriteLine("PASS service attempt ownership, reservation, and terminal release lifecycle");
            TestLaunchTokenFailureBeforeDispatch();
            Console.WriteLine("PASS token setup failure releases only a proved never-started native attempt");
            TestSharedWriterImportPromotion();
            Console.WriteLine("PASS shared ordinary writers and exclusive import reservation promotion");
            TestServiceImportTransactions(root);
            Console.WriteLine("PASS service import transaction binds native identities and recovers publication without replay");
            TestServiceImportPublicationRecovery(root);
            Console.WriteLine("PASS interrupted native publication recovers by identity and never replays a rename or replaces a collision");
            TestImportValidationOwnerState();
            Console.WriteLine("PASS terminal, unknown, and never-started attempts cannot launch import validation");
            TestServiceImportTimeoutFence(root).GetAwaiter().GetResult();
            Console.WriteLine("PASS native timeout persists import cancellation before stopping its outer Job");
            TestDurableServiceAttemptLedger();
            Console.WriteLine("PASS crash recovery keeps unknown reservations and persists terminal release");
            TestServiceRestartAndJobReconciliation();
            Console.WriteLine("PASS service restart reconciles dead jobs, preserves live descendants, and cancels cleanly");
            TestServicePipeRefusesPreexistingInstance();
            ServicePipeSecurityTests.Run();
            StaleTunnelAliasTests.Run();
            Console.WriteLine("PASS service pipe refuses pre-existing pipe instances");
            TestAuthenticatedPipeCallerCapture();
            Console.WriteLine("PASS pipe caller SID and primary token come from the connected kernel-authenticated client");
            TestCallerLaunchSessionPolicy();
            Console.WriteLine("PASS headless launch session policy preserves caller security and fails closed on mismatch");
            TestOutputWaitsForReservationRelease().GetAwaiter().GetResult();
            TestCancellationWaitsForReservationRelease().GetAwaiter().GetResult();
            TestServiceRpcIdentityAndReservationsAsync();
            Console.WriteLine("PASS service RPC derives caller identity from the pipe and persists admission before replying");
            TestOutputReaderFailure().GetAwaiter().GetResult();
            Console.WriteLine("PASS output reader failure preserves native Job-zero termination and released reservation");
            TestServiceImportRpcAsync(root).GetAwaiter().GetResult();
            Console.WriteLine("PASS authenticated service import RPC retains its transaction through native process completion");
            TestProfileKeyIsNotExported();
            Console.WriteLine("PASS receipt authority is not exported to the caller");
            var breakaway = ContainedProcess.Capture(Executable, ["breakaway"], root, EnvironmentBlock, 5000, 1024);
            if (breakaway != "BREAKAWAY_REFUSED") throw new Exception("Breakaway test failed");
            Console.WriteLine("PASS explicit CREATE_BREAKAWAY_FROM_JOB refused");
            var nested = ContainedProcess.Capture(Executable, ["nested"], root, EnvironmentBlock, 5000, 1024);
            if (nested != "NESTED_JOB_EMPTY") throw new Exception("Nested Job test failed");
            Console.WriteLine("PASS creation-time nested Job membership and zero-active completion");
            var pendingCancellation = false;
            var cancellationTargetPid = 0u;
            ContainedProcess.Fault = (stage, pid) => { if (stage == "before_resume") { cancellationTargetPid = pid; pendingCancellation = true; } };
            try
            {
                using var unexpected = ContainedProcess.Start(Executable, ["mark", Path.Combine(root, "cancelled-before-resume")], root, false, EnvironmentBlock, cancellationRequested: () => pendingCancellation);
                throw new Exception("Pending cancellation resumed its target");
            }
            catch (OperationCanceledException) { }
            finally { ContainedProcess.Fault = null; }
            if (cancellationTargetPid == 0) throw new Exception("Cancellation did not reach suspended target");
            try { using var target = Process.GetProcessById((int)cancellationTargetPid); if (!target.WaitForExit(5000)) throw new Exception("Cancelled suspended target survived"); } catch (ArgumentException) { }
            if (File.Exists(Path.Combine(root, "cancelled-before-resume"))) throw new Exception("Cancelled target executed");
            Console.WriteLine("PASS pending cancellation terminates suspended target before resume");
            var dispatchMarker = Path.Combine(root, "failed-dispatch-commit");
            var dispatchTargetPid = 0u;
            var dispatchOrder = new StringBuilder();
            ContainedProcess.Fault = (stage, pid) =>
            {
                if (stage == "before_resume") { dispatchTargetPid = pid; dispatchOrder.Append("membership"); }
            };
            try
            {
                try
                {
                    using var unexpected = ContainedProcess.Start(
                        Executable,
                        ["mark", dispatchMarker],
                        root,
                        false,
                        EnvironmentBlock,
                        beforeResume: _ => { dispatchOrder.Append("/commit"); throw new IOException("DISPATCH_PERSIST_FAILED"); });
                    throw new Exception("Dispatch persistence failure resumed its target");
                }
                catch (IOException exception) when (exception.Message == "DISPATCH_PERSIST_FAILED") { }
            }
            finally { ContainedProcess.Fault = null; }
            if (dispatchTargetPid == 0 || dispatchOrder.ToString() != "membership/commit")
                throw new Exception("Dispatch commit did not run after verified Job membership");
            try { using var target = Process.GetProcessById((int)dispatchTargetPid); if (!target.WaitForExit(5000)) throw new Exception("Uncommitted suspended target survived"); } catch (ArgumentException) { }
            if (File.Exists(dispatchMarker)) throw new Exception("Target executed before durable dispatch commit");
            Console.WriteLine("PASS failed pre-resume dispatch commit kills the contained suspended target");
            foreach (var stage in new[] { "after_create_before_membership", "before_resume" })
            {
                var marker = Path.Combine(root, stage);
                using var helper = Process.Start(new ProcessStartInfo(Executable) { ArgumentList = { "crash", stage, marker }, UseShellExecute = false, RedirectStandardOutput = true, RedirectStandardError = true, CreateNoWindow = true }) ?? throw new Exception("Fault helper unavailable");
                var stdout = helper.StandardOutput.ReadToEndAsync(); var stderr = helper.StandardError.ReadToEndAsync();
                if (!helper.WaitForExit(20000)) { helper.Kill(true); throw new Exception("Fault helper did not exit"); }
                // A suspended escaped target can inherit the crashing helper's pipe and
                // keep ReadToEnd open forever. Fail this native security test rather
                // than hiding the containment leak behind an unbounded wait.
                if (!Task.WaitAll([stdout, stderr], TimeSpan.FromSeconds(8)))
                    throw new Exception("FAULT_HELPER_STDIO_HANDLES_REMAIN_OPEN_AFTER_EXIT");
                if (helper.ExitCode == 0) throw new Exception("Fault helper returned success");
                if (!int.TryParse(stdout.Result.Trim(), out var targetPid)) throw new Exception("Fault target identity missing");
                try { using var target = Process.GetProcessById(targetPid); if (!target.WaitForExit(5000)) throw new Exception("Suspended target survived helper crash"); } catch (ArgumentException) { }
                Thread.Sleep(300);
                if (File.Exists(marker)) throw new Exception("Target escaped creation-time Job on helper crash");
                Console.WriteLine("PASS helper crash " + stage + " does not resume or leak target execution");
            }
            return 0;
        }
        finally
        {
            var absolute = Path.GetFullPath(root);
            var temporary = Path.GetFullPath(Path.GetTempPath()).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
            if (!absolute.StartsWith(temporary, StringComparison.OrdinalIgnoreCase)
                || !Path.GetFileName(absolute).StartsWith("lnwjud-native-fault-", StringComparison.Ordinal))
                throw new Exception("Refusing native test cleanup outside its temporary root");
            foreach (var file in Directory.EnumerateFiles(absolute, "*", new EnumerationOptions { RecurseSubdirectories = true, AttributesToSkip = FileAttributes.ReparsePoint }))
                File.SetAttributes(file, File.GetAttributes(file) & ~FileAttributes.ReadOnly);
            Directory.Delete(absolute, true);
        }
    }

    private static void TestServiceStoreCreation(string root)
    {
        var currentUser = WindowsIdentity.GetCurrent().User ?? throw new Exception("Missing current user SID");
        var system = new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null);
        var administrators = new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null);
        var parent = Directory.CreateDirectory(Path.Combine(root, "store-acl-parent"));
        var parentSecurity = new DirectorySecurity();
        parentSecurity.SetSecurityDescriptorSddlForm("O:" + currentUser.Value + "G:BAD:P(A;;FA;;;" + currentUser.Value
            + ")(A;OICIIO;GA;;;CO)(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1200a9;;;BU)(A;CI;0x116;;;BU)",
            AccessControlSections.Owner | AccessControlSections.Access);
        parent.SetAccessControl(parentSecurity);

        var suppliedSecurity = new DirectorySecurity();
        suppliedSecurity.SetAccessRuleProtection(true, false);
        suppliedSecurity.SetOwner(currentUser);
        var inheritance = InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit;
        suppliedSecurity.AddAccessRule(new FileSystemAccessRule(currentUser, FileSystemRights.FullControl, inheritance, PropagationFlags.None, AccessControlType.Allow));
        suppliedSecurity.AddAccessRule(new FileSystemAccessRule(system, FileSystemRights.FullControl, inheritance, PropagationFlags.None, AccessControlType.Allow));
        suppliedSecurity.AddAccessRule(new FileSystemAccessRule(administrators, FileSystemRights.FullControl, inheritance, PropagationFlags.None, AccessControlType.Allow));

        var create = typeof(WindowsContainmentService).GetMethod("CreateStoreDirectory", System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Static)
            ?? throw new Exception("Missing store creation seam");
        void ExpectOwnerRefusal(string path, DirectorySecurity security)
        {
            try { create.Invoke(null, [path, security]); }
            catch (System.Reflection.TargetInvocationException failure) when (failure.InnerException is IOException { Message: "SERVICE_STORE_OWNER_REFUSED" }) { return; }
            throw new Exception("Current-user fixture was accepted as a SYSTEM or Administrators owned store");
        }

        var legacy = Directory.CreateDirectory(Path.Combine(parent.FullName, "legacy-inherited-store"));
        var legacySecurity = legacy.GetAccessControl(AccessControlSections.Owner | AccessControlSections.Access);
        var users = new SecurityIdentifier(WellKnownSidType.BuiltinUsersSid, null);
        if (legacySecurity.AreAccessRulesProtected
            || !legacySecurity.GetAccessRules(true, true, typeof(SecurityIdentifier)).Cast<FileSystemAccessRule>()
                .Any(rule => rule.IsInherited && rule.AccessControlType == AccessControlType.Allow
                    && rule.IdentityReference.Equals(users) && (rule.FileSystemRights & FileSystemRights.WriteData) != 0))
            throw new Exception("Copied ProgramData fixture did not expose legacy inherited user write access");

        var createdPath = Path.Combine(parent.FullName, "protected-store");
        ExpectOwnerRefusal(createdPath, suppliedSecurity);
        var actualSecurity = new DirectoryInfo(createdPath).GetAccessControl(AccessControlSections.Owner | AccessControlSections.Access);
        var actualRules = actualSecurity.GetAccessRules(true, true, typeof(SecurityIdentifier)).Cast<FileSystemAccessRule>().ToArray();
        if (!actualSecurity.AreAccessRulesProtected || actualRules.Any(rule => rule.IsInherited)
            || actualRules.Any(rule => rule.IdentityReference.Equals(users)
                || rule.IdentityReference.Equals(new SecurityIdentifier(WellKnownSidType.CreatorOwnerSid, null))))
            throw new Exception("Store creation inherited untrusted ProgramData permissions before validation");
        if (!actualSecurity.GetOwner(typeof(SecurityIdentifier))!.Equals(currentUser)
            || !actualRules.Any(rule => rule.IdentityReference.Equals(currentUser) && (rule.FileSystemRights & FileSystemRights.FullControl) == FileSystemRights.FullControl))
            throw new Exception("Store creation did not apply the supplied protected descriptor");

        var existingPath = Path.Combine(parent.FullName, "existing-untrusted-store");
        var existing = suppliedSecurity.CreateDirectory(existingPath);
        var unsafeSecurity = existing.GetAccessControl(AccessControlSections.Owner | AccessControlSections.Access);
        unsafeSecurity.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(WellKnownSidType.AuthenticatedUserSid, null),
            FileSystemRights.WriteData, inheritance, PropagationFlags.InheritOnly, AccessControlType.Allow));
        existing.SetAccessControl(unsafeSecurity);
        var marker = Path.Combine(existingPath, "attempts.json");
        File.WriteAllText(marker, "untrusted fixture data");
        var before = existing.GetAccessControl(AccessControlSections.Owner | AccessControlSections.Access).GetSecurityDescriptorBinaryForm();
        var productionSecurity = new DirectorySecurity();
        productionSecurity.SetAccessRuleProtection(true, false);
        productionSecurity.SetOwner(system);
        productionSecurity.AddAccessRule(new FileSystemAccessRule(system, FileSystemRights.FullControl, inheritance, PropagationFlags.None, AccessControlType.Allow));
        productionSecurity.AddAccessRule(new FileSystemAccessRule(administrators, FileSystemRights.FullControl, inheritance, PropagationFlags.None, AccessControlType.Allow));
        ExpectOwnerRefusal(existingPath, productionSecurity);
        var after = existing.GetAccessControl(AccessControlSections.Owner | AccessControlSections.Access).GetSecurityDescriptorBinaryForm();
        if (!before.AsSpan().SequenceEqual(after) || File.ReadAllText(marker) != "untrusted fixture data")
            throw new Exception("Existing untrusted store security or persisted data was silently repaired");
    }

    private static void TestServiceAccessControl()
    {
        var failures = new List<string>();
        var checks = 0;
        void Check(string name, Action verify)
        {
            checks++;
            try { verify(); }
            catch (Exception failure)
            {
                failures.Add(name + ": " + failure.Message);
                Console.WriteLine("FAIL ACL " + name + ": " + failure.Message);
            }
        }
        static void Invoke(Type type, string methodName, params object[] arguments)
        {
            var method = type.GetMethod(methodName, System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Static)
                ?? throw new Exception("Missing ACL validator " + methodName);
            try { method.Invoke(null, arguments); }
            catch (System.Reflection.TargetInvocationException failure) when (failure.InnerException is not null)
            {
                System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(failure.InnerException).Throw();
            }
        }
        static DirectorySecurity DirectoryAcl(string ace, string owner = "BA")
        {
            var security = new DirectorySecurity();
            security.SetSecurityDescriptorSddlForm("O:" + owner + "G:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)" + ace);
            return security;
        }

        var installer = typeof(WindowsContainmentServiceInstaller);
        var service = typeof(WindowsContainmentService);
        var programFiles = Path.GetFullPath(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles));
        Check("real Program Files ancestor", () => Invoke(installer, "VerifyProtectedAncestors", Path.Combine(programFiles, "lnwjud"), programFiles));

        var helperDirectory = new DirectorySecurity();
        var system = new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null);
        var administrators = new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null);
        var users = new SecurityIdentifier(WellKnownSidType.AuthenticatedUserSid, null);
        helperDirectory.SetOwner(administrators);
        helperDirectory.SetAccessRuleProtection(true, false);
        var inheritance = InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit;
        helperDirectory.AddAccessRule(new FileSystemAccessRule(system, FileSystemRights.FullControl, inheritance, PropagationFlags.None, AccessControlType.Allow));
        helperDirectory.AddAccessRule(new FileSystemAccessRule(administrators, FileSystemRights.FullControl, inheritance, PropagationFlags.None, AccessControlType.Allow));
        helperDirectory.AddAccessRule(new FileSystemAccessRule(users, FileSystemRights.ReadAndExecute, inheritance, PropagationFlags.None, AccessControlType.Allow));
        Check("generated helper directory AU read and execute", () => Invoke(installer, "EnsureProtectedAcl", helperDirectory));
        var helperFile = new FileSecurity();
        helperFile.SetOwner(administrators);
        helperFile.SetAccessRuleProtection(true, false);
        helperFile.AddAccessRule(new FileSystemAccessRule(system, FileSystemRights.FullControl, AccessControlType.Allow));
        helperFile.AddAccessRule(new FileSystemAccessRule(administrators, FileSystemRights.FullControl, AccessControlType.Allow));
        helperFile.AddAccessRule(new FileSystemAccessRule(users, FileSystemRights.ReadAndExecute, AccessControlType.Allow));
        Check("generated helper file AU read and execute", () => Invoke(installer, "EnsureProtectedAcl", helperFile));

        var validators = new (string Name, Action<DirectorySecurity> Verify, string WriteError, string OwnerError)[]
        {
            ("installer", security => Invoke(installer, "EnsureProtectedAcl", security), "SERVICE_INSTALL_ACL_UNTRUSTED", "SERVICE_INSTALL_OWNER_UNTRUSTED"),
            ("store", security => Invoke(service, "EnsureStoreAcl", security), "SERVICE_STORE_WRITE_ACL_REFUSED", "SERVICE_STORE_OWNER_REFUSED"),
        };
        foreach (var validator in validators)
        {
            foreach (var rights in new[] { "FRFX", "GR", "GX", "GRGX", "0x00120089", "0x00100000" })
            {
                Check(validator.Name + " accepts " + rights, () => validator.Verify(DirectoryAcl("(A;;" + rights + ";;;AU)")));
                Check(validator.Name + " accepts inherited " + rights, () => validator.Verify(DirectoryAcl("(A;ID;" + rights + ";;;AU)")));
            }
            if (validator.Name == "installer")
            {
                Check("installer ignores inherit-only Creator Owner generic all", () => validator.Verify(DirectoryAcl("(A;OICIIO;GA;;;CO)")));
                Check("installer ignores inherit-only user generic write", () => validator.Verify(DirectoryAcl("(A;OICIIO;GW;;;AU)")));
            }
            else
            {
                Check("store rejects inherit-only Creator Owner generic all", () => ExpectFailure<IOException>(
                    () => validator.Verify(DirectoryAcl("(A;OICIIO;GA;;;CO)")), validator.WriteError));
                foreach (var flags in new[] { "OI", "CI", "OICI", "OIIO", "CIIO", "OICIIO" })
                {
                    foreach (var inherited in new[] { "", "ID" })
                    {
                        var aceFlags = flags + inherited;
                        foreach (var rights in new[] { "0x2", "0x4", "0x10", "0x40", "0x100", "0x10000", "0x40000", "0x80000", "FW", "FA", "GW", "GA" })
                            Check("store rejects " + aceFlags + " " + rights, () => ExpectFailure<IOException>(
                                () => validator.Verify(DirectoryAcl("(A;" + aceFlags + ";" + rights + ";;;AU)")), validator.WriteError));
                        foreach (var rights in new[] { "GR", "GX", "GRGX", "FRFX" })
                            Check("store accepts " + aceFlags + " " + rights, () => validator.Verify(DirectoryAcl("(A;" + aceFlags + ";" + rights + ";;;AU)")));
                        foreach (var principal in new[] { "SY", "BA" })
                            Check("store accepts trusted " + principal + " " + aceFlags + " GA", () => validator.Verify(DirectoryAcl("(A;" + aceFlags + ";GA;;;" + principal + ")")));
                        foreach (var rights in new[] { "FW", "GW", "GA" })
                            Check("store accepts deny-only " + aceFlags + " " + rights, () => validator.Verify(DirectoryAcl("(D;" + aceFlags + ";" + rights + ";;;AU)")));
                    }
                }
            }
            Check(validator.Name + " accepts deny-only generic write", () => validator.Verify(DirectoryAcl("(D;;GW;;;AU)")));
            Check(validator.Name + " accepts system owner", () => validator.Verify(DirectoryAcl("", "SY")));
            Check(validator.Name + " rejects untrusted owner", () => ExpectFailure<IOException>(
                () => validator.Verify(DirectoryAcl("", "S-1-5-21-42-42-42-1001")), validator.OwnerError));

            foreach (var rights in new[] { "0x2", "0x4", "0x10", "0x40", "0x100", "0x10000", "0x40000", "0x80000", "FW", "FA", "GW", "GA" })
            {
                Check(validator.Name + " rejects " + rights, () => ExpectFailure<IOException>(
                    () => validator.Verify(DirectoryAcl("(A;;" + rights + ";;;AU)")), validator.WriteError));
                Check(validator.Name + " rejects inherited " + rights, () => ExpectFailure<IOException>(
                    () => validator.Verify(DirectoryAcl("(A;ID;" + rights + ";;;AU)")), validator.WriteError));
            }
        }
        if (failures.Count != 0) throw new Exception("Service ACL regression checks failed " + failures.Count + "/" + checks);
        Console.WriteLine("PASS ACL " + checks + " checks including real Program Files and both service ACL policies");
    }

    private static void TestServiceInstallPathValidation()
    {
        var programFiles = Path.GetFullPath(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles));
        var installRoot = Path.Combine(programFiles, "lnwjud");
        var helperPath = Path.Combine(installRoot, "resources", "native-containment", "lnwjud-containment.exe");
        var validatedRoot = WindowsContainmentServiceInstaller.ValidateImagePath(helperPath, programFiles);
        if (!String.Equals(validatedRoot, installRoot, StringComparison.OrdinalIgnoreCase))
            throw new Exception("Protected install root did not resolve canonically");
        var expectedCommand = "\"" + Path.GetFullPath(helperPath) + "\" service";
        if (!String.Equals(WindowsContainmentServiceInstaller.BuildServiceCommand(helperPath), expectedCommand, StringComparison.Ordinal))
            throw new Exception("Service image command was not quoted exactly");
        var outside = Path.Combine(Path.GetTempPath(), "native-containment", "lnwjud-containment.exe");
        ExpectFailure<IOException>(() => WindowsContainmentServiceInstaller.ValidateImagePath(outside, programFiles), "SERVICE_INSTALL_ROOT_UNPROTECTED");
        var wrongLayout = Path.Combine(installRoot, "resources", "other", "lnwjud-containment.exe");
        ExpectFailure<IOException>(() => WindowsContainmentServiceInstaller.ValidateImagePath(wrongLayout, programFiles), "SERVICE_INSTALL_LAYOUT_INVALID");
    }

    private static void TestServiceAttemptLedger()
    {
        var ledger = new ServiceAttemptLedger();
        var reservationKey = Path.GetFullPath(Path.Combine(Path.GetTempPath(), "lnwjud-ledger-" + Guid.NewGuid().ToString("N")));
        var request = NewServiceAttemptRequest("attempt-1", reservationKey);

        var prepared = ledger.Prepare(request);
        if (prepared.Phase != ServiceAttemptPhase.Prepared || !prepared.ReservationHeld)
            throw new Exception("Service attempt was not prepared with its reservation");
        if (ledger.Prepare(request) != prepared)
            throw new Exception("Repeated prepare did not return the original attempt");
        // Before Run commits, the prepared attempt has no output snapshot.
        // Reading it at watcher startup is a real SERVICE_OUTPUT_UNAVAILABLE race.
        var prelaunchRuntime = new WindowsServiceProcessRuntime(ledger, useCurrentUserTestLauncher: true);
        ExpectFailure<IOException>(
            () => prelaunchRuntime.ReadOutput(request.Identity, request.AuthenticatedCallerSid),
            "SERVICE_OUTPUT_UNAVAILABLE");
        if (!WindowsContainmentServiceClient.ShouldWaitForOutput(prepared.Phase))
            throw new Exception("Watcher would read output before dispatch");

        var overlapping = NewServiceAttemptRequest("attempt-2", reservationKey.ToUpperInvariant());
        ExpectFailure<IOException>(() => ledger.Prepare(overlapping), "WRITER_RESERVATION_BUSY");
        ExpectFailure<UnauthorizedAccessException>(() => ledger.Inspect(request.Identity, "S-1-5-21-2000"), "ATTEMPT_OWNER_MISMATCH");

        if (!ledger.TryCommitDispatch(request.Identity, request.AuthenticatedCallerSid, request.OperationDigest)
            || ledger.TryCommitDispatch(request.Identity, request.AuthenticatedCallerSid, request.OperationDigest))
            throw new Exception("Dispatch was not committed exactly once");
        var running = ledger.MarkRunning(request.Identity, request.AuthenticatedCallerSid, 4242);
        if (running.Phase != ServiceAttemptPhase.Running || running.TargetPid != 4242 || !running.ReservationHeld)
            throw new Exception("Running attempt lost its process or reservation identity");

        var unknown = ledger.MarkUnknown(request.Identity, request.AuthenticatedCallerSid, "service-restart-ambiguous");
        if (unknown.Phase != ServiceAttemptPhase.TerminationUnknown || !unknown.ReservationHeld)
            throw new Exception("Ambiguous termination released its reservation");
        if (ledger.Release(request.Identity, request.AuthenticatedCallerSid) != ReservationRelease.Retained)
            throw new Exception("Unknown attempt did not retain its reservation");
        ExpectFailure<IOException>(() => ledger.RecordTerminal(request.Identity, request.AuthenticatedCallerSid, ServiceProcessOutcome.Completed, 0, 1), "ACTIVE_PROCESSES_REMAIN");

        var terminal = ledger.RecordTerminal(request.Identity, request.AuthenticatedCallerSid, ServiceProcessOutcome.Completed, 0, 0);
        if (terminal.Phase != ServiceAttemptPhase.TerminalVerified || terminal.ActiveProcesses != 0 || !terminal.ReservationHeld)
            throw new Exception("Terminal proof was not recorded before reservation release");
        if (ledger.RecordTerminal(request.Identity, request.AuthenticatedCallerSid, ServiceProcessOutcome.Completed, 0, 0) != terminal)
            throw new Exception("Repeated terminal proof was not idempotent");
        if (ledger.Release(request.Identity, request.AuthenticatedCallerSid) != ReservationRelease.Released
            || ledger.Release(request.Identity, request.AuthenticatedCallerSid) != ReservationRelease.AlreadyReleased)
            throw new Exception("Verified terminal reservation did not release idempotently");

        var next = ledger.Prepare(overlapping);
        if (next.Phase != ServiceAttemptPhase.Prepared || !next.ReservationHeld)
            throw new Exception("A verified release did not admit the next writer");
        var aborted = ledger.AbortBeforeLaunch(overlapping);
        if (aborted.Phase != ServiceAttemptPhase.LaunchNotStarted || !aborted.ReservationHeld)
            throw new Exception("Prelaunch abort was not durably represented before release");
        if (ledger.AbortBeforeLaunch(overlapping) != aborted)
            throw new Exception("Repeated prelaunch abort was not idempotent");
        ExpectFailure<IOException>(() => ledger.TryCommitDispatch(overlapping.Identity, overlapping.AuthenticatedCallerSid, overlapping.OperationDigest), "ATTEMPT_ALREADY_ABORTED");
        if (ledger.Release(overlapping.Identity, overlapping.AuthenticatedCallerSid) != ReservationRelease.Released)
            throw new Exception("Verified prelaunch abort did not release its reservation");

        var earlyRequest = NewServiceAttemptRequest(
            "attempt-before-prepare",
            Path.GetFullPath(Path.Combine(Path.GetTempPath(), "lnwjud-ledger-abort-" + Guid.NewGuid().ToString("N"))));
        var earlyAbortRequest = earlyRequest with { OperationDigest = earlyRequest.Identity.RequestDigest };
        var earlyAborted = ledger.AbortBeforeLaunch(earlyAbortRequest);
        if (earlyAborted.Phase != ServiceAttemptPhase.LaunchNotStarted || !earlyAborted.ReservationHeld)
            throw new Exception("Abort before prepare did not persist a held no-replay tombstone");
        if (ledger.AbortBeforeLaunch(earlyAbortRequest) != earlyAborted)
            throw new Exception("Abort before prepare was not idempotent");
        if (ledger.Prepare(earlyAbortRequest) != earlyAborted)
            throw new Exception("Exact prepare replay did not return the permanent abort tombstone");
        ExpectFailure<IOException>(() => ledger.Prepare(earlyRequest), "ATTEMPT_ID_CONFLICT");
        var earlyOverlap = NewServiceAttemptRequest("attempt-before-prepare-overlap", earlyRequest.ReservationKey);
        ExpectFailure<IOException>(() => ledger.Prepare(earlyOverlap), "WRITER_RESERVATION_BUSY");
        ExpectFailure<IOException>(
            () => ledger.TryCommitDispatch(earlyAbortRequest.Identity, earlyAbortRequest.AuthenticatedCallerSid, earlyAbortRequest.OperationDigest),
            "ATTEMPT_ALREADY_ABORTED");
        if (ledger.Release(earlyAbortRequest.Identity, earlyAbortRequest.AuthenticatedCallerSid) != ReservationRelease.Released)
            throw new Exception("Verified early abort did not release its reservation");
        var afterEarlyRelease = ledger.Prepare(earlyAbortRequest);
        if (afterEarlyRelease.Phase != ServiceAttemptPhase.LaunchNotStarted || afterEarlyRelease.ReservationHeld)
            throw new Exception("Released tombstone allowed prepare replay or reacquired its reservation");
    }

    private static void TestLaunchTokenFailureBeforeDispatch()
    {
        var ledger = new ServiceAttemptLedger();
        var runtime = new WindowsServiceProcessRuntime(ledger, useCurrentUserTestLauncher: true);
        var operation = new ServiceProcessOperation("run_process", Executable, ["noop"], Environment.CurrentDirectory,
            10000, false, EnvironmentBlock, 1024);
        var first = NewServiceAttemptRequest("failed-token-setup", ServiceAttemptLedger.GlobalReservationKey);
        _ = ledger.Prepare(first);
        ExpectFailure<IOException>(
            () => WindowsContainmentService.RunWithLaunchToken(ledger, runtime, first.Identity,
                first.AuthenticatedCallerSid, first.OperationDigest, operation,
                () => throw new IOException("SIMULATED_TOKEN_SETUP_FAILURE")),
            "SIMULATED_TOKEN_SETUP_FAILURE");
        var neverStarted = ledger.Inspect(first.Identity, first.AuthenticatedCallerSid);
        if (neverStarted.Phase != ServiceAttemptPhase.LaunchNotStarted || neverStarted.ReservationHeld
            || ledger.Release(first.Identity, first.AuthenticatedCallerSid) != ReservationRelease.AlreadyReleased)
            throw new Exception("Failed pre-dispatch token setup retained an unnecessary reservation");

        var second = NewServiceAttemptRequest("concurrent-dispatch", ServiceAttemptLedger.GlobalReservationKey);
        _ = ledger.Prepare(second);
        if (!ledger.TryCommitDispatch(second.Identity, second.AuthenticatedCallerSid, second.OperationDigest))
            throw new Exception("Concurrent test attempt did not commit dispatch");
        ExpectFailure<IOException>(
            () => WindowsContainmentService.RunWithLaunchToken(ledger, runtime, second.Identity,
                second.AuthenticatedCallerSid, second.OperationDigest, operation,
                () => throw new IOException("SIMULATED_TOKEN_SETUP_FAILURE")),
            "SIMULATED_TOKEN_SETUP_FAILURE");
        var dispatched = ledger.Inspect(second.Identity, second.AuthenticatedCallerSid);
        if (dispatched.Phase != ServiceAttemptPhase.DispatchCommitted || !dispatched.ReservationHeld
            || ledger.Release(second.Identity, second.AuthenticatedCallerSid) != ReservationRelease.Retained)
            throw new Exception("Token setup failure illegally cleared a dispatched reservation");
    }

    private static void TestServiceEndpointImagePolicy(string root)
    {
        var programFiles = Path.Combine(root, "test-program-files");
        var currentUser = WindowsIdentity.GetCurrent().User ?? throw new Exception("Missing current user SID");
        var programFilesDir = Directory.CreateDirectory(programFiles);
        var programFilesSecurity = new DirectorySecurity();
        programFilesSecurity.SetSecurityDescriptorSddlForm("O:" + currentUser.Value + "G:BAD:P(A;OICI;FA;;;" + currentUser.Value + ")(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)",
            AccessControlSections.Owner | AccessControlSections.Access);
        programFilesDir.SetAccessControl(programFilesSecurity);
        var image = Path.Combine(programFiles, "lnwjud", "resources", "native-containment", "lnwjud-containment.exe");
        Directory.CreateDirectory(Path.GetDirectoryName(image)!);
        File.WriteAllText(image, "protected service fixture");
        var expected = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(File.ReadAllBytes(image))).ToLowerInvariant();
        if (String.Equals(image, Executable, StringComparison.OrdinalIgnoreCase)) throw new Exception("Image policy test did not use a distinct client executable");
        WindowsContainmentServiceClient.ValidateServerImage(image, programFiles, expected);
        var linked = Path.Combine(programFiles, "lnwjud-linked", "resources", "native-containment", "lnwjud-containment.exe");
        Directory.CreateDirectory(Path.GetDirectoryName(linked)!);
        File.CreateSymbolicLink(linked, image);
        ExpectFailure<IOException>(() => WindowsContainmentServiceClient.ValidateServerImage(linked, programFiles, expected), "SERVICE_ENDPOINT_REPARSE_PATH");
        ExpectFailure<IOException>(() => WindowsContainmentServiceClient.ValidateServerImage(image, programFiles, new string('0', 64)), "SERVICE_ENDPOINT_PACKAGE_MISMATCH");
        ExpectFailure<IOException>(() => WindowsContainmentServiceClient.ValidateServerImage(Executable, programFiles, expected), "SERVICE_INSTALL_ROOT_UNPROTECTED");
        WindowsContainmentServiceClient.ValidateServerAccount("S-1-5-18");
        ExpectFailure<IOException>(() => WindowsContainmentServiceClient.ValidateServerAccount("S-1-5-21-1000"), "SERVICE_ENDPOINT_NOT_SYSTEM");
        var publish = System.Text.Json.JsonSerializer.SerializeToUtf8Bytes(new
        {
            protocol = 3, command = "control", controlCommand = "publish_import",
            controlRequest = new { workspaceRoot = Path.Combine(root, "workspace"), destination = "repo",
                stagePath = Path.Combine(root, ".lnwjud-import-stage-" + Guid.NewGuid().ToString()), commit = new string('a', 40),
                privateHome = root, expectedStageIdentity = "0000000000000001-" + new string('A', 32) },
        });
        if (WindowsContainmentServiceClient.RequestTimeout(publish) != TimeSpan.FromSeconds(115))
            throw new Exception("Validated import publication did not get its bounded validation timeout");
        var run = System.Text.Json.JsonSerializer.SerializeToUtf8Bytes(new { protocol = 3, command = "run" });
        if (WindowsContainmentServiceClient.RequestTimeout(run) != TimeSpan.FromSeconds(25))
            throw new Exception("A native process launch must have a bounded service dispatch timeout");
        var inspect = System.Text.Json.JsonSerializer.SerializeToUtf8Bytes(new { protocol = 3, command = "inspect" });
        if (WindowsContainmentServiceClient.RequestTimeout(inspect) != TimeSpan.FromSeconds(10))
            throw new Exception("Ordinary RPC received the import publication timeout");
    }

    private static ServiceAttemptRequest NewServiceAttemptRequest(string attemptId, string reservationKey) =>
        new(
            new ServiceAttemptIdentity(
                "task-" + attemptId,
                "reservation-" + attemptId,
                attemptId,
                1,
                new string('a', 64),
                "client-1",
                "session-1",
                "workspace-1"),
            "S-1-5-21-1000",
            reservationKey,
            new string('b', 64));

    private static void TestSharedWriterImportPromotion()
    {
        var ledger = new ServiceAttemptLedger();
        var first = NewServiceAttemptRequest("shared-first", ServiceAttemptLedger.GlobalReservationKey) with { Shared = true };
        var second = NewServiceAttemptRequest("shared-second", ServiceAttemptLedger.GlobalReservationKey) with { Shared = true };
        ledger.Prepare(first);
        ledger.Prepare(second);
        ledger.TryCommitDispatch(first.Identity, first.AuthenticatedCallerSid, first.OperationDigest);
        ledger.MarkRunning(first.Identity, first.AuthenticatedCallerSid, 1001);
        ExpectFailure<IOException>(() => ledger.AcquireImportReservation(first.Identity, first.AuthenticatedCallerSid), "WRITER_RESERVATION_BUSY");
        ledger.AbortBeforeLaunch(second);
        ledger.Release(second.Identity, second.AuthenticatedCallerSid);
        ledger.AcquireImportReservation(first.Identity, first.AuthenticatedCallerSid);
        ExpectFailure<IOException>(() => ledger.Prepare(NewServiceAttemptRequest("blocked-by-import", ServiceAttemptLedger.GlobalReservationKey) with { Shared = true }), "WRITER_RESERVATION_BUSY");
        ledger.RecordTerminal(first.Identity, first.AuthenticatedCallerSid, ServiceProcessOutcome.Completed, 0, 0);
        if (ledger.Release(first.Identity, first.AuthenticatedCallerSid) != ReservationRelease.Retained)
            throw new Exception("Native process completion released an unfinished import");
        ledger.CompleteImportReservation(first.Identity, first.AuthenticatedCallerSid);
        if (ledger.Inspect(first.Identity, first.AuthenticatedCallerSid).ReservationHeld)
            throw new Exception("Completed import did not release a previously verified terminal process");
        ledger.Prepare(NewServiceAttemptRequest("admitted-after-import", ServiceAttemptLedger.GlobalReservationKey) with { Shared = true });
    }

    private static void TestServiceImportTransactions(string root)
    {
        var directory = Path.Combine(root, "import-transaction");
        Directory.CreateDirectory(directory);
        var workspace = Path.Combine(directory, "workspace");
        var home = Path.Combine(directory, "home");
        Directory.CreateDirectory(workspace);
        Directory.CreateDirectory(home);
        var stage = Path.Combine(directory, ".lnwjud-import-stage-" + Guid.NewGuid().ToString());
        using var caller = System.Security.Principal.WindowsIdentity.GetCurrent();
        var sid = caller.User?.Value ?? throw new Exception("No test SID");
        var request = NewServiceAttemptRequest("import-transaction", ServiceAttemptLedger.GlobalReservationKey) with { AuthenticatedCallerSid = sid, Shared = true };
        var store = Path.Combine(directory, "attempts.json");
        var importStore = Path.Combine(directory, "imports");
        var ledger = new ServiceAttemptLedger(new ServiceAttemptLedgerPersistence(store), importStore);
        ledger.Prepare(request);
        ledger.TryCommitDispatch(request.Identity, sid, request.OperationDigest);
        ledger.MarkRunning(request.Identity, sid, Environment.ProcessId);
        var runtime = new ServiceImportTransactionRuntime(ledger, importStore, useCurrentUserTestLauncher: true);
        var operation = System.Text.Json.JsonSerializer.SerializeToElement(new { workspaceRoot = workspace, destination = "repo", stagePath = stage, commit = new string('a', 40), privateHome = home });
        var prepared = runtime.Control("prepare_import", request.Identity, sid, operation, caller.AccessToken);
        if (prepared.Result.State != "prepared" || !Directory.Exists(stage)) throw new Exception("Service did not create its bound private stage");
        if (runtime.Control("prepare_import", request.Identity, sid, operation, caller.AccessToken) != prepared)
            throw new Exception("Prepare replay changed the transaction");
        var reopened = new ServiceAttemptLedger(new ServiceAttemptLedgerPersistence(store), importStore);
        var recovered = new ServiceImportTransactionRuntime(reopened, importStore, useCurrentUserTestLauncher: true);
        if (recovered.Inspect("prepare_import", request.Identity, sid, caller.AccessToken) != prepared)
            throw new Exception("Prepared native identity did not survive service restart");
        ExpectFailure<UnauthorizedAccessException>(() => recovered.Inspect("prepare_import", request.Identity, "S-1-5-21-9999", caller.AccessToken), "ATTEMPT_OWNER_MISMATCH");
        var changed = System.Text.Json.JsonSerializer.SerializeToElement(new { workspaceRoot = workspace, destination = "other", stagePath = stage, commit = new string('a', 40), privateHome = home });
        ExpectFailure<IOException>(() => recovered.Control("prepare_import", request.Identity, sid, changed, caller.AccessToken), "SERVICE_IMPORT_REQUEST_CONFLICT");
        if (!reopened.Inspect(request.Identity, sid).ReservationHeld) throw new Exception("Unknown import released after restart");
        var recordFile = Directory.GetFiles(importStore, "*.json").Single();
        File.WriteAllText(recordFile, "{");
        ExpectFailure<IOException>(() => recovered.Inspect("prepare_import", request.Identity, sid, caller.AccessToken), "SERVICE_IMPORT_STORE_CORRUPT");
        if (!reopened.Inspect(request.Identity, sid).ReservationHeld) throw new Exception("Corrupt import metadata released its reservation");
    }

    private static void TestServiceImportPublicationRecovery(string root)
    {
        var scenarioIndex = 0;
        foreach (var scenario in new[] { "after_native_publish", "after_publication_intent", "collision", "cancel_before_control",
            "cancel_during_validation", "cancel_before_publication_commit", "timeout_before_publication_commit", "cancel_after_publication_commit" })
        {
            // Git for Windows defaults to MAX_PATH-sensitive loose-object paths.
            // Keep native-security fixture paths bounded regardless of CI TEMP
            // depth; the complete scenario still appears in assertion messages.
            var directory = Path.Combine(root, "p" + scenarioIndex++);
            Directory.CreateDirectory(directory);
            var workspace = Path.Combine(directory, "workspace");
            var home = Path.Combine(directory, "home");
            var source = Path.Combine(directory, "source");
            Directory.CreateDirectory(workspace);
            Directory.CreateDirectory(home);
            Directory.CreateDirectory(source);
            var git = Path.Combine(Path.GetPathRoot(Environment.GetFolderPath(Environment.SpecialFolder.Windows))!, "Program Files", "Git", "cmd", "git.exe");
            var gitEnvironment = new Dictionary<string, string>(EnvironmentBlock, StringComparer.OrdinalIgnoreCase)
            { ["GIT_CONFIG_NOSYSTEM"] = "1", ["GIT_CONFIG_GLOBAL"] = "NUL", ["GIT_TERMINAL_PROMPT"] = "0", ["GCM_INTERACTIVE"] = "never", ["GIT_TRACE"] = "0", ["GIT_TRACE_SETUP"] = "0" };
            string Git(params string[] arguments) => ContainedProcess.Capture(git, ["-c", "core.fsmonitor=false", "-c", "commit.gpgsign=false", .. arguments], home, gitEnvironment, 15000, 1024 * 1024);
            Git("init", "--initial-branch=dev", source);
            Git("-C", source, "-c", "core.hooksPath=NUL", "-c", "user.name=Native Test", "-c", "user.email=native-test@example.invalid", "commit", "--allow-empty", "-m", "fixture");
            var commit = Git("-C", source, "rev-parse", "HEAD").Trim();
            var stage = Path.Combine(directory, ".lnwjud-import-stage-" + Guid.NewGuid().ToString());
            using var caller = System.Security.Principal.WindowsIdentity.GetCurrent();
            var sid = caller.User!.Value;
            var request = NewServiceAttemptRequest("import-publication-" + scenario, ServiceAttemptLedger.GlobalReservationKey) with { AuthenticatedCallerSid = sid, Shared = true };
            var store = Path.Combine(directory, "attempts.json");
            var importStore = Path.Combine(directory, "imports");
            var ledger = new ServiceAttemptLedger(new ServiceAttemptLedgerPersistence(store), importStore);
            ledger.Prepare(request);
            ledger.TryCommitDispatch(request.Identity, sid, request.OperationDigest);
            ledger.MarkRunning(request.Identity, sid, Environment.ProcessId);
            var runtime = new ServiceImportTransactionRuntime(ledger, importStore, useCurrentUserTestLauncher: true);
            var operation = System.Text.Json.JsonSerializer.SerializeToElement(new { workspaceRoot = workspace, destination = "repo", stagePath = stage, commit, privateHome = home });
            var prepared = runtime.Control("prepare_import", request.Identity, sid, operation, caller.AccessToken);
            // The native publication test needs a valid fixture checkout, not
            // Git's clone optimization: on Windows scanners may temporarily
            // deny loose-object unlink or pack keep-file creation in a fresh
            // SID-restricted staging directory. Copy only this locally created
            // fixture repository into the already anchored private stage; the
            // native control still performs real contained Git HEAD/index/status
            // validation and checks the same NTFS stage identity before rename.
            foreach (var sourceFile in Directory.EnumerateFiles(source, "*", SearchOption.AllDirectories))
            {
                var destinationFile = Path.Combine(stage, Path.GetRelativePath(source, sourceFile));
                Directory.CreateDirectory(Path.GetDirectoryName(destinationFile)!);
                File.Copy(sourceFile, destinationFile);
            }
            var publication = System.Text.Json.JsonSerializer.SerializeToElement(new { workspaceRoot = workspace, destination = "repo", stagePath = stage, commit, privateHome = home, expectedStageIdentity = prepared.Result.NativeIdentity });
            var destination = Path.Combine(workspace, "repo");
            if (scenario == "cancel_before_control")
            {
                ledger.RecordTerminal(request.Identity, sid, ServiceProcessOutcome.Cancelled, 1, 0);
                var rejected = false;
                try { runtime.Control("publish_import", request.Identity, sid, publication, caller.AccessToken); }
                catch (IOException) { rejected = true; }
                if (!rejected || Directory.Exists(destination) || !ledger.Inspect(request.Identity, sid).ReservationHeld)
                    throw new Exception("A cancelled outer attempt still published its repository");
                continue;
            }
            if (scenario is "cancel_during_validation" or "cancel_before_publication_commit" or "timeout_before_publication_commit" or "cancel_after_publication_commit")
            {
                using var paused = new ManualResetEventSlim();
                using var resume = new ManualResetEventSlim();
                var validationStarts = 0;
                var publications = 0;
                var pausePoint = scenario == "cancel_during_validation" ? "validation_started"
                    : scenario == "cancel_after_publication_commit" ? "after_publication_intent" : "before_publication_commit";
                ServiceImportTransactionRuntime.Fault = point =>
                {
                    if (point == "validation_started") Interlocked.Increment(ref validationStarts);
                    if (point == "after_native_publish") Interlocked.Increment(ref publications);
                    if (point != pausePoint) return;
                    paused.Set();
                    if (!resume.Wait(TimeSpan.FromSeconds(10))) throw new Exception("Publication cancellation test did not resume");
                };
                var worker = Task.Run(() =>
                {
                    try { return (Result: runtime.Control("publish_import", request.Identity, sid, publication, caller.AccessToken), Failure: (IOException?)null); }
                    catch (IOException exception) { return (Result: (ServiceControlObservation?)null, Failure: exception); }
                });
                try
                {
                    if (!paused.Wait(TimeSpan.FromSeconds(10))) throw new Exception("Publication cancellation test did not reach " + pausePoint);
                    var startsAtCancellation = validationStarts;
                    var cancellation = ledger.RequestCancellation(request.Identity, sid);
                    if (!cancellation.CancellationRequested || cancellation.PublicationCommitted != (scenario == "cancel_after_publication_commit"))
                        throw new Exception("Cancellation and publication did not linearize in ledger order");
                    var persisted = new ServiceAttemptLedger(new ServiceAttemptLedgerPersistence(store), importStore).Inspect(request.Identity, sid);
                    if (!persisted.CancellationRequested || persisted.PublicationCommitted != cancellation.PublicationCommitted)
                        throw new Exception("Cancellation fence was not durable before native work continued");
                    ledger.RecordTerminal(request.Identity, sid, scenario == "timeout_before_publication_commit" ? ServiceProcessOutcome.TimedOut : ServiceProcessOutcome.Cancelled, 1, 0);
                    resume.Set();
                    var finished = worker.GetAwaiter().GetResult();
                    var final = ledger.Inspect(request.Identity, sid);
                    if (validationStarts != startsAtCancellation) throw new Exception("Cancellation started another service Git validation process");
                    if (scenario == "cancel_after_publication_commit")
                    {
                        if (finished.Failure is not null || finished.Result?.Result.State != "published" || !Directory.Exists(destination)
                            || publications != 1 || final.ReservationHeld || !final.PublicationCommitted || !final.CancellationRequested)
                            throw new Exception("Committed publication did not report its actual native result after cancellation");
                        var retry = runtime.Control("publish_import", request.Identity, sid, publication, caller.AccessToken);
                        if (retry != finished.Result || publications != 1 || validationStarts != startsAtCancellation)
                            throw new Exception("Committed publication retry replayed native work");
                    }
                    else if (finished.Failure?.Message != "SERVICE_IMPORT_CANCELLED" || Directory.Exists(destination)
                        || publications != 0 || !final.ReservationHeld || !Directory.Exists(stage))
                        throw new Exception("Cancellation winning before commit allowed native publication or released an unresolved import");
                    Console.WriteLine("TEST_CANCELLATION_ORDER " + scenario + " git=" + validationStarts + " rename=" + publications);
                }
                finally
                {
                    resume.Set();
                    try { worker.Wait(TimeSpan.FromSeconds(15)); } catch { }
                    ServiceImportTransactionRuntime.Fault = null;
                }
                continue;
            }
            if (scenario == "collision")
            {
                Directory.CreateDirectory(destination);
                File.WriteAllText(Path.Combine(destination, "existing.txt"), "preserve");
            }
            ServiceImportTransactionRuntime.Fault = point => { if (point == scenario) throw new IOException("SERVICE_TEST_PUBLICATION_INTERRUPTION"); };
            var refused = false;
            try { runtime.Control("publish_import", request.Identity, sid, publication, caller.AccessToken); }
            catch (IOException exception)
            {
                Console.WriteLine("TEST_PUBLICATION_FAULT " + scenario + " " + exception.Message);
                if (scenario == "collision" ? !exception.Message.StartsWith("IMPORT_PUBLICATION_REFUSED_", StringComparison.Ordinal)
                    : exception.Message != "SERVICE_TEST_PUBLICATION_INTERRUPTION") throw;
                refused = true;
            }
            finally { ServiceImportTransactionRuntime.Fault = null; }
            if (!refused) throw new Exception("Publication test did not reach its fault or collision");
            ledger.RecordTerminal(request.Identity, sid, ServiceProcessOutcome.Completed, 0, 0);
            if (ledger.Release(request.Identity, sid) != ReservationRelease.Retained)
                throw new Exception("Interrupted import released before native publication reconciliation");
            var reopened = new ServiceAttemptLedger(new ServiceAttemptLedgerPersistence(store), importStore);
            var recovered = new ServiceImportTransactionRuntime(reopened, importStore, useCurrentUserTestLauncher: true);
            if (scenario == "after_native_publish")
            {
                Directory.CreateDirectory(stage);
                File.WriteAllText(Path.Combine(stage, "replacement.txt"), "preserve replacement");
                var published = recovered.Inspect("publish_import", request.Identity, sid, caller.AccessToken);
                if (published.Result.State != "published" || published.Result.NativeIdentity != prepared.Result.NativeIdentity
                    || reopened.Inspect(request.Identity, sid).ReservationHeld)
                    throw new Exception("Native identity recovery did not complete the original published transaction");
                if (!File.Exists(Path.Combine(stage, "replacement.txt"))) throw new Exception("Recovery touched a replacement staging path");
                if (recovered.Control("publish_import", request.Identity, sid, publication, caller.AccessToken) != published)
                    throw new Exception("Published retry did not inspect its original native identity");
            }
            else
            {
                refused = false;
                try { recovered.Control("publish_import", request.Identity, sid, publication, caller.AccessToken); }
                catch (IOException) { refused = true; }
                if (!refused || !Directory.Exists(stage) || !reopened.Inspect(request.Identity, sid).ReservationHeld)
                    throw new Exception("Unknown publication was replayed or its reservation was released");
                if (scenario == "collision" && File.ReadAllText(Path.Combine(destination, "existing.txt")) != "preserve")
                    throw new Exception("Publication replaced an existing destination");
                if (scenario == "after_publication_intent" && Directory.Exists(destination))
                    throw new Exception("Retry replayed a native rename after publication intent");
            }
        }
    }

    private static void TestImportValidationOwnerState()
    {
        foreach (var phase in new[] { "completed", "unknown", "not_started" })
        {
            var ledger = new ServiceAttemptLedger();
            var request = NewServiceAttemptRequest("import-owner-" + phase, ServiceAttemptLedger.GlobalReservationKey) with { Shared = true };
            ledger.Prepare(request);
            if (phase == "not_started") ledger.RequestCancellation(request.Identity, request.AuthenticatedCallerSid);
            else
            {
                ledger.TryCommitDispatch(request.Identity, request.AuthenticatedCallerSid, request.OperationDigest);
                ledger.MarkRunning(request.Identity, request.AuthenticatedCallerSid, Environment.ProcessId);
                ledger.AcquireImportReservation(request.Identity, request.AuthenticatedCallerSid);
                if (phase == "completed") ledger.RecordTerminal(request.Identity, request.AuthenticatedCallerSid, ServiceProcessOutcome.Completed, 0, 0);
                else ledger.MarkUnknown(request.Identity, request.AuthenticatedCallerSid, "TEST_UNKNOWN");
            }
            var starts = 0;
            try { ledger.StartImportValidation(request.Identity, request.AuthenticatedCallerSid, () => ++starts); }
            catch (IOException) { }
            if (starts != 0) throw new Exception("An inactive outer attempt launched service Git");
        }
    }

    private static async Task TestServiceImportTimeoutFence(string root)
    {
        var directory = Path.Combine(root, "import-timeout");
        Directory.CreateDirectory(directory);
        var store = Path.Combine(directory, "attempts.json");
        var ledger = new ServiceAttemptLedger(new ServiceAttemptLedgerPersistence(store));
        var request = NewServiceAttemptRequest("import-timeout", ServiceAttemptLedger.GlobalReservationKey) with { Shared = true };
        ledger.Prepare(request);
        var runtime = new WindowsServiceProcessRuntime(ledger, useCurrentUserTestLauncher: true);
        var stopObserved = false;
        ContainedProcess.Fault = (point, _) =>
        {
            if (point != "before_cancel") return;
            var persisted = new ServiceAttemptLedger(new ServiceAttemptLedgerPersistence(store)).Inspect(request.Identity, request.AuthenticatedCallerSid);
            if (!persisted.CancellationRequested) throw new Exception("Outer Job stopped before durable cancellation admission");
            stopObserved = true;
        };
        try
        {
            runtime.Run(request.Identity, request.AuthenticatedCallerSid, request.OperationDigest,
                new ServiceProcessOperation("run_process", Executable, ["sleep", "10000"], directory, 500, false, EnvironmentBlock, 1024), 0);
            ledger.AcquireImportReservation(request.Identity, request.AuthenticatedCallerSid);
            for (var attempt = 0; attempt < 200 && ledger.Inspect(request.Identity, request.AuthenticatedCallerSid).Phase != ServiceAttemptPhase.TerminalVerified; attempt++) await Task.Delay(20);
            var terminal = ledger.Inspect(request.Identity, request.AuthenticatedCallerSid);
            if (!stopObserved || terminal.Outcome != ServiceProcessOutcome.TimedOut || !terminal.CancellationRequested
                || terminal.Phase != ServiceAttemptPhase.TerminalVerified || terminal.ActiveProcesses != 0 || !terminal.ReservationHeld)
                throw new Exception("Timeout did not retain its unfinished import after native Job-zero proof");
        }
        finally { ContainedProcess.Fault = null; await runtime.StopAsync(); }
    }

    private static void ExpectFailure<T>(Action action, string expectedMessage) where T : Exception
    {
        try { action(); }
        catch (T exception)
        {
            if (!String.Equals(exception.Message, expectedMessage, StringComparison.Ordinal))
                throw new Exception($"Expected {expectedMessage} but received {exception.Message}");
            return;
        }
        throw new Exception("Expected " + typeof(T).Name + " with " + expectedMessage);
    }

    private static void TestDurableServiceAttemptLedger()
    {
        var directory = Path.Combine(Path.GetTempPath(), "lnwjud-ledger-store-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        var storePath = Path.Combine(directory, "attempts.json");
        var reservationKey = Path.Combine(directory, "workspace");
        try
        {
            var request = NewServiceAttemptRequest("durable-attempt", reservationKey);
            var initial = new ServiceAttemptLedger(new ServiceAttemptLedgerPersistence(storePath));
            initial.Prepare(request);
            if (!initial.TryCommitDispatch(request.Identity, request.AuthenticatedCallerSid, request.OperationDigest))
                throw new Exception("Durable attempt did not commit dispatch");
            initial.MarkRunning(request.Identity, request.AuthenticatedCallerSid, 5252);

            var recovered = new ServiceAttemptLedger(new ServiceAttemptLedgerPersistence(storePath));
            var observation = recovered.Inspect(request.Identity, request.AuthenticatedCallerSid);
            if (observation.Phase != ServiceAttemptPhase.TerminationUnknown || !observation.ReservationHeld)
                throw new Exception("Restart did not conservatively retain an ambiguous running attempt");
            ExpectFailure<IOException>(
                () => recovered.Prepare(NewServiceAttemptRequest("blocked-after-restart", reservationKey)),
                "WRITER_RESERVATION_BUSY");
            if (recovered.Release(request.Identity, request.AuthenticatedCallerSid) != ReservationRelease.Retained)
                throw new Exception("Recovered unknown attempt released its writer reservation");

            recovered.RecordTerminal(request.Identity, request.AuthenticatedCallerSid, ServiceProcessOutcome.Completed, 0, 0);
            if (recovered.Release(request.Identity, request.AuthenticatedCallerSid) != ReservationRelease.Released)
                throw new Exception("Recovered attempt did not release after terminal proof");
            var afterRelease = new ServiceAttemptLedger(new ServiceAttemptLedgerPersistence(storePath))
                .Inspect(request.Identity, request.AuthenticatedCallerSid);
            if (afterRelease.Phase != ServiceAttemptPhase.TerminalVerified || afterRelease.ReservationHeld)
                throw new Exception("Terminal proof or reservation release did not survive restart");

            var unpreparedRequest = NewServiceAttemptRequest(
                "durable-abort-before-prepare",
                Path.GetFullPath(Path.Combine(directory, "abort-before-prepare")));
            var abortRequest = unpreparedRequest with { OperationDigest = unpreparedRequest.Identity.RequestDigest };
            var beforeRestartAbort = new ServiceAttemptLedger(new ServiceAttemptLedgerPersistence(storePath))
                .AbortBeforeLaunch(abortRequest);
            if (beforeRestartAbort.Phase != ServiceAttemptPhase.LaunchNotStarted || !beforeRestartAbort.ReservationHeld)
                throw new Exception("Abort tombstone was not persisted before service restart");
            var afterRestartAbort = new ServiceAttemptLedger(new ServiceAttemptLedgerPersistence(storePath));
            var recoveredAbort = afterRestartAbort.Inspect(abortRequest.Identity, abortRequest.AuthenticatedCallerSid);
            if (recoveredAbort.Phase != ServiceAttemptPhase.LaunchNotStarted || !recoveredAbort.ReservationHeld)
                throw new Exception("Abort tombstone or its reservation did not survive restart");
            if (afterRestartAbort.Prepare(abortRequest) != recoveredAbort)
                throw new Exception("Recovered abort tombstone allowed or changed an exact prepare replay");
            ExpectFailure<IOException>(
                () => afterRestartAbort.Prepare(NewServiceAttemptRequest("blocked-by-abort-after-restart", abortRequest.ReservationKey)),
                "WRITER_RESERVATION_BUSY");
            ExpectFailure<IOException>(
                () => afterRestartAbort.TryCommitDispatch(abortRequest.Identity, abortRequest.AuthenticatedCallerSid, abortRequest.OperationDigest),
                "ATTEMPT_ALREADY_ABORTED");

            var corruptPath = Path.Combine(directory, "corrupt.json");
            File.WriteAllText(corruptPath, "{");
            ExpectFailure<IOException>(
                () => _ = new ServiceAttemptLedger(new ServiceAttemptLedgerPersistence(corruptPath)),
                "ATTEMPT_STORE_CORRUPT");
        }
        finally
        {
            Directory.Delete(directory, true);
        }
    }

    private static void TestServiceRestartAndJobReconciliation()
    {
        var directory = Path.Combine(Path.GetTempPath(), "lnwjud-restart-reconciliation-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        var storePath = Path.Combine(directory, "attempts.json");
        var reservationKey = Path.Combine(directory, "workspace");
        try
        {
            var callerSid = WindowsIdentity.GetCurrent().User!.Value;

            // Scenario 1: Terminated Job - Process ran and exited, service restarts.
            // When runtime.Inspect is called, it verifies Job Object has 0 active processes / not found,
            // records TerminalVerified and releases the reservation.
            {
                var persistence = new ServiceAttemptLedgerPersistence(storePath);
                var initialLedger = new ServiceAttemptLedger(persistence);
                var initialRuntime = new WindowsServiceProcessRuntime(initialLedger, useCurrentUserTestLauncher: true);

                var op = new ServiceProcessOperation("run_process", Executable, ["noop"], directory, 5000, false, EnvironmentBlock, 1024);
                var opBytes = System.Text.Json.JsonSerializer.SerializeToUtf8Bytes(op, new System.Text.Json.JsonSerializerOptions { PropertyNamingPolicy = System.Text.Json.JsonNamingPolicy.CamelCase });
                var opDigest = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(opBytes)).ToLowerInvariant();
                var identity = new ServiceAttemptIdentity(Guid.NewGuid().ToString("D"), Guid.NewGuid().ToString("D"), Guid.NewGuid().ToString("D"), 1,
                    opDigest, "client-test", "session-test", "workspace-test");
                var request = new ServiceAttemptRequest(identity, callerSid, reservationKey, opDigest, Shared: false);

                initialLedger.Prepare(request);
                initialRuntime.Run(identity, callerSid, opDigest, op, 0);

                var sw = Stopwatch.StartNew();
                while (sw.ElapsedMilliseconds < 5000 && initialLedger.Inspect(identity, callerSid).Phase != ServiceAttemptPhase.TerminalVerified)
                {
                    Thread.Sleep(20);
                }

                var restartLedger = new ServiceAttemptLedger(new ServiceAttemptLedgerPersistence(storePath));
                var restartRuntime = new WindowsServiceProcessRuntime(restartLedger, useCurrentUserTestLauncher: true);

                var inspected = restartRuntime.Inspect(identity, callerSid);
                if (inspected.Phase != ServiceAttemptPhase.TerminalVerified || inspected.ReservationHeld)
                    throw new Exception("Terminated job was not terminal verified after restart");

                var idempotent = restartRuntime.Inspect(identity, callerSid);
                if (idempotent.Phase != ServiceAttemptPhase.TerminalVerified || idempotent.ReservationHeld)
                    throw new Exception("Idempotent inspection failed for terminated job");
            }

            // Isolate persistence between the simulated service lifetimes; asynchronous
            // monitors from an earlier scenario must not overwrite this scenario's ledger.
            storePath = Path.Combine(directory, "scenario2-attempts.json");
            // Scenario 2: Live Descendants - Process is still running when service restarts.
            // runtime.Inspect detects ActiveProcesses > 0, keeps TerminationUnknown and holds reservation.
            // runtime.Cancel terminates the named job object, drains active processes to 0, transitions to TerminalVerified (Cancelled), and releases reservation.
            {
                var persistence = new ServiceAttemptLedgerPersistence(storePath);
                var initialLedger = new ServiceAttemptLedger(persistence);
                var initialRuntime = new WindowsServiceProcessRuntime(initialLedger, useCurrentUserTestLauncher: true);

                var op = new ServiceProcessOperation("run_process", Executable, ["sleep", "30000"], directory, 30000, false, EnvironmentBlock, 1024);
                var opBytes = System.Text.Json.JsonSerializer.SerializeToUtf8Bytes(op, new System.Text.Json.JsonSerializerOptions { PropertyNamingPolicy = System.Text.Json.JsonNamingPolicy.CamelCase });
                var opDigest = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(opBytes)).ToLowerInvariant();
                var identity = new ServiceAttemptIdentity(Guid.NewGuid().ToString("D"), Guid.NewGuid().ToString("D"), Guid.NewGuid().ToString("D"), 1,
                    opDigest, "client-test", "session-test", "workspace-test");
                var request = new ServiceAttemptRequest(identity, callerSid, reservationKey, opDigest, Shared: false);

                initialLedger.Prepare(request);
                initialRuntime.Run(identity, callerSid, opDigest, op, 0);

                var sw = Stopwatch.StartNew();
                while (sw.ElapsedMilliseconds < 5000 && initialLedger.Inspect(identity, callerSid).Phase != ServiceAttemptPhase.Running)
                {
                    Thread.Sleep(20);
                }

                // Simulated old service monitors remain live in this process; its
                // persistence must not race with the recovered service ledger.
                var restartedStorePath = Path.Combine(directory, "scenario2-restarted-attempts.json");
                File.Copy(storePath, restartedStorePath);
                var restartLedger = new ServiceAttemptLedger(new ServiceAttemptLedgerPersistence(restartedStorePath));
                var restartRuntime = new WindowsServiceProcessRuntime(restartLedger, useCurrentUserTestLauncher: true);
                var initialObs = restartLedger.Inspect(identity, callerSid);
                if (initialObs.Phase != ServiceAttemptPhase.TerminationUnknown || !initialObs.ReservationHeld)
                    throw new Exception("Active attempt was not marked unknown on restart");

                var liveObs = restartRuntime.Inspect(identity, callerSid);
                if (liveObs.Phase != ServiceAttemptPhase.TerminationUnknown || !liveObs.ReservationHeld || liveObs.ActiveProcesses is null or 0)
                    throw new Exception("Live descendants were not detected by runtime inspection");

                var conflictingRequest = new ServiceAttemptRequest(
                    identity with { AttemptId = Guid.NewGuid().ToString("D"), TaskId = "conflicting-task" },
                    callerSid, reservationKey, opDigest, Shared: false);
                ExpectFailure<IOException>(() => restartLedger.Prepare(conflictingRequest), "WRITER_RESERVATION_BUSY");

                var cancelObs = restartRuntime.Cancel(identity, callerSid);
                if (cancelObs.Phase != ServiceAttemptPhase.TerminalVerified || cancelObs.ActiveProcesses != 0 || cancelObs.ReservationHeld)
                    throw new Exception("Cancel on orphaned job did not reach terminal verified or release reservation");

                var admitted = restartLedger.Prepare(conflictingRequest);
                if (admitted.Phase != ServiceAttemptPhase.Prepared || !admitted.ReservationHeld)
                    throw new Exception("Conflicting writer was not admitted after job cancellation");
            }

            storePath = Path.Combine(directory, "scenario3-attempts.json");
            // Scenario 3: Crash after dispatch committed (process never started)
            {
                var persistence = new ServiceAttemptLedgerPersistence(storePath);
                var initialLedger = new ServiceAttemptLedger(persistence);

                var attemptId = Guid.NewGuid().ToString("D");
                var request = NewServiceAttemptRequest(attemptId, Path.Combine(directory, "crash-dispatch-workspace")) with { AuthenticatedCallerSid = callerSid };
                initialLedger.Prepare(request);
                if (!initialLedger.TryCommitDispatch(request.Identity, callerSid, request.OperationDigest))
                    throw new Exception("TryCommitDispatch failed");

                var restartLedger = new ServiceAttemptLedger(new ServiceAttemptLedgerPersistence(storePath));
                var restartRuntime = new WindowsServiceProcessRuntime(restartLedger, useCurrentUserTestLauncher: true);

                var afterCrash = restartRuntime.Inspect(request.Identity, callerSid);
                if (afterCrash.Phase != ServiceAttemptPhase.TerminationUnknown || !afterCrash.ReservationHeld)
                    throw new Exception("Dispatch without verified Job membership must not synthesize terminal success");
                var cancelWithoutMembership = restartRuntime.Cancel(request.Identity, callerSid);
                if (cancelWithoutMembership.Phase != ServiceAttemptPhase.TerminationUnknown || !cancelWithoutMembership.ReservationHeld)
                    throw new Exception("Cancellation without verified membership must retain admission");
            }
            storePath = Path.Combine(directory, "scenario4-attempts.json");
            // Scenario 4: The service persisted verified Job membership, then
            // lost the target exit status. No Job survives after the restart.
            // Release after zero-process evidence, but never report success.
            {
                var ledger = new ServiceAttemptLedger(new ServiceAttemptLedgerPersistence(storePath));
                var request = NewServiceAttemptRequest(Guid.NewGuid().ToString("D"), Path.Combine(directory, "previously-contained"))
                    with { AuthenticatedCallerSid = callerSid };
                ledger.Prepare(request);
                if (!ledger.TryCommitDispatch(request.Identity, callerSid, request.OperationDigest))
                    throw new Exception("Membership scenario did not commit dispatch");
                ledger.MarkRunning(request.Identity, callerSid, 424242);
                var recoveredLedger = new ServiceAttemptLedger(new ServiceAttemptLedgerPersistence(storePath));
                var recoveredRuntime = new WindowsServiceProcessRuntime(recoveredLedger, useCurrentUserTestLauncher: true);
                var result = recoveredRuntime.Inspect(request.Identity, callerSid);
                if (result.Phase != ServiceAttemptPhase.TerminalVerified || result.Outcome != ServiceProcessOutcome.Interrupted
                    || result.ExitCode != 125 || result.ActiveProcesses != 0 || result.ReservationHeld)
                    throw new Exception("Restart synthesized successful exit or retained verified-empty Job admission");
            }
        }
        finally
        {
            Directory.Delete(directory, true);
        }
    }

    private static void TestServicePipeRefusesPreexistingInstance()
    {
        var pipeName = "lnwjud-squatted-" + Guid.NewGuid().ToString("N");
        using var attacker = new NamedPipeServerStream(pipeName, PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous, 4096, 4096);
        try
        {
            using var accepted = ServicePipeSecurity.CreateServer(pipeName, firstInstance: true);
            throw new Exception("Service pipe accepted a pre-existing pipe instance");
        }
        catch (System.ComponentModel.Win32Exception exception) when (exception.NativeErrorCode is 5 or 231)
        {
        }
    }

    private static void TestServiceRpcIdentityAndReservationsAsync() =>
        TestServiceRpcIdentityAndReservationsCoreAsync().GetAwaiter().GetResult();

    private static async Task TestServiceImportRpcAsync(string root)
    {
        var directory = Path.Combine(root, "import-rpc");
        Directory.CreateDirectory(directory);
        var workspace = Path.Combine(directory, "workspace");
        var home = Path.Combine(directory, "home");
        Directory.CreateDirectory(workspace);
        Directory.CreateDirectory(home);
        var stage = Path.Combine(directory, ".lnwjud-import-stage-" + Guid.NewGuid().ToString());
        var imports = Path.Combine(directory, "imports");
        var ledger = new ServiceAttemptLedger(new ServiceAttemptLedgerPersistence(Path.Combine(directory, "attempts.json")), imports);
        var pipeName = "lnwjud-import-rpc-" + Guid.NewGuid().ToString("N");
        using var stopping = new CancellationTokenSource(TimeSpan.FromSeconds(15));
        var server = WindowsContainmentService.RunPipeServerAsync(pipeName, ledger, stopping.Token, useCurrentUserTestLauncher: true);
        var identity = NewServiceAttemptRequest("rpc-import", ServiceAttemptLedger.GlobalReservationKey).Identity;
        var json = new System.Text.Json.JsonSerializerOptions { PropertyNamingPolicy = System.Text.Json.JsonNamingPolicy.CamelCase };
        var operation = new { kind = "run_process", executable = Executable, args = new[] { "sleep", "10000" }, cwd = directory,
            timeoutMs = 10000, windowsVerbatimArguments = false, environment = EnvironmentBlock, maximumOutputBytes = 1024 };
        try
        {
            foreach (var command in new[] { "prepare", "run" })
            {
                using var response = await SendServiceRpcAsync(pipeName, System.Text.Json.JsonSerializer.SerializeToUtf8Bytes(new
                { protocol = 3, command, identity, reservationKey = "caller-unique-directory-must-not-define-conflict", operation }, json));
                if (!response.RootElement.GetProperty("ok").GetBoolean()) throw new Exception("RPC process preparation or launch failed");
            }
            using var prepared = await SendServiceRpcAsync(pipeName, System.Text.Json.JsonSerializer.SerializeToUtf8Bytes(new
            {
                protocol = 3, command = "control", identity, controlCommand = "prepare_import",
                controlRequest = new { workspaceRoot = workspace, destination = "repo", stagePath = stage, commit = new string('a', 40), privateHome = home },
            }, json));
            if (!prepared.RootElement.GetProperty("ok").GetBoolean()
                || !prepared.RootElement.GetProperty("result").GetProperty("verified").GetBoolean() || !Directory.Exists(stage))
                throw new Exception("Authenticated import control did not create its caller-owned stage");
            var nativeId = prepared.RootElement.GetProperty("result").GetProperty("result").GetProperty("nativeIdentity").GetString();
            using var inspected = await SendServiceRpcAsync(pipeName, System.Text.Json.JsonSerializer.SerializeToUtf8Bytes(new
            { protocol = 3, command = "inspect_control", identity, controlCommand = "prepare_import" }, json));
            if (!inspected.RootElement.GetProperty("ok").GetBoolean()
                || inspected.RootElement.GetProperty("result").GetProperty("result").GetProperty("nativeIdentity").GetString() != nativeId)
                throw new Exception("Authenticated import readback changed the native stage identity");
            using var wrongOwner = await SendServiceRpcAsync(pipeName, System.Text.Json.JsonSerializer.SerializeToUtf8Bytes(new
            { protocol = 3, command = "inspect_control", identity = identity with { OwnerSessionId = "other-session" }, controlCommand = "prepare_import" }, json));
            if (wrongOwner.RootElement.GetProperty("ok").GetBoolean()) throw new Exception("Import RPC accepted another owner session");
            using var overlap = await SendServiceRpcAsync(pipeName, System.Text.Json.JsonSerializer.SerializeToUtf8Bytes(new
            { protocol = 3, command = "prepare", identity = identity with { AttemptId = "other-attempt" }, reservationKey = "another-unique-directory", operation }, json));
            if (overlap.RootElement.GetProperty("ok").GetBoolean() || overlap.RootElement.GetProperty("error").GetString() != "WRITER_RESERVATION_BUSY")
                throw new Exception("Caller directory bypassed the service-owned global import reservation");
            using var cancellation = await SendServiceRpcAsync(pipeName, System.Text.Json.JsonSerializer.SerializeToUtf8Bytes(new { protocol = 3, command = "cancel", identity }, json));
            if (!cancellation.RootElement.GetProperty("ok").GetBoolean()) throw new Exception("Import worker cancellation was rejected");
            using var caller = System.Security.Principal.WindowsIdentity.GetCurrent();
            var sid = caller.User!.Value;
            for (var attempt = 0; attempt < 100 && ledger.Inspect(identity, sid).Phase != ServiceAttemptPhase.TerminalVerified; attempt++) await Task.Delay(20);
            var terminal = ledger.Inspect(identity, sid);
            if (terminal.Phase != ServiceAttemptPhase.TerminalVerified || terminal.ActiveProcesses != 0 || !terminal.ReservationHeld)
                throw new Exception("Native completion released an unpublished import transaction");
        }
        finally
        {
            stopping.Cancel();
            try { await server.WaitAsync(TimeSpan.FromSeconds(5)); }
            catch (OperationCanceledException) { }
        }
    }

    private static async Task TestServiceRpcIdentityAndReservationsCoreAsync()
    {
        var pipeName = "lnwjud-service-rpc-" + Guid.NewGuid().ToString("N");
        var storeDirectory = Path.Combine(Path.GetTempPath(), "lnwjud-service-rpc-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(storeDirectory);
        var storePath = Path.Combine(storeDirectory, "attempts.json");
        var reservationKey = Path.GetFullPath(Path.Combine(storeDirectory, "workspace"));
        var ledger = new ServiceAttemptLedger(new ServiceAttemptLedgerPersistence(storePath));
        using var stopping = new CancellationTokenSource(TimeSpan.FromSeconds(20));
        var server = WindowsContainmentService.RunPipeServerAsync(pipeName, ledger, stopping.Token, useCurrentUserTestLauncher: true);
        try
        {
            var operation = new
            {
                kind = "run_process",
                executable = Executable,
                args = new[] { "emit-sleep", "10000" },
                cwd = Environment.CurrentDirectory,
                timeoutMs = 10000,
                windowsVerbatimArguments = false,
                environment = new SortedDictionary<string, string>(EnvironmentBlock, StringComparer.OrdinalIgnoreCase),
                maximumOutputBytes = 4096,
            };
            var operationBytes = System.Text.Json.JsonSerializer.SerializeToUtf8Bytes(operation);
            var operationDigest = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(operationBytes)).ToLowerInvariant();
            static object Identity(string attemptId, string digest) => new
            {
                taskId = "task-" + attemptId,
                reservationId = "reservation-" + attemptId,
                attemptId,
                generation = 1,
                requestDigest = digest,
                ownerClientId = "client-test",
                ownerSessionId = "session-test",
                workspaceId = "workspace-test",
            };
            static byte[] Request(string command, object identity, string reservation, object operation, string digest) =>
                System.Text.Json.JsonSerializer.SerializeToUtf8Bytes(new
                {
                    protocol = 3,
                    command,
                    identity,
                    reservationKey = reservation,
                    operationDigest = digest,
                    operation,
                });

            var earlyAbortDigest = new string('c', 64);
            var earlyAbortIdentity = Identity("rpc-abort-before-prepare", earlyAbortDigest);
            var earlyAbortReservation = Path.GetFullPath(Path.Combine(storeDirectory, "abort-before-prepare"));
            using var earlyAbort = await SendServiceRpcAsync(pipeName, System.Text.Json.JsonSerializer.SerializeToUtf8Bytes(new
            {
                protocol = 3,
                command = "abort",
                identity = earlyAbortIdentity,
                reservationKey = earlyAbortReservation,
                operationDigest = earlyAbortDigest,
            }));
            var earlyAbortObservation = earlyAbort.RootElement.GetProperty("result");
            if (!earlyAbort.RootElement.GetProperty("ok").GetBoolean()
                || earlyAbortObservation.GetProperty("phase").GetInt32() != (int)ServiceAttemptPhase.LaunchNotStarted
                || earlyAbortObservation.GetProperty("reservationHeld").GetBoolean())
                throw new Exception("Service RPC did not persist and release an abort-before-prepare tombstone");
            using var replayPrepare = await SendServiceRpcAsync(pipeName,
                Request("prepare", earlyAbortIdentity, earlyAbortReservation, operation, operationDigest));
            if (replayPrepare.RootElement.GetProperty("ok").GetBoolean()
                || replayPrepare.RootElement.GetProperty("error").GetString() != "ATTEMPT_ID_CONFLICT")
                throw new Exception("Service RPC allowed an aborted identity to prepare with a different operation digest");

            using var accepted = await SendServiceRpcAsync(pipeName,
                Request("prepare", Identity("rpc-attempt-1", operationDigest), reservationKey, operation, operationDigest));
            if (!accepted.RootElement.GetProperty("ok").GetBoolean()
                || accepted.RootElement.GetProperty("result").GetProperty("phase").GetInt32() != (int)ServiceAttemptPhase.Prepared
                || !accepted.RootElement.GetProperty("result").GetProperty("reservationHeld").GetBoolean())
                throw new Exception("Service RPC did not durably admit the authenticated caller");

            using var currentIdentity = System.Security.Principal.WindowsIdentity.GetCurrent();
            var callerSid = currentIdentity.User?.Value ?? throw new Exception("Current Windows SID was unavailable");
            var persistedIdentity = new ServiceAttemptIdentity(
                "task-rpc-attempt-1", "reservation-rpc-attempt-1", "rpc-attempt-1", 1,
                operationDigest, "client-test", "session-test", "workspace-test");
            var reopenedLedger = new ServiceAttemptLedger(new ServiceAttemptLedgerPersistence(storePath));
            var reopenedObservation = reopenedLedger.Inspect(persistedIdentity, callerSid);
            if (reopenedObservation.Phase != ServiceAttemptPhase.Prepared || !reopenedObservation.ReservationHeld)
                throw new Exception("Service RPC admission did not survive a ledger reopen");
            ExpectFailure<IOException>(
                () => reopenedLedger.Prepare(NewServiceAttemptRequest("rpc-overlap-after-reopen", reservationKey)),
                "WRITER_RESERVATION_BUSY");

            using var overlap = await SendServiceRpcAsync(pipeName,
                Request("prepare", Identity("rpc-attempt-2", operationDigest), reservationKey, operation, operationDigest));
            if (!overlap.RootElement.GetProperty("ok").GetBoolean())
                throw new Exception("Service RPC unnecessarily serialized ordinary managed processes");
            using var abortSecond = await SendServiceRpcAsync(pipeName,
                Request("abort", Identity("rpc-attempt-2", operationDigest), reservationKey, operation, operationDigest));
            if (!abortSecond.RootElement.GetProperty("ok").GetBoolean()
                || abortSecond.RootElement.GetProperty("result").GetProperty("reservationHeld").GetBoolean())
                throw new Exception("Shared ordinary process did not release after prelaunch abort");

            using var started = await SendServiceRpcAsync(pipeName,
                Request("run", Identity("rpc-attempt-1", operationDigest), reservationKey, operation, operationDigest));
            if (!started.RootElement.GetProperty("ok").GetBoolean()
                || started.RootElement.GetProperty("result").GetProperty("phase").GetInt32() != (int)ServiceAttemptPhase.Running)
                throw new Exception("Service RPC did not start the bound operation under the caller token");

            var stdoutText = string.Empty;
            var stderrText = string.Empty;
            for (var attempt = 0; attempt < 25; attempt++)
            {
                using var output = await SendServiceRpcAsync(pipeName, System.Text.Json.JsonSerializer.SerializeToUtf8Bytes(new
                {
                    protocol = 3, command = "read_output", identity = Identity("rpc-attempt-1", operationDigest),
                }));
                if (!output.RootElement.GetProperty("ok").GetBoolean())
                    throw new Exception("Service RPC did not expose bounded service-owned process output");
                var captured = output.RootElement.GetProperty("result");
                stdoutText = System.Text.Encoding.UTF8.GetString(Convert.FromBase64String(captured.GetProperty("stdoutBase64").GetString()!));
                stderrText = System.Text.Encoding.UTF8.GetString(Convert.FromBase64String(captured.GetProperty("stderrBase64").GetString()!));
                if (stdoutText.Contains("NATIVE_STDOUT", StringComparison.Ordinal)
                    && stderrText.Contains("NATIVE_STDERR", StringComparison.Ordinal)) break;
                await Task.Delay(20);
            }
            if (!stdoutText.Contains("NATIVE_STDOUT", StringComparison.Ordinal)
                || !stderrText.Contains("NATIVE_STDERR", StringComparison.Ordinal))
                throw new Exception("Service RPC did not capture both stdout and stderr before terminal completion");

            using var delta = await SendServiceRpcAsync(pipeName, System.Text.Json.JsonSerializer.SerializeToUtf8Bytes(new
            {
                protocol = 3, command = "read_output", identity = Identity("rpc-attempt-1", operationDigest),
                outputCursor = new { stdoutOffset = 7, stderrOffset = 7 },
            }));
            if (!delta.RootElement.GetProperty("ok").GetBoolean())
                throw new Exception("Service output byte cursors were rejected");
            var deltaOutput = delta.RootElement.GetProperty("result");
            if (Encoding.UTF8.GetString(Convert.FromBase64String(deltaOutput.GetProperty("stdoutBase64").GetString()!)) != "STDOUT"
                || Encoding.UTF8.GetString(Convert.FromBase64String(deltaOutput.GetProperty("stderrBase64").GetString()!)) != "STDERR"
                || !deltaOutput.GetProperty("persisted").GetBoolean()
                || deltaOutput.GetProperty("identity").GetProperty("attemptId").GetString() != persistedIdentity.AttemptId
                || deltaOutput.GetProperty("identity").GetProperty("requestDigest").GetString() != persistedIdentity.RequestDigest
                || deltaOutput.GetProperty("finalCursor").ValueKind != System.Text.Json.JsonValueKind.Null
                || deltaOutput.GetProperty("nextCursor").GetProperty("stdoutOffset").GetInt32() != 13)
                throw new Exception("Service output cursors or running persistence state were incorrect");
            var runningReadback = new WindowsServiceProcessRuntime(ledger, useCurrentUserTestLauncher: true).ReadOutput(persistedIdentity, callerSid);
            if (!runningReadback.Persisted || runningReadback.Complete || runningReadback.FinalCursor is not null
                || runningReadback.IncompleteReason != "SERVICE_OUTPUT_READERS_INCOMPLETE")
                throw new Exception("Recovered running output invented EOF or lost persisted bytes");

            using var cancellation = await SendServiceRpcAsync(pipeName, System.Text.Json.JsonSerializer.SerializeToUtf8Bytes(new
            {
                protocol = 3, command = "cancel", identity = Identity("rpc-attempt-1", operationDigest),
            }));
            if (!cancellation.RootElement.GetProperty("ok").GetBoolean())
                throw new Exception("Service RPC did not accept cancellation for its active Job");

            System.Text.Json.JsonDocument? terminal = null;
            try
            {
                terminal = await WaitForRpcReservationRelease(() => SendServiceRpcAsync(pipeName, System.Text.Json.JsonSerializer.SerializeToUtf8Bytes(new
                    {
                        protocol = 3, command = "inspect", identity = Identity("rpc-attempt-1", operationDigest),
                    })));
                if (terminal is null
                    || terminal.RootElement.GetProperty("outcome").GetInt32() != (int)ServiceProcessOutcome.Cancelled
                    || terminal.RootElement.GetProperty("activeProcesses").GetInt32() != 0
                    || terminal.RootElement.GetProperty("reservationHeld").GetBoolean())
                    throw new Exception("Service RPC did not persist Job-backed cancellation and release");
            }
            finally { terminal?.Dispose(); }

            var freshRuntime = new WindowsServiceProcessRuntime(ledger, useCurrentUserTestLauncher: true);
            ServiceOutputObservation recoveredOutput = freshRuntime.ReadOutput(persistedIdentity, callerSid);
            for (var retry = 0; !recoveredOutput.Complete && retry < 50; retry++)
            {
                await Task.Delay(20);
                recoveredOutput = freshRuntime.ReadOutput(persistedIdentity, callerSid);
            }
            if (!recoveredOutput.Complete || recoveredOutput.FinalCursor != new ServiceOutputCursor(13, 13)
                || Encoding.UTF8.GetString(Convert.FromBase64String(recoveredOutput.StdoutBase64)) != "NATIVE_STDOUT")
                throw new Exception("Fresh runtime did not recover final output from disk");
            ExpectFailure<IOException>(() => freshRuntime.ReadOutput(persistedIdentity, callerSid, new ServiceOutputCursor(14, 0)), "SERVICE_OUTPUT_CURSOR_INVALID");
            ExpectFailure<IOException>(() => freshRuntime.ReadOutput(persistedIdentity, callerSid, new ServiceOutputCursor(-1, 0)), "SERVICE_OUTPUT_CURSOR_INVALID");
            var ownerRejected = false;
            try { _ = freshRuntime.ReadOutput(persistedIdentity, "S-1-5-18"); }
            catch (UnauthorizedAccessException) { ownerRejected = true; }
            if (!ownerRejected) throw new Exception("Persisted output bypassed authenticated owner checking");

            await TestRpcOutputBoundsAndFailure(pipeName, storeDirectory, ledger, callerSid);

            var forgedIdentity = Identity("rpc-attempt-forged", operationDigest);
            var forged = System.Text.Json.JsonSerializer.SerializeToUtf8Bytes(new
            {
                protocol = 3,
                command = "prepare",
                identity = forgedIdentity,
                reservationKey = reservationKey + ".forged",
                operationDigest,
                operation,
                authenticatedCallerSid = "S-1-5-18",
            });
            using var rejected = await SendServiceRpcAsync(pipeName, forged);
            if (rejected.RootElement.GetProperty("ok").GetBoolean())
                throw new Exception("Service RPC accepted caller-supplied authentication identity");

            stopping.Cancel();
            await server.WaitAsync(TimeSpan.FromSeconds(5));
            using var restartedStopping = new CancellationTokenSource(TimeSpan.FromSeconds(10));
            var restarted = WindowsContainmentService.RunPipeServerAsync(pipeName,
                new ServiceAttemptLedger(new ServiceAttemptLedgerPersistence(storePath)), restartedStopping.Token, useCurrentUserTestLauncher: true);
            try
            {
                using var afterRestart = await SendServiceRpcAsync(pipeName, System.Text.Json.JsonSerializer.SerializeToUtf8Bytes(new
                {
                    protocol = 3, command = "read_output", identity = Identity("rpc-attempt-1", operationDigest),
                    outputCursor = new { stdoutOffset = 7, stderrOffset = 13 },
                }));
                var restored = afterRestart.RootElement.GetProperty("result");
                if (!afterRestart.RootElement.GetProperty("ok").GetBoolean()
                    || !restored.GetProperty("complete").GetBoolean()
                    || !restored.GetProperty("persisted").GetBoolean()
                    || restored.GetProperty("finalCursor").GetProperty("stdoutOffset").GetInt64() != 13
                    || Encoding.UTF8.GetString(Convert.FromBase64String(restored.GetProperty("stdoutBase64").GetString()!)) != "STDOUT"
                    || restored.GetProperty("stderrBase64").GetString() != "")
                    throw new Exception("Restarted pipe server lost output or cursor state");
            }
            finally
            {
                restartedStopping.Cancel();
                await restarted.WaitAsync(TimeSpan.FromSeconds(5));
            }

            var store = new ServiceOutputStore(ledger.OutputStoreDirectory!);
            var saved = store.Load(persistedIdentity, callerSid);
            store.Save(saved with { Identity = persistedIdentity with { Generation = 2 } });
            ExpectFailure<IOException>(() => freshRuntime.ReadOutput(persistedIdentity, callerSid), "SERVICE_OUTPUT_CORRUPT");
            store.Save(saved);
            store.Save(saved with { AuthenticatedCallerSid = "S-1-5-18" });
            ExpectFailure<IOException>(() => freshRuntime.ReadOutput(persistedIdentity, callerSid), "SERVICE_OUTPUT_CORRUPT");
            store.Save(saved);
            var snapshotFile = Path.Combine(ledger.OutputStoreDirectory!,
                Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(Encoding.UTF8.GetBytes(persistedIdentity.AttemptId))).ToLowerInvariant() + ".json");
            var outputFile = new FileInfo(snapshotFile);
            var originalAcl = outputFile.GetAccessControl().GetSecurityDescriptorSddlForm(AccessControlSections.Access);
            var unsafeAcl = outputFile.GetAccessControl();
            unsafeAcl.AddAccessRule(new FileSystemAccessRule(
                new SecurityIdentifier(WellKnownSidType.WorldSid, null), FileSystemRights.WriteData, AccessControlType.Allow));
            try
            {
                outputFile.SetAccessControl(unsafeAcl);
                ExpectFailure<IOException>(() => freshRuntime.ReadOutput(persistedIdentity, callerSid), "SERVICE_OUTPUT_WRITE_ACL_REFUSED");
            }
            finally
            {
                var restoredAcl = new FileSecurity();
                restoredAcl.SetSecurityDescriptorSddlForm(originalAcl, AccessControlSections.Access);
                outputFile.SetAccessControl(restoredAcl);
            }
            var alteredBytes = System.Text.Json.Nodes.JsonNode.Parse(File.ReadAllText(snapshotFile))!;
            alteredBytes["snapshot"]!["stdout"] = Convert.ToBase64String(Encoding.UTF8.GetBytes("ALTERED_BYTES"));
            File.WriteAllText(snapshotFile, alteredBytes.ToJsonString());
            ExpectFailure<IOException>(() => freshRuntime.ReadOutput(persistedIdentity, callerSid), "SERVICE_OUTPUT_CORRUPT");
            store.Save(saved);
            File.WriteAllText(snapshotFile, "{broken");
            ExpectFailure<IOException>(() => freshRuntime.ReadOutput(persistedIdentity, callerSid), "SERVICE_OUTPUT_CORRUPT");
            File.Delete(snapshotFile);
            ExpectFailure<IOException>(() => freshRuntime.ReadOutput(persistedIdentity, callerSid), "SERVICE_OUTPUT_UNAVAILABLE");
            if (ledger.Inspect(persistedIdentity, callerSid).Phase != ServiceAttemptPhase.TerminalVerified)
                throw new Exception("Unavailable output erased verified process termination");
        }
        finally
        {
            stopping.Cancel();
            await server.WaitAsync(TimeSpan.FromSeconds(5));
            Directory.Delete(storeDirectory, true);
        }
    }

    private static async Task TestRpcOutputBoundsAndFailure(string pipeName, string directory, ServiceAttemptLedger ledger, string callerSid)
    {
        foreach (var failPersistence in new[] { false, true })
        {
            var operation = new
            {
                kind = "run_process", executable = Executable,
                args = new[] { "output-pattern" }, cwd = Environment.CurrentDirectory, timeoutMs = 10_000,
                windowsVerbatimArguments = false,
                environment = new SortedDictionary<string, string>(EnvironmentBlock, StringComparer.OrdinalIgnoreCase),
                maximumOutputBytes = 1_048_576,
            };
            var digest = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(
                System.Text.Json.JsonSerializer.SerializeToUtf8Bytes(operation))).ToLowerInvariant();
            var id = failPersistence ? "output-failed-persistence" : "output-bounded";
            var identity = new ServiceAttemptIdentity("task-" + id, "reservation-" + id, id, 1, digest, "client-test", "session-test", "workspace-test");
            byte[] Request(string command, ServiceOutputCursor? cursor = null) => System.Text.Json.JsonSerializer.SerializeToUtf8Bytes(new
            {
                protocol = 3, command, identity, operationDigest = digest, operation,
                reservationKey = Path.Combine(directory, id), outputCursor = cursor,
            }, new System.Text.Json.JsonSerializerOptions { PropertyNamingPolicy = System.Text.Json.JsonNamingPolicy.CamelCase });
            var outputDirectory = ledger.OutputStoreDirectory!;
            var backup = Path.Combine(directory, "output-backup");
            if (failPersistence)
            {
                Directory.Move(outputDirectory, backup);
                File.WriteAllText(outputDirectory, "blocked output store");
            }
            try
            {
                using var prepared = await SendServiceRpcAsync(pipeName, Request("prepare"));
                using var launched = await SendServiceRpcAsync(pipeName, Request("run"));
                if (!prepared.RootElement.GetProperty("ok").GetBoolean() || !launched.RootElement.GetProperty("ok").GetBoolean())
                    throw new Exception("Output scenario did not launch");
                var terminal = await WaitForOutputReservationRelease(ledger, identity, callerSid);
                if (terminal.Phase != ServiceAttemptPhase.TerminalVerified || terminal.ReservationHeld)
                    throw new Exception($"Output persistence state prevented native terminal proof and release. phase={terminal.Phase} held={terminal.ReservationHeld} reason={terminal.Reason} persistenceFailure={failPersistence}");
                using var output = await SendServiceRpcAsync(pipeName, Request("read_output"));
                if (!output.RootElement.GetProperty("ok").GetBoolean()) throw new Exception("Output scenario read failed");
                var result = output.RootElement.GetProperty("result");
                var stdout = Convert.FromBase64String(result.GetProperty("stdoutBase64").GetString()!);
                if (stdout.Length != ServiceOutputStore.MaximumStreamBytes
                    || Convert.FromBase64String(result.GetProperty("stderrBase64").GetString()!).Length != ServiceOutputStore.MaximumStreamBytes
                    || !result.GetProperty("stdoutTruncated").GetBoolean() || !result.GetProperty("stderrTruncated").GetBoolean()
                    || result.GetProperty("persisted").GetBoolean() == failPersistence)
                    throw new Exception("Per-stream bounded retention or persistence status was incorrect");
                using var byteDelta = await SendServiceRpcAsync(pipeName, Request("read_output", new ServiceOutputCursor(4, ServiceOutputStore.MaximumStreamBytes)));
                if (!Convert.FromBase64String(byteDelta.RootElement.GetProperty("result").GetProperty("stdoutBase64").GetString()!).AsSpan().SequenceEqual(stdout.AsSpan(4)))
                    throw new Exception("Unicode output cursor used character offsets instead of byte offsets");
                if (failPersistence && (result.GetProperty("complete").GetBoolean()
                    || result.GetProperty("finalCursor").ValueKind != System.Text.Json.JsonValueKind.Null
                    || result.GetProperty("incompleteReason").GetString() != "SERVICE_OUTPUT_PERSISTENCE_FAILED"))
                    throw new Exception("Persistence failure invented complete output");
            }
            finally
            {
                if (failPersistence)
                {
                    File.Delete(outputDirectory);
                    Directory.Move(backup, outputDirectory);
                }
            }
        }
    }

    private static async Task<ServiceAttemptObservation> WaitForOutputReservationRelease(ServiceAttemptLedger ledger, ServiceAttemptIdentity identity, string callerSid)
    {
        for (var retry = 0; retry < 200; retry++)
        {
            var observation = ledger.Inspect(identity, callerSid);
            if (observation.Phase == ServiceAttemptPhase.TerminalVerified && !observation.ReservationHeld) return observation;
            await Task.Delay(20);
        }
        return ledger.Inspect(identity, callerSid);
    }

    private static async Task<System.Text.Json.JsonDocument?> WaitForRpcReservationRelease(Func<Task<System.Text.Json.JsonDocument>> inspect)
    {
        for (var attempt = 0; attempt < 100; attempt++)
        {
            using var inspected = await inspect();
            var observation = inspected.RootElement.GetProperty("result");
            if (observation.GetProperty("phase").GetInt32() == (int)ServiceAttemptPhase.TerminalVerified
                && !observation.GetProperty("reservationHeld").GetBoolean())
                return System.Text.Json.JsonDocument.Parse(observation.GetRawText());
            await Task.Delay(20);
        }
        return null;
    }

    private static async Task TestCancellationWaitsForReservationRelease()
    {
        var ledger = new ServiceAttemptLedger();
        var request = NewServiceAttemptRequest("cancel-release-observation", Path.Combine(Path.GetTempPath(), "cancel-release-observation"));
        ledger.Prepare(request);
        ledger.TryCommitDispatch(request.Identity, request.AuthenticatedCallerSid, request.OperationDigest);
        var terminal = ledger.RecordTerminal(request.Identity, request.AuthenticatedCallerSid, ServiceProcessOutcome.Cancelled, 0, 0);
        if (!terminal.ReservationHeld) throw new Exception("Cancellation arrangement lost its terminal-held reservation");
        var waiting = WaitForRpcReservationRelease(() => Task.FromResult(System.Text.Json.JsonSerializer.SerializeToDocument(
            new { result = ledger.Inspect(request.Identity, request.AuthenticatedCallerSid) },
            new System.Text.Json.JsonSerializerOptions { PropertyNamingPolicy = System.Text.Json.JsonNamingPolicy.CamelCase })));
        if (waiting.IsCompleted) throw new Exception("Cancellation RPC observer returned before native reservation release");
        ledger.Release(request.Identity, request.AuthenticatedCallerSid);
        using var released = await waiting;
        if (released is null || released.RootElement.GetProperty("reservationHeld").GetBoolean()
            || released.RootElement.GetProperty("outcome").GetInt32() != (int)ServiceProcessOutcome.Cancelled
            || released.RootElement.GetProperty("activeProcesses").GetInt32() != 0)
            throw new Exception("Cancellation RPC observer did not report Job-zero cancellation and release");
        Console.WriteLine("PASS cancellation RPC waits through terminal-before-reservation-release state");
    }

    private static async Task TestOutputWaitsForReservationRelease()
    {
        var ledger = new ServiceAttemptLedger();
        var request = NewServiceAttemptRequest("output-release-observation", Path.Combine(Path.GetTempPath(), "output-release-observation"));
        ledger.Prepare(request);
        ledger.TryCommitDispatch(request.Identity, request.AuthenticatedCallerSid, request.OperationDigest);
        var terminal = ledger.RecordTerminal(request.Identity, request.AuthenticatedCallerSid, ServiceProcessOutcome.Completed, 0, 0);
        if (!terminal.ReservationHeld) throw new Exception("Terminal-before-release arrangement lost its reservation");
        var waiting = WaitForOutputReservationRelease(ledger, request.Identity, request.AuthenticatedCallerSid);
        if (waiting.IsCompleted) throw new Exception("Output completion observer returned before native reservation release");
        ledger.Release(request.Identity, request.AuthenticatedCallerSid);
        var released = await waiting;
        if (released.Phase != ServiceAttemptPhase.TerminalVerified || released.ReservationHeld)
            throw new Exception("Output completion observer did not report terminal release");
        Console.WriteLine("PASS output completion waits through terminal-before-reservation-release state");
    }

    private static void TestOutputStoreRetention()
    {
        var directory = Path.Combine(Path.GetTempPath(), "lnwjud-output-retention-" + Guid.NewGuid().ToString("N"));
        try
        {
            var store = new ServiceOutputStore(directory);
            ServiceAttemptIdentity Identity(int index) => new("task", "reservation", "retained-" + index, 1, new string('a', 64), "client", "session", "workspace");
            for (var index = 0; index <= ServiceOutputStore.MaximumSnapshots; index++)
                store.Save(new ServiceOutputSnapshot(1, Identity(index), "S-1-5-18", [], [], false, false, false, "SERVICE_OUTPUT_READERS_INCOMPLETE"));
            ExpectFailure<IOException>(() => store.Load(Identity(0), "S-1-5-18"), "SERVICE_OUTPUT_UNAVAILABLE");
            var incomplete = store.Load(Identity(ServiceOutputStore.MaximumSnapshots), "S-1-5-18");
            if (incomplete.Complete || Directory.GetFiles(directory, "*.json").Length != ServiceOutputStore.MaximumSnapshots)
                throw new Exception("Output retention count or incomplete recovery was incorrect");
            var data = new byte[ServiceOutputStore.MaximumStreamBytes];
            for (var index = 0; index < 200; index++)
                store.Save(new ServiceOutputSnapshot(1, Identity(index), "S-1-5-18", data, data, true, true, true, null));
            if (new DirectoryInfo(directory).GetFiles().Sum(file => file.Length) > ServiceOutputStore.MaximumStoreBytes)
                throw new Exception("Global output retention exceeded its byte budget");
        }
        finally { if (Directory.Exists(directory)) Directory.Delete(directory, true); }
    }

    private static async Task TestOutputReaderFailure()
    {
        var directory = Path.Combine(Path.GetTempPath(), "lnwjud-output-reader-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        WindowsServiceProcessRuntime? runtime = null;
        try
        {
            var ledger = new ServiceAttemptLedger(new ServiceAttemptLedgerPersistence(Path.Combine(directory, "attempts.json")));
            using var current = WindowsIdentity.GetCurrent();
            var sid = current.User!.Value;
            var request = NewServiceAttemptRequest("output-reader-failure", Path.Combine(directory, "workspace")) with { AuthenticatedCallerSid = sid };
            ledger.Prepare(request);
            runtime = new WindowsServiceProcessRuntime(ledger, useCurrentUserTestLauncher: true);
            WindowsServiceProcessRuntime.FailOutputReadsForTest = true;
            runtime.Run(request.Identity, sid, request.OperationDigest,
                new ServiceProcessOperation("run_process", Executable, ["emit-sleep", "10000"], directory, 10000, false, EnvironmentBlock, 4096), 0);
            runtime.Cancel(request.Identity, sid);
            for (var retry = 0; retry < 100; retry++)
            {
                if (ledger.Inspect(request.Identity, sid).Phase == ServiceAttemptPhase.TerminalVerified) break;
                await Task.Delay(20);
            }
            await runtime.StopAsync();
            var terminal = ledger.Inspect(request.Identity, sid);
            var output = new WindowsServiceProcessRuntime(ledger, useCurrentUserTestLauncher: true).ReadOutput(request.Identity, sid);
            if (terminal.Phase != ServiceAttemptPhase.TerminalVerified || terminal.ActiveProcesses != 0 || terminal.ReservationHeld
                || !output.Persisted || output.Complete || output.FinalCursor is not null || output.IncompleteReason != "SERVICE_OUTPUT_READ_FAILED")
                throw new Exception("Reader failure erased terminal proof or invented complete output");
        }
        finally
        {
            if (runtime is not null) await runtime.StopAsync();
            WindowsServiceProcessRuntime.FailOutputReadsForTest = false;
            Directory.Delete(directory, true);
        }
    }

    private static async Task<System.Text.Json.JsonDocument> SendServiceRpcAsync(string pipeName, byte[] payload)
    {
        using var client = new NamedPipeClientStream(".", pipeName, PipeDirection.InOut, PipeOptions.Asynchronous);
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        await client.ConnectAsync(timeout.Token);
        var header = new byte[sizeof(int)];
        System.Buffers.Binary.BinaryPrimitives.WriteInt32LittleEndian(header, payload.Length);
        await client.WriteAsync(header, timeout.Token);
        await client.WriteAsync(payload, timeout.Token);
        await client.FlushAsync(timeout.Token);

        await client.ReadExactlyAsync(header, timeout.Token);
        var length = System.Buffers.Binary.BinaryPrimitives.ReadInt32LittleEndian(header);
        if (length is < 2 or > 1024 * 1024) throw new Exception("Service RPC response size was invalid");
        var response = new byte[length];
        await client.ReadExactlyAsync(response, timeout.Token);
        return System.Text.Json.JsonDocument.Parse(response);
    }

    private static void TestAuthenticatedPipeCallerCapture() =>
        TestAuthenticatedPipeCallerCaptureAsync().GetAwaiter().GetResult();

    private static async Task TestAuthenticatedPipeCallerCaptureAsync()
    {
        Console.WriteLine("PIPE_TEST_BEGIN");
        var pipeName = "lnwjud-caller-" + Guid.NewGuid().ToString("N");
        using var server = ServicePipeSecurity.CreateServer(pipeName, firstInstance: true);
        using var client = new NamedPipeClientStream(".", pipeName, PipeDirection.Out, PipeOptions.Asynchronous);
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(5));

        Console.WriteLine("PIPE_CONNECT_BEGIN");
        var serverConnect = server.WaitForConnectionAsync(timeout.Token);
        var clientConnect = client.ConnectAsync(timeout.Token);
        await Task.WhenAll(serverConnect, clientConnect).WaitAsync(TimeSpan.FromSeconds(6));
        Console.WriteLine("PIPE_CONNECTED");

        var probe = new byte[1];
        var read = server.ReadAsync(probe, 0, 1, timeout.Token);
        Console.WriteLine("PIPE_READ_ARMED");
        await client.WriteAsync(new byte[] { 0x5A }, 0, 1, timeout.Token).WaitAsync(TimeSpan.FromSeconds(5));
        Console.WriteLine("PIPE_WRITE_DONE");
        var count = await read.WaitAsync(TimeSpan.FromSeconds(5));
        if (count != 1 || probe[0] != 0x5A) throw new Exception("Pipe authentication probe was not received");
        Console.WriteLine("PIPE_READ_DONE");

        var expectedSid = System.Security.Principal.WindowsIdentity.GetCurrent().User?.Value
            ?? throw new Exception("Current Windows SID unavailable");
        Console.WriteLine("PIPE_CAPTURE_BEGIN");
        using var caller = await Task.Run(() => AuthenticatedPipeCaller.Capture(server)).WaitAsync(TimeSpan.FromSeconds(5));
        Console.WriteLine("PIPE_CAPTURE_DONE");
        if (!String.Equals(caller.Sid, expectedSid, StringComparison.Ordinal))
            throw new Exception("Pipe caller SID did not match the connected client");
        if (caller.PrimaryToken.IsInvalid || caller.PrimaryToken.IsClosed)
            throw new Exception("Pipe caller primary token is unavailable");
        if (!String.Equals(System.Security.Principal.WindowsIdentity.GetCurrent().User?.Value, expectedSid, StringComparison.Ordinal))
            throw new Exception("Pipe caller capture did not revert service-thread impersonation");
        Console.WriteLine("PIPE_TEST_DONE");
    }

    private static void TestProfileKeyIsNotExported()
    {
        var directory = Path.Combine(Path.GetTempPath(), "lnwjud-native-key-export-" + Guid.NewGuid().ToString("N"));
        var original = Console.Out;
        using var captured = new StringWriter();
        try
        {
            Console.SetOut(captured);
            var exitCode = Program.Main(["profile-key", directory]).GetAwaiter().GetResult();
            if (exitCode == 0 || captured.ToString().Length != 0) throw new Exception("Helper exported receipt authority to the caller");
        }
        finally
        {
            Console.SetOut(original);
            if (Directory.Exists(directory)) Directory.Delete(directory, true);
        }
    }

    private static void TestCallerLaunchSessionPolicy()
    {
        using var caller = System.Security.Principal.WindowsIdentity.GetCurrent();
        var before = AuthenticatedPipeCaller.SecurityFingerprint(caller.AccessToken);
        var originalSession = AuthenticatedPipeCaller.ReadSessionId(caller.AccessToken.DangerousGetHandle());
        using var launch = AuthenticatedPipeCaller.CreateLaunchToken(caller.AccessToken);
        if (AuthenticatedPipeCaller.ReadSessionId(launch.DangerousGetHandle()) != originalSession)
            throw new Exception("Launch token changed the authenticated caller's original session");
        if (AuthenticatedPipeCaller.SecurityFingerprint(launch) != before
            || AuthenticatedPipeCaller.SecurityFingerprint(caller.AccessToken) != before
            || AuthenticatedPipeCaller.ReadSessionId(caller.AccessToken.DangerousGetHandle()) != originalSession)
            throw new Exception("Launch duplication changed caller security or its original session");
    }
}
