using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Security.Principal;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace Lnwjud.UpdateAdmission;

// A retained, query-only process observation from a connected server pipe.
// It is NOT a peer principal or proof that the pipe still belongs to this
// process: PID reuse during initial capture and duplicated pipe handles
// require independent authentication before any admission can be granted.
[SupportedOSPlatform("windows")]
internal sealed class WindowsUpdateAdmissionPeerObservation : IDisposable
{
    private const uint ProcessQueryLimitedInformation = 0x1000;
    private const uint TokenQuery = 0x0008;
    private const int TokenUser = 1;
    private const int TokenSessionId = 12;
    private const uint MaxTokenUserBytes = 8192;
    private readonly SafeProcessHandle process;

    private WindowsUpdateAdmissionPeerObservation(SafeProcessHandle process, uint pid,
        long creationTime, string imagePath, string userSid, uint sessionId)
    {
        this.process = process;
        ProcessId = pid;
        CreationTime = creationTime;
        ImagePath = imagePath;
        UserSid = userSid;
        SessionId = sessionId;
    }

    internal uint ProcessId { get; }
    internal long CreationTime { get; }
    internal string ImagePath { get; }
    internal string UserSid { get; }
    internal uint SessionId { get; }

    [StructLayout(LayoutKind.Sequential)]
    private struct TokenUserValue
    {
        internal nint Sid;
        internal uint Attributes;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetNamedPipeClientProcessId(SafePipeHandle pipe, out uint pid);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetNamedPipeClientSessionId(SafePipeHandle pipe, out uint sessionId);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool ProcessIdToSessionId(uint pid, out uint sessionId);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern SafeProcessHandle OpenProcess(uint access, [MarshalAs(UnmanagedType.Bool)] bool inherit, uint pid);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetProcessTimes(SafeProcessHandle process, out long creation, out long exit, out long kernel, out long user);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool QueryFullProcessImageName(SafeProcessHandle process, uint flags, StringBuilder path, ref uint size);

    [DllImport("advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool OpenProcessToken(SafeProcessHandle process, uint access, out SafeAccessTokenHandle token);

    [DllImport("advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetTokenInformation(SafeAccessTokenHandle token, int informationClass,
        nint buffer, uint bufferLength, out uint required);

    [DllImport("advapi32.dll", EntryPoint = "GetTokenInformation", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetTokenSessionId(SafeAccessTokenHandle token, int informationClass,
        out uint sessionId, uint bufferLength, out uint returned);

    internal static WindowsUpdateAdmissionPeerObservation Capture(SafePipeHandle connectedServerPipe)
    {
        if (!OperatingSystem.IsWindows() || connectedServerPipe.IsInvalid || connectedServerPipe.IsClosed
            || !GetNamedPipeClientProcessId(connectedServerPipe, out var pid) || pid == 0)
            throw new Refusal("MAINTENANCE_PEER_UNVERIFIED");

        var process = OpenProcess(ProcessQueryLimitedInformation, false, pid);
        if (process.IsInvalid)
        {
            process.Dispose();
            throw new Refusal("MAINTENANCE_PEER_UNVERIFIED");
        }
        try
        {
            if (!GetNamedPipeClientSessionId(connectedServerPipe, out var pipeSession)
                || !ProcessIdToSessionId(pid, out var processSession) || pipeSession != processSession)
                throw new Refusal("MAINTENANCE_PEER_UNVERIFIED");
            if (!GetProcessTimes(process, out var created, out var exited, out _, out _)
                || created <= 0 || exited != 0)
                throw new Refusal("MAINTENANCE_PEER_UNVERIFIED");
            var image = new StringBuilder(32768);
            uint length = (uint)image.Capacity;
            if (!QueryFullProcessImageName(process, 0, image, ref length)
                || length == 0 || length >= image.Capacity)
                throw new Refusal("MAINTENANCE_PEER_UNVERIFIED");
            if (!OpenProcessToken(process, TokenQuery, out var token) || token.IsInvalid)
                throw new Refusal("MAINTENANCE_PEER_UNVERIFIED");
            string userSid;
            using (token)
            {
                _ = GetTokenInformation(token, TokenUser, 0, 0, out var required);
                if (required < Marshal.SizeOf<TokenUserValue>() || required > MaxTokenUserBytes)
                    throw new Refusal("MAINTENANCE_PEER_UNVERIFIED");
                var buffer = Marshal.AllocHGlobal(checked((int)required));
                try
                {
                    if (!GetTokenInformation(token, TokenUser, buffer, required, out var returned)
                        || returned < Marshal.SizeOf<TokenUserValue>() || returned > required)
                        throw new Refusal("MAINTENANCE_PEER_UNVERIFIED");
                    var user = Marshal.PtrToStructure<TokenUserValue>(buffer);
                    if (user.Sid == 0) throw new Refusal("MAINTENANCE_PEER_UNVERIFIED");
                    userSid = new SecurityIdentifier(user.Sid).Value;
                }
                finally { Marshal.FreeHGlobal(buffer); }
                if (!GetTokenSessionId(token, TokenSessionId, out var tokenSession, sizeof(uint), out var returnedSessionBytes)
                    || returnedSessionBytes != sizeof(uint) || tokenSession != pipeSession)
                    throw new Refusal("MAINTENANCE_PEER_UNVERIFIED");
            }
            if (!GetNamedPipeClientProcessId(connectedServerPipe, out var confirmedPid) || confirmedPid != pid
                || !GetProcessTimes(process, out var confirmedCreated, out var confirmedExit, out _, out _)
                || confirmedCreated != created || confirmedExit != 0
                || !GetNamedPipeClientSessionId(connectedServerPipe, out var confirmedSession) || confirmedSession != pipeSession
                || !ProcessIdToSessionId(pid, out var confirmedProcessSession) || confirmedProcessSession != pipeSession)
                throw new Refusal("MAINTENANCE_PEER_UNVERIFIED");
            return new WindowsUpdateAdmissionPeerObservation(process, pid, created, image.ToString(), userSid, pipeSession);
        }
        catch
        {
            process.Dispose();
            throw;
        }
    }

    // This checks the retained process instance, not connection liveness or
    // whether the original pipe client is still authorized.
    internal bool IsObservedProcessAlive() =>
        !process.IsClosed && !process.IsInvalid
        && GetProcessTimes(process, out var created, out var exited, out _, out _)
        && created == CreationTime && exited == 0;

    public void Dispose() => process.Dispose();
}
