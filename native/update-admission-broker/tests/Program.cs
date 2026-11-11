using System.Diagnostics;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.Json.Nodes;
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
    private static string NewPermit(AdmissionGrant grant) => grant is AdmissionGrant.Granted created
        ? created.PermitId : throw new Exception("Expected a new admission grant");
    private static Process Child(params string[] arguments)
    {
        var start = new ProcessStartInfo(Environment.ProcessPath!) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true };
        foreach (var arg in arguments) start.ArgumentList.Add(arg);
        return Process.Start(start)!;
    }
    private static int Main(string[] args)
    {
        if (args.Length == 1 && args[0] == "epoch-quiescence-test")
        {
            try { EpochBoundQuiescence(); Console.WriteLine("PASS current-epoch quiescence"); return 0; }
            catch (Exception error) { Console.Error.WriteLine(error); return 1; }
        }
        if (args.Length == 1 && args[0] == "unsafe-successor-test")
        {
            try { UnsafeSuccessor(); Console.WriteLine("PASS unsafe admission successor refused"); return 0; }
            catch (Exception error) { Console.Error.WriteLine(error); return 1; }
        }
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
        try { Protocol(); PeerObservation(); CorruptJournal(); Lifecycle(); EpochBoundQuiescence(); SequenceAndRetirement(); Concurrency(); DuplicateEntryRace(); DurableStore(); UnsafeSuccessor(); Console.WriteLine($"PASS {assertions} admission assertions"); return 0; }
        catch (Exception error) { Console.Error.WriteLine(error); return 1; }
    }
    private static void PeerObservation()
    {
        var name = "lnwjud-admission-observe-" + Guid.NewGuid().ToString("N");
        using var server = new NamedPipeServerStream(name, PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous);
        Refuses(() => WindowsUpdateAdmissionPeerObservation.Capture(server.SafePipeHandle), "MAINTENANCE_PEER_UNVERIFIED");
        using var client = new NamedPipeClientStream(".", name, PipeDirection.InOut, PipeOptions.Asynchronous);
        var connected = server.WaitForConnectionAsync();
        client.Connect(5000);
        if (!connected.Wait(5000)) throw new Exception("Observation pipe connection timed out");
        using var observation = WindowsUpdateAdmissionPeerObservation.Capture(server.SafePipeHandle);
        Check(observation.ProcessId == (uint)Environment.ProcessId && observation.CreationTime > 0, "peer observation pins process creation identity");
        Check(observation.UserSid == WindowsIdentity.GetCurrent().User!.Value, "peer observation reads kernel token user");
        Check(observation.SessionId == (uint)Process.GetCurrentProcess().SessionId, "pipe, process and token session identities agree");
        Check(string.Equals(Path.GetFullPath(observation.ImagePath), Path.GetFullPath(Environment.ProcessPath!), StringComparison.OrdinalIgnoreCase), "peer observation reads process image");
        Check(observation.IsObservedProcessAlive(), "peer observation checks retained process handle");
        observation.Dispose();
        Check(!observation.IsObservedProcessAlive(), "disposed observation cannot assert process liveness");
    }

    private static void DuplicateEntryRace()
    {
        var root = Root();
        try
        {
            using var core = new AdmissionCore(StoreIdentity.Isolated(root));
            var runtime = RuntimePrincipal.Isolated("duplicate-race"); var participant = core.Register(runtime);
            using var start = new ManualResetEventSlim(false);
            var first = Task.Run(() => { start.Wait(); return core.Enter(runtime, participant, 1, "call"); });
            var second = Task.Run(() => { start.Wait(); return core.Enter(runtime, participant, 1, "call"); });
            start.Set();
            if (!Task.WaitAll([first, second], 10_000)) throw new Exception("Duplicate entry race did not finish");
            var results = new[] { first.Result, second.Result };
            Check(results.Count(result => result is AdmissionGrant.Granted) == 1
                && results.Count(result => result is AdmissionGrant.ExistingRequiresReconciliation) == 1
                && core.Status().HeldPermits == 1, "concurrent duplicate entry grants once and requires reconciliation");
        }
        finally { Directory.Delete(root, true); }
    }
    private static void EpochBoundQuiescence()
    {
        var root = Root();
        try
        {
            var runtime = RuntimePrincipal.Isolated("epoch-owner");
            string participant; string oldEpoch;
            using (var previous = new AdmissionCore(StoreIdentity.Isolated(root)))
            {
                participant = previous.Register(runtime); oldEpoch = previous.Status().Epoch;
                previous.Quiesce(runtime, participant, Evidence(SettlementKind.ParticipantQuiesced, $"{participant}:{oldEpoch}"));
            }
            using var core = new AdmissionCore(StoreIdentity.Isolated(root));
            var updater = UpdatePrincipal.Isolated("epoch-update", 1);
            core.Close(updater, core.Status().Revision);
            var current = core.Status();
            Check(current.Epoch != oldEpoch && current.UnquiescedParticipants == 1, "new closure requires current-epoch quiescence");
            Refuses(() => core.Seal(updater, current.Revision), "ADMISSION_DRAIN_INCOMPLETE");
            Refuses(() => core.Quiesce(runtime, participant, Evidence(SettlementKind.ParticipantQuiesced, $"{participant}:{oldEpoch}")), "ADMISSION_QUIESCENCE_UNPROVEN");
            core.Quiesce(runtime, participant, Evidence(SettlementKind.ParticipantQuiesced, $"{participant}:{current.Epoch}"));
            Check(core.Seal(updater, core.Status().Revision).Epoch == current.Epoch, "new epoch proof permits sealing");
        }
        finally { Directory.Delete(root, true); }
    }
    private static void UnsafeSuccessor()
    {
        var root = Root();
        try
        {
            var identity = StoreIdentity.Isolated(root);
            using (var core = new AdmissionCore(identity))
            {
                var owner = RuntimePrincipal.Isolated("held-owner"); var participant = core.Register(owner);
                core.Enter(owner, participant, 1, "call");
                core.Close(UpdatePrincipal.Isolated("update-held", 1), core.Status().Revision);
                Check(core.Status().HeldPermits == 1 && core.Status().Phase == "closing", "fixture has a held permit during closure");
            }
            byte[] current; byte[] pending;
            using (var store = new AdmissionStore(identity))
            {
                var previous = store.Read("admission.json")!; current = previous.Bytes;
                var value = AdmissionProtocol.Object(current, AdmissionStore.MaximumJournalBytes);
                value["predecessor"] = previous.Digest;
                value["revision"] = AdmissionProtocol.Decimal(AdmissionProtocol.Number(value, "revision") + 1);
                var state = value["state"]!.AsObject();
                state["phase"] = "open"; state["transaction"] = ""; state["generation"] = "0";
                state["participants"] = new JsonObject(); state["permits"] = new JsonObject();
                pending = AdmissionProtocol.Encode(value); store.Stage(pending);
            }
            Refuses(() => AdmissionCore.RecoverPublication(identity), "ADMISSION_RECOVERY_UNVERIFIED");
            Check(File.ReadAllBytes(Path.Combine(root, "admission.json")).SequenceEqual(current), "rejected successor preserves current state");
            Check(File.ReadAllBytes(Path.Combine(root, "admission.pending.json")).SequenceEqual(pending), "rejected successor preserves pending evidence");
        }
        finally { Directory.Delete(root, true); }
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
        Refuses(() => AdmissionProtocol.Object([123, 34, 255, 34, 58, 49, 125], 100), "ADMISSION_JSON_INVALID");
        Refuses(() => AdmissionProtocol.Object(Encoding.UTF8.GetBytes("{broken"), 100), "ADMISSION_JSON_INVALID");
        Refuses(() => AdmissionProtocol.Object(Encoding.UTF8.GetBytes("{\"x\":\"\\uD800\"}"), 100), "ADMISSION_JSON_INVALID");
        Refuses(() => AdmissionProtocol.Object(Encoding.UTF8.GetBytes("{\"\\uD800\":1}"), 100), "ADMISSION_JSON_INVALID");
        Check(AdmissionProtocol.Text(AdmissionProtocol.Object(Encoding.UTF8.GetBytes("{\"x\":\"\\uD83D\\uDE00\"}"), 100), "x") == "😀", "valid paired surrogate accepted");
        Refuses(() => StoreIdentity.Installed(), "MAINTENANCE_SERVICE_IDENTITY_UNAVAILABLE");
        // ProgramData grants Users child creation. Only a protected trusted
        // immediate parent can prevent pre-created/replaced journal roots.
        var testServiceSid = WindowsIdentity.GetCurrent().User!.Value;
        var protectedParent = $"O:BAG:BAD:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;0x00000004;;;{testServiceSid})(A;;GR;;;WD)";
        AdmissionStore.ValidateProtectedParentDacl(new RawSecurityDescriptor(protectedParent), testServiceSid);
        Check(true, "trusted protected journal parent permits service-only child creation");
        var protectedParentSecurity = WindowsUpdateAdmissionStoreParentProvisioner.ProtectedParentSecurity(
            WindowsIdentity.GetCurrent().User!);
        AdmissionStore.ValidateProtectedParentDacl(
            new RawSecurityDescriptor(protectedParentSecurity.GetSecurityDescriptorBinaryForm(), 0), testServiceSid);
        Check(true, "provisioned parent ACL passes installed-store readback validator");
        WindowsUpdateAdmissionStoreParentProvisioner.ValidateProgramDataDacl(
            new RawSecurityDescriptor("O:SYG:SYD:(A;;GA;;;SY)(A;;GA;;;BA)(A;;0x00000006;;;AU)"));
        Check(true, "ProgramData permits unprivileged creation without deletion or attribute writes");
        Refuses(() => WindowsUpdateAdmissionStoreParentProvisioner.ValidateProgramDataDacl(
            new RawSecurityDescriptor("O:SYG:SYD:(A;;GA;;;SY)(A;;GA;;;BA)(A;;0x00000100;;;AU)")),
            "STATE_PARENT_ACL_UNSAFE");
        var provisionedAcl = new RawSecurityDescriptor(protectedParentSecurity.GetSecurityDescriptorBinaryForm(), 0);
        Check(provisionedAcl.DiscretionaryAcl!.Cast<GenericAce>().OfType<QualifiedAce>()
            .Where(ace => ace.SecurityIdentifier.Value == testServiceSid)
            .All(ace => (ace.AceFlags & (AceFlags.ContainerInherit | AceFlags.ObjectInherit)) == 0),
            "service child-creation ACE does not propagate into journal root");
        const string badParent = "STATE_PARENT_ACL_UNSAFE";
        foreach (var unsafeParent in new[] {
            $"O:BAG:BAD:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GA;;;{testServiceSid})",
            "O:BAG:BAD:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GW;;;WD)",
            "O:AUG:BAD:P(A;;GA;;;SY)(A;;GA;;;BA)",
            "O:BAG:BAD:(A;;GA;;;SY)(A;;GA;;;BA)" })
            Refuses(() => AdmissionStore.ValidateProtectedParentDacl(new RawSecurityDescriptor(unsafeParent), testServiceSid), badParent);
        Check(WindowsUpdateAdmissionService.Run() == 125, "SCM-only admission service refuses non-SCM launch");
        var commonFiles = Environment.GetFolderPath(Environment.SpecialFolder.CommonProgramFiles);
        var image = WindowsUpdateAdmissionRegistration.ExpectedImagePath(commonFiles);
        var command = "\"" + image + "\" service";
        WindowsUpdateAdmissionRegistration.Validate(command, @"NT AUTHORITY\LocalService", 0x10, 2, 1, 1, commonFiles);
        Check(true, "exact protected-layout SCM registration shape accepted for inspection only");
        const string badRegistration = "MAINTENANCE_SERVICE_REGISTRATION_UNVERIFIED";
        Refuses(() => WindowsUpdateAdmissionRegistration.Validate(command + " extra", @"NT AUTHORITY\LocalService", 0x10, 2, 1, 1, commonFiles), badRegistration);
        Refuses(() => WindowsUpdateAdmissionRegistration.Validate(command, @"LocalSystem", 0x10, 2, 1, 1, commonFiles), badRegistration);
        Refuses(() => WindowsUpdateAdmissionRegistration.Validate(command, @"NT AUTHORITY\LocalService", 0x20, 2, 1, 1, commonFiles), badRegistration);
        Refuses(() => WindowsUpdateAdmissionRegistration.Validate(command, @"NT AUTHORITY\LocalService", 0x10, 3, 1, 1, commonFiles), badRegistration);
        Refuses(() => WindowsUpdateAdmissionRegistration.Validate(command, @"NT AUTHORITY\LocalService", 0x10, 2, 0, 1, commonFiles), badRegistration);
        Refuses(() => WindowsUpdateAdmissionRegistration.Validate(command, @"NT AUTHORITY\LocalService", 0x10, 2, 1, 0, commonFiles), badRegistration);
        Refuses(() => WindowsUpdateAdmissionRegistration.Validate(command, @"NT AUTHORITY\LocalService", 0x10, 2, 1, 1, commonFiles, loadOrderGroup: "UntrustedGroup"), badRegistration);
        Refuses(() => WindowsUpdateAdmissionRegistration.Validate(command, @"NT AUTHORITY\LocalService", 0x10, 2, 1, 1, commonFiles, dependencies: "UntrustedService"), badRegistration);
        Refuses(() => WindowsUpdateAdmissionRegistration.Validate(command, @"NT AUTHORITY\LocalService", 0x10, 2, 1, 1, commonFiles, tagId: 1), badRegistration);
        WindowsUpdateAdmissionRegistration.ValidateOptionalConfiguration(false, false, false, false, false, false);
        const string badOptionalConfig = "MAINTENANCE_SERVICE_REGISTRATION_UNVERIFIED";
        Refuses(() => WindowsUpdateAdmissionRegistration.ValidateOptionalConfiguration(true, false, false, false, false, false), badOptionalConfig);
        Refuses(() => WindowsUpdateAdmissionRegistration.ValidateOptionalConfiguration(false, true, false, false, false, false), badOptionalConfig);
        Refuses(() => WindowsUpdateAdmissionRegistration.ValidateOptionalConfiguration(false, false, true, false, false, false), badOptionalConfig);
        Refuses(() => WindowsUpdateAdmissionRegistration.ValidateOptionalConfiguration(false, false, false, true, false, false), badOptionalConfig);
        Refuses(() => WindowsUpdateAdmissionRegistration.ValidateOptionalConfiguration(false, false, false, false, true, false), badOptionalConfig);
        Refuses(() => WindowsUpdateAdmissionRegistration.ValidateOptionalConfiguration(false, false, false, false, false, true), badOptionalConfig);
        var safeServiceDacl = new RawSecurityDescriptor("O:SYG:SYD:(A;;0x000F01FF;;;SY)(A;;0x000F01FF;;;BA)(A;;0x00020004;;;AU)");
        WindowsUpdateAdmissionRegistration.ValidateServiceDacl(safeServiceDacl);
        Check(true, "service DACL allows read-only unprivileged observers");
        const string badDacl = "MAINTENANCE_SERVICE_DACL_UNVERIFIED";
        foreach (var sddl in new[] {
            "O:SYG:SYD:(A;;0x00000002;;;AU)",
            "O:SYG:SYD:(A;;0x00040000;;;LS)",
            "O:SYG:SYD:(A;;0x10000000;;;WD)",
            "O:AUG:SYD:(A;;0x000F01FF;;;BA)" })
            Refuses(() => WindowsUpdateAdmissionRegistration.ValidateServiceDacl(new RawSecurityDescriptor(sddl)), badDacl);
        var safeImageDacl = new RawSecurityDescriptor("O:SYG:SYD:(A;;0x001F01FF;;;SY)(A;;0x001F01FF;;;BA)(A;;0x001200A9;;;AU)");
        WindowsUpdateAdmissionRegistration.ValidateImageDacl(safeImageDacl);
        Check(true, "protected image ACL permits unprivileged read and execute only");
        foreach (var sddl in new[] {
            "O:SYG:SYD:(A;;0x00000002;;;BU)",
            "O:SYG:SYD:(A;;0x00010000;;;AU)",
            "O:SYG:SYD:(A;;0x40000000;;;WD)",
            "O:AUG:SYD:(A;;0x001F01FF;;;BA)" })
            Refuses(() => WindowsUpdateAdmissionRegistration.ValidateImageDacl(new RawSecurityDescriptor(sddl)), "MAINTENANCE_SERVICE_IMAGE_UNVERIFIED");
        WindowsUpdateAdmissionRegistration.ValidateImageDacl(new RawSecurityDescriptor("O:SYG:SYD:(A;OIIO;0x001F01FF;;;CO)(A;;0x001200A9;;;AU)"));
        Check(true, "inherit-only creator owner ACE is not effective on inspected image path");
        WindowsUpdateAdmissionRegistration.ValidateRunningImage(image, commonFiles);
        Check(true, "running image path must match fixed service registration");
        Check(WindowsUpdateAdmissionProvisioner.ValidatePin(new string('A', 64)).Length == 32,
            "attended SCM provisioner accepts exact SHA-256 pin");
        foreach (var invalidPin in new[] { "", new string('a', 63), new string('g', 64), new string('a', 65) })
            Refuses(() => WindowsUpdateAdmissionProvisioner.ValidatePin(invalidPin),
                "MAINTENANCE_SERVICE_IMAGE_UNVERIFIED");
        var imageBytes = Encoding.UTF8.GetBytes("immutable broker image fixture");
        var imagePin = SHA256.HashData(imageBytes);
        using (var source = new MemoryStream(imageBytes))
        using (var destination = new MemoryStream())
        {
            WindowsUpdateAdmissionImageStager.CopyVerified(source, destination, imagePin);
            Check(destination.ToArray().SequenceEqual(imageBytes), "staged image bytes match authenticated pin");
        }
        using (var source = new MemoryStream(imageBytes))
        using (var destination = new MemoryStream())
        {
            Refuses(() => WindowsUpdateAdmissionImageStager.CopyVerified(source, destination, new byte[32]),
                "MAINTENANCE_SERVICE_IMAGE_UNVERIFIED");
            Check(destination.Length == 0, "mismatched image pin refuses before any staging writes");
        }
        using (var empty = new MemoryStream())
        using (var destination = new MemoryStream())
            Refuses(() => WindowsUpdateAdmissionImageStager.CopyVerified(empty, destination, SHA256.HashData([])),
                "MAINTENANCE_SERVICE_IMAGE_UNVERIFIED");
        Refuses(() => WindowsUpdateAdmissionRegistration.ValidateRunningImage(image + ".old", commonFiles), "MAINTENANCE_SERVICE_IMAGE_UNVERIFIED");
        Refuses(() => WindowsUpdateAdmissionRegistration.ExpectedImagePath(@"\\server\share"), "MAINTENANCE_SERVICE_IMAGE_UNVERIFIED");
        foreach (var path in new[] { "relative", "\\\\server\\share", "C:\\", "C:\\root:stream" }) Refuses(() => AdmissionStore.ValidatePath(path), "STATE_ROOT_UNSAFE");
    }
    private static void CorruptJournal()
    {
        var root = Root();
        try
        {
            var identity = StoreIdentity.Isolated(root); var file = Path.Combine(root, "admission.json");
            var current = File.ReadAllBytes(file); byte[] corrupt = [123, 34, 255, 34, 58, 49, 125];
            using (var store = new AdmissionStore(identity)) store.Stage(corrupt);
            Refuses(() => AdmissionCore.RecoverPublication(identity), "ADMISSION_JSON_INVALID");
            Check(File.ReadAllBytes(file).SequenceEqual(current), "invalid pending preserves current journal");
            Check(File.ReadAllBytes(Path.Combine(root, "admission.pending.json")).SequenceEqual(corrupt), "invalid pending evidence is preserved");
        }
        finally { Directory.Delete(root, true); }
        root = Root();
        try
        {
            var file = Path.Combine(root, "admission.json"); var corrupt = Encoding.UTF8.GetBytes("{broken");
            File.WriteAllBytes(file, corrupt);
            Refuses(() => new AdmissionCore(StoreIdentity.Isolated(root)), "ADMISSION_JSON_INVALID");
            Check(File.ReadAllBytes(file).SequenceEqual(corrupt), "invalid current journal is preserved");
        }
        finally { Directory.Delete(root, true); }
        root = Root();
        try
        {
            var identity = StoreIdentity.Isolated(root);
            var runtime = RuntimePrincipal.Isolated("parent-journal-owner");
            string participant;
            using (var core = new AdmissionCore(identity))
            {
                participant = core.Register(runtime);
                core.Enter(runtime, participant, 1, "call");
                core.Promote(runtime, participant, 2, "parent-attempt", $"{participant}.1");
            }
            var file = Path.Combine(root, "admission.json");
            var original = AdmissionProtocol.Object(File.ReadAllBytes(file), AdmissionStore.MaximumJournalBytes);
            var permits = (JsonObject)((JsonObject)original["state"]!)["permits"]!;
            ((JsonObject)permits[$"{participant}.2"]!).Remove("parent");
            File.WriteAllBytes(file, AdmissionProtocol.Encode(original));
            Refuses(() => new AdmissionCore(identity), "ADMISSION_FIELDS_INVALID");
            ((JsonObject)permits[$"{participant}.2"]!)["parent"] = $"{participant}.01";
            File.WriteAllBytes(file, AdmissionProtocol.Encode(original));
            Refuses(() => new AdmissionCore(identity), "ADMISSION_STATE_INVALID");
        }
        finally { Directory.Delete(root, true); }
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
                Check(NewPermit(core.Enter(runtime, participant, 1, "call")) == $"{participant}.1", "initial entry grants a permit"); var revision = core.Status().Revision;
                Check(core.Enter(runtime, participant, 1, "call") is AdmissionGrant.ExistingRequiresReconciliation && core.Status().Revision == revision, "entry retry requires reconciliation");
                Refuses(() => core.Enter(runtime, participant, 1, "background"), "ADMISSION_PERMIT_CONFLICT");
                core.Close(owner, revision);
                Check(core.Enter(runtime, participant, 1, "call") is AdmissionGrant.ExistingRequiresReconciliation, "closed admission never regrants an existing permit");
                Refuses(() => core.Enter(runtime, participant, 2, "call"), "ADMISSION_CLOSED");
                Refuses(() => core.Enter(other, participant, 1, "call"), "ADMISSION_PARTICIPANT_MISMATCH");
                var quarantined = core.Register(other); Check(core.Status().UnquiescedParticipants == 1, "late participant quarantined");
                Refuses(() => core.Enter(other, quarantined, 1, "startup"), "ADMISSION_PARTICIPANT_QUIESCENT");
                Check(core.Promote(runtime, participant, 2, "attempt1", $"{participant}.1") is AdmissionGrant.Granted, "promotion grants a new job permit");
                Check(core.Promote(runtime, participant, 2, "attempt1", $"{participant}.1") is AdmissionGrant.ExistingRequiresReconciliation, "matching promotion retry requires reconciliation");
                Refuses(() => core.Promote(runtime, participant, 2, "attempt1", "different-parent"), "ADMISSION_PERMIT_CONFLICT");
                Refuses(() => core.Promote(runtime, participant, 2, "different-attempt", $"{participant}.1"), "ADMISSION_PERMIT_CONFLICT");
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
                Check(core.Promote(runtime, participant, 2, "attempt1", $"{participant}.1") is AdmissionGrant.ExistingRequiresReconciliation, "restart retains matching promotion parent without regrant");
                Refuses(() => core.Promote(runtime, participant, 2, "attempt1", "different-parent"), "ADMISSION_PERMIT_CONFLICT");
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
                    var permit = NewPermit(core.Enter(runtime, participant, sequence, "call")); core.Settle(runtime, permit, Evidence(SettlementKind.OperationSettled, permit));
                }
                var records = AdmissionProtocol.Object(File.ReadAllBytes(Path.Combine(root, "admission.json")), AdmissionStore.MaximumJournalBytes);
                Check(records["state"]!["permits"]!.AsObject().Count == 0 && core.Status().HeldPermits == 0, "more than512 completed calls compact without exhaustion");
                Refuses(() => core.Enter(runtime, participant, 1, "call"), "ADMISSION_PERMIT_ALREADY_SETTLED");
                var first = NewPermit(core.Enter(runtime, participant, 521, "call")); var second = NewPermit(core.Enter(runtime, participant, 522, "background"));
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
            AdmissionCore.RecoverPublication(StoreIdentity.Isolated(root));
            AdmissionCore.RecoverPublication(StoreIdentity.Isolated(root));
            using (var child = Child("crash", root)) Check(child.WaitForExit(10_000) && child.ExitCode == 42, "actual process exits after durable stage");
            var old = File.ReadAllBytes(Path.Combine(root, "admission.json"));
            var staged = File.ReadAllBytes(Path.Combine(root, "admission.pending.json"));
            var stageAcl = new FileInfo(Path.Combine(root, "admission.pending.json")).GetAccessControl();
            Check(stageAcl.GetOwner(typeof(SecurityIdentifier))?.Value == WindowsIdentity.GetCurrent().User!.Value && stageAcl.AreAccessRulesProtected, "crash stage explicit user owner protected DACL");
            Refuses(() => new AdmissionCore(StoreIdentity.Isolated(root)), "ADMISSION_PUBLICATION_PENDING");
            Check(File.ReadAllBytes(Path.Combine(root, "admission.json")).SequenceEqual(old), "read-only open never recovers publication");
            Refuses(() => AdmissionCore.RecoverPublication(StoreIdentity.Isolated(root)), "ADMISSION_RECOVERY_UNVERIFIED");
            Check(File.ReadAllBytes(Path.Combine(root, "admission.json")).SequenceEqual(old), "unverified recovery preserves current journal");
            Check(File.ReadAllBytes(Path.Combine(root, "admission.pending.json")).SequenceEqual(staged), "unverified recovery preserves staged journal");
            Refuses(() => new AdmissionCore(StoreIdentity.Isolated(root)), "ADMISSION_PUBLICATION_PENDING");
            File.Delete(Path.Combine(root, "admission.pending.json")); // Isolated fixture only; production must retain pending evidence.
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
