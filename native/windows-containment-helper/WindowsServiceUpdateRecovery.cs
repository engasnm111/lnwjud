using System.Text.Json.Nodes;
using Lnwjud.UpdateWorker;

namespace Lnwjud.Containment;

internal sealed partial class WindowsServiceUpdateRuntime
{
    private JsonObject ReadOffer(UpdateTransactionJournal transaction)
    {
        var offer = Wire.Object((store!.Read("offer.json") ?? throw new Refusal("UPDATE_OFFER_STATE_MISSING")).Bytes);
        Wire.Fields(offer, "transactionId", "packageDirectory", "previousDataPath", "snapshotDigest", "snapshotPath", "artifactSha256", "candidateInstallation");
        if (Wire.Text(offer, "transactionId") != transaction.TransactionId || !Wire.Digest(Wire.Text(offer, "artifactSha256")))
            throw new Refusal("UPDATE_OFFER_IDENTITY_MISMATCH");
        return offer;
    }

    private void PrepareRollbackData(UpdateTransactionJournal transaction)
    {
        var offer = ReadOffer(transaction);
        if (offer["snapshotDigest"] is null || offer["snapshotPath"] is null)
        {
            if (offer["snapshotDigest"] is not null || offer["snapshotPath"] is not null
                || installed!.DataPath(transaction.PreviousDataGeneration) != Wire.Text(offer, "previousDataPath"))
                throw new Refusal("UPDATE_SNAPSHOT_EVIDENCE_MISSING");
            return;
        }
        var snapshot = Wire.Text(offer, "snapshotPath"); var expected = Wire.Text(offer, "snapshotDigest");
        var profiles = Path.Combine(Path.GetFullPath(stateRoot), "profiles");
        if (!Wire.Digest(expected) || !String.Equals(Path.GetDirectoryName(Path.GetFullPath(snapshot)), profiles, StringComparison.OrdinalIgnoreCase)
            || !Guid.TryParseExact(Path.GetFileName(snapshot), "D", out _) || NativeUpdateData.DigestProtected(snapshot) != expected)
            throw new Refusal("UPDATE_SNAPSHOT_UNVERIFIED");
        var working = Path.Combine(profiles, Guid.NewGuid().ToString("D"));
        if (NativeUpdateData.CloneNew(snapshot, working) != expected) throw new Refusal("UPDATE_PROFILE_COPY_CHANGED");
        installed = installed! with { DataPaths = new(installed!.DataPaths, StringComparer.Ordinal) { [transaction.PreviousDataGeneration.Id] = working } };
        NativeInstalledUpdate.Publish(store!, "installation", installed.Encode());
        NativeUpdateData.MakeWritable(working, installed.OwnerSid);
    }

    private void QuarantineCandidate(UpdateTransactionJournal transaction)
    {
        var digest = Wire.Text(ReadOffer(transaction), "artifactSha256");
        if (installed!.FailedCandidates.Contains(digest, StringComparer.Ordinal)) return;
        if (installed.FailedCandidates.Length >= 128) throw new Refusal("UPDATE_FAILED_CANDIDATE_LIMIT");
        installed = installed with { FailedCandidates = [.. installed.FailedCandidates, digest],
            DataPaths = installed.DataPaths.Where(entry => entry.Key == transaction.PreviousDataGeneration.Id
                || entry.Key == transaction.CandidateDataGeneration.Id).ToDictionary(entry => entry.Key, entry => entry.Value, StringComparer.Ordinal) };
        NativeInstalledUpdate.Publish(store!, "installation", installed.Encode());
    }

    private void ReconcileCommittedInstallation(UpdateTransactionJournal transaction)
    {
        if (transaction.Phase != UpdateTransactionPhase.Committed || transaction.NativeHealth is null) throw new Refusal("UPDATE_COMMIT_UNVERIFIED");
        if (installed!.AcceptanceDigest == ReleaseTrustPolicy.Hash(transaction.Encode()) && installed.Version == transaction.CandidateVersion
            && installed.ReadLayout().Manifest.Sha256 == transaction.CandidateSlotDigest) return;
        var candidate = ReadOffer(transaction)["candidateInstallation"] as JsonObject ?? throw new Refusal("UPDATE_COMMIT_STATE_MISSING");
        var accepted = NativeInstalledUpdate.Decode(Wire.Encode(candidate));
        if (!accepted.Accepted || accepted.InstallationId != installed.InstallationId || accepted.OwnerSid != installed.OwnerSid
            || accepted.Version != transaction.CandidateVersion || accepted.ReadLayout().Manifest.Sha256 != transaction.CandidateSlotDigest
            || accepted.ReadLayout().Application.Sha256 != transaction.NativeHealth.ImageSha256
            || ReleaseTrustPolicy.Hash(Convert.FromBase64String(accepted.Envelope!)) != transaction.ReleaseEnvelopeDigest
            || !accepted.DataPaths.ContainsKey(transaction.CandidateDataGeneration.Id)) throw new Refusal("UPDATE_COMMIT_STATE_MISMATCH");
        installed = accepted with { AcceptanceDigest = ReleaseTrustPolicy.Hash(transaction.Encode()) };
        NativeInstalledUpdate.Publish(store!, "installation", installed.Encode());
    }

    private void StartRecoveredPrevious(NativeDesktopSession desktop, UpdateTransactionJournal transaction)
    {
        if (transaction.Phase == UpdateTransactionPhase.RollbackUnverified) throw new Refusal("UPDATE_ROLLBACK_UNVERIFIED");
        QuarantineCandidate(transaction);
        if (transaction.Phase is not (UpdateTransactionPhase.RollbackIntent or UpdateTransactionPhase.PreviousSelectionIntent
            or UpdateTransactionPhase.PreviousSelected or UpdateTransactionPhase.PreviousLaunchIntent or UpdateTransactionPhase.PreviousStarted))
            transaction = Advance(transaction, UpdateTransactionPhase.RollbackIntent);
        if (transaction.Phase == UpdateTransactionPhase.RollbackIntent) transaction = Advance(transaction, UpdateTransactionPhase.PreviousSelectionIntent);
        if (transaction.Phase == UpdateTransactionPhase.PreviousSelectionIntent)
        {
            _ = transactions!.SelectPrevious(transaction, transaction.Digest, transactions.ReadSelection()!.Digest, WindowsStoreIO.CurrentOwner());
            transaction = Advance(transaction, UpdateTransactionPhase.PreviousSelected);
        }
        if (transaction.Phase == UpdateTransactionPhase.PreviousSelected) transaction = Advance(transaction, UpdateTransactionPhase.PreviousLaunchIntent);
        PrepareRollbackData(transaction);
        StartDesktop(desktop, transaction.PreviousSlot, installed!.ReadLayout(), transaction.PreviousDataGeneration, installed.Version!, transaction, true);
    }

    private async Task CompleteRecoveredPreviousAsync(NativeDesktopSession desktop, string seal)
    {
        try
        {
            var evidence = await desktop.Health.Task.WaitAsync(TimeSpan.FromSeconds(120)).ConfigureAwait(false);
            lock (gate)
            {
                var transaction = AdvanceHealth(transactions!.ReadTransaction()!, UpdateTransactionPhase.RollbackVerified, evidence);
                eligibility!.ReopenWithVerifiedWriter(transaction.TransactionId, seal, desktop.Witness!);
                desktop.Registered = true; desktop.Updating = false;
                desktop.Ready.TrySetResult(new() { ["kind"] = "rolled_back", ["safeToStart"] = true,
                    ["transactionId"] = transaction.TransactionId, ["reason"] = "UPDATE_INTERRUPTED_BY_REBOOT" });
            }
        }
        catch
        {
            lock (gate)
            {
                desktop.Process?.Cancel(); failure = "UPDATE_ROLLBACK_UNVERIFIED";
                desktop.Ready.TrySetException(new IOException(failure));
            }
        }
    }
}
