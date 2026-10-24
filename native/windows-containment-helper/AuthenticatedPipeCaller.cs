using System.ComponentModel;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace Lnwjud.Containment;

internal sealed class AuthenticatedPipeCaller : IDisposable
{
    private const uint TokenAssignPrimary = 0x0001;
    private const uint TokenDuplicate = 0x0002;
    private const uint TokenQuery = 0x0008;
    private const int TokenSessionId = 12;
    private const int TokenUser = 1;
    private const int SecurityImpersonation = 2;
    private const int TokenPrimary = 1;
    private const nint CurrentThread = -2;

    private AuthenticatedPipeCaller(string sid, SafeAccessTokenHandle primaryToken)
    {
        Sid = sid;
        PrimaryToken = primaryToken;
    }

    internal string Sid { get; }
    internal SafeAccessTokenHandle PrimaryToken { get; }

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool ImpersonateNamedPipeClient(SafePipeHandle pipe);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool OpenThreadToken(nint thread, uint access, bool openAsSelf, out SafeAccessTokenHandle token);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool GetTokenInformation(SafeAccessTokenHandle token, int informationClass, nint information, uint informationLength, out uint returnLength);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool DuplicateTokenEx(
        SafeAccessTokenHandle existingToken,
        uint desiredAccess,
        nint tokenAttributes,
        int impersonationLevel,
        int tokenType,
        out SafeAccessTokenHandle newToken);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "ConvertSidToStringSidW")]
    private static extern bool ConvertSidToStringSid(nint sid, out nint stringSid);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern nint LocalFree(nint memory);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool RevertToSelf();

    [DllImport("advapi32.dll", SetLastError = true, EntryPoint = "GetTokenInformation")]
    private static extern bool GetRawTokenInformation(nint token, int informationClass, nint information, uint informationLength, out uint returnLength);

    internal static SafeAccessTokenHandle CreateLaunchToken(SafeAccessTokenHandle callerToken)
    {
        var expectedSecurity = SecurityFingerprint(callerToken);
        var originalSession = ReadSessionId(callerToken.DangerousGetHandle());
        // The authenticated caller's token already carries the launch session.
        var access = TokenAssignPrimary | TokenDuplicate | TokenQuery;
        if (!DuplicateTokenEx(callerToken, access, 0, SecurityImpersonation, TokenPrimary, out var launch))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "PIPE_LAUNCH_TOKEN_UNAVAILABLE");
        try
        {
            if (SecurityFingerprint(launch) != expectedSecurity || SecurityFingerprint(callerToken) != expectedSecurity
                || ReadSessionId(launch.DangerousGetHandle()) != originalSession
                || ReadSessionId(callerToken.DangerousGetHandle()) != originalSession)
                throw new IOException("PIPE_LAUNCH_SECURITY_CHANGED");
            return launch;
        }
        catch { launch.Dispose(); throw; }
    }

    internal static uint ReadSessionId(nint token) => ReadInformation(token, TokenSessionId, (buffer, length) =>
        length == sizeof(uint) ? unchecked((uint)Marshal.ReadInt32(buffer)) : throw new IOException("PIPE_TOKEN_SESSION_INVALID"));

    internal static string SecurityFingerprint(SafeAccessTokenHandle token)
    {
        string SidAt(nint pointer)
        {
            if (!ConvertSidToStringSid(pointer, out var text)) throw new IOException("PIPE_TOKEN_SECURITY_INVALID");
            try { return Marshal.PtrToStringUni(text) ?? throw new IOException("PIPE_TOKEN_SECURITY_INVALID"); }
            finally { _ = LocalFree(text); }
        }
        string Groups(int informationClass) => ReadInformation(token.DangerousGetHandle(), informationClass, (buffer, length) =>
        {
            var count = Marshal.ReadInt32(buffer);
            if (count < 0 || count > 4096 || IntPtr.Size + count * IntPtr.Size * 2 > length) throw new IOException("PIPE_TOKEN_SECURITY_INVALID");
            var values = new List<string>();
            for (var index = 0; index < count; index++)
            {
                var row = buffer + IntPtr.Size + index * IntPtr.Size * 2;
                values.Add(SidAt(Marshal.ReadIntPtr(row)) + ":" + Marshal.ReadInt32(row, IntPtr.Size));
            }
            return String.Join(',', values.Order(StringComparer.Ordinal));
        });
        var user = ReadSid(token);
        var integrity = ReadInformation(token.DangerousGetHandle(), 25, (buffer, _) => SidAt(Marshal.ReadIntPtr(buffer)) + ":" + Marshal.ReadInt32(buffer, IntPtr.Size));
        var privileges = ReadInformation(token.DangerousGetHandle(), 3, (buffer, length) =>
        {
            var count = Marshal.ReadInt32(buffer);
            if (count < 0 || count > 4096 || 4 + count * 12 > length) throw new IOException("PIPE_TOKEN_SECURITY_INVALID");
            var bytes = new byte[4 + count * 12];
            Marshal.Copy(buffer, bytes, 0, bytes.Length);
            return Convert.ToHexString(bytes);
        });
        return String.Join('|', user, Groups(2), Groups(11), integrity, privileges);
    }

    private static T ReadInformation<T>(nint token, int informationClass, Func<nint, int, T> parse)
    {
        _ = GetRawTokenInformation(token, informationClass, 0, 0, out var required);
        if (required < 4 || required > 1024 * 1024) throw new IOException("PIPE_TOKEN_INFORMATION_INVALID");
        var buffer = Marshal.AllocHGlobal(checked((int)required));
        try
        {
            if (!GetRawTokenInformation(token, informationClass, buffer, required, out var returned) || returned > required)
                throw new Win32Exception(Marshal.GetLastWin32Error(), "PIPE_TOKEN_INFORMATION_UNAVAILABLE");
            return parse(buffer, checked((int)returned));
        }
        finally { Marshal.FreeHGlobal(buffer); }
    }

    internal static AuthenticatedPipeCaller Capture(NamedPipeServerStream pipe)
    {
        ArgumentNullException.ThrowIfNull(pipe);
        if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException("PIPE_CALLER_WINDOWS_REQUIRED");
        if (!pipe.IsConnected) throw new IOException("PIPE_CLIENT_NOT_CONNECTED");
        if (!ImpersonateNamedPipeClient(pipe.SafePipeHandle)) throw new Win32Exception(Marshal.GetLastWin32Error(), "PIPE_CLIENT_IMPERSONATION_FAILED");

        SafeAccessTokenHandle? primaryToken = null;
        string? sid = null;
        try
        {
            if (!OpenThreadToken(CurrentThread, TokenQuery | TokenDuplicate, true, out var impersonationToken))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "PIPE_CLIENT_TOKEN_UNAVAILABLE");
            using (impersonationToken)
            {
                sid = ReadSid(impersonationToken);
                if (!DuplicateTokenEx(impersonationToken, TokenAssignPrimary | TokenDuplicate | TokenQuery, 0, SecurityImpersonation, TokenPrimary, out primaryToken))
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "PIPE_CLIENT_PRIMARY_TOKEN_UNAVAILABLE");
            }
        }
        finally
        {
            if (!RevertToSelf())
            {
                primaryToken?.Dispose();
                throw new Win32Exception(Marshal.GetLastWin32Error(), "PIPE_CLIENT_REVERT_FAILED");
            }
        }

        if (primaryToken is null || primaryToken.IsInvalid || sid is null)
        {
            primaryToken?.Dispose();
            throw new IOException("PIPE_CLIENT_IDENTITY_INVALID");
        }

        return new AuthenticatedPipeCaller(sid, primaryToken);
    }

    private static string ReadSid(SafeAccessTokenHandle token)
    {
        _ = GetTokenInformation(token, TokenUser, 0, 0, out var required);
        if (required < (uint)IntPtr.Size || required > 65536u) throw new IOException("PIPE_CLIENT_TOKEN_INVALID");
        var buffer = Marshal.AllocHGlobal((int)required);
        try
        {
            if (!GetTokenInformation(token, TokenUser, buffer, required, out _))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "PIPE_CLIENT_SID_UNAVAILABLE");
            var sidPointer = Marshal.ReadIntPtr(buffer);
            if (sidPointer == 0 || !ConvertSidToStringSid(sidPointer, out var textPointer))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "PIPE_CLIENT_SID_UNAVAILABLE");
            try
            {
                var sid = Marshal.PtrToStringUni(textPointer);
                if (sid is null || sid.Length is < 5 or > 184 || !sid.StartsWith("S-1-", StringComparison.Ordinal))
                    throw new IOException("PIPE_CLIENT_SID_INVALID");
                return sid;
            }
            finally { _ = LocalFree(textPointer); }
        }
        finally { Marshal.FreeHGlobal(buffer); }
    }

    public void Dispose() => PrimaryToken.Dispose();
}
