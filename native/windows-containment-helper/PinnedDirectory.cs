using Microsoft.Win32.SafeHandles;
using System.Runtime.InteropServices;

namespace Lnwjud.Containment;

internal sealed class PinnedDirectory : IDisposable
{
    private readonly List<SafeFileHandle> handles = [];
    [StructLayout(LayoutKind.Sequential)] private struct FileInfo { public uint Attributes; public System.Runtime.InteropServices.ComTypes.FILETIME Creation, Access, Write; public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow; }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern SafeFileHandle CreateFile(string name, uint access, uint share, nint security, uint disposition, uint flags, nint template);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetFileInformationByHandle(SafeFileHandle handle, out FileInfo info);
    internal static PinnedDirectory Open(string directory)
    {
        var result = new PinnedDirectory();
        try
        {
            var current = Path.GetFullPath(directory);
            while (true)
            {
                var handle = CreateFile(current, 0x80, 3, 0, 3, 0x02200000, 0);
                if (handle.IsInvalid) { handle.Dispose(); throw new IOException("NATIVE_DIRECTORY_PIN_FAILED"); }
                result.handles.Add(handle);
                if (!GetFileInformationByHandle(handle, out var info) || (info.Attributes & 0x400) != 0 || (info.Attributes & 0x10) == 0) throw new IOException("NATIVE_DIRECTORY_REPARSE_REFUSED");
                var parent = Directory.GetParent(current); if (parent is null) break; current = parent.FullName;
            }
            return result;
        }
        catch { result.Dispose(); throw; }
    }
    public void Dispose() { foreach (var handle in handles) handle.Dispose(); }
}
