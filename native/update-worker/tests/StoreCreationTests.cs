using System.Runtime.Versioning;
using System.Security.AccessControl;
using System.Security.Principal;
using Lnwjud.UpdateWorker;

[SupportedOSPlatform("windows")]
internal static class StoreCreationTests
{
    internal static int Run()
    {
        var assertions = 0;
        void Check(bool condition, string message)
        {
            assertions++;
            if (!condition) throw new Exception(message);
        }
        using var identity = WindowsIdentity.GetCurrent();
        var user = identity.User ?? throw new Exception("Store fixture has no user identity");
        var root = Path.Combine(Path.GetTempPath(), "lnwjud-update-owner-" + Guid.NewGuid().ToString("N"));
        void CheckPrivateFile(string filename)
        {
            var security = new FileInfo(filename).GetAccessControl(AccessControlSections.Owner | AccessControlSections.Access);
            Check(security.GetOwner(typeof(SecurityIdentifier)) == user, "New update file must explicitly belong to the user, including elevated default-owner tokens");
            Check(security.AreAccessRulesProtected, "New update file must have a protected private DACL at creation");
            foreach (FileSystemAccessRule rule in security.GetAccessRules(true, true, typeof(SecurityIdentifier)))
            {
                if (rule.AccessControlType != AccessControlType.Allow) continue;
                Check(rule.IdentityReference == user || rule.IdentityReference.Value is "S-1-5-18" or "S-1-5-32-544",
                    "New update file must not grant another principal access");
            }
        }
        using (var io = new WindowsStoreIO(root))
        {
            CheckPrivateFile(Path.Combine(root, "owner.lock"));
            io.Stage("private-stage"u8.ToArray());
            CheckPrivateFile(Path.Combine(root, "journal.pending.json"));
            io.PublishStage("none");
            CheckPrivateFile(Path.Combine(root, "journal.json"));
        }
        using (var reopened = new WindowsStoreIO(root))
            Check(reopened.Read("journal.json")!.Bytes.AsSpan().SequenceEqual("private-stage"u8), "Explicit-owner journal must reopen without changing bytes");

        var lockPath = Path.Combine(root, "owner.lock");
        File.Delete(lockPath);
        File.WriteAllText(lockPath, "");
        var existingOwner = new FileInfo(lockPath).GetAccessControl(AccessControlSections.Owner).GetOwner(typeof(SecurityIdentifier));
        if (existingOwner != user)
        {
            var refused = false;
            try { using var unexpected = new WindowsStoreIO(root); }
            catch (Refusal error) { refused = error.Reason == "JOURNAL_ACL_UNSAFE"; }
            Check(refused, "Existing foreign-owner lock must remain refused instead of being adopted");
            Check(new FileInfo(lockPath).GetAccessControl(AccessControlSections.Owner).GetOwner(typeof(SecurityIdentifier)) == existingOwner,
                "Opening an existing lock must preserve its foreign owner");
            File.Delete(lockPath);
            using var restored = new WindowsStoreIO(root);
        }

        var unsafeAcl = new FileInfo(lockPath).GetAccessControl(AccessControlSections.Access);
        unsafeAcl.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(WellKnownSidType.WorldSid, null), FileSystemRights.FullControl, AccessControlType.Allow));
        new FileInfo(lockPath).SetAccessControl(unsafeAcl);
        var unsafeBytes = new FileInfo(lockPath).GetAccessControl(AccessControlSections.Access).GetSecurityDescriptorBinaryForm();
        var held = false;
        try { using var unexpected = new WindowsStoreIO(root); }
        catch (Refusal error) { held = error.Reason == "JOURNAL_ACL_UNSAFE"; }
        Check(held, "Existing unsafe lock DACL must remain refused");
        Check(new FileInfo(lockPath).GetAccessControl(AccessControlSections.Access).GetSecurityDescriptorBinaryForm().AsSpan().SequenceEqual(unsafeBytes),
            "Refusal must preserve the existing lock DACL");
        Console.WriteLine($"PASS explicit user-owner/private-DACL update files; existing unsafe state refused ({assertions} assertions, foreignOwnerFixture={existingOwner != user})");
        return assertions;
    }
}
