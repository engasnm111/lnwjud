using Microsoft.Win32;
using Microsoft.Win32.SafeHandles;
using System.Runtime.InteropServices;
using System.Security.AccessControl;

namespace Lnwjud.Containment;

internal sealed record UpdateStartupDisposition(string Kind, string Reason);

internal sealed class UpdateStartupGate
{
    private readonly string installationRoot;
    private readonly string serviceStore;
    private readonly Func<bool> machineEnrolled;
    private UpdateStartupGate(string installationRoot, string serviceStore, Func<bool> machineEnrolled)
        => (this.installationRoot, this.serviceStore, this.machineEnrolled) = (installationRoot, serviceStore, machineEnrolled);

    internal static UpdateStartupGate Installed(ServiceEndpointIdentity.ProductionServiceAuthority owner, string serviceStore)
    {
        owner.RequireActive();
        return new(owner.InstallationRoot, serviceStore, MachineEnrolled);
    }

#if NATIVE_CONTAINMENT_TESTS
    internal static UpdateStartupGate Isolated(string install, string state, Func<bool> registrationPresent)
        => new(install, state, registrationPresent);
#endif

    internal static readonly UpdateStartupDisposition Unavailable = new("held", "UPDATE_STARTUP_INSPECTION_UNAVAILABLE");
    private static readonly UpdateStartupDisposition Unverified = new("held", "UPDATE_ENROLLMENT_UNVERIFIED");
    private static readonly UpdateStartupDisposition Unmanaged = new("unmanaged", "MANUAL_INSTALLATION");

    [DllImport("shell32.dll", ExactSpelling = true)]
    private static extern int SHGetKnownFolderPath(in Guid folder, uint flags, nint token, out nint path);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern int RegOpenKeyExW(SafeRegistryHandle parent, string name, uint options, int access, out SafeRegistryHandle result);

    internal UpdateStartupDisposition Inspect()
    {
        try
        {
            using var install = ServiceEndpointIdentity.OpenProtected(installationRoot, directory: true);
            using var store = ServiceEndpointIdentity.OpenProtected(serviceStore, directory: true);
            if (ExistsInPinnedDirectory(installationRoot, "slots") || ExistsInPinnedDirectory(serviceStore, "update-authority") || machineEnrolled())
                return Unverified;
            return Unmanaged;
        }
        catch (IOException) { return Unavailable; }
        catch (UnauthorizedAccessException) { return Unavailable; }
        catch (System.ComponentModel.Win32Exception) { return Unavailable; }
        catch (System.Security.SecurityException) { return Unavailable; }
    }

    internal static UpdateStartupDisposition InspectFootprint()
    {
        try
        {
            if (MachineEnrolled()) return Unverified;
            var programFiles = KnownFolder(new("905e63b6-c1bf-494e-b29c-65b732d3d21a"));
            var programData = KnownFolder(new("62ab5d82-fdc1-4dc3-a9dd-070d1d495d97"));
            using var programs = ServiceEndpointIdentity.OpenProtected(programFiles, directory: true);
            if (ServiceEndpointIdentity.CurrentSlotHold(programFiles) is { } slotHold) return new("held", slotHold);
            using var data = ServiceEndpointIdentity.PinKnownFolder(programData);
            if (HasSlots(programFiles, Path.Combine(programFiles, "lnwjud"), required: false)) return Unverified;
            using var service = OpenMachineKey(@"SYSTEM\CurrentControlSet\Services\LnwjudContainment");
            if (service is not null)
            {
                VerifyRegistryProtection(service);
                var command = service.GetValue("ImagePath", null, RegistryValueOptions.DoNotExpandEnvironmentNames) as string;
                if (command is null || command.Length > 32767) return Unavailable;
                var image = WindowsContainmentServiceInstaller.ParseRegisteredImagePath(command);
                var root = WindowsContainmentServiceInstaller.ValidateImagePath(image, programFiles);
                if (HasSlots(programFiles, root, required: true)) return Unverified;
            }
            // Existing installations keep the ledger accessible only to SYSTEM and administrators.
            // The protected machine registration precedes all managed files and survives rollback.
            if (HasPrivateAuthority(programData)) return Unverified;
            return MachineEnrolled() ? Unverified : Unmanaged;
        }
        catch (Exception) { return Unavailable; }
    }

    internal static bool HasPrivateAuthority(string programData)
    {
        var store = Path.Combine(programData, "lnwjud-containment");
        var attributes = ReadAttributesIfPresent(store);
        if (attributes is null) return false;
        if ((attributes & (FileAttributes.Directory | FileAttributes.ReparsePoint)) != FileAttributes.Directory)
            throw new IOException("SERVICE_FOOTPRINT_DIRECTORY_UNSAFE");
        if (ReadAttributesIfPresent(Path.Combine(store, "update-authority")) is not null) return true;
        if (ReadAttributesIfPresent(store) != attributes) throw new IOException("SERVICE_FOOTPRINT_DIRECTORY_CHANGED");
        return false;
    }

    private static bool HasSlots(string programs, string installation, bool required)
    {
        var handles = new List<SafeFileHandle>();
        try
        {
            var path = programs;
            foreach (var component in Path.GetRelativePath(programs, installation).Split(Path.DirectorySeparatorChar))
            {
                path = Path.Combine(path, component);
                if (ReadAttributesIfPresent(path) is null)
                {
                    if (required) throw new IOException("SERVICE_FOOTPRINT_INSTALLATION_MISSING");
                    return false;
                }
                handles.Add(ServiceEndpointIdentity.OpenProtected(path, directory: true));
            }
            return ExistsInPinnedDirectory(installation, "slots");
        }
        finally { foreach (var handle in handles) handle.Dispose(); }
    }

    private static string KnownFolder(Guid folder)
    {
        var result = SHGetKnownFolderPath(in folder, 0, 0, out var path);
        try
        {
            if (result != 0 || Marshal.PtrToStringUni(path) is not { } directory || !Path.IsPathFullyQualified(directory)
                || directory.StartsWith('\\') || Path.GetPathRoot(directory)?.Length != 3)
                throw new IOException("SERVICE_FOOTPRINT_KNOWN_FOLDER_UNAVAILABLE");
            return Path.GetFullPath(directory);
        }
        finally { Marshal.FreeCoTaskMem(path); }
    }

    private static RegistryKey? OpenMachineKey(string name)
    {
        using var machine = new SafeRegistryHandle(unchecked((nint)(int)0x80000002), ownsHandle: false);
        return OpenKey(machine, name);
    }

    private static RegistryKey? OpenKey(SafeRegistryHandle parent, string name)
    {
        const int read64 = 0x20019 | 0x0100;
        var error = RegOpenKeyExW(parent, name, 8, read64, out var handle);
        if (error == 0) return RegistryKey.FromHandle(handle, RegistryView.Registry64);
        handle.Dispose();
        if (error == 2) return null;
        throw new IOException("SERVICE_FOOTPRINT_REGISTRY_UNAVAILABLE");
    }

    private static bool MachineEnrolled()
    {
        using var product = OpenMachineKey(@"SOFTWARE\lnwjud");
        if (product is null) return false;
        VerifyRegistryProtection(product);
        using var registration = OpenKey(product.Handle, "UpdateAuthority");
        return registration is not null;
    }

    private static void VerifyRegistryProtection(RegistryKey key)
    {
        var security = key.GetAccessControl(AccessControlSections.Owner | AccessControlSections.Access);
        const int registryMutation = 0x500d0026;
        ServiceEndpointIdentity.ValidateProtectedAccess(new RawSecurityDescriptor(security.GetSecurityDescriptorBinaryForm(), 0), registryMutation);
        uint size = 0;
        if (RegQueryValueExW(key.Handle, "SymbolicLinkValue", 0, out _, 0, ref size) != 2)
            throw new IOException("SERVICE_FOOTPRINT_REGISTRY_UNVERIFIED");
    }

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern int RegQueryValueExW(SafeRegistryHandle key, string name, nint reserved, out uint type, nint data, ref uint size);

    private static bool ExistsInPinnedDirectory(string parent, string name)
        => ReadAttributesIfPresent(Path.Combine(parent, name)) is not null;

    private static FileAttributes? ReadAttributesIfPresent(string path)
    {
        try { return File.GetAttributes(path); }
        catch (FileNotFoundException) { return null; }
    }
}
