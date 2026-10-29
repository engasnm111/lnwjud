using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using Lnwjud.UpdateAdmission;

[SupportedOSPlatform("windows")]
internal static class Program
{
    private static int assertions;
    private static void Check(bool condition, string label) { if (!condition) throw new Exception(label); assertions++; }
    private static void Refuses(Action action, string reason)
    {
        try { action(); throw new Exception("Expected " + reason); }
        catch (Refusal refusal) { Check(refusal.Reason == reason, reason + ": got " + refusal.Reason); }
    }
    private static string Root(bool bootstrap = true)
    {
        var path = Path.Combine(Path.GetTempPath(), "lnwjud-admission-" + Guid.NewGuid().ToString("N"));
        var security = new DirectorySecurity();
        var user = WindowsIdentity.GetCurrent().User!; security.SetOwner(user); security.SetAccessRuleProtection(true, false);
        foreach (var sid in new[] { user, new SecurityIdentifier("S-1-5-18"), new SecurityIdentifier("S-1-5-32-544") }.Distinct())
            security.AddAccessRule(new FileSystemAccessRule(sid, FileSystemRights.FullControl, InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
        FileSystemAclExtensions.CreateDirectory(security, path); if (bootstrap) AdmissionCore.InitializeIsolated(StoreIdentity.Isolated(path)); return path;
    }
    private static NativeEvidence Evidence(SettlementKind kind, string id) => NativeEvidence.Isolated(kind, id);
    private static Process Child(params string[] arguments)
    {
        var start = new ProcessStartInfo(Environment.ProcessPath!) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true };
        foreach (var arg in arguments) start.ArgumentList.Add(arg);
        return Process.Start(start)!;
    }
    private static int Main(string[] args)
    {
        if (args.Length == 2 && args[0] == "lock")
        {
            try { using var store = new AdmissionStore(StoreIdentity.Isolated(args[1])); return 10; }
            catch (Refusal refusal) { Console.WriteLine(refusal.Reason); return refusal.Reason == "OWNER_BUSY" ? 0 : 11; }
        }
        if (args.Length == 2 && args[0] == "crash")
        {
            using var core = new AdmissionCore(StoreIdentity.Isolated(args[1]));
            core.AfterStage = () => Environment.Exit(42);
            core.Close(UpdatePrincipal.Isolated("crash-update", 1), core.Status().Revision); return 12;
        }
        try { Protocol(); Lifecycle(); SequenceAndRetirement(); Concurrency(); DurableStore(); Console.WriteLine($"PASS {assertions} admission assertions"); return 0; }
        catch (Exception error) { Console.Error.WriteLine(error); return 1; }
    }
    private static void Protocol()
    {
        Check(AdmissionProtocol.Decode(Encoding.UTF8.GetBytes("{\"protocol\":1,\"requestId\":\"r1\",\"command\":\"status\"}")).Name == "status", "status decode");
        foreach (var text in new[] {
            "{\"protocol\":1,\"protocol\":1,\"requestId\":\"r\",\"command\":\"status\"}",
            "{\"protocol\":1,\"requestId\":\"r\",\"command\":\"status\",\"comm\\u0061nd\":\"status\"}" })
            Refuses(() => AdmissionProtocol.Decode(Encoding.UTF8.GetBytes(text)), "ADMISSION_DUPLICATE_FIELD");
        Refuses(() => AdmissionProtocol.Decode(Encoding.UTF8.GetBytes("{\"protocol\":1,\"requestId\":\"r\",\"command\":\"execute\"}")), "ADMISSION_COMMAND_UNKNOWN");
        Refuses(() => AdmissionProtocol.Decode(Encoding.UTF8.GetBytes("{\"protocol\":1,\"requestId\":\"r\",\"command\":\"status\",\"verified\":true}")), "ADMISSION_FIELDS_INVALID");
        foreach (var number in new[] { "01", "-1", "1.0", "18446744073709551616", "", " 1" }) Refuses(() => AdmissionProtocol.Decimal(number), "ADMISSION_POSITION_INVALID");
        Check(AdmissionProtocol.Decimal("18446744073709551615") == ulong.MaxValue, "exact unsigned bound");
        Refuses(() => AdmissionProtocol.Object(new byte[16_385], AdmissionProtocol.FrameBytes), "ADMISSION_JSON_INVALID");
        try { _ = AdmissionProtocol.Object([123, 34, 255, 34, 58, 49, 125], 100); throw new Exception("UTF8 accepted"); } catch (DecoderFallbackException) { assertions++; }
        Refuses(() => StoreIdentity.Installed(), "MAINTENANCE_REGISTRY_UNCONFIGURED");
        foreach (var path in new[] { "relative", "\\\\server\\share", "C:\\", "C:\\root:stream" }) Refuses(() => AdmissionStore.ValidatePath(path), "STATE_ROOT_UNSAFE");
    }
    private static void Lifecycle()
    {
        var root = Root();
        try
        {
            var runtime = RuntimePrincipal.Isolated("user1-process1"); var other = RuntimePrincipal.Isolated("user2-process2");
            var owner = UpdatePrincipal.Isolated("update1", 1); string participant;
            using (var core = new AdmissionCore(StoreIdentity.Isolated(root)))
            {
                participant = core.Register(runtime); Check(core.Register(runtime) == participant, "register idempotence");
                core.Enter(runtime, participant, 1, "call"); var revision = core.Status().Revision;
                Check(core.Enter(runtime, participant, 1, "call") == $"{participant}.1" && core.Status().Revision == revision, "enter retry cannot duplicate work");
                core.Close(owner, revision);
                Refuses(() => core.Enter(runtime, participant, 2, "call"), "ADMISSION_CLOSED");
                Refuses(() => core.Enter(other, participant, 1, "call"), "ADMISSION_PARTICIPANT_MISMATCH");
                var quarantined = core.Register(other); Check(core.Status().UnquiescedParticipants == 1, "late participant quarantined");
                Refuses(() => core.Enter(other, quarantined, 1, "startup"), "ADMISSION_PARTICIPANT_QUIESCENT");
                core.Promote(runtime, participant, 2, "attempt1", $"{participant}.1");
                core.Settle(runtime, $"{participant}.1", Evidence(SettlementKind.OperationSettled, $"{participant}.1"));
                Check(core.Status().HeldPermits == 1, "background job retains drain reservation");
                Refuses(() => core.Settle(runtime, $"{participant}.2", Evidence(SettlementKind.OperationSettled, $"{participant}.2")), "ADMISSION_SETTLEMENT_UNPROVEN");
                Refuses(() => core.Settle(runtime, $"{participant}.2", Evidence(SettlementKind.NativeJobZeroAndReleased, "foreign-job")), "ADMISSION_SETTLEMENT_UNPROVEN");
                Refuses(() => core.Quiesce(runtime, participant, Evidence(SettlementKind.ParticipantQuiesced, $"{participant}:{core.Status().Epoch}")), "ADMISSION_WORK_HELD");
                Refuses(() => core.Seal(owner, core.Status().Revision), "ADMISSION_DRAIN_INCOMPLETE");
            }
            using (var core = new AdmissionCore(StoreIdentity.Isolated(root)))
            {
                Check(core.Status().Phase == "closing" && core.Status().HeldPermits == 1, "restart retains closure and job");
                core.Settle(runtime, $"{participant}.2", Evidence(SettlementKind.NativeJobZeroAndReleased, $"{participant}.2"));
                Refuses(() => core.Seal(owner, core.Status().Revision), "ADMISSION_DRAIN_INCOMPLETE");
                core.Quiesce(runtime, participant, Evidence(SettlementKind.ParticipantQuiesced, $"{participant}:{core.Status().Epoch}"));
                var receipt = core.Seal(owner, core.Status().Revision); Check(receipt.Domain == AdmissionProtocol.Domain && receipt.Digest == core.Status().Digest, "drain receipt exact state");
                var successor = UpdatePrincipal.Isolated("update1", 2);
                Refuses(() => core.RecoverOwner(successor, core.Status().Revision, Evidence(SettlementKind.OperationSettled, "update1:1")), "ADMISSION_OWNER_RECOVERY_UNPROVEN");
                core.RecoverOwner(successor, core.Status().Revision, Evidence(SettlementKind.OwnerCessation, "update1:1"));
                Refuses(() => core.Reopen(owner, core.Status().Revision, "health1", Evidence(SettlementKind.AcceptedDisposition, "anything")), "ADMISSION_OWNER_FENCED");
                Refuses(() => core.Reopen(successor, core.Status().Revision, "health1", Evidence(SettlementKind.AcceptedDisposition, $"update1:2:{receipt.Epoch}:health1")), "ADMISSION_DRAIN_INCOMPLETE");
                _ = core.Seal(successor, core.Status().Revision);
                core.Reopen(successor, core.Status().Revision, "health1", Evidence(SettlementKind.AcceptedDisposition, $"update1:2:{receipt.Epoch}:health1"));
                Check(core.Status().Phase == "open", "accepted disposition opens");
                core.Enter(runtime, participant, 3, "call");
                Refuses(() => core.Enter(runtime, participant, 1, "call"), "ADMISSION_PERMIT_ALREADY_SETTLED");
                Refuses(() => core.Close(successor, core.Status().Revision), "ADMISSION_TRANSACTION_FINISHED");
                core.Settle(runtime, $"{participant}.3", Evidence(SettlementKind.OperationSettled, $"{participant}.3"));
                var later = UpdatePrincipal.Isolated("update2", 1); core.Close(later, core.Status().Revision);
                Refuses(() => core.Quiesce(runtime, participant, Evidence(SettlementKind.ParticipantQuiesced, $"{participant}:{receipt.Epoch}")), "ADMISSION_QUIESCENCE_UNPROVEN");
                foreach (var identity in new[] { runtime, other })
                {
                    var member = core.Register(identity); core.Quiesce(identity, member, Evidence(SettlementKind.ParticipantQuiesced, $"{member}:{core.Status().Epoch}"));
                }
                var laterReceipt = core.Seal(later, core.Status().Revision);
                core.Reopen(later, core.Status().Revision, "health2", Evidence(SettlementKind.AcceptedDisposition, $"update2:1:{laterReceipt.Epoch}:health2"));
                Refuses(() => core.Close(owner, core.Status().Revision), "ADMISSION_TRANSACTION_FINISHED");
            }
        }
        finally { Directory.Delete(root, true); }
    }
    private static void Concurrency()
    {
        var root = Root();
        try
        {
            using var core = new AdmissionCore(StoreIdentity.Isolated(root)); var runtime = RuntimePrincipal.Isolated("race-process"); var id = core.Register(runtime); var revision = core.Status().Revision;
            using var start = new ManualResetEventSlim(false); var entered = false; var closed = false;
            var a = Task.Run(() => { start.Wait(); try { core.Enter(runtime, id, 1, "call"); entered = true; } catch (Refusal refusal) when (refusal.Reason == "ADMISSION_CLOSED") { } });
            var b = Task.Run(() => { start.Wait(); try { core.Close(UpdatePrincipal.Isolated("race-update", 1), revision); closed = true; } catch (Refusal refusal) when (refusal.Reason == "ADMISSION_REVISION_CONFLICT") { } });
            start.Set(); Task.WaitAll(a, b);
            Check(entered != closed, "entry versus closure shares durable serialization");
            Check(core.Status().HeldPermits == (entered ? 1 : 0), "race preserves accepted writer");
        }
        finally { Directory.Delete(root, true); }
    }
    private static void SequenceAndRetirement()
    {
        var root = Root(); var runtime = RuntimePrincipal.Isolated("long-lived-runtime"); string participant;
        try
        {
            using (var core = new AdmissionCore(StoreIdentity.Isolated(root)))
            {
                participant = core.Register(runtime);
                for (ulong sequence = 1; sequence <= 520; sequence++)
                {
                    var permit = core.Enter(runtime, participant, sequence, "call"); core.Settle(runtime, permit, Evidence(SettlementKind.OperationSettled, permit));
                }
                var records = AdmissionProtocol.Object(File.ReadAllBytes(Path.Combine(root, "admission.json")), AdmissionStore.MaximumJournalBytes);
                Check(records["state"]!["permits"]!.AsObject().Count == 0 && core.Status().HeldPermits == 0, "more than512 completed calls compact without exhaustion");
                Refuses(() => core.Enter(runtime, participant, 1, "call"), "ADMISSION_PERMIT_ALREADY_SETTLED");
                var first = core.Enter(runtime, participant, 521, "call"); var second = core.Enter(runtime, participant, 522, "background");
                core.Settle(runtime, second, Evidence(SettlementKind.OperationSettled, second));
                Check(core.Status().HeldPermits == 1, "out-of-order settlement retains unknown predecessor");
                core.Settle(runtime, first, Evidence(SettlementKind.OperationSettled, first));
                core.Settle(runtime, second, Evidence(SettlementKind.OperationSettled, second));
                Refuses(() => core.RetireParticipant(runtime, participant, Evidence(SettlementKind.OwnerCessation, $"{runtime.Identity}:{participant}")), "ADMISSION_WORK_HELD");
            }
            using (var core = new AdmissionCore(StoreIdentity.Isolated(root)))
            {
                Refuses(() => core.Enter(runtime, participant, 522, "call"), "ADMISSION_PERMIT_ALREADY_SETTLED");
                Refuses(() => core.Enter(runtime, participant, 524, "call"), "ADMISSION_SEQUENCE_CONFLICT");
                core.Quiesce(runtime, participant, Evidence(SettlementKind.ParticipantQuiesced, $"{participant}:{core.Status().Epoch}"));
                Refuses(() => core.RetireParticipant(runtime, participant, Evidence(SettlementKind.ParticipantQuiesced, participant)), "ADMISSION_PARTICIPANT_CESSATION_UNPROVEN");
                core.RetireParticipant(runtime, participant, Evidence(SettlementKind.OwnerCessation, $"{runtime.Identity}:{participant}"));
                Refuses(() => core.Register(runtime), "ADMISSION_PRINCIPAL_RETIRED");
                Refuses(() => core.Enter(RuntimePrincipal.Isolated(runtime.Identity), participant, 523, "call"), "ADMISSION_PARTICIPANT_MISMATCH");
                for (var index = 0; index < 130; index++)
                {
                    var peer = RuntimePrincipal.Isolated("retired-peer-" + index); var member = core.Register(peer);
                    core.Quiesce(peer, member, Evidence(SettlementKind.ParticipantQuiesced, $"{member}:{core.Status().Epoch}"));
                    core.RetireParticipant(peer, member, Evidence(SettlementKind.OwnerCessation, $"{peer.Identity}:{member}"));
                }
                Check(core.Status().UnquiescedParticipants == 0, "more than128 lifetime participants retire only after cessation and settlement");
            }
        }
        finally { Directory.Delete(root, true); }
    }
    private static void DurableStore()
    {
        var root = Root();
        try
        {
            using (var core = new AdmissionCore(StoreIdentity.Isolated(root)))
            {
                var lockAcl = new FileInfo(Path.Combine(root, "owner.lock")).GetAccessControl();
                Check(lockAcl.GetOwner(typeof(SecurityIdentifier))?.Value == WindowsIdentity.GetCurrent().User!.Value && lockAcl.AreAccessRulesProtected, "lock explicit user owner protected DACL");
                using var child = Child("lock", root); Check(child.WaitForExit(10_000) && child.ExitCode == 0 && child.StandardOutput.ReadToEnd().Trim() == "OWNER_BUSY", "cross-process lifetime lock");
                try { Directory.Move(root, root + "-moved"); throw new Exception("Pinned root renamed"); } catch (IOException) { assertions++; }
                Refuses(() => new AdmissionStore(StoreIdentity.Isolated(root)), "OWNER_BUSY");
                Refuses(() => core.Enter(RuntimePrincipal.Isolated("unknown"), "absent", 1, "call"), "ADMISSION_PARTICIPANT_MISMATCH");
            }
            using (var child = Child("crash", root)) Check(child.WaitForExit(10_000) && child.ExitCode == 42, "actual process exits after durable stage");
            var old = File.ReadAllBytes(Path.Combine(root, "admission.json"));
            var stageAcl = new FileInfo(Path.Combine(root, "admission.pending.json")).GetAccessControl();
            Check(stageAcl.GetOwner(typeof(SecurityIdentifier))?.Value == WindowsIdentity.GetCurrent().User!.Value && stageAcl.AreAccessRulesProtected, "crash stage explicit user owner protected DACL");
            Refuses(() => new AdmissionCore(StoreIdentity.Isolated(root)), "ADMISSION_PUBLICATION_PENDING");
            Check(File.ReadAllBytes(Path.Combine(root, "admission.json")).SequenceEqual(old), "read-only open never recovers publication");
            AdmissionCore.RecoverPublication(StoreIdentity.Isolated(root)); AdmissionCore.RecoverPublication(StoreIdentity.Isolated(root));
            using (var recovered = new AdmissionCore(StoreIdentity.Isolated(root))) Check(recovered.Status().Phase == "closing" && recovered.Status().TransactionId == "crash-update", "explicit recovery idempotent retains closure");
            using (var io = new AdmissionStore(StoreIdentity.Isolated(root)))
            {
                Refuses(() => io.Read("../outside"), "STORE_NAME_INVALID");
                var pending = File.ReadAllBytes(Path.Combine(root, "admission.json")); io.Stage(pending);
                Refuses(() => io.PublishStage("none"), "JOURNAL_CAS_CONFLICT");
            }
            Refuses(() => AdmissionCore.RecoverPublication(StoreIdentity.Isolated(root)), "ADMISSION_RECOVERY_CONFLICT");
            Check(File.ReadAllBytes(Path.Combine(root, "admission.json")).SequenceEqual(File.ReadAllBytes(Path.Combine(root, "admission.pending.json"))), "conflict never overwrites either state");
            File.Delete(Path.Combine(root, "admission.pending.json"));
            var file = new FileInfo(Path.Combine(root, "admission.json")); var acl = file.GetAccessControl();
            Check(acl.GetOwner(typeof(SecurityIdentifier))?.Value == WindowsIdentity.GetCurrent().User!.Value && acl.AreAccessRulesProtected, "published userowner private protected ACL");
            var alias = Path.Combine(root, "extra-link"); Check(CreateHardLinkW(alias, file.FullName, IntPtr.Zero), "hardlink fixture created");
            using (var io = new AdmissionStore(StoreIdentity.Isolated(root))) Refuses(() => io.Read("admission.json"), "JOURNAL_FILE_UNSAFE"); File.Delete(alias);
            Check(SetNamedSecurityInfoW(file.FullName, 1, 0x80000004, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero) == 0, "actual native NULL DACL fixture");
            Refuses(() => new AdmissionCore(StoreIdentity.Isolated(root)), "JOURNAL_ACL_UNSAFE"); file.SetAccessControl(acl);
            acl.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier("S-1-1-0"), FileSystemRights.WriteData, AccessControlType.Allow)); file.SetAccessControl(acl);
            Refuses(() => new AdmissionCore(StoreIdentity.Isolated(root)), "JOURNAL_ACL_UNSAFE");
            Check(file.GetAccessControl().GetAccessRules(true, false, typeof(SecurityIdentifier)).Cast<FileSystemAccessRule>().Any(x => x.IdentityReference.Value == "S-1-1-0"), "unsafe existing ACL preserved");
        }
        finally { Directory.Delete(root, true); }
        var missing = Root();
        try
        {
            using (var core = new AdmissionCore(StoreIdentity.Isolated(missing))) core.Close(UpdatePrincipal.Isolated("lost-journal", 1), core.Status().Revision);
            File.Delete(Path.Combine(missing, "admission.json"));
            Refuses(() => new AdmissionCore(StoreIdentity.Isolated(missing)), "ADMISSION_STATE_MISSING");
            Check(!File.Exists(Path.Combine(missing, "admission.json")), "missing closed journal never reinitializes open");
            Refuses(() => AdmissionCore.InitializeIsolated(StoreIdentity.Isolated(missing)), "JOURNAL_FILE_UNAVAILABLE");
        }
        finally { Directory.Delete(missing, true); }
        var unsafeRoot = Root(false);
        try
        {
            var directory = new DirectoryInfo(unsafeRoot); var permissions = directory.GetAccessControl();
            permissions.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier("S-1-1-0"), FileSystemRights.WriteData, AccessControlType.Allow)); directory.SetAccessControl(permissions);
            Refuses(() => new AdmissionStore(StoreIdentity.Isolated(unsafeRoot)), "STATE_ROOT_ACL_UNSAFE");
            Check(!File.Exists(Path.Combine(unsafeRoot, "owner.lock")), "unsafe existing root untouched");
        }
        finally { Directory.Delete(unsafeRoot, true); }
        var absent = Path.Combine(Path.GetTempPath(), "lnwjud-absent-" + Guid.NewGuid().ToString("N"));
        Refuses(() => new AdmissionStore(StoreIdentity.Isolated(absent)), "STATE_ROOT_UNPROVISIONED");
        Check(!Directory.Exists(absent), "unprovisioned root never bootstrapped");
        var junctionParent = Root(false); var target = Root(false);
        try
        {
            var link = Path.Combine(junctionParent, "junction");
            var start = new ProcessStartInfo("cmd.exe") { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true };
            foreach (var arg in new[] { "/d", "/c", "mklink", "/J", link, target }) start.ArgumentList.Add(arg);
            using (var child = Process.Start(start)!) Check(child.WaitForExit(10_000) && child.ExitCode == 0, "isolated junction created");
            Refuses(() => new AdmissionStore(StoreIdentity.Isolated(link)), "STATE_ROOT_UNSAFE");
            Check(!File.Exists(Path.Combine(target, "owner.lock")), "junction target never mutated");
            Directory.Delete(link);
        }
        finally { Directory.Delete(junctionParent, true); Directory.Delete(target, true); }
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool CreateHardLinkW(string link, string existing, IntPtr attributes);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode)] private static extern uint SetNamedSecurityInfoW(string name, uint type, uint information, IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl);
}
