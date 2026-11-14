using System.Diagnostics;
using System.IO.Compression;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text.Json.Nodes;
using Lnwjud.UpdateWorker;

namespace Lnwjud.Containment;

internal static class NativeUpdateTransactionTests
{
    private static int assertions;
    private static void Check(bool value, string message) { assertions++; if (!value) throw new Exception(message); }
    private static void Refused(Action action, string? reason = null)
    {
        try { action(); }
        catch (Refusal error) when (reason is null || error.Reason == reason) { assertions++; return; }
        throw new Exception("Expected native refusal " + reason);
    }

    internal static void Run()
    {
        var root = Path.Combine(Path.GetTempPath(), "lnwjud-native-update-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try { Payload(root); Profile(root); Health(root); ColdRecovery(root); }
        finally
        {
            var full = Path.GetFullPath(root);
            if (!full.StartsWith(Path.GetFullPath(Path.GetTempPath()), StringComparison.OrdinalIgnoreCase)
                || !Path.GetFileName(full).StartsWith("lnwjud-native-update-", StringComparison.Ordinal)) throw new Exception("Unsafe fixture cleanup");
            Directory.Delete(full, true);
        }
        Console.WriteLine($"PASS native update bounded ZIP, lossless data streams, live health proof and cold recovery ({assertions} assertions)");
    }

    private static void Payload(string root)
    {
        var app = "native candidate fixture"u8.ToArray();
        var file = new InstalledFile("lnwjud.exe", (ulong)app.Length, ReleaseTrustPolicy.Hash(app));
        JsonObject Entry(InstalledFile item) => new() { ["path"] = item.Path, ["sizeBytes"] = Wire.Decimal(item.SizeBytes), ["sha256"] = item.Sha256 };
        var manifest = Wire.Encode(new JsonObject { ["schemaVersion"] = 1, ["files"] = new JsonArray(Entry(file)) });
        var layout = new WindowsBaselineLayout(new string('a', 64), file, file, file,
            new("slots/A/manifest.json", (ulong)manifest.Length, ReleaseTrustPolicy.Hash(manifest)));
        var index = 0;
        string Archive(Action<ZipArchive> populate)
        {
            var path = Path.Combine(root, "archive-" + index++ + ".zip");
            using var destination = File.Create(path);
            using var zip = new ZipArchive(destination, ZipArchiveMode.Create);
            void Add(string name, byte[] bytes) { using var stream = zip.CreateEntry(name).Open(); stream.Write(bytes); }
            Add("manifest.json", manifest); Add("lnwjud.exe", app); populate(zip);
            return path;
        }
        var valid = Archive(_ => { });
        using (var payload = NativeUpdatePayload.OpenFixture(valid, layout))
        {
            var copied = Path.Combine(root, "extracted.exe"); payload.CopyFixture("lnwjud.exe", copied);
            Check(File.ReadAllBytes(copied).AsSpan().SequenceEqual(app), "Authenticated inventory copies exact candidate bytes");
        }
        Refused(() => { using var payload = NativeUpdatePayload.OpenFixture(valid, layout with { Manifest = layout.Manifest with { Sha256 = new string('0', 64) } }); });
        Refused(() => { using var payload = NativeUpdatePayload.OpenFixture(Archive(zip => zip.CreateEntry("../escape.exe")), layout); });
        Refused(() => { using var payload = NativeUpdatePayload.OpenFixture(Archive(zip => zip.CreateEntry("LNWJUD.EXE")), layout); });
        Refused(() => { using var payload = NativeUpdatePayload.OpenFixture(Archive(zip => zip.CreateEntry("folder/")), layout); });
        Check(!File.Exists(Path.Combine(Path.GetDirectoryName(root)!, "escape.exe")), "Rejected ZIP entries never escape the staging directory");
        var unsafeMode = Path.Combine(root, "symlink.zip");
        using (var destination = File.Create(unsafeMode))
        using (var zip = new ZipArchive(destination, ZipArchiveMode.Create))
        {
            using (var stream = zip.CreateEntry("manifest.json").Open()) stream.Write(manifest);
            var entry = zip.CreateEntry("lnwjud.exe"); entry.ExternalAttributes = unchecked((int)0xa1ff0000);
            using var content = entry.Open(); content.Write(app);
        }
        Refused(() => { using var payload = NativeUpdatePayload.OpenFixture(unsafeMode, layout); }, "UPDATE_PAYLOAD_ENTRY_UNSAFE");
        var changed = Path.Combine(root, "changed.zip");
        using (var destination = File.Create(changed))
        using (var zip = new ZipArchive(destination, ZipArchiveMode.Create))
        {
            using (var stream = zip.CreateEntry("manifest.json").Open()) stream.Write(manifest);
            app[0] ^= 1; using var content = zip.CreateEntry("lnwjud.exe").Open(); content.Write(app);
        }
        using var corrupt = NativeUpdatePayload.OpenFixture(changed, layout);
        Refused(() => corrupt.CopyFixture("lnwjud.exe", Path.Combine(root, "corrupt.exe")), "UPDATE_PAYLOAD_FILE_MISMATCH");
    }

    private static void Profile(string root)
    {
        var source = Path.Combine(root, "source"); Directory.CreateDirectory(Path.Combine(source, "empty"));
        var database = Path.Combine(source, "data.sqlite"); File.WriteAllBytes(database, [0, 1, 2, 255]);
        File.WriteAllText(database + ":operator-note", "preserve alternate stream");
        File.WriteAllText(Path.Combine(source, "data.sqlite-wal"), "uncheckpointed transaction");
        var first = Path.Combine(root, "snapshot"); var second = Path.Combine(root, "candidate");
        var digest = NativeUpdateData.CloneFixture(source, first);
        Check(NativeUpdateData.CloneFixture(first, second) == digest, "Immutable backup and candidate retain identical stream inventory");
        Check(File.ReadAllText(Path.Combine(second, "data.sqlite:operator-note")) == "preserve alternate stream"
            && File.ReadAllText(Path.Combine(second, "data.sqlite-wal")) == "uncheckpointed transaction"
            && Directory.Exists(Path.Combine(second, "empty")), "Snapshot preserves ADS, SQLite WAL and empty directories");
        File.WriteAllText(Path.Combine(second, "data.sqlite-wal"), "candidate migration");
        Check(File.ReadAllText(Path.Combine(first, "data.sqlite-wal")) == "uncheckpointed transaction"
            && File.ReadAllBytes(database).AsSpan().SequenceEqual(new byte[] { 0, 1, 2, 255 }), "Candidate mutation leaves original and rollback snapshot unchanged");
        using (var writer = new FileStream(database, FileMode.Open, FileAccess.ReadWrite, FileShare.None))
            Refused(() => NativeUpdateData.CloneFixture(source, Path.Combine(root, "writer-conflict")), "UPDATE_PROFILE_FILE_UNSAFE");
        Check(CreateHardLinkW(Path.Combine(source, "alias.sqlite"), database, 0), "NTFS hardlink fixture created");
        Refused(() => NativeUpdateData.CloneFixture(source, Path.Combine(root, "hardlink-refusal")), "UPDATE_PROFILE_FILE_UNSAFE");
    }

    private static void Health(string root)
    {
        var image = Environment.ProcessPath!;
        var expected = new InstalledFile("fixture.exe", (ulong)new FileInfo(image).Length, ReleaseTrustPolicy.Hash(File.ReadAllBytes(image)));
        var job = @"Local\lnwjud-update-health-" + Guid.NewGuid().ToString("N");
        var environment = Environment.GetEnvironmentVariables().Cast<System.Collections.DictionaryEntry>()
            .ToDictionary(entry => (string)entry.Key, entry => (string)(entry.Value ?? ""), StringComparer.OrdinalIgnoreCase);
        using var child = ContainedProcess.Start(image, ["installed-client-boundary-hold"], AppContext.BaseDirectory, false, environment, jobName: job);
        using var witness = NativeUpdateWriterWitness.CaptureFixture(Guid.NewGuid().ToString("D"), (int)child.ProcessId, job, image, expected);
        var owner = WindowsStoreIO.CurrentOwner(); var installation = new string('a', 64);
        var selected = SlotSelection.Create(installation, 1, 1, "none", owner, Guid.NewGuid().ToString("D"), "A", new string('a', 64),
            DataGeneration.Create(Guid.NewGuid().ToString("D"), new string('1', 64)));
        var transaction = UpdateTransactionJournal.Create(selected, "none", owner, "fixture", "fixture-release", 1, new string('e', 64), "5.9.2",
            new string('b', 64), DataGeneration.Create(Guid.NewGuid().ToString("D"), new string('2', 64)), new(false, false, null),
            Guid.NewGuid().ToString("D"), Guid.NewGuid().ToString("D"), Guid.NewGuid().ToString("D"));
        var challenge = new string('c', 64);
        var report = new JsonObject { ["transactionId"] = transaction.TransactionId, ["challenge"] = challenge, ["version"] = "5.9.2",
            ["dataGenerationId"] = transaction.CandidateDataGeneration.Id, ["migrationReady"] = true, ["runtimeReady"] = true,
            ["tunnelConnected"] = false, ["profileDigest"] = null };
        report["challenge"] = new string('0', 64);
        Refused(() => NativeUpdateHealthEvidence.Capture(transaction, false, "5.9.2", witness, challenge, report), "UPDATE_HEALTH_UNVERIFIED");
        report["challenge"] = challenge;
        var proof = NativeUpdateHealthEvidence.Capture(transaction, false, "5.9.2", witness, challenge, report);
        using var store = new UpdateTransactionStore(Path.Combine(root, "health-state"), installation); store.InitializeSelection(selected);
        transaction = store.PersistTransaction(transaction, "none");
        void Advance(UpdateTransactionPhase phase) => transaction = store.PersistTransaction(transaction.Advance(phase, transaction.Digest, owner), transaction.Digest);
        foreach (var phase in new[] { UpdateTransactionPhase.QuiesceIntent, UpdateTransactionPhase.Quiesced, UpdateTransactionPhase.TunnelStopIntent,
            UpdateTransactionPhase.TunnelStopped, UpdateTransactionPhase.CandidateSelectionIntent }) Advance(phase);
        _ = store.SelectCandidate(transaction, transaction.Digest, selected.Digest, owner);
        foreach (var phase in new[] { UpdateTransactionPhase.CandidateSelected, UpdateTransactionPhase.CandidateLaunchIntent, UpdateTransactionPhase.TrialStarted }) Advance(phase);
        Refused(() => transaction.Advance(UpdateTransactionPhase.HealthVerified, transaction.Digest, owner), "UPDATE_CANDIDATE_HEALTH_EVIDENCE_REQUIRED");
        transaction = store.PersistTransaction(transaction.AdvanceWithNativeHealth(UpdateTransactionPhase.HealthVerified, transaction.Digest, owner, proof), transaction.Digest);
        Advance(UpdateTransactionPhase.CommitIntent);
        transaction = store.PersistTransaction(transaction.AdvanceWithNativeHealth(UpdateTransactionPhase.Committed, transaction.Digest, owner, proof), transaction.Digest);
        Check(store.ReadTransaction() == transaction && transaction.SafeToStart && transaction.NativeHealth!.ProcessId == (int)child.ProcessId,
            "Native live image/Job witness and challenge-bound report commit the durable selected app/data pair");
        child.Cancel(); var timer = Stopwatch.StartNew();
        while (!witness.ObserveCessation() && timer.Elapsed < TimeSpan.FromSeconds(5)) Thread.Sleep(10);
        Check(witness.ObserveCessation(), "Health fixture observes actual Job zero before releasing ownership");
        Refused(() => NativeUpdateHealthEvidence.Capture(transaction, false, "5.9.2", witness, challenge, report), "UPDATE_HEALTH_UNVERIFIED");
    }

    private static void ColdRecovery(string root)
    {
        using var user = WindowsIdentity.GetCurrent(); var owner = user.User!.Value;
        var boot = Guid.NewGuid().ToString("D"); var transaction = Guid.NewGuid().ToString("D"); var installation = new string('d', 64);
        using (var store = new WindowsStoreIO(Path.Combine(root, "cold-state")))
        {
            var eligibility = NativeUpdateEligibility.EnrollFixture(store, installation, owner, boot);
            _ = eligibility.BeforeKnownWriterDispatch(owner); var position = eligibility.Inspect(owner).Position;
            eligibility.Close(owner, position, transaction);
            Refused(() => eligibility.ResumeTransactionAfterColdBoot(owner, transaction, position.Epoch), "UPDATE_RECOVERY_REBOOT_REQUIRED");
        }
        using (var store = new WindowsStoreIO(Path.Combine(root, "cold-state")))
        {
            var eligibility = NativeUpdateEligibility.OpenFixture(store, installation, Guid.NewGuid().ToString("D"));
            var epoch = eligibility.Inspect(owner).Position.Epoch;
            Refused(() => eligibility.ResumeTransactionAfterColdBoot(owner, Guid.NewGuid().ToString("D"), epoch), "UPDATE_RECOVERY_REBOOT_REQUIRED");
            var seal = eligibility.ResumeTransactionAfterColdBoot(owner, transaction, epoch); eligibility.RequireSeal(transaction, seal);
            Check(eligibility.Inspect(owner).Writers == 0, "A new native boot settles only boot-bound transaction writers and keeps admission sealed");
        }
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool CreateHardLinkW(string path, string target, nint security);
}
