using System.Security.Principal;
using System.Runtime.Versioning;

namespace Lnwjud.UpdateAdmission;

internal sealed class StoreIdentity
{
    internal string Directory { get; }
    internal string OwnerSid { get; }
    internal bool RequireProtectedParent { get; }
    private StoreIdentity(string directory, string ownerSid, bool requireProtectedParent)
    {
        Directory = directory;
        OwnerSid = ownerSid;
        RequireProtectedParent = requireProtectedParent;
    }
    // This identity is granted by the Windows Service Control Manager, never by
    // a caller-supplied SID or a shared LocalService process. The service and
    // protected store must already have been provisioned independently.
    [SupportedOSPlatform("windows")]
    internal static StoreIdentity Installed()
    {
        using var identity = WindowsIdentity.GetCurrent();
        if (identity.User?.Value != "S-1-5-19") throw new Refusal("MAINTENANCE_SERVICE_IDENTITY_UNAVAILABLE");
        SecurityIdentifier serviceSid;
        try
        {
            serviceSid = (SecurityIdentifier)new NTAccount(@"NT SERVICE\LnwjudUpdateAdmission").Translate(typeof(SecurityIdentifier));
        }
        catch (IdentityNotMappedException) { throw new Refusal("MAINTENANCE_SERVICE_IDENTITY_UNAVAILABLE"); }
        if (!new WindowsPrincipal(identity).IsInRole(serviceSid)) throw new Refusal("MAINTENANCE_SERVICE_IDENTITY_UNAVAILABLE");
        var commonData = Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData);
        if (string.IsNullOrWhiteSpace(commonData)) throw new Refusal("MAINTENANCE_STORE_ROOT_UNAVAILABLE");
        var root = AdmissionStore.ValidatePath(Path.Combine(commonData, "lnwjud", "update-admission"));
        return new StoreIdentity(root, serviceSid.Value, requireProtectedParent: true);
    }
#if ADMISSION_ISOLATED_TESTS
    [SupportedOSPlatform("windows")]
    internal static StoreIdentity Isolated(string directory) => new(directory, WindowsIdentity.GetCurrent().User!.Value, requireProtectedParent: false);
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
