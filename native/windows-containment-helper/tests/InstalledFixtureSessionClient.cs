using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Security.Principal;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace Lnwjud.Containment;

[SupportedOSPlatform("windows")]
internal static class InstalledFixtureSessionClient
{
    internal sealed class NormalParentSource : IDisposable
    {
        private readonly SafeProcessHandle parent;
        private readonly SafeAccessTokenHandle token;
        private readonly string sid;
        private readonly int session;
        private readonly long ticks;
        private readonly string image;

        private NormalParentSource(SafeProcessHandle parent, SafeAccessTokenHandle token, string sid, int session, long ticks, string image)
        { this.parent = parent; this.token = token; this.sid = sid; this.session = session; this.ticks = ticks; this.image = image; }

        internal static NormalParentSource Open(int pid, long ticks, string image, string sid, int session)
        {
            var parent = OpenProcess(0x101000, false, pid);
            if (parent.IsInvalid) { var error = Marshal.GetLastWin32Error(); parent.Dispose(); throw new Win32Exception(error, "NORMAL_PARENT_OPEN"); }
            SafeAccessTokenHandle? token = null;
            try
            {
                VerifyProcess(parent, ticks, image);
                Native(OpenProcessToken(parent.DangerousGetHandle(), 0xB, out token), "NORMAL_PARENT_TOKEN");
                Validate(token, sid, session);
                return new NormalParentSource(parent, token, sid, session, ticks, image);
            }
            catch { token?.Dispose(); parent.Dispose(); throw; }
        }

        internal void VerifyPipeServer(SafePipeHandle pipe)
        {
            Native(GetNamedPipeServerProcessId(pipe, out var pid), "NORMAL_PARENT_PIPE_PID");
            Require(pid == GetProcessId(parent), "NORMAL_PARENT_PIPE_MISMATCH");
            VerifyProcess(parent, ticks, image);
            Validate(token, sid, session);
        }

        internal SafeAccessTokenHandle CreateLaunchToken(string expectedSid, int expectedSession)
        {
            Require(expectedSid == sid && expectedSession == session, "NORMAL_PARENT_SCOPE");
            VerifyProcess(parent, ticks, image);
            Validate(token, sid, session);
            var launch = AuthenticatedPipeCaller.CreateLaunchToken(token);
            try { Validate(launch, sid, session); return launch; }
            catch { launch.Dispose(); throw; }
        }

        public void Dispose() { token.Dispose(); parent.Dispose(); }
    }

    internal sealed class OwnedClientJob : IDisposable
    {
        private readonly nint job;
        private readonly string name;
        private ContainedProcess? client;
        private SafeProcessHandle? child;
        private long ticks;
        private bool terminal;

        internal int Id { get; private set; }
        internal long StartTicks => ticks;

        internal OwnedClientJob()
        {
            name = @"Local\lnwjud-fixture-client-" + Guid.NewGuid().ToString("N");
            job = CreateJobObject(0, name);
            Native(job != 0, "CLIENT_JOB_CREATE");
            if (Marshal.GetLastWin32Error() == 183) { CloseHandle(job); throw new IOException("CLIENT_JOB_ALREADY_EXISTS"); }
        }

        internal void Start(NormalParentSource source, string image, string scenario, string action, string sid, int session, Action<int, long> beforeResume)
        {
            Require(action is "launch" or "recover" or "observe" or "noop" or "hold", "CLIENT_ACTION");
            Require(Path.IsPathFullyQualified(image) && Path.IsPathFullyQualified(scenario), "CLIENT_PATH");
            using var token = source.CreateLaunchToken(sid, session);
            using var nul = new SafeFileHandle(CreateFile("NUL", 0x40000000, 3, 0, 3, 0, 0), true);
            Require(!nul.IsInvalid, "CLIENT_NUL_OUTPUT");
            try
            {
                client = ContainedProcess.StartAsUser(token.DangerousGetHandle(), image,
                    action == "noop" ? ["noop"] : action == "hold" ? ["installed-client-boundary-hold"] : ["installed-updater-client", scenario, action],
                    Path.GetDirectoryName(image)!, false,
                    new Dictionary<string, string> { ["SystemRoot"] = Environment.GetFolderPath(Environment.SpecialFolder.Windows) },
                    standardOutput: nul.DangerousGetHandle(), standardError: nul.DangerousGetHandle(), jobName: name,
                    beforeResume: pid =>
                    {
                        child = OpenProcess(0x101000, false, checked((int)pid));
                        Require(!child.IsInvalid, "CLIENT_PROCESS_HANDLE");
                        Native(IsProcessInJob(child, job, out var member), "CLIENT_JOB_MEMBERSHIP_QUERY");
                        Require(member, "CLIENT_JOB_MEMBERSHIP");
                        Native(GetProcessTimes(child, out var created, out _, out _, out _), "CLIENT_CREATION");
                        ticks = DateTime.FromFileTimeUtc(created).Ticks;
                        Id = checked((int)pid);
                        VerifyProcess(child, ticks, image, requireLive: false);
                        Native(OpenProcessToken(child.DangerousGetHandle(), 8, out var actual), "CLIENT_TOKEN");
                        using (actual) Validate(actual, sid, session);
                        beforeResume(Id, ticks);
                    });
            }
            catch { TerminateAndProveZero(); throw; }
        }

        internal int WaitForExit(Func<bool>? cancelled = null)
        {
            if (client == null || child == null) throw new IOException("CLIENT_MISSING");
            var watch = Stopwatch.StartNew();
            while (Active() != 0)
            {
                if (cancelled?.Invoke() == true) { TerminateAndProveZero(); throw new IOException("CLIENT_PEER_DISCONNECTED"); }
                if (watch.ElapsedMilliseconds > 40_000) { TerminateAndProveZero(); throw new IOException("CLIENT_TIMEOUT"); }
                Thread.Sleep(20);
            }
            Require(WaitForSingleObject(child, 10_000) == 0, "CLIENT_ROOT_STILL_ACTIVE");
            terminal = true;
            return client.ExitCode;
        }

        internal void TerminateAndProveZero()
        {
            if (job == 0) throw new IOException("CLIENT_JOB_UNAVAILABLE");
            if (Active() != 0) Native(TerminateJobObject(job, 92), "CLIENT_JOB_TERMINATE");
            var watch = Stopwatch.StartNew();
            while (Active() != 0)
            {
                if (watch.ElapsedMilliseconds > 10_000) throw new IOException("CLIENT_JOB_ZERO_UNPROVEN");
                Thread.Sleep(20);
            }
            if (child != null) Require(WaitForSingleObject(child, 10_000) == 0, "CLIENT_CESSATION_UNPROVEN");
            terminal = true;
        }

        private uint Active()
        {
            Native(QueryInformationJobObject(job, 1, out var info, (uint)Marshal.SizeOf<Accounting>(), 0), "CLIENT_JOB_QUERY");
            return info.ActiveProcesses;
        }

        public void Dispose()
        {
            try { if (!terminal) TerminateAndProveZero(); }
            finally { child?.Dispose(); client?.Dispose(); CloseHandle(job); }
        }
    }

    internal static bool VerifyNormalParentSource()
    {
        using var process = Process.GetCurrentProcess();
        using var identity = WindowsIdentity.GetCurrent();
        var sid = identity.User!.Value;
        var session = process.SessionId;
        var ticks = process.StartTime.ToUniversalTime().Ticks;
        var image = Environment.ProcessPath!;
        using var source = NormalParentSource.Open(process.Id, ticks, image, sid, session);
        using var launch = source.CreateLaunchToken(sid, session);
        foreach (var refusal in new Action[]
        {
            () => { using var invalid = NormalParentSource.Open(process.Id, ticks + 1, image, sid, session); },
            () => { using var invalid = NormalParentSource.Open(process.Id, ticks, image + ".different", sid, session); },
            () => { using var invalid = NormalParentSource.Open(process.Id, ticks, image, "S-1-5-18", session); },
            () => { using var invalid = NormalParentSource.Open(process.Id, ticks, image, sid, session + 1); },
            () => { using var invalid = source.CreateLaunchToken("S-1-5-18", session); },
            () => { using var invalid = source.CreateLaunchToken(sid, session + 1); },
        })
        {
            try { refusal(); }
            catch (IOException) { continue; }
            throw new IOException("NORMAL_PARENT_INVALID_SOURCE_ACCEPTED");
        }
        return true;
    }

    internal static void ValidateCurrent(string sid, int session)
    {
        using var current = Process.GetCurrentProcess();
        Native(OpenProcessToken(current.Handle, 8, out var token), "CURRENT_TOKEN");
        using (token) Validate(token, sid, session);
    }

    internal static void VerifyProcess(SafeProcessHandle process, long ticks, string image, bool requireLive = true)
    {
        Native(GetProcessTimes(process, out var created, out _, out _, out _), "PROCESS_CREATION");
        var name = new StringBuilder(32768); uint length = 32768;
        Native(QueryFullProcessImageName(process, 0, name, ref length), "PROCESS_IMAGE");
        Require(DateTime.FromFileTimeUtc(created).Ticks == ticks
            && string.Equals(Path.GetFullPath(name.ToString()), Path.GetFullPath(image), StringComparison.OrdinalIgnoreCase)
            && (!requireLive || WaitForSingleObject(process, 0) == 258), "PROCESS_IDENTITY_REQUIRED");
    }

    internal static void Validate(SafeAccessTokenHandle token, string sid, int session)
    {
        using var identity = new WindowsIdentity(token.DangerousGetHandle());
        var actualSession = Integer(token, 12); var tokenType = Integer(token, 8);
        var elevationType = Integer(token, 18); var elevated = Integer(token, 20); var integrity = Integrity(token);
        Require(identity.User?.Value == sid && actualSession == session && tokenType == 1
            && elevationType == 3 && elevated == 0 && integrity == 8192,
            $"LIMITED_TOKEN_REQUIRED_session={actualSession}_type={tokenType}_elevationType={elevationType}_elevated={elevated}_integrity={integrity}");
    }

    internal static int Integrity(SafeAccessTokenHandle token)
    {
        var buffer = Marshal.AllocHGlobal(512);
        try
        {
            Native(GetTokenBuffer(token, 25, buffer, 512, out var size), "TOKEN_INTEGRITY");
            Require(size >= nint.Size && size <= 512, "TOKEN_INTEGRITY_SIZE");
            return int.Parse(new SecurityIdentifier(Marshal.ReadIntPtr(buffer)).Value.Split('-')[^1], System.Globalization.CultureInfo.InvariantCulture);
        }
        finally { Marshal.FreeHGlobal(buffer); }
    }

    internal static int Integer(SafeAccessTokenHandle token, int kind)
    {
        Native(GetTokenInformation(token, kind, out var value, sizeof(int), out var size), "TOKEN_INFORMATION_" + kind);
        Require(size == sizeof(int), "TOKEN_INFORMATION_SIZE");
        return value;
    }

    private static void Native(bool result, string operation) { if (!result) throw new Win32Exception(Marshal.GetLastWin32Error(), "INSTALLED_FIXTURE_" + operation); }
    private static void Require(bool result, string operation) { if (!result) throw new IOException("INSTALLED_FIXTURE_" + operation); }
    [StructLayout(LayoutKind.Sequential)] private struct Accounting { public long UserTime, KernelTime, PeriodUserTime, PeriodKernelTime; public uint PageFaults, TotalProcesses, ActiveProcesses, TerminatedProcesses; }
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool OpenProcessToken(nint process, uint access, out SafeAccessTokenHandle token);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool GetTokenInformation(SafeAccessTokenHandle token, int kind, out int value, int size, out int returned);
    [DllImport("advapi32.dll", EntryPoint = "GetTokenInformation", SetLastError = true)] private static extern bool GetTokenBuffer(SafeAccessTokenHandle token, int kind, nint value, int size, out int returned);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern SafeProcessHandle OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetProcessTimes(SafeProcessHandle process, out long created, out long exited, out long kernel, out long user);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool QueryFullProcessImageName(SafeProcessHandle process, uint flags, StringBuilder name, ref uint size);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern uint WaitForSingleObject(SafeProcessHandle process, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern uint GetProcessId(SafeProcessHandle process);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetNamedPipeServerProcessId(SafePipeHandle pipe, out uint pid);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern nint CreateJobObject(nint security, string name);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool QueryInformationJobObject(nint job, int infoClass, out Accounting info, uint size, nint length);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool IsProcessInJob(SafeProcessHandle process, nint job, out bool result);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool TerminateJobObject(nint job, uint code);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool CloseHandle(nint handle);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern nint CreateFile(string name, uint access, uint share, nint security, uint disposition, uint flags, nint template);
}
