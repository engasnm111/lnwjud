using System.ComponentModel;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.Principal;
using Microsoft.Win32.SafeHandles;

namespace Lnwjud.Containment;

internal static class ServicePipeSecurityTests
{
    [StructLayout(LayoutKind.Sequential)]
    private struct SidAndAttributes { internal nint Sid; internal uint Attributes; }

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool OpenProcessToken(nint process, uint access, out SafeAccessTokenHandle token);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool CreateRestrictedToken(SafeAccessTokenHandle existing, uint flags,
        uint disableCount, nint disable, uint deleteCount, nint delete,
        uint restrictCount, ref SidAndAttributes restrict, out SafeAccessTokenHandle token);

    internal static void Run()
    {
        if (!OpenProcessToken(new nint(-1), 0x000A, out var original))
            throw new Win32Exception(Marshal.GetLastWin32Error());
        using (original)
        {
            var authenticatedUsers = new SecurityIdentifier(WellKnownSidType.AuthenticatedUserSid, null);
            var sidBytes = new byte[authenticatedUsers.BinaryLength];
            authenticatedUsers.GetBinaryForm(sidBytes, 0);
            var pinned = GCHandle.Alloc(sidBytes, GCHandleType.Pinned);
            try
            {
                // The restricted access check uses only AU, so an administrator
                // or the pipe owner cannot mask an over-permissive AU entry.
                var restrict = new SidAndAttributes { Sid = pinned.AddrOfPinnedObject() };
                if (!CreateRestrictedToken(original, 1, 0, 0, 0, 0, 1, ref restrict, out var token))
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                using (token)
                {
                    var pipeName = "lnwjud-acl-" + Guid.NewGuid().ToString("N");
                    using var server = ServicePipeSecurity.CreateServer(pipeName, firstInstance: true);
                    WindowsIdentity.RunImpersonated(token, () =>
                    {
                        try
                        {
                            using var competing = ServicePipeSecurity.CreateServer(pipeName, firstInstance: false);
                            throw new Exception("Authenticated client created a competing service pipe instance");
                        }
                        catch (Win32Exception exception) when (exception.NativeErrorCode == 5) { }
                    });
                    using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(5));
                    var connected = server.WaitForConnectionAsync(timeout.Token);
                    using var client = WindowsIdentity.RunImpersonated(token, () =>
                        ServicePipeSecurity.ConnectClientAsync(pipeName, timeout.Token).GetAwaiter().GetResult());
                    connected.WaitAsync(TimeSpan.FromSeconds(5)).GetAwaiter().GetResult();
                    var buffer = new byte[1];
                    client.WriteAsync(new byte[] { 0x5A }, timeout.Token).AsTask().GetAwaiter().GetResult();
                    server.ReadExactlyAsync(buffer, timeout.Token).AsTask().GetAwaiter().GetResult();
                    if (buffer[0] != 0x5A) throw new Exception("Restricted client request was not received");
                    using var caller = AuthenticatedPipeCaller.Capture(server);
                    if (caller.Sid != WindowsIdentity.GetCurrent().User?.Value)
                        throw new Exception("Restricted client identity was not authenticated");
                    server.WriteAsync(new byte[] { 0xA5 }, timeout.Token).AsTask().GetAwaiter().GetResult();
                    client.ReadExactlyAsync(buffer, timeout.Token).AsTask().GetAwaiter().GetResult();
                    if (buffer[0] != 0xA5) throw new Exception("Restricted client response was not received");
                    Console.WriteLine("PIPE_AU_INSTANCE_DENIED_DUPLEX_OK");
                }
            }
            finally { pinned.Free(); }
        }
        using var cancelled = new CancellationTokenSource();
        var missingEndpoint = ServicePipeSecurity.ConnectClientAsync("lnwjud-missing-" + Guid.NewGuid().ToString("N"), cancelled.Token);
        cancelled.Cancel();
        try
        {
            using var unexpected = missingEndpoint.GetAwaiter().GetResult();
            throw new Exception("Missing service endpoint ignored cancellation");
        }
        catch (OperationCanceledException) when (cancelled.IsCancellationRequested) { }
    }
}
