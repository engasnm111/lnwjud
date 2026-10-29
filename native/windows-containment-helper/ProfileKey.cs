using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;

namespace Lnwjud.Containment;

internal static class ProfileKey
{
    [StructLayout(LayoutKind.Sequential)] private struct Blob { public int Length; public nint Data; }
    [DllImport("crypt32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool CryptProtectData(ref Blob input, string description, nint entropy, nint reserved, nint prompt, uint flags, out Blob output);
    [DllImport("crypt32.dll", SetLastError = true)] private static extern bool CryptUnprotectData(ref Blob input, nint description, nint entropy, nint reserved, nint prompt, uint flags, out Blob output);
    [DllImport("kernel32.dll")] private static extern nint LocalFree(nint value);

    internal static byte[] ReadOrCreate(string directory)
    {
        if (!Path.IsPathFullyQualified(directory)) throw new IOException("KEY_ABSOLUTE_DIRECTORY_REQUIRED");
        var security = new DirectorySecurity();
        security.SetAccessRuleProtection(true, false);
        var sid = WindowsIdentity.GetCurrent().User ?? throw new IOException("KEY_IDENTITY_UNAVAILABLE");
        security.AddAccessRule(new FileSystemAccessRule(sid, FileSystemRights.FullControl, InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
        if (!Directory.Exists(directory)) FileSystemAclExtensions.CreateDirectory(security, directory);
        using var pinned = PinnedDirectory.Open(directory);
        new DirectoryInfo(directory).SetAccessControl(security);
        var filename = Path.Combine(directory, "native-receipt-key.dpapi");
        if (!File.Exists(filename))
        {
            var raw = RandomNumberGenerator.GetBytes(32);
            var protectedKey = Transform(raw, true);
            CryptographicOperations.ZeroMemory(raw);
            var temporary = filename + "." + Guid.NewGuid().ToString("N");
            try
            {
                using (var stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None, 4096, FileOptions.WriteThrough)) { stream.Write(protectedKey); stream.Flush(true); }
                try { File.Move(temporary, filename, false); } catch (IOException) when (File.Exists(filename)) { }
            }
            finally { if (File.Exists(temporary)) File.Delete(temporary); }
        }
        if ((File.GetAttributes(filename) & FileAttributes.ReparsePoint) != 0) throw new IOException("KEY_REPARSE_REFUSED");
        var bytes = File.ReadAllBytes(filename);
        if (bytes.Length is < 32 or > 16384) throw new IOException("KEY_INVALID_SIZE");
        var key = Transform(bytes, false);
        if (key.Length != 32) throw new IOException("KEY_INVALID_LENGTH");
        return key;
    }

    private static byte[] Transform(byte[] bytes, bool protect)
    {
        var input = new Blob { Length = bytes.Length, Data = Marshal.AllocHGlobal(bytes.Length) };
        Blob output = default;
        try
        {
            Marshal.Copy(bytes, 0, input.Data, bytes.Length);
            var ok = protect ? CryptProtectData(ref input, "lnwjud native receipt key v2", 0, 0, 0, 1, out output) : CryptUnprotectData(ref input, 0, 0, 0, 0, 1, out output);
            if (!ok) throw new IOException("KEY_DPAPI_FAILED");
            var result = new byte[output.Length]; Marshal.Copy(output.Data, result, 0, output.Length); return result;
        }
        finally { Marshal.FreeHGlobal(input.Data); if (output.Data != 0) LocalFree(output.Data); }
    }
}
