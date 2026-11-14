using System.Diagnostics;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;
using Lnwjud.UpdateWorker;

namespace Lnwjud.Containment;

internal sealed partial class WindowsServiceUpdateRuntime : IDisposable
{
    private readonly object gate = new();
    private readonly string stateRoot;
    private readonly string installationRoot;
    private readonly ReleaseTrustPolicy policy = ReleaseTrustPolicy.Embedded();
    private WindowsStoreIO? store;
    private UpdateTransactionStore? transactions;
    private NativeUpdateEligibility? eligibility;
    private NativeInstalledUpdate? installed;
    private NativePreparation? prepared;
    private NativeDesktopSession? session;
    private string? failure;
    private readonly List<AttestationOwner> heldVerifiers = [];

    private WindowsServiceUpdateRuntime(string stateRoot, string installationRoot)
        => (this.stateRoot, this.installationRoot) = (stateRoot, installationRoot);

    internal static WindowsServiceUpdateRuntime Installed(ServiceEndpointIdentity.ProductionServiceAuthority authority, string serviceStore)
    {
        authority.RequireActive();
        using var parent = ServiceEndpointIdentity.OpenProtected(serviceStore, true);
        var runtime = new WindowsServiceUpdateRuntime(Path.Combine(serviceStore, "update-authority"), authority.InstallationRoot);
        runtime.OpenExisting();
        return runtime;
    }

    private void OpenExisting()
    {
        try
        {
            if (!StateExists()) return;
            using var directory = ServiceEndpointIdentity.OpenProtected(stateRoot, true);
            store = new WindowsStoreIO(stateRoot);
            if (store.Read("installation.pending.json") is not null || store.Read("offer.pending.json") is not null)
                throw new Refusal("UPDATE_AUTHORITY_PUBLICATION_PENDING");
            installed = NativeInstalledUpdate.Decode((store.Read("installation.json") ?? throw new Refusal("UPDATE_ENROLLMENT_UNVERIFIED")).Bytes);
            eligibility = NativeUpdateEligibility.Open(store, installed.InstallationId);
            transactions = new UpdateTransactionStore(store, installed.InstallationId);
            var transaction = transactions.ReadTransaction();
            if (transaction?.Phase == UpdateTransactionPhase.Committed) ReconcileCommittedInstallation(transaction);
            if (transaction is not { SafeToStart: false }
                && eligibility.Inspect(installed.OwnerSid).Reason == "UPDATE_COLD_EPOCH_REQUIRED") eligibility.StartColdEpoch(installed.OwnerSid);
        }
        catch (Refusal error) { failure = error.Reason; }
        catch { failure = "UPDATE_AUTHORITY_UNAVAILABLE"; }
    }

    internal void BeforeOpaqueDispatch(string sid)
    {
        lock (gate)
        {
            RequireExisting(sid);
            if (eligibility is null) throw new IOException("UPDATE_ENROLLMENT_UNVERIFIED");
            try { eligibility.BeforeOpaqueDispatch(sid); }
            catch (Refusal error) { throw new IOException(error.Reason, error); }
        }
    }

    internal JsonObject Inspect(string sid)
    {
        lock (gate)
        {
            try
            {
                RequireExisting(sid);
                if (installed?.Accepted != true || eligibility is null || transactions is null)
                    return Unavailable("UPDATE_BASELINE_ACCEPTANCE_REQUIRED");
                var current = transactions.ReadTransaction();
                if (current is { SafeToStart: false }) return new() { ["kind"] = "held", ["reason"] = "UPDATE_TRANSACTION_PENDING" };
                _ = eligibility.ClosingPosition(sid);
                return new() { ["kind"] = "available", ["version"] = installed.Version,
                    ["installationId"] = installed.InstallationId, ["releaseIdentity"] = installed.IdentityDigest };
            }
            catch (Refusal error) { return Unavailable(error.Reason); }
            catch { return Unavailable("UPDATE_AUTHORITY_UNAVAILABLE"); }
        }
    }

    internal JsonObject Handle(string command, JsonElement arguments, AuthenticatedPipeCaller caller)
    {
        lock (gate)
        {
            if (command == "update_status")
            {
                if (installed is null || installed.OwnerSid != caller.Sid) throw new Refusal("UPDATE_OWNER_MISMATCH");
            }
            else RequireExisting(caller.Sid);
            var input = Wire.Object(JsonSerializer.SerializeToUtf8Bytes(arguments));
            return command switch
            {
                "update_enroll" => Enroll(input, caller),
                "update_prepare" => Prepare(input, caller.Sid),
                "update_abort" => AbortPreparation(input),
                "update_execute" => Execute(input, caller.Sid),
                "update_status" => ReadStatus(input),
                "update_boot" => Boot(input, caller.Sid),
                _ => throw new Refusal("UPDATE_COMMAND_UNSUPPORTED"),
            };
        }
    }

    private void EnsureManualBaseline(AuthenticatedPipeCaller caller)
    {
        if (installed is not null) { RequireExisting(caller.Sid); return; }
        if (StateExists()) throw new Refusal("UPDATE_ENROLLMENT_UNVERIFIED");
        var local = LocalLayout();
        var initial = NativeInstalledUpdate.PlannedData(caller.Sid, Guid.NewGuid().ToString("D"));
        var identity = ReleaseTrustPolicy.Hash(Wire.Utf8.GetBytes(Path.GetFullPath(installationRoot).ToUpperInvariant()
            + "|" + local.Launcher.Sha256 + "|" + local.Service.Sha256));
        Directory.CreateDirectory(stateRoot);
        using var root = ServiceEndpointIdentity.OpenProtected(stateRoot, true);
        store = new WindowsStoreIO(stateRoot);
        var profile = NativeUpdateData.DefaultProfile(caller.PrimaryToken.DangerousGetHandle());
        installed = new(identity, caller.Sid, profile, Convert.ToBase64String(EncodeLayout(local)), null, null, null,
            null, 0, 0, ReleaseAuthorizationPurpose.Baseline, new(StringComparer.Ordinal) { [initial.Id] = profile });
        NativeInstalledUpdate.Publish(store, "installation", installed.Encode());
        eligibility = NativeUpdateEligibility.Enroll(store, identity, caller.Sid);
        transactions = new UpdateTransactionStore(store, identity);
        transactions.InitializeSelection(SlotSelection.Create(identity, 1, 1, "none", WindowsStoreIO.CurrentOwner(),
            Guid.NewGuid().ToString("D"), "A", local.Manifest.Sha256, initial));
    }

    private JsonObject Enroll(JsonObject input, AuthenticatedPipeCaller caller)
    {
        Wire.Fields(input, "packageDirectory");
        if (installed is null || store is null || transactions is null) throw new Refusal("UPDATE_MANAGED_LAUNCH_REQUIRED");
        if (installed.Accepted) return new() { ["kind"] = "enrolled", ["installationId"] = installed.InstallationId,
            ["version"] = installed.Version, ["releaseIdentity"] = installed.IdentityDigest };
        using var package = AuthenticatedBaselinePackage.Open(Wire.Text(input, "packageDirectory"), policy, Now());
        VerifyEvidence(package.Authorization, package.Files);
        var layout = package.ReadInstalledLayout();
        var selection = transactions.ReadSelection() ?? throw new Refusal("UPDATE_SLOT_SELECTION_MISSING");
        if (selection.Slot != "A" || selection.SlotDigest != layout.Manifest.Sha256) throw new Refusal("UPDATE_BASELINE_SLOT_MISMATCH");
        VerifyStable(layout);
        NativeUpdatePayload.VerifySlot(Path.Combine(installationRoot, "slots", "A"), layout.Manifest,
            layout.ReadManifest(ReadProtected(Path.Combine(installationRoot, "slots", "A", "manifest.json"), WindowsBaselineLayout.MaximumManifestBytes)));
        var signed = package.Authorization;
        var release = signed.Payload.GetProperty("release");
        var artifact = SignedRelease.Identity(release.GetProperty("artifact"));
        NativeUpdatePayload.VerifyFile(Path.Combine(installationRoot, "update-baseline", artifact.Name), new(artifact.Name, artifact.SizeBytes, artifact.Sha256));
        var now = Now().UnixSeconds;
        var acceptance = ReleaseTrustPolicy.Hash(Wire.Encode(new JsonObject { ["installationId"] = installed.InstallationId,
            ["ownerSid"] = caller.Sid, ["releaseEnvelopeSha256"] = signed.EnvelopeSha256, ["layoutSha256"] = layout.Sha256,
            ["slotSha256"] = selection.SlotDigest, ["dataGenerationId"] = selection.DataGeneration.Id, ["acceptedAt"] = Wire.Decimal(now) }));
        installed = installed with { Envelope = Convert.ToBase64String(package.Files.Read("RELEASE.json", ReleaseSchema.AuthorizationV2().EnvelopeBytes)),
            IdentityDigest = signed.IdentitySha256, AcceptanceDigest = acceptance, AcceptedAt = now,
            Version = ReleaseValues.Text(release, "version"), Sequence = ReleaseValues.Number(release, "releaseSequence"),
            Layout = Convert.ToBase64String(package.Files.Read("INSTALL-LAYOUT.json", 65536)) };
        NativeInstalledUpdate.Publish(store, "installation", installed.Encode());
        return new() { ["kind"] = "enrolled", ["installationId"] = installed.InstallationId, ["version"] = installed.Version,
            ["releaseIdentity"] = installed.IdentityDigest };
    }

    private JsonObject Prepare(JsonObject input, string sid)
    {
        Wire.Fields(input, "packageDirectory", "requestId", "tunnel");
        if (installed?.Accepted != true || eligibility is null || store is null || transactions is null || session is null)
            throw new Refusal("UPDATE_BASELINE_ACCEPTANCE_REQUIRED");
        if (session.Updating || transactions.ReadTransaction() is { SafeToStart: false }) throw new Refusal("UPDATE_TRANSACTION_BUSY");
        if (installed.FailedCandidates.Length >= 128) throw new Refusal("UPDATE_FAILED_CANDIDATE_LIMIT");
        _ = eligibility.ClosingPosition(sid);
        if (!Wire.Identifier(Wire.Text(input, "requestId"))) throw new Refusal("UPDATE_REQUEST_ID_INVALID");
        var tunnel = input["tunnel"] as JsonObject ?? throw new Refusal("UPDATE_TUNNEL_STATE_INVALID");
        Wire.Fields(tunnel, "enabled", "wasConnected", "profileDigest");
        var snapshot = new TunnelSnapshot(tunnel["enabled"]!.GetValue<bool>(), tunnel["wasConnected"]!.GetValue<bool>(),
            tunnel["profileDigest"] is null ? null : Wire.Text(tunnel, "profileDigest"));
        snapshot.Validate();
        var selection = transactions.ReadSelection() ?? throw new Refusal("UPDATE_SLOT_SELECTION_MISSING");
        var trust = new ReleaseTrustSnapshot(selection.Generation, selection.Revision, installed.Sequence, installed.AcceptedAt,
            new HashSet<string>(installed.FailedCandidates, StringComparer.Ordinal));
        var package = AuthenticatedUpdatePackage.Open(Wire.Text(input, "packageDirectory"), policy, Now(), installed.Retained(), trust);
        NativeUpdatePayload? payload = null;
        try
        {
            VerifyEvidence(package.Metadata.Candidate, package.Files);
            payload = NativeUpdatePayload.Open(package, policy);
            VerifyStable(payload.Layout);
            var id = Guid.NewGuid().ToString("D");
            var data = NativeInstalledUpdate.PlannedData(sid, id, selection.DataGeneration.Id);
            prepared?.Dispose();
            prepared = new(package, payload, id, Secret(), Wire.Text(input, "requestId"), snapshot, data,
                DateTimeOffset.UtcNow.AddMinutes(5), Wire.Text(input, "packageDirectory"));
            return new() { ["kind"] = "prepared", ["transactionId"] = id,
                ["version"] = ReleaseValues.Text(package.Metadata.Candidate.Payload.GetProperty("release"), "version"),
                ["artifactSha256"] = SignedRelease.Identity(package.Metadata.Candidate.Payload.GetProperty("release").GetProperty("artifact")).Sha256,
                ["previousReleaseIdentity"] = package.Metadata.PreviousIdentitySha256,
                ["challenge"] = prepared.Confirmation, ["generation"] = Wire.Decimal(selection.Generation),
                ["revision"] = Wire.Decimal(transactions.ReadTransaction()?.Revision ?? 0) };
        }
        catch { payload?.Dispose(); package.Dispose(); throw; }
    }

    private JsonObject AbortPreparation(JsonObject input)
    {
        Wire.Fields(input, "transactionId", "challenge");
        var id = Wire.Text(input, "transactionId");
        if (transactions?.ReadTransaction()?.TransactionId == id) throw new Refusal("UPDATE_EXECUTION_ALREADY_STARTED");
        if (prepared is null || prepared.TransactionId != id || prepared.Confirmation != Wire.Text(input, "challenge"))
            throw new Refusal("UPDATE_PREPARATION_UNKNOWN");
        prepared.Dispose(); prepared = null;
        return new() { ["kind"] = "aborted", ["transactionId"] = id };
    }

    private JsonObject Execute(JsonObject input, string sid)
    {
        Wire.Fields(input, "transactionId", "challenge");
        var preparation = prepared ?? throw new Refusal("UPDATE_PREPARATION_MISSING");
        if (installed is null || eligibility is null || transactions is null || store is null || session is null
            || preparation.TransactionId != Wire.Text(input, "transactionId") || preparation.Confirmation != Wire.Text(input, "challenge")
            || preparation.ExpiresAt <= DateTimeOffset.UtcNow || session.Updating) throw new Refusal("UPDATE_CONFIRMATION_INVALID");
        var position = eligibility.ClosingPosition(sid);
        var selection = transactions.ReadSelection() ?? throw new Refusal("UPDATE_SLOT_SELECTION_MISSING");
        preparation.Package.Files.RecheckAll();
        _ = ReleaseAuthorizationV2.Authenticate(preparation.Package.Files.Read("RELEASE.json", ReleaseSchema.AuthorizationV2().EnvelopeBytes), policy, Now(), ReleaseAuthorizationPurpose.Update);
        var candidate = preparation.Package.Metadata.Candidate;
        var release = candidate.Payload.GetProperty("release");
        var previous = transactions.ReadTransaction();
        var transaction = UpdateTransactionJournal.Create(selection, previous?.Digest ?? "none", WindowsStoreIO.CurrentOwner(),
            preparation.RequestId, ReleaseValues.Text(release, "releaseId"), policy.Revision, candidate.EnvelopeSha256,
            ReleaseValues.Text(release, "version"), preparation.Payload.Layout.Manifest.Sha256, preparation.Data,
            preparation.Tunnel, preparation.TransactionId, position.Epoch, Guid.NewGuid().ToString("D"));
        var offer = new JsonObject { ["transactionId"] = transaction.TransactionId, ["packageDirectory"] = preparation.Directory,
            ["previousDataPath"] = installed.DataPath(selection.DataGeneration), ["snapshotDigest"] = null, ["snapshotPath"] = null,
            ["artifactSha256"] = SignedRelease.Identity(release.GetProperty("artifact")).Sha256, ["candidateInstallation"] = null };
        NativeInstalledUpdate.Publish(store, "offer", offer);
        transaction = transactions.PersistTransaction(transaction, previous?.Digest ?? "none");
        eligibility.Close(sid, position, transaction.TransactionId);
        transaction = Advance(transaction, UpdateTransactionPhase.QuiesceIntent);
        session.Updating = true;
        prepared = null;
        _ = RunTransactionAsync(session, preparation, offer);
        return new() { ["kind"] = "accepted", ["transactionId"] = transaction.TransactionId };
    }

    private async Task RunTransactionAsync(NativeDesktopSession desktop, NativePreparation preparation, JsonObject offer)
    {
        string? seal = null;
        try
        {
            await WaitForOldDesktopAsync(desktop).ConfigureAwait(false);
            lock (gate)
            {
                var transaction = transactions!.ReadTransaction()!;
                seal = eligibility!.Seal(transaction.TransactionId);
                transaction = Advance(transaction, UpdateTransactionPhase.Quiesced);
                transaction = Advance(transaction, UpdateTransactionPhase.TunnelStopIntent);
                transaction = Advance(transaction, UpdateTransactionPhase.TunnelStopped);
                var profiles = Path.Combine(stateRoot, "profiles"); Directory.CreateDirectory(profiles);
                var backup = Path.Combine(profiles, Guid.NewGuid().ToString("D"));
                var digest = NativeUpdateData.CloneNew(Wire.Text(offer, "previousDataPath"), backup, desktop.Token);
                var candidateData = Path.Combine(profiles, preparation.Data.Id);
                if (NativeUpdateData.CloneNew(backup, candidateData) != digest) throw new Refusal("UPDATE_PROFILE_COPY_CHANGED");
                offer["snapshotDigest"] = digest; offer["snapshotPath"] = backup; NativeInstalledUpdate.Publish(store!, "offer", offer);
                installed = installed! with { DataPaths = new(installed!.DataPaths, StringComparer.Ordinal)
                    { [transaction.PreviousDataGeneration.Id] = backup, [transaction.CandidateDataGeneration.Id] = candidateData } };
                NativeInstalledUpdate.Publish(store!, "installation", installed.Encode());
                var slots = Path.Combine(installationRoot, "slots");
                var target = Path.Combine(slots, transaction.CandidateSlot);
                if (Directory.Exists(target))
                {
                    var retired = Path.Combine(slots, "retired-" + Guid.NewGuid().ToString("D"));
                    if (!Path.GetFullPath(retired).StartsWith(Path.GetFullPath(slots) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) throw new Refusal("UPDATE_SLOT_PATH_UNSAFE");
                    Directory.Move(target, retired);
                }
                preparation.Payload.ExtractNewSlot(slots, transaction.CandidateSlot);
                transaction = Advance(transaction, UpdateTransactionPhase.CandidateSelectionIntent);
                _ = transactions!.SelectCandidate(transaction, transaction.Digest, transactions.ReadSelection()!.Digest, WindowsStoreIO.CurrentOwner());
                transaction = Advance(transaction, UpdateTransactionPhase.CandidateSelected);
                transaction = Advance(transaction, UpdateTransactionPhase.CandidateLaunchIntent);
                NativeUpdateData.MakeWritable(candidateData, installed.OwnerSid);
                StartDesktop(desktop, transaction.CandidateSlot, preparation.Payload.Layout, preparation.Data, transaction.CandidateVersion, transaction, false);
            }
            var evidence = await desktop.Health.Task.WaitAsync(TimeSpan.FromSeconds(120)).ConfigureAwait(false);
            lock (gate)
            {
                var transaction = AdvanceHealth(transactions!.ReadTransaction()!, UpdateTransactionPhase.HealthVerified, evidence);
                transaction = Advance(transaction, UpdateTransactionPhase.CommitIntent);
                var signed = preparation.Package.Metadata.Candidate;
                var candidateInstallation = installed! with { Envelope = Convert.ToBase64String(preparation.Package.Files.Read("RELEASE.json", ReleaseSchema.AuthorizationV2().EnvelopeBytes)),
                    IdentityDigest = signed.IdentitySha256, AcceptanceDigest = ReleaseTrustPolicy.Hash(transaction.Encode()),
                    Version = transaction.CandidateVersion, AcceptedAt = Now().UnixSeconds,
                    Sequence = ReleaseValues.Number(signed.Payload.GetProperty("release"), "releaseSequence"), Purpose = ReleaseAuthorizationPurpose.Update,
                    Layout = Convert.ToBase64String(preparation.Package.Files.Read("INSTALL-LAYOUT.json", 65536)),
                    DataPaths = installed.DataPaths.Where(entry => entry.Key == transaction.PreviousDataGeneration.Id || entry.Key == transaction.CandidateDataGeneration.Id)
                        .ToDictionary(entry => entry.Key, entry => entry.Value, StringComparer.Ordinal) };
                offer["candidateInstallation"] = candidateInstallation.Encode(); NativeInstalledUpdate.Publish(store!, "offer", offer);
                transaction = AdvanceHealth(transaction, UpdateTransactionPhase.Committed, evidence);
                installed = candidateInstallation with { AcceptanceDigest = ReleaseTrustPolicy.Hash(transaction.Encode()) };
                NativeInstalledUpdate.Publish(store!, "installation", installed.Encode());
                eligibility!.ReopenWithVerifiedWriter(transaction.TransactionId, seal!, desktop.Witness!);
                desktop.Registered = true; desktop.Updating = false;
                desktop.Ready.TrySetResult(new() { ["kind"] = "committed", ["safeToStart"] = true, ["transactionId"] = transaction.TransactionId });
            }
        }
        catch (Exception error)
        {
            try { await RollbackAsync(desktop, seal, error).ConfigureAwait(false); }
            catch { lock (gate) { failure = "UPDATE_ROLLBACK_UNVERIFIED"; desktop.Ready.TrySetException(new IOException(failure)); } }
        }
        finally { preparation.Dispose(); }
    }

    private async Task RollbackAsync(NativeDesktopSession desktop, string? seal, Exception cause)
    {
        desktop.Process?.Cancel();
        await WaitForOldDesktopAsync(desktop).ConfigureAwait(false);
        lock (gate)
        {
            var transaction = transactions!.ReadTransaction()!;
            if (transaction.IsTerminal) throw new Refusal("UPDATE_COMMIT_RECOVERY_REQUIRED");
            seal ??= eligibility!.Seal(transaction.TransactionId);
            QuarantineCandidate(transaction);
            transaction = Advance(transaction, UpdateTransactionPhase.RollbackIntent);
            transaction = Advance(transaction, UpdateTransactionPhase.PreviousSelectionIntent);
            _ = transactions.SelectPrevious(transaction, transaction.Digest, transactions.ReadSelection()!.Digest, WindowsStoreIO.CurrentOwner());
            transaction = Advance(transaction, UpdateTransactionPhase.PreviousSelected);
            transaction = Advance(transaction, UpdateTransactionPhase.PreviousLaunchIntent);
            PrepareRollbackData(transaction);
            StartDesktop(desktop, transaction.PreviousSlot, installed!.ReadLayout(), transaction.PreviousDataGeneration, installed.Version!, transaction, true);
        }
        var evidence = await desktop.Health.Task.WaitAsync(TimeSpan.FromSeconds(120)).ConfigureAwait(false);
        lock (gate)
        {
            var transaction = AdvanceHealth(transactions!.ReadTransaction()!, UpdateTransactionPhase.RollbackVerified, evidence);
            eligibility!.ReopenWithVerifiedWriter(transaction.TransactionId, seal, desktop.Witness!);
            desktop.Registered = true; desktop.Updating = false;
            desktop.Ready.TrySetResult(new() { ["kind"] = "rolled_back", ["safeToStart"] = true, ["transactionId"] = transaction.TransactionId,
                ["reason"] = cause is Refusal refusal ? refusal.Reason : "UPDATE_CANDIDATE_FAILED" });
        }
    }

    private static async Task WaitForOldDesktopAsync(NativeDesktopSession desktop)
    {
        var timer = Stopwatch.StartNew();
        var cancelled = false;
        while (desktop.Process is not null)
        {
            if (!cancelled && timer.Elapsed > TimeSpan.FromSeconds(90)) { desktop.Process?.Cancel(); cancelled = true; }
            if (timer.Elapsed > TimeSpan.FromSeconds(120)) throw new Refusal("UPDATE_WRITER_DRAIN_TIMEOUT");
            await Task.Delay(20).ConfigureAwait(false);
        }
    }

    private JsonObject ReadStatus(JsonObject input)
    {
        Wire.Fields(input, "transactionId");
        var current = transactions?.ReadTransaction();
        if (current is null || current.TransactionId != Wire.Text(input, "transactionId")) throw new Refusal("UPDATE_TRANSACTION_IDENTITY_MISMATCH");
        return Status(current);
    }
    private JsonObject Status(UpdateTransactionJournal current) => new()
    {
        ["kind"] = "status",
        ["transactionId"] = current.TransactionId, ["version"] = current.CandidateVersion, ["phase"] = current.Phase.ToString(),
        ["generation"] = Wire.Decimal(current.Generation), ["revision"] = Wire.Decimal(current.Revision),
        ["safeToStart"] = current.SafeToStart && failure is null, ["reason"] = failure,
    };
    private UpdateTransactionJournal Advance(UpdateTransactionJournal current, UpdateTransactionPhase next)
        => transactions!.PersistTransaction(current.Advance(next, current.Digest, WindowsStoreIO.CurrentOwner()), current.Digest);
    private UpdateTransactionJournal AdvanceHealth(UpdateTransactionJournal current, UpdateTransactionPhase next, NativeUpdateHealthEvidence proof)
        => transactions!.PersistTransaction(current.AdvanceWithNativeHealth(next, current.Digest, WindowsStoreIO.CurrentOwner(), proof), current.Digest);
    private void VerifyStable(WindowsBaselineLayout layout)
    {
        try
        {
            NativeUpdatePayload.VerifyFile(Path.Combine(installationRoot, "lnwjud.exe"), layout.Launcher);
            NativeUpdatePayload.VerifyFile(Path.Combine(installationRoot, "resources", "native-containment", "lnwjud-containment.exe"), layout.Service);
        }
        catch { throw new Refusal("UPDATE_MANUAL_BASELINE_REQUIRED"); }
    }
    private void VerifyEvidence(SignedAuthorizationV2 authorization, EnrollmentPackageFiles files)
    {
        var owner = new AttestationOwner();
        try { owner.VerifyAuthorizedRelease(authorization.Payload.GetProperty("release"), files, policy, ReleaseValues.Number(authorization.Payload, "issuedAt")); }
        finally
        {
            if (!owner.TryFinishCleanup(TimeSpan.FromSeconds(10)))
            { heldVerifiers.Add(owner); failure = "UPDATE_VERIFIER_TERMINATION_UNVERIFIED"; throw new Refusal(failure); }
        }
    }
    private WindowsBaselineLayout LocalLayout()
    {
        var manifest = ReadProtected(Path.Combine(installationRoot, "slots", "A", "manifest.json"), WindowsBaselineLayout.MaximumManifestBytes);
        var layout = new WindowsBaselineLayout("", Measure("lnwjud.exe"), Measure("resources/native-containment/lnwjud-containment.exe"),
            Measure("slots/A/lnwjud.exe"), new("slots/A/manifest.json", (ulong)manifest.Length, ReleaseTrustPolicy.Hash(manifest)));
        return layout with { Sha256 = ReleaseTrustPolicy.Hash(EncodeLayout(layout)) };
    }
    private InstalledFile Measure(string relative)
    {
        using var file = ServiceEndpointIdentity.OpenProtected(Path.Combine(installationRoot, relative.Replace('/', Path.DirectorySeparatorChar)), false);
        using var stream = new FileStream(file, FileAccess.Read);
        return new(relative, checked((ulong)stream.Length), Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant());
    }
    private static byte[] EncodeLayout(WindowsBaselineLayout layout)
    {
        JsonObject File(InstalledFile value) => new() { ["path"] = value.Path, ["sizeBytes"] = Wire.Decimal(value.SizeBytes), ["sha256"] = value.Sha256 };
        return Wire.Encode(new JsonObject { ["schemaVersion"] = 1, ["product"] = "lnwjud", ["platform"] = "win32", ["architecture"] = "x64", ["slot"] = "A",
            ["roles"] = new JsonObject { ["stableLauncher"] = File(layout.Launcher), ["stableService"] = File(layout.Service),
                ["slotApplication"] = File(layout.Application), ["slotManifest"] = File(layout.Manifest) } });
    }
    private static byte[] ReadProtected(string path, int limit)
    {
        using var handle = ServiceEndpointIdentity.OpenProtected(path, false);
        var length = RandomAccess.GetLength(handle);
        if (length < 1 || length > limit) throw new Refusal("UPDATE_FILE_SIZE_INVALID");
        var bytes = new byte[checked((int)length)];
        var offset = 0;
        while (offset < bytes.Length)
        {
            var count = RandomAccess.Read(handle, bytes.AsSpan(offset), offset);
            if (count == 0) throw new Refusal("UPDATE_FILE_CHANGED");
            offset += count;
        }
        return bytes;
    }
    private void RequireExisting(string sid)
    {
        if (failure is not null) throw new Refusal(failure);
        if (installed is not null && installed.OwnerSid != sid) throw new Refusal("UPDATE_OWNER_MISMATCH");
        if (installed is null && StateExists()) throw new Refusal("UPDATE_AUTHORITY_RESTART_REQUIRED");
    }
    private bool StateExists()
    {
        try { return (File.GetAttributes(stateRoot) & (FileAttributes.Directory | FileAttributes.ReparsePoint)) == FileAttributes.Directory
            ? true : throw new Refusal("UPDATE_AUTHORITY_PATH_UNSAFE"); }
        catch (FileNotFoundException) { return false; }
        catch (DirectoryNotFoundException) { return false; }
    }
    private static string Secret() => Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant();
    private static ReleaseTimeObservation Now() => new(true, checked((ulong)DateTimeOffset.UtcNow.ToUnixTimeSeconds()));
    private static JsonObject Unavailable(string reason) => new() { ["kind"] = "unavailable", ["reason"] = reason };
    public void Dispose() { prepared?.Dispose(); session?.Process?.Cancel(); store?.Dispose(); }
    private sealed record NativePreparation(AuthenticatedUpdatePackage Package, NativeUpdatePayload Payload, string TransactionId,
        string Confirmation, string RequestId, TunnelSnapshot Tunnel, DataGeneration Data, DateTimeOffset ExpiresAt, string Directory) : IDisposable
    { public void Dispose() { Payload.Dispose(); Package.Dispose(); } }
}
