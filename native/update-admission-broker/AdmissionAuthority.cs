using System.Security.Principal;
using System.Runtime.Versioning;

namespace Lnwjud.UpdateAdmission;

internal sealed class StoreIdentity
{
    internal string Directory { get; }
    internal string OwnerSid { get; }
    private StoreIdentity(string directory, string ownerSid) { Directory = directory; OwnerSid = ownerSid; }
    internal static StoreIdentity Installed() => throw new Refusal("MAINTENANCE_REGISTRY_UNCONFIGURED");
#if ADMISSION_ISOLATED_TESTS
    [SupportedOSPlatform("windows")]
    internal static StoreIdentity Isolated(string directory) => new(directory, WindowsIdentity.GetCurrent().User!.Value);
#endif
}

internal sealed class RuntimePrincipal
{
    internal string Identity { get; }
    internal bool Retired { get; private set; }
    internal void Retire() => Retired = true;
    private RuntimePrincipal(string identity) { Identity = identity; }
#if ADMISSION_ISOLATED_TESTS
    internal static RuntimePrincipal Isolated(string identity) => AdmissionProtocol.Identifier(identity) ? new(identity) : throw new Refusal("TEST_IDENTITY_INVALID");
#endif
}

internal sealed class UpdatePrincipal
{
    internal string TransactionId { get; }
    internal ulong Generation { get; }
    private UpdatePrincipal(string transactionId, ulong generation) { TransactionId = transactionId; Generation = generation; }
#if ADMISSION_ISOLATED_TESTS
    internal static UpdatePrincipal Isolated(string transactionId, ulong generation) => AdmissionProtocol.Identifier(transactionId) && generation > 0
        ? new(transactionId, generation) : throw new Refusal("TEST_IDENTITY_INVALID");
#endif
}

internal enum SettlementKind { OperationSettled, NativeJobZeroAndReleased, ParticipantQuiesced, OwnerCessation, AcceptedDisposition }

internal sealed class NativeEvidence
{
    internal SettlementKind Kind { get; }
    internal string Binding { get; }
    private NativeEvidence(SettlementKind kind, string binding) { Kind = kind; Binding = binding; }
#if ADMISSION_ISOLATED_TESTS
    internal static NativeEvidence Isolated(SettlementKind kind, string binding) => new(kind, binding);
#endif
}
