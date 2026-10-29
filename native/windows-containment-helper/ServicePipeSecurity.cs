using System.ComponentModel;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace Lnwjud.Containment;

/// <summary>
/// Creates local-only service pipes with a protected DACL. Clients can exchange
/// data, but only LocalSystem and administrators can create pipe instances.
/// </summary>
internal static class ServicePipeSecurity
{
    private const uint SddlRevision = 1;
    private const uint PipeAccessDuplex = 0x00000003;
    private const uint FileFlagOverlapped = 0x40000000;
    private const uint FileFlagFirstPipeInstance = 0x00080000;
    private const uint ClientDataAccess = 0x0012019b;
    private const uint SecuritySqosImpersonation = 0x00120000;
    private const uint PipeTypeByte = 0x00000000;
    private const uint PipeReadModeByte = 0x00000000;
    private const uint PipeWait = 0x00000000;
    private const uint PipeRejectRemoteClients = 0x00000008;
    private const int MaximumInstances = 16;
    private const int BufferBytes = 64 * 1024;
    // FILE_GENERIC_WRITE includes FILE_CREATE_PIPE_INSTANCE. Grant client data
    // rights explicitly so authenticated clients cannot create server instances.
    private const string PipeSecurityDescriptor = "D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;0x0012019b;;;AU)";

    [StructLayout(LayoutKind.Sequential)]
    private struct SecurityAttributes
    {
        internal int Length;
        internal nint SecurityDescriptor;
        internal int InheritHandle;
    }

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "ConvertStringSecurityDescriptorToSecurityDescriptorW")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(
        string stringSecurityDescriptor,
        uint stringSdRevision,
        out nint securityDescriptor,
        out uint securityDescriptorSize);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "CreateNamedPipeW")]
    private static extern nint CreateNamedPipe(
        string name,
        uint openMode,
        uint pipeMode,
        uint maximumInstances,
        uint outputBufferSize,
        uint inputBufferSize,
        uint defaultTimeout,
        ref SecurityAttributes securityAttributes);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern nint LocalFree(nint memory);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "CreateFileW")]
    private static extern SafePipeHandle OpenClient(string name, uint access, uint share,
        nint attributes, uint disposition, uint flags, nint template);

    internal static async Task<NamedPipeClientStream> ConnectClientAsync(string pipeName, CancellationToken cancellationToken)
    {
        while (true)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var handle = OpenClient(@"\\.\pipe\" + pipeName, ClientDataAccess, 0, 0, 3,
                FileFlagOverlapped | SecuritySqosImpersonation, 0);
            if (!handle.IsInvalid)
            {
                try { return new NamedPipeClientStream(PipeDirection.InOut, isAsync: true, isConnected: true, handle); }
                catch { handle.Dispose(); throw; }
            }
            var error = Marshal.GetLastWin32Error();
            handle.Dispose();
            if (error is not (2 or 231)) throw new Win32Exception(error, "SERVICE_PIPE_CONNECT_FAILED");
            await Task.Delay(50, cancellationToken).ConfigureAwait(false);
        }
    }

    internal static NamedPipeServerStream CreateServer(string pipeName, bool firstInstance) =>
        CreateServerCore(pipeName, firstInstance, PipeSecurityDescriptor);

#if NATIVE_CONTAINMENT_TESTS
    internal static NamedPipeServerStream CreateCurrentUserTestServer(string pipeName, bool firstInstance)
    {
        var sid = System.Security.Principal.WindowsIdentity.GetCurrent().User?.Value
            ?? throw new IOException("SERVICE_TEST_USER_UNAVAILABLE");
        return CreateServerCore(pipeName, firstInstance, PipeSecurityDescriptor + $"(A;;GA;;;{sid})");
    }
#endif

    private static NamedPipeServerStream CreateServerCore(string pipeName, bool firstInstance, string securityDescriptor)
    {
        if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException("SERVICE_PIPE_WINDOWS_REQUIRED");
        if (pipeName.Length is < 1 or > 80 || pipeName.Any(character =>
                !(character is >= 'A' and <= 'Z' or >= 'a' and <= 'z' or >= '0' and <= '9' or '.' or '_' or '-')))
            throw new IOException("SERVICE_PIPE_NAME_INVALID");

        if (!ConvertStringSecurityDescriptorToSecurityDescriptor(securityDescriptor, SddlRevision, out var descriptor, out _))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "SERVICE_PIPE_SECURITY_DESCRIPTOR_FAILED");
        try
        {
            var attributes = new SecurityAttributes
            {
                Length = Marshal.SizeOf<SecurityAttributes>(),
                SecurityDescriptor = descriptor,
                InheritHandle = 0,
            };
            var openMode = PipeAccessDuplex | FileFlagOverlapped | (firstInstance ? FileFlagFirstPipeInstance : 0);
            var pipeMode = PipeTypeByte | PipeReadModeByte | PipeWait | PipeRejectRemoteClients;
            var handle = CreateNamedPipe(@"\\.\pipe\" + pipeName, openMode, pipeMode, MaximumInstances, BufferBytes, BufferBytes, 0, ref attributes);
            if (handle == 0 || handle == new nint(-1))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "SERVICE_PIPE_CREATE_FAILED");

            var safeHandle = new SafePipeHandle(handle, ownsHandle: true);
            try { return new NamedPipeServerStream(PipeDirection.InOut, isAsync: true, isConnected: false, safeHandle); }
            catch { safeHandle.Dispose(); throw; }
        }
        finally { _ = LocalFree(descriptor); }
    }
}
