using System.Text.RegularExpressions;

namespace Lnwjud.Containment;

internal enum ServiceAttemptPhase
{
    Prepared,
    DispatchCommitted,
    LaunchNotStarted,
    Running,
    TerminalVerified,
    TerminationUnknown,
}

internal enum ServiceProcessOutcome
{
    Completed,
    Cancelled,
    TimedOut,
    // Zero live Job processes after a service restart; actual target exit status was not observed.
    Interrupted,
}

internal enum ReservationRelease
{
    Released,
    AlreadyReleased,
    Retained,
}

internal sealed record ServiceAttemptIdentity(
    string TaskId,
    string ReservationId,
    string AttemptId,
    int Generation,
    string RequestDigest,
    string OwnerClientId,
    string OwnerSessionId,
    string WorkspaceId);

internal sealed record ServiceAttemptObservation(
    ServiceAttemptIdentity Identity,
    ServiceAttemptPhase Phase,
    int? TargetPid,
    ServiceProcessOutcome? Outcome,
    int? ExitCode,
    int? ActiveProcesses,
    string? Reason,
    bool ReservationHeld,
    bool CancellationRequested = false,
    bool PublicationCommitted = false);

internal sealed record ServiceAttemptRequest(
    ServiceAttemptIdentity Identity,
    string AuthenticatedCallerSid,
    string ReservationKey,
    string OperationDigest,
    bool Shared = false,
    bool HoldForImport = false,
    bool CancellationRequested = false,
    bool PublicationCommitted = false);

internal sealed class ServiceAttemptLedger
{
    private sealed class Entry(ServiceAttemptRequest request)
    {
        internal ServiceAttemptRequest Request = request;
        internal ServiceAttemptPhase Phase = ServiceAttemptPhase.Prepared;
        internal int? TargetPid;
        internal ServiceProcessOutcome? Outcome;
        internal int? ExitCode;
        internal int? ActiveProcesses;
        internal string? Reason;
        internal bool ReservationHeld = true;
    }

    private static readonly Regex Digest = new("^[a-f0-9]{64}$", RegexOptions.CultureInvariant | RegexOptions.Compiled);
    private static readonly Regex Sid = new("^S-1-[0-9]+(?:-[0-9]+)+$", RegexOptions.CultureInvariant | RegexOptions.Compiled);
    private readonly object gate = new();
    private readonly Dictionary<string, Entry> attempts = new(StringComparer.Ordinal);
    private readonly ServiceAttemptLedgerPersistence? persistence;
    private bool unavailable;

    internal ServiceAttemptLedger() { }

    internal static string GlobalReservationKey { get; } = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "lnwjud-containment", "managed-writers");

    internal string? ImportStoreDirectory { get; }
    internal string? OutputStoreDirectory => persistence?.OutputStoreDirectory;

    internal ServiceAttemptLedger(ServiceAttemptLedgerPersistence persistence, string? importStoreDirectory = null)
    {
        this.persistence = persistence ?? throw new ArgumentNullException(nameof(persistence));
        ImportStoreDirectory = importStoreDirectory;
        var recovered = false;
        foreach (var stored in persistence.Load())
        {
            ValidateStored(stored);
            var entry = new Entry(stored.Request)
            {
                Phase = stored.Phase,
                TargetPid = stored.TargetPid,
                Outcome = stored.Outcome,
                ExitCode = stored.ExitCode,
                ActiveProcesses = stored.ActiveProcesses,
                Reason = stored.Reason,
                ReservationHeld = stored.ReservationHeld,
            };
            if (entry.Phase is ServiceAttemptPhase.DispatchCommitted or ServiceAttemptPhase.Running)
            {
                entry.Phase = ServiceAttemptPhase.TerminationUnknown;
                entry.Reason = "SERVICE_RESTART_REQUIRES_RECONCILIATION";
                entry.ActiveProcesses = null;
                recovered = true;
            }
            if (!attempts.TryAdd(entry.Request.Identity.AttemptId, entry))
                throw new IOException("ATTEMPT_STORE_CORRUPT");
            if (entry.ReservationHeld && HasConflict(entry.Request, entry.Request.Identity.AttemptId))
                throw new IOException("ATTEMPT_STORE_CORRUPT");
        }
        if (recovered) Persist();
    }

    internal ServiceAttemptObservation Prepare(ServiceAttemptRequest request)
    {
        Validate(request);
        lock (gate)
        {
            EnsureAvailable();
            if (attempts.TryGetValue(request.Identity.AttemptId, out var existing))
            {
                if (!SameRequest(existing.Request, request)) throw new IOException("ATTEMPT_ID_CONFLICT");
                return Observe(existing);
            }
            if (HasConflict(request)) throw new IOException("WRITER_RESERVATION_BUSY");
            var entry = new Entry(request);
            attempts.Add(request.Identity.AttemptId, entry);
            Persist();
            return Observe(entry);
        }
    }

    internal bool TryCommitDispatch(ServiceAttemptIdentity identity, string callerSid, string operationDigest)
    {
        lock (gate)
        {
            var entry = Require(identity, callerSid);
            if (!string.Equals(entry.Request.OperationDigest, operationDigest, StringComparison.Ordinal))
                throw new IOException("SERVICE_OPERATION_DIGEST_MISMATCH");
            if (entry.Phase == ServiceAttemptPhase.Prepared)
            {
                entry.Phase = ServiceAttemptPhase.DispatchCommitted;
                Persist();
                return true;
            }
            if (entry.Phase == ServiceAttemptPhase.LaunchNotStarted) throw new IOException("ATTEMPT_ALREADY_ABORTED");
            return false;
        }
    }

    internal ServiceAttemptObservation MarkRunning(ServiceAttemptIdentity identity, string callerSid, int targetPid)
    {
        if (targetPid <= 0) throw new IOException("TARGET_PID_INVALID");
        lock (gate)
        {
            var entry = Require(identity, callerSid);
            if (entry.Phase == ServiceAttemptPhase.Running && entry.TargetPid == targetPid) return Observe(entry);
            if (entry.Phase != ServiceAttemptPhase.DispatchCommitted) throw new IOException("ATTEMPT_PHASE_CONFLICT");
            entry.TargetPid = targetPid;
            entry.Phase = ServiceAttemptPhase.Running;
            Persist();
            return Observe(entry);
        }
    }

    internal ServiceAttemptObservation AbortBeforeLaunch(ServiceAttemptRequest request)
    {
        Validate(request);
        lock (gate)
        {
            EnsureAvailable();
            var identity = request.Identity;
            if (attempts.TryGetValue(identity.AttemptId, out var existing))
            {
                if (existing.Request.Identity != identity
                    || !String.Equals(existing.Request.AuthenticatedCallerSid, request.AuthenticatedCallerSid, StringComparison.Ordinal)
                    || !String.Equals(existing.Request.ReservationKey, request.ReservationKey, StringComparison.OrdinalIgnoreCase))
                    throw new IOException("ATTEMPT_ID_CONFLICT");
                if (!String.Equals(existing.Request.OperationDigest, request.OperationDigest, StringComparison.Ordinal)
                    && !String.Equals(identity.RequestDigest, request.OperationDigest, StringComparison.Ordinal))
                    throw new IOException("SERVICE_OPERATION_DIGEST_MISMATCH");
                if (existing.Phase == ServiceAttemptPhase.Prepared)
                {
                    existing.Phase = ServiceAttemptPhase.LaunchNotStarted;
                    Persist();
                }
                return Observe(existing);
            }

            if (HasConflict(request)) throw new IOException("WRITER_RESERVATION_BUSY");
            var tombstone = new Entry(request) { Phase = ServiceAttemptPhase.LaunchNotStarted };
            attempts.Add(identity.AttemptId, tombstone);
            Persist();
            return Observe(tombstone);
        }
    }

    internal ServiceAttemptObservation MarkUnknown(ServiceAttemptIdentity identity, string callerSid, string reason)
    {
        if (string.IsNullOrWhiteSpace(reason) || reason.Length > 128) throw new IOException("ATTEMPT_REASON_INVALID");
        lock (gate)
        {
            var entry = Require(identity, callerSid);
            if (entry.Phase is ServiceAttemptPhase.DispatchCommitted or ServiceAttemptPhase.Running)
            {
                entry.Phase = ServiceAttemptPhase.TerminationUnknown;
                entry.Reason = reason;
                Persist();
            }
            return Observe(entry);
        }
    }

    internal ServiceAttemptObservation RecordTerminal(
        ServiceAttemptIdentity identity,
        string callerSid,
        ServiceProcessOutcome outcome,
        int exitCode,
        int activeProcesses)
    {
        if (activeProcesses != 0) throw new IOException("ACTIVE_PROCESSES_REMAIN");
        lock (gate)
        {
            var entry = Require(identity, callerSid);
            if (entry.Phase == ServiceAttemptPhase.TerminalVerified)
            {
                if (entry.Outcome != outcome || entry.ExitCode != exitCode) throw new IOException("TERMINAL_PROOF_CONFLICT");
                return Observe(entry);
            }
            if (entry.Phase is not (ServiceAttemptPhase.DispatchCommitted or ServiceAttemptPhase.Running or ServiceAttemptPhase.TerminationUnknown))
                throw new IOException("ATTEMPT_PHASE_CONFLICT");
            entry.Phase = ServiceAttemptPhase.TerminalVerified;
            entry.Outcome = outcome;
            entry.ExitCode = exitCode;
            entry.ActiveProcesses = 0;
            entry.Reason = null;
            if (outcome is ServiceProcessOutcome.Cancelled or ServiceProcessOutcome.TimedOut)
                entry.Request = entry.Request with { CancellationRequested = true };
            Persist();
            return Observe(entry);
        }
    }

    internal ReservationRelease Release(ServiceAttemptIdentity identity, string callerSid)
    {
        lock (gate)
        {
            var entry = Require(identity, callerSid);
            if (!entry.ReservationHeld) return ReservationRelease.AlreadyReleased;
            if (entry.Request.HoldForImport) return ReservationRelease.Retained;
            if (entry.Phase is not (ServiceAttemptPhase.LaunchNotStarted or ServiceAttemptPhase.TerminalVerified))
                return ReservationRelease.Retained;
            entry.ReservationHeld = false;
            Persist();
            return ReservationRelease.Released;
        }
    }

    internal void AcquireImportReservation(ServiceAttemptIdentity identity, string callerSid)
    {
        lock (gate)
        {
            var entry = Require(identity, callerSid);
            if (entry.Request.CancellationRequested) throw new IOException("SERVICE_IMPORT_CANCELLED");
            if (entry.Request.HoldForImport) return;
            if (!entry.ReservationHeld || entry.Phase is not (ServiceAttemptPhase.DispatchCommitted or ServiceAttemptPhase.Running))
                throw new IOException("ATTEMPT_IMPORT_PHASE_INVALID");
            var exclusive = entry.Request with { ReservationKey = GlobalReservationKey, Shared = false, HoldForImport = true };
            if (HasConflict(exclusive, identity.AttemptId)) throw new IOException("WRITER_RESERVATION_BUSY");
            entry.Request = exclusive;
            Persist();
        }
    }

    internal ServiceAttemptObservation RequestCancellation(ServiceAttemptIdentity identity, string callerSid)
    {
        lock (gate)
        {
            var entry = Require(identity, callerSid);
            if (!entry.ReservationHeld) return Observe(entry);
            if (!entry.Request.CancellationRequested)
            {
                entry.Request = entry.Request with { CancellationRequested = true };
                if (entry.Phase == ServiceAttemptPhase.Prepared) entry.Phase = ServiceAttemptPhase.LaunchNotStarted;
                Persist();
            }
            if (entry.Phase == ServiceAttemptPhase.LaunchNotStarted) _ = Release(identity, callerSid);
            return Observe(entry);
        }
    }

    internal T StartImportValidation<T>(ServiceAttemptIdentity identity, string callerSid, Func<T> start)
    {
        lock (gate)
        {
            EnsureImportMayValidate(Require(identity, callerSid));
            return start();
        }
    }

    internal void CheckImportValidation(ServiceAttemptIdentity identity, string callerSid)
    {
        lock (gate) EnsureImportMayValidate(Require(identity, callerSid));
    }

    internal void CommitImportPublication(ServiceAttemptIdentity identity, string callerSid, Action persistIntent)
    {
        lock (gate)
        {
            var entry = Require(identity, callerSid);
            EnsureImportMayValidate(entry);
            entry.Request = entry.Request with { PublicationCommitted = true };
            Persist();
            persistIntent();
        }
    }

    private static void EnsureImportMayValidate(Entry entry)
    {
        if (entry.Request.CancellationRequested) throw new IOException("SERVICE_IMPORT_CANCELLED");
        if (entry.Phase is not (ServiceAttemptPhase.DispatchCommitted or ServiceAttemptPhase.Running)
            || !entry.ReservationHeld || !entry.Request.HoldForImport) throw new IOException("SERVICE_IMPORT_OWNER_NOT_RUNNING");
        if (entry.Request.PublicationCommitted) throw new IOException("SERVICE_IMPORT_PUBLICATION_ALREADY_COMMITTED");
    }

    internal void CompleteImportReservation(ServiceAttemptIdentity identity, string callerSid)
    {
        lock (gate)
        {
            var entry = Require(identity, callerSid);
            if (!entry.Request.HoldForImport) return;
            entry.Request = entry.Request with { HoldForImport = false };
            Persist();
            if (entry.Phase == ServiceAttemptPhase.TerminalVerified) _ = Release(identity, callerSid);
        }
    }

    private bool HasConflict(ServiceAttemptRequest request, string? exceptAttemptId = null) => attempts.Values.Any(entry =>
        entry.Request.Identity.AttemptId != exceptAttemptId && entry.ReservationHeld
        && (String.Equals(entry.Request.ReservationKey, request.ReservationKey, StringComparison.OrdinalIgnoreCase)
            || String.Equals(entry.Request.ReservationKey, GlobalReservationKey, StringComparison.OrdinalIgnoreCase)
            || String.Equals(request.ReservationKey, GlobalReservationKey, StringComparison.OrdinalIgnoreCase))
        && !(entry.Request.Shared && request.Shared));

    internal ServiceAttemptObservation Inspect(ServiceAttemptIdentity identity, string callerSid)
    {
        lock (gate) return Observe(Require(identity, callerSid));
    }

    private Entry Require(ServiceAttemptIdentity identity, string callerSid)
    {
        EnsureAvailable();
        if (!attempts.TryGetValue(identity.AttemptId, out var entry)
            || entry.Request.Identity != identity
            || !String.Equals(entry.Request.AuthenticatedCallerSid, callerSid, StringComparison.Ordinal))
            throw new UnauthorizedAccessException("ATTEMPT_OWNER_MISMATCH");
        return entry;
    }

    private static ServiceAttemptObservation Observe(Entry entry) => new(
        entry.Request.Identity,
        entry.Phase,
        entry.TargetPid,
        entry.Outcome,
        entry.ExitCode,
        entry.ActiveProcesses,
        entry.Reason,
        entry.ReservationHeld,
        entry.Request.CancellationRequested,
        entry.Request.PublicationCommitted);

    private static bool SameRequest(ServiceAttemptRequest left, ServiceAttemptRequest right) =>
        left.Identity == right.Identity
        && String.Equals(left.AuthenticatedCallerSid, right.AuthenticatedCallerSid, StringComparison.Ordinal)
        && String.Equals(left.ReservationKey, right.ReservationKey, StringComparison.OrdinalIgnoreCase)
        && String.Equals(left.OperationDigest, right.OperationDigest, StringComparison.Ordinal);

    private static void Validate(ServiceAttemptRequest request)
    {
        var identity = request.Identity;
        if (String.IsNullOrWhiteSpace(identity.TaskId) || identity.TaskId.Length > 256
            || String.IsNullOrWhiteSpace(identity.ReservationId) || identity.ReservationId.Length > 256
            || String.IsNullOrWhiteSpace(identity.AttemptId) || identity.AttemptId.Length > 256
            || identity.Generation < 1 || !Digest.IsMatch(identity.RequestDigest)
            || String.IsNullOrWhiteSpace(identity.OwnerClientId) || identity.OwnerClientId.Length > 256
            || String.IsNullOrWhiteSpace(identity.OwnerSessionId) || identity.OwnerSessionId.Length > 256
            || String.IsNullOrWhiteSpace(identity.WorkspaceId) || identity.WorkspaceId.Length > 256
            || !Sid.IsMatch(request.AuthenticatedCallerSid)
            || !Path.IsPathFullyQualified(request.ReservationKey)
            || request.HoldForImport && request.Shared
            || !Digest.IsMatch(request.OperationDigest))
            throw new IOException("ATTEMPT_REQUEST_INVALID");
    }

    private void Persist()
    {
        if (persistence is null) return;
        try
        {
            var snapshot = attempts.Values
                .OrderBy(entry => entry.Request.Identity.AttemptId, StringComparer.Ordinal)
                .Select(entry => new PersistedServiceAttempt(
                    entry.Request,
                    entry.Phase,
                    entry.TargetPid,
                    entry.Outcome,
                    entry.ExitCode,
                    entry.ActiveProcesses,
                    entry.Reason,
                    entry.ReservationHeld))
                .ToArray();
            persistence.Save(snapshot);
        }
        catch (Exception exception)
        {
            unavailable = true;
            throw new IOException("ATTEMPT_STORE_UNAVAILABLE", exception);
        }
    }

    private void EnsureAvailable()
    {
        if (unavailable) throw new IOException("ATTEMPT_STORE_UNAVAILABLE");
    }

    private static void ValidateStored(PersistedServiceAttempt stored)
    {
        if (stored is null) throw new IOException("ATTEMPT_STORE_CORRUPT");
        try { Validate(stored.Request); }
        catch { throw new IOException("ATTEMPT_STORE_CORRUPT"); }
        if (!Enum.IsDefined(stored.Phase)
            || (stored.Outcome is not null && !Enum.IsDefined(stored.Outcome.Value))
            || (stored.TargetPid is <= 0)
            || (stored.Reason is { Length: > 128 })
            || (stored.Phase == ServiceAttemptPhase.Running && stored.TargetPid is null)
            || (stored.Phase == ServiceAttemptPhase.TerminationUnknown && String.IsNullOrWhiteSpace(stored.Reason))
            || (stored.Phase == ServiceAttemptPhase.TerminalVerified
                ? stored.Outcome is null || stored.ExitCode is null || stored.ActiveProcesses != 0
                : stored.Outcome is not null || stored.ExitCode is not null || stored.ActiveProcesses is not null)
            || (stored.Phase is ServiceAttemptPhase.Prepared or ServiceAttemptPhase.DispatchCommitted or ServiceAttemptPhase.LaunchNotStarted
                && stored.TargetPid is not null)
            || (!stored.ReservationHeld && stored.Phase is not (ServiceAttemptPhase.LaunchNotStarted or ServiceAttemptPhase.TerminalVerified)))
            throw new IOException("ATTEMPT_STORE_CORRUPT");
    }
}
