using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using System.IO.Pipes;
using System.Diagnostics;

namespace Lnwjud.Containment;

internal sealed class ContainedProcess : IDisposable
{
#if NATIVE_CONTAINMENT_TESTS
    internal static Action<string, uint>? Fault;
#endif
    private nint job;
    private nint process;
    internal uint ProcessId { get; private set; }
    private const uint CreateSuspended = 4, ExtendedStartup = 0x80000, UnicodeEnvironment = 0x400, CreateNoWindow = 0x08000000;
    [StructLayout(LayoutKind.Sequential)] private struct BasicLimits { public long ProcessTime, JobTime; public uint Flags; public nuint MinimumWorkingSet, MaximumWorkingSet; public uint ActiveProcessLimit; public nuint Affinity; public uint Priority, Scheduling; }
    [StructLayout(LayoutKind.Sequential)] private struct IoCounters { public ulong ReadOperations, WriteOperations, OtherOperations, ReadBytes, WriteBytes, OtherBytes; }
    [StructLayout(LayoutKind.Sequential)] private struct ExtendedLimits { public BasicLimits Basic; public IoCounters Io; public nuint ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory; }
    [StructLayout(LayoutKind.Sequential)] private struct Accounting { public long UserTime, KernelTime, PeriodUserTime, PeriodKernelTime; public uint PageFaults, TotalProcesses, ActiveProcesses, TerminatedProcesses; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] private struct Startup { public uint Size; public nint Reserved, Desktop, Title; public uint X, Y, XSize, YSize, XChars, YChars, Fill, Flags; public ushort Show, ReservedSize; public nint ReservedPointer, Input, Output, Error; }
    [StructLayout(LayoutKind.Sequential)] private struct StartupEx { public Startup Startup; public nint Attributes; }
    [StructLayout(LayoutKind.Sequential)] private struct ProcessInfo { public nint Process, Thread; public uint ProcessId, ThreadId; }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern nint CreateJobObject(nint security, string? name);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern nint OpenJobObject(uint desiredAccess, bool inheritHandle, string name);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool SetInformationJobObject(nint job, int infoClass, ref ExtendedLimits info, uint size);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool QueryInformationJobObject(nint job, int infoClass, out Accounting info, uint size, nint length);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool IsProcessInJob(nint process, nint job, out bool result);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool CreateProcess(string application, StringBuilder command, nint processSecurity, nint threadSecurity, bool inherit, uint flags, nint environment, string cwd, ref StartupEx startup, out ProcessInfo info);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "CreateProcessAsUserW")] private static extern bool CreateProcessAsUser(nint token, string application, StringBuilder command, nint processSecurity, nint threadSecurity, bool inherit, uint flags, nint environment, string cwd, ref StartupEx startup, out ProcessInfo info);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool InitializeProcThreadAttributeList(nint list, int count, int flags, ref nuint size);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool UpdateProcThreadAttribute(nint list, uint flags, nuint attribute, nint value, nuint size, nint previous, nint returnedSize);
    [DllImport("kernel32.dll")] private static extern void DeleteProcThreadAttributeList(nint list);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern uint ResumeThread(nint thread);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool TerminateJobObject(nint job, uint code);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetExitCodeProcess(nint process, out uint code);
    [DllImport("kernel32.dll")] private static extern nint GetStdHandle(int handle);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(nint handle);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool DuplicateHandle(nint sourceProcess, nint source, nint targetProcess, out nint target, uint access, bool inherit, uint options);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern nint CreateFile(string name, uint access, uint share, nint security, uint disposition, uint flags, nint template);

    internal const uint JobObjectQuery = 0x0004;
    internal const uint JobObjectTerminate = 0x0008;

    internal enum JobProbeStatus { NotFound, Active, Empty, Failed }
    internal sealed record JobProbeResult(JobProbeStatus Status, uint ActiveProcesses, int ErrorCode);

    internal static string GetJobName(string attemptId)
    {
        var clean = string.Concat(attemptId.Select(c => char.IsAsciiLetterOrDigit(c) || c == '-' || c == '_' ? c : '_'));
        return @"Local\lnwjud-job-" + clean;
    }

    internal static JobProbeResult QueryJob(string jobName)
    {
        var handle = OpenJobObject(JobObjectQuery | JobObjectTerminate, false, jobName);
        if (handle == 0) handle = OpenJobObject(JobObjectQuery, false, jobName);
        if (handle == 0)
        {
            var error = Marshal.GetLastWin32Error();
            if (error == 2) return new JobProbeResult(JobProbeStatus.NotFound, 0, 0);
            return new JobProbeResult(JobProbeStatus.Failed, 0, error);
        }
        try
        {
            if (QueryInformationJobObject(handle, 1, out var info, (uint)Marshal.SizeOf<Accounting>(), 0))
            {
                return info.ActiveProcesses > 0
                    ? new JobProbeResult(JobProbeStatus.Active, info.ActiveProcesses, 0)
                    : new JobProbeResult(JobProbeStatus.Empty, 0, 0);
            }
            return new JobProbeResult(JobProbeStatus.Failed, 0, Marshal.GetLastWin32Error());
        }
        finally
        {
            CloseHandle(handle);
        }
    }

    internal static bool TerminateJobByName(string jobName, int timeoutMs = 15000)
    {
        var handle = OpenJobObject(JobObjectQuery | JobObjectTerminate, false, jobName);
        if (handle == 0)
        {
            var error = Marshal.GetLastWin32Error();
            return error == 2;
        }
        try
        {
            if (!TerminateJobObject(handle, 1))
            {
                var error = Marshal.GetLastWin32Error();
                if (error != 0 && error != 2)
                {
                    if (QueryInformationJobObject(handle, 1, out var probe, (uint)Marshal.SizeOf<Accounting>(), 0) && probe.ActiveProcesses == 0)
                        return true;
                    return false;
                }
            }
            var sw = Stopwatch.StartNew();
            while (sw.ElapsedMilliseconds < timeoutMs)
            {
                if (QueryInformationJobObject(handle, 1, out var info, (uint)Marshal.SizeOf<Accounting>(), 0))
                {
                    if (info.ActiveProcesses == 0) return true;
                }
                Thread.Sleep(20);
            }
            return false;
        }
        finally
        {
            CloseHandle(handle);
        }
    }

    internal static ContainedProcess Start(string executable, string[] arguments, string cwd, bool verbatim, IReadOnlyDictionary<string, string> environment, nint? standardOutput = null, nint? standardError = null, Func<bool>? cancellationRequested = null, Action<uint>? beforeResume = null, string? jobName = null) =>
        StartCore(0, executable, arguments, cwd, verbatim, environment, standardOutput, standardError, cancellationRequested, beforeResume, jobName);

    internal static ContainedProcess StartAsUser(nint primaryToken, string executable, string[] arguments, string cwd, bool verbatim, IReadOnlyDictionary<string, string> environment, nint? standardOutput = null, nint? standardError = null, Func<bool>? cancellationRequested = null, Action<uint>? beforeResume = null, string? jobName = null)
    {
        if (primaryToken == 0 || primaryToken == -1) throw new IOException("CONTAINMENT_CALLER_TOKEN_INVALID");
        // CreateProcessAsUser uses the original authenticated caller's session.
        _ = AuthenticatedPipeCaller.ReadSessionId(primaryToken);
        return StartCore(primaryToken, executable, arguments, cwd, verbatim, environment, standardOutput, standardError, cancellationRequested, beforeResume, jobName);
    }

    private static ContainedProcess StartCore(nint primaryToken, string executable, string[] arguments, string cwd, bool verbatim, IReadOnlyDictionary<string, string> environment, nint? standardOutput, nint? standardError, Func<bool>? cancellationRequested, Action<uint>? beforeResume, string? jobName)
    {
        if (!Path.IsPathFullyQualified(executable) || !Path.IsPathFullyQualified(cwd)) throw new IOException("CONTAINMENT_ABSOLUTE_PATH_REQUIRED");
        var instance = new ContainedProcess();
        ProcessInfo child = default;
        nint attributes = 0, jobList = 0, handles = 0, input = 0, output = 0, error = 0, environmentBlock = 0;
        bool initialized = false;
        try
        {
            if (cancellationRequested?.Invoke() == true) throw new OperationCanceledException();
            instance.job = CreateJobObject(0, jobName);
            Check(instance.job != 0, "JOB_CREATE");
            var limits = new ExtendedLimits(); limits.Basic.Flags = 0x2000; // KILL_ON_JOB_CLOSE; no breakaway.
            Check(SetInformationJobObject(instance.job, 9, ref limits, (uint)Marshal.SizeOf<ExtendedLimits>()), "JOB_LIMITS");
            var command = new StringBuilder(Quote(executable));
            foreach (var argument in arguments)
            {
                if (argument.Contains('\0')) throw new IOException("CONTAINMENT_INVALID_ARGUMENT");
                command.Append(' ').Append(verbatim ? argument : Quote(argument));
            }
            if (command.Length >= 32767) throw new IOException("CONTAINMENT_COMMAND_TOO_LONG");
            var nullInput = CreateFile("NUL", 0x80000000, 3, 0, 3, 0, 0);
            Check(nullInput != -1, "NULL_INPUT");
            try { input = Inherit(nullInput); } finally { CloseHandle(nullInput); }
            output = Inherit(standardOutput ?? GetStdHandle(-11)); error = Inherit(standardError ?? GetStdHandle(-12));
            nuint size = 0;
            InitializeProcThreadAttributeList(0, 2, 0, ref size);
            Check(size > 0, "ATTRIBUTE_SIZE");
            attributes = Marshal.AllocHGlobal((nint)size);
            Check(InitializeProcThreadAttributeList(attributes, 2, 0, ref size), "ATTRIBUTE_INIT"); initialized = true;
            jobList = Marshal.AllocHGlobal(nint.Size); Marshal.WriteIntPtr(jobList, instance.job);
            Check(UpdateProcThreadAttribute(attributes, 0, 0x2000D, jobList, (nuint)nint.Size, 0, 0), "JOB_LIST");
            handles = Marshal.AllocHGlobal(nint.Size * 3);
            Marshal.WriteIntPtr(handles, 0, input); Marshal.WriteIntPtr(handles, nint.Size, output); Marshal.WriteIntPtr(handles, nint.Size * 2, error);
            Check(UpdateProcThreadAttribute(attributes, 0, 0x20002, handles, (nuint)(nint.Size * 3), 0, 0), "HANDLE_LIST");
            // Service-side CLI workers are headless and retain the authenticated
            // caller token's session. Never force the interactive WinSta0 desktop:
            // an unprivileged token may lack access to that desktop.
            var startup = new StartupEx { Startup = new Startup { Size = (uint)Marshal.SizeOf<StartupEx>(), Flags = 0x100, Input = input, Output = output, Error = error, Desktop = 0 }, Attributes = attributes };
            var environmentText = string.Join('\0', environment.OrderBy(pair => pair.Key, StringComparer.OrdinalIgnoreCase).Select(pair => pair.Key + "=" + pair.Value)) + "\0\0";
            environmentBlock = Marshal.StringToHGlobalUni(environmentText);
            var created = primaryToken == 0
                ? CreateProcess(executable, command, 0, 0, true, CreateSuspended | ExtendedStartup | UnicodeEnvironment | CreateNoWindow, environmentBlock, cwd, ref startup, out child)
                : CreateProcessAsUser(primaryToken, executable, command, 0, 0, true, CreateSuspended | ExtendedStartup | UnicodeEnvironment | CreateNoWindow, environmentBlock, cwd, ref startup, out child);
            Check(created, "CREATE_PROCESS");
#if NATIVE_CONTAINMENT_TESTS
            Fault?.Invoke("after_create_before_membership", child.ProcessId);
#endif
            instance.process = child.Process; instance.ProcessId = child.ProcessId;
            Check(IsProcessInJob(child.Process, instance.job, out var contained) && contained, "JOB_MEMBERSHIP");
#if NATIVE_CONTAINMENT_TESTS
            Fault?.Invoke("before_resume", child.ProcessId);
#endif
            if (cancellationRequested?.Invoke() == true)
            {
                instance.Cancel();
                var cancellationWait = Stopwatch.StartNew();
                while (instance.ActiveProcesses != 0)
                {
                    if (cancellationWait.ElapsedMilliseconds > 10000) throw new IOException("CONTAINMENT_PRE_RESUME_TERMINATION_UNKNOWN");
                    Thread.Sleep(10);
                }
                throw new OperationCanceledException();
            }
            beforeResume?.Invoke(child.ProcessId);
            Check(ResumeThread(child.Thread) == 1, "RESUME");
            return instance;
        }
        catch { instance.Dispose(); throw; }
        finally
        {
            if (child.Thread != 0) CloseHandle(child.Thread);
            foreach (var handle in new[] { input, output, error }) if (handle != 0) CloseHandle(handle);
            if (initialized) DeleteProcThreadAttributeList(attributes);
            foreach (var allocation in new[] { attributes, jobList, handles, environmentBlock }) if (allocation != 0) Marshal.FreeHGlobal(allocation);
        }
    }
    internal uint ActiveProcesses { get { Check(QueryInformationJobObject(job, 1, out var info, (uint)Marshal.SizeOf<Accounting>(), 0), "JOB_QUERY"); return info.ActiveProcesses; } }
    internal int ExitCode { get { Check(GetExitCodeProcess(process, out var code), "EXIT_CODE"); return unchecked((int)code); } }
    internal void Cancel()
    {
#if NATIVE_CONTAINMENT_TESTS
        Fault?.Invoke("before_cancel", ProcessId);
#endif
        Check(TerminateJobObject(job, 1), "JOB_TERMINATE");
    }
    internal static string Capture(string executable, string[] args, string cwd, IReadOnlyDictionary<string, string> environment, int timeoutMs, int maximumBytes)
    {
        using var output = new AnonymousPipeServerStream(PipeDirection.In, HandleInheritability.None);
        using var error = new AnonymousPipeServerStream(PipeDirection.In, HandleInheritability.None);
        using var child = Start(executable, args, cwd, false, environment, output.ClientSafePipeHandle.DangerousGetHandle(), error.ClientSafePipeHandle.DangerousGetHandle());
        output.DisposeLocalCopyOfClientHandle(); error.DisposeLocalCopyOfClientHandle();
        var stdout = Task.Run(() => ReadBounded(output, maximumBytes));
        var stderr = Task.Run(() => ReadBounded(error, maximumBytes));
        var stopwatch = Stopwatch.StartNew();
        while (child.ActiveProcesses != 0)
        {
            if (stopwatch.ElapsedMilliseconds >= timeoutMs || stdout.IsFaulted || stderr.IsFaulted) { child.Cancel(); throw new IOException("CONTAINMENT_CAPTURE_LIMIT"); }
            Thread.Sleep(10);
        }
        if (!Task.WaitAll([stdout, stderr], 5000)) throw new IOException("CONTAINMENT_CAPTURE_STDIO_UNDRAINED");
        if (child.ExitCode != 0)
        {
#if NATIVE_CONTAINMENT_TESTS
            // Test fixture git stderr is bounded and contains no user credentials;
            // production errors must never echo potentially secret child output.
            var details = Encoding.UTF8.GetString(stderr.GetAwaiter().GetResult());
            throw new IOException("CONTAINMENT_CAPTURE_EXIT_" + child.ExitCode + "_" + details[..Math.Min(512, details.Length)]);
#else
            throw new IOException("CONTAINMENT_CAPTURE_EXIT_" + child.ExitCode);
#endif
        }
        return new UTF8Encoding(false, true).GetString(stdout.GetAwaiter().GetResult());
    }
    private static byte[] ReadBounded(Stream stream, int maximumBytes)
    {
        using var result = new MemoryStream(); var buffer = new byte[8192];
        while (true) { var count = stream.Read(buffer); if (count == 0) return result.ToArray(); if (result.Length + count > maximumBytes) throw new IOException("CONTAINMENT_CAPTURE_LIMIT"); result.Write(buffer, 0, count); }
    }
    public void Dispose() { if (job != 0) { CloseHandle(job); job = 0; } if (process != 0) { CloseHandle(process); process = 0; } }
    private static nint Inherit(nint source) { Check(source != 0 && source != -1, "STANDARD_HANDLE"); Check(DuplicateHandle(-1, source, -1, out var result, 0, true, 2), "HANDLE_DUPLICATE"); return result; }
    private static void Check(bool ok, string code) { if (!ok) throw new IOException("CONTAINMENT_" + code + "_" + Marshal.GetLastWin32Error()); }
    private static string Quote(string value)
    {
        var result = new StringBuilder("\""); var slashes = 0;
        foreach (var character in value)
        {
            if (character == '\\') { slashes++; continue; }
            if (character == '"') { result.Append('\\', slashes * 2 + 1).Append('"'); slashes = 0; continue; }
            result.Append('\\', slashes).Append(character); slashes = 0;
        }
        return result.Append('\\', slashes * 2).Append('"').ToString();
    }
}
