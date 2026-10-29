using System.Runtime.Versioning;

namespace Lnwjud.UpdateWorker;

internal sealed record UpdateTransactionSnapshot(UpdateTransactionJournal? Transaction, SlotSelection? Selection);

[SupportedOSPlatform("windows")]
internal sealed class UpdateTransactionStore : IDisposable
{
    private readonly WindowsStoreIO io;
    private readonly string installationId;
    private readonly Action<string>? boundary;
    private readonly bool ownsIO;

    internal UpdateTransactionStore(string root, string installationId, Action<string>? boundary = null)
    {
        if (!Wire.Digest(installationId)) throw new Refusal("UPDATE_TRANSACTION_IDENTITY_MISMATCH");
        io = new WindowsStoreIO(root);
        this.installationId = installationId;
        this.boundary = boundary;
        ownsIO = true;
    }

    internal UpdateTransactionStore(WindowsStoreIO io, string installationId, Action<string>? boundary = null)
    {
        if (!Wire.Digest(installationId)) throw new Refusal("UPDATE_TRANSACTION_IDENTITY_MISMATCH");
        this.io = io;
        this.installationId = installationId;
        this.boundary = boundary;
        ownsIO = false;
    }

    internal SlotSelection? ReadSelection()
    {
        if (io.Read("active-slot.pending.json") is not null) throw new Refusal("UPDATE_SLOT_PUBLICATION_PENDING");
        return ReadPublishedSelection();
    }

    internal UpdateTransactionJournal? ReadTransaction()
    {
        if (io.Read("transaction.pending.json") is not null) throw new Refusal("UPDATE_TRANSACTION_PUBLICATION_PENDING");
        return ReadPublishedTransaction();
    }

    internal void InitializeSelection(SlotSelection selection)
    {
        if (selection.InstallationId != installationId || selection.PreviousDigest != "none"
            || io.Read("active-slot.json") is not null || io.Read("active-slot.pending.json") is not null
            || io.Read("transaction.json") is not null || io.Read("transaction.pending.json") is not null)
            throw new Refusal("UPDATE_SLOT_ENROLLMENT_CONFLICT");
        PublishSelection(selection, "none");
    }

    internal UpdateTransactionJournal PersistTransaction(UpdateTransactionJournal next, string expectedCurrentDigest)
    {
        if (next.InstallationId != installationId) throw new Refusal("UPDATE_TRANSACTION_IDENTITY_MISMATCH");
        if (io.Read("transaction.pending.json") is not null || io.Read("active-slot.pending.json") is not null)
            throw new Refusal("UPDATE_PUBLICATION_PENDING");
        var currentFile = io.Read("transaction.json");
        var selectionFile = io.Read("active-slot.json");
        var currentDigest = currentFile?.Digest ?? "none";
        if (currentDigest != expectedCurrentDigest) throw new Refusal("UPDATE_TRANSACTION_CAS_CONFLICT");
        var current = currentFile is null ? null : DecodeTransaction(currentFile);
        var selection = selectionFile is null ? null : DecodeSelection(selectionFile);
        ValidateTransactionSuccessor(current, currentDigest, selection, next);
        ValidateSelectionPhase(next, selection);
        PublishTransaction(next, currentDigest);
        return ReadPublishedTransaction() ?? throw new Refusal("UPDATE_TRANSACTION_READBACK_MISSING");
    }

    internal SlotSelection SelectCandidate(UpdateTransactionJournal transaction, string expectedTransactionDigest,
        string expectedSelectionDigest, ProcessOwner owner)
    {
        var stored = ReadTransaction() ?? throw new Refusal("UPDATE_TRANSACTION_MISSING");
        if (stored.Digest != expectedTransactionDigest || stored != transaction
            || stored.Phase != UpdateTransactionPhase.CandidateSelectionIntent)
            throw new Refusal("UPDATE_SLOT_SELECTION_PHASE_INVALID");
        var current = ReadSelection() ?? throw new Refusal("UPDATE_SLOT_SELECTION_MISSING");
        var next = current.SelectCandidate(stored, expectedSelectionDigest, owner);
        if (next == current) return current;
        return PublishSelection(next, current.Digest);
    }

    internal SlotSelection SelectPrevious(UpdateTransactionJournal transaction, string expectedTransactionDigest,
        string expectedSelectionDigest, ProcessOwner owner)
    {
        var stored = ReadTransaction() ?? throw new Refusal("UPDATE_TRANSACTION_MISSING");
        if (stored.Digest != expectedTransactionDigest || stored != transaction
            || stored.Phase != UpdateTransactionPhase.PreviousSelectionIntent)
            throw new Refusal("UPDATE_SLOT_SELECTION_PHASE_INVALID");
        var current = ReadSelection() ?? throw new Refusal("UPDATE_SLOT_SELECTION_MISSING");
        var next = current.SelectPrevious(stored, expectedSelectionDigest, owner);
        if (next == current) return current;
        return PublishSelection(next, current.Digest);
    }

    internal UpdateTransactionSnapshot RecoverPublications()
    {
        RecoverTransactionPublication();
        RecoverSelectionPublication();
        var transactionFile = io.Read("transaction.json");
        var selectionFile = io.Read("active-slot.json");
        var transaction = transactionFile is null ? null : DecodeTransaction(transactionFile);
        var selection = selectionFile is null ? null : DecodeSelection(selectionFile);
        ReconcileSelection(transaction, transactionFile, selection);
        transactionFile = io.Read("transaction.json");
        selectionFile = io.Read("active-slot.json");
        transaction = transactionFile is null ? null : DecodeTransaction(transactionFile);
        selection = selectionFile is null ? null : DecodeSelection(selectionFile);
        ValidateSelectionPhase(transaction, selection);
        return new UpdateTransactionSnapshot(transaction, selection);
    }

    private void RecoverTransactionPublication()
    {
        var stagedFile = io.Read("transaction.pending.json");
        if (stagedFile is null) return;
        var currentFile = io.Read("transaction.json");
        var selectionFile = io.Read("active-slot.json");
        var current = currentFile is null ? null : DecodeTransaction(currentFile);
        var selection = selectionFile is null ? null : DecodeSelection(selectionFile);
        var staged = DecodeTransaction(stagedFile);
        ValidateTransactionSuccessor(current, currentFile?.Digest ?? "none", selection, staged);
        ValidateSelectionPhase(staged, selection);
        io.PublishStage("transaction.pending.json", "transaction.json", currentFile?.Digest ?? "none");
        var published = ReadPublishedTransaction() ?? throw new Refusal("UPDATE_TRANSACTION_READBACK_MISSING");
        if (published.Digest != staged.Digest) throw new Refusal("UPDATE_TRANSACTION_READBACK_CHANGED");
    }

    private void RecoverSelectionPublication()
    {
        var stagedFile = io.Read("active-slot.pending.json");
        if (stagedFile is null) return;
        var transaction = ReadPublishedTransaction() ?? throw new Refusal("UPDATE_TRANSACTION_MISSING");
        var currentFile = io.Read("active-slot.json");
        var current = currentFile is null ? null : DecodeSelection(currentFile);
        var staged = DecodeSelection(stagedFile);
        if (currentFile is null || current is null || staged.PreviousDigest != currentFile.Digest
            || staged.Generation != transaction.Generation || staged.TransactionId != transaction.TransactionId
            || !IsExpectedSelectionPublication(transaction, current, staged))
            throw new Refusal("UPDATE_SLOT_PUBLICATION_UNVERIFIED");
        io.PublishStage("active-slot.pending.json", "active-slot.json", currentFile.Digest);
        var published = ReadPublishedSelection() ?? throw new Refusal("UPDATE_SLOT_SELECTION_READBACK_MISSING");
        if (published.Digest != staged.Digest) throw new Refusal("UPDATE_SLOT_SELECTION_READBACK_CHANGED");
    }

    private void ReconcileSelection(UpdateTransactionJournal? transaction, NativeFile? transactionNativeFile,
        SlotSelection? selection)
    {
        if (transaction is null || selection is null) return;
        if (transaction.Phase == UpdateTransactionPhase.CandidateSelectionIntent && IsCandidateSelection(transaction, selection))
        {
            var advanced = transaction.Advance(UpdateTransactionPhase.CandidateSelected,
                transactionNativeFile?.Digest ?? throw new Refusal("UPDATE_TRANSACTION_READBACK_MISSING"), WindowsStoreIO.CurrentOwner());
            _ = PersistTransaction(advanced, transactionNativeFile.Digest);
            return;
        }
        if (transaction.Phase == UpdateTransactionPhase.PreviousSelectionIntent && IsPreviousSelection(transaction, selection))
        {
            var advanced = transaction.Advance(UpdateTransactionPhase.PreviousSelected,
                transactionNativeFile?.Digest ?? throw new Refusal("UPDATE_TRANSACTION_READBACK_MISSING"), WindowsStoreIO.CurrentOwner());
            _ = PersistTransaction(advanced, transactionNativeFile.Digest);
        }
    }

    private static bool IsExpectedSelectionPublication(UpdateTransactionJournal transaction,
        SlotSelection current, SlotSelection staged) => transaction.Phase switch
    {
        UpdateTransactionPhase.CandidateSelectionIntent => IsPreviousSelection(transaction, current)
            && IsCandidateSelection(transaction, staged) && staged.Revision == 1,
        UpdateTransactionPhase.PreviousSelectionIntent => IsCandidateSelection(transaction, current)
            && IsPreviousSelection(transaction, staged) && staged.Revision == checked(current.Revision + 1),
        _ => false,
    };

    private static bool IsCandidateSelection(UpdateTransactionJournal transaction, SlotSelection selection) =>
        selection.InstallationId == transaction.InstallationId && selection.Generation == transaction.Generation
        && selection.TransactionId == transaction.TransactionId && selection.Slot == transaction.CandidateSlot
        && selection.SlotDigest == transaction.CandidateSlotDigest && selection.DataGeneration == transaction.CandidateDataGeneration;

    private static bool IsPreviousSelection(UpdateTransactionJournal transaction, SlotSelection selection) =>
        selection.InstallationId == transaction.InstallationId && selection.Slot == transaction.PreviousSlot
        && selection.SlotDigest == transaction.PreviousSlotDigest && selection.DataGeneration == transaction.PreviousDataGeneration
        && ((selection.Generation < transaction.Generation && selection.Digest == transaction.PreviousSelectionDigest)
            || (selection.Generation == transaction.Generation && selection.TransactionId == transaction.TransactionId));

    private void ValidateSelectionPhase(UpdateTransactionJournal? transaction, SlotSelection? selection)
    {
        if (transaction is null)
        {
            if (io.Read("transaction.json") is null && selection is not null) return;
            if (selection is null) return;
            throw new Refusal("UPDATE_SELECTION_WITHOUT_TRANSACTION");
        }
        if (selection is null) throw new Refusal("UPDATE_SLOT_SELECTION_MISSING");
        var previous = IsPreviousSelection(transaction, selection);
        var candidate = IsCandidateSelection(transaction, selection);
        var valid = transaction.Phase switch
        {
            UpdateTransactionPhase.CandidateReady or UpdateTransactionPhase.QuiesceIntent or UpdateTransactionPhase.Quiesced
                or UpdateTransactionPhase.TunnelStopIntent or UpdateTransactionPhase.TunnelStopped => previous,
            UpdateTransactionPhase.CandidateSelectionIntent or UpdateTransactionPhase.RollbackIntent
                or UpdateTransactionPhase.PreviousSelectionIntent => previous || candidate,
            UpdateTransactionPhase.CandidateSelected or UpdateTransactionPhase.CandidateLaunchIntent
                or UpdateTransactionPhase.TrialStarted or UpdateTransactionPhase.HealthVerified
                or UpdateTransactionPhase.CommitIntent or UpdateTransactionPhase.Committed => candidate,
            UpdateTransactionPhase.PreviousSelected or UpdateTransactionPhase.PreviousLaunchIntent
                or UpdateTransactionPhase.PreviousStarted or UpdateTransactionPhase.RollbackVerified
                or UpdateTransactionPhase.RollbackUnverified => previous,
            _ => false,
        };
        if (!valid) throw new Refusal("UPDATE_SLOT_SELECTION_PHASE_CONFLICT");
    }

    private static void ValidateTransactionSuccessor(UpdateTransactionJournal? current, string currentDigest,
        SlotSelection? selection, UpdateTransactionJournal next)
    {
        if (next.PreviousDigest != currentDigest) throw new Refusal("UPDATE_TRANSACTION_CAS_CONFLICT");
        if (current is null)
        {
            if (next.Phase != UpdateTransactionPhase.CandidateReady || next.Revision != 1 || selection is null
                || next.PreviousSelectionDigest != selection.Digest || selection.Generation == ulong.MaxValue
                || next.Generation != selection.Generation + 1 || !IsPreviousSelection(next, selection))
                throw new Refusal("UPDATE_TRANSACTION_SUCCESSOR_INVALID");
            return;
        }
        if (selection is null) throw new Refusal("UPDATE_SLOT_SELECTION_MISSING");
        if (next.TransactionId == current.TransactionId)
        {
            var expected = current.Advance(next.Phase, currentDigest, next.Owner);
            if (expected != next) throw new Refusal("UPDATE_TRANSACTION_SUCCESSOR_INVALID");
            return;
        }
        if (!current.IsTerminal || !current.SafeToStart || next.Phase != UpdateTransactionPhase.CandidateReady
            || next.Revision != 1 || current.Generation == ulong.MaxValue || next.Generation != current.Generation + 1
            || next.PreviousSelectionDigest != selection.Digest || selection.Generation + 1 != next.Generation
            || !IsPreviousSelection(next, selection))
            throw new Refusal("UPDATE_TRANSACTION_SUCCESSOR_INVALID");
    }

    private void PublishTransaction(UpdateTransactionJournal transaction, string expectedDigest)
    {
        var bytes = transaction.Encode();
        io.Stage("transaction.pending.json", bytes);
        boundary?.Invoke("transaction-stage-flushed");
        io.PublishStage("transaction.pending.json", "transaction.json", expectedDigest);
        boundary?.Invoke("transaction-publication-readback");
        var published = io.Read("transaction.json") ?? throw new Refusal("UPDATE_TRANSACTION_READBACK_MISSING");
        if (published.Digest != WindowsStoreIO.Hash(bytes)) throw new Refusal("UPDATE_TRANSACTION_READBACK_CHANGED");
    }

    private SlotSelection PublishSelection(SlotSelection selection, string expectedDigest)
    {
        var bytes = selection.Encode();
        io.Stage("active-slot.pending.json", bytes);
        boundary?.Invoke("active-slot-stage-flushed");
        io.PublishStage("active-slot.pending.json", "active-slot.json", expectedDigest);
        boundary?.Invoke("active-slot-publication-readback");
        var published = io.Read("active-slot.json") ?? throw new Refusal("UPDATE_SLOT_SELECTION_READBACK_MISSING");
        if (published.Digest != WindowsStoreIO.Hash(bytes)) throw new Refusal("UPDATE_SLOT_SELECTION_READBACK_CHANGED");
        return DecodeSelection(published);
    }

    private SlotSelection? ReadPublishedSelection()
    {
        var file = io.Read("active-slot.json");
        return file is null ? null : DecodeSelection(file);
    }

    private UpdateTransactionJournal? ReadPublishedTransaction()
    {
        var file = io.Read("transaction.json");
        return file is null ? null : DecodeTransaction(file);
    }

    private SlotSelection DecodeSelection(NativeFile file)
    {
        var value = SlotSelection.Decode(file.Bytes, installationId);
        if (!file.Bytes.AsSpan().SequenceEqual(value.Encode()) || file.Digest != value.Digest)
            throw new Refusal("UPDATE_SLOT_SELECTION_NONCANONICAL");
        return value;
    }

    private UpdateTransactionJournal DecodeTransaction(NativeFile file)
    {
        var value = UpdateTransactionJournal.Decode(file.Bytes, installationId);
        if (!file.Bytes.AsSpan().SequenceEqual(value.Encode()) || file.Digest != value.Digest)
            throw new Refusal("UPDATE_TRANSACTION_NONCANONICAL");
        return value;
    }

    public void Dispose() { if (ownsIO) io.Dispose(); }
}
