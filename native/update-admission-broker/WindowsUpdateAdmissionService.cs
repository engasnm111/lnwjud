using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;

namespace Lnwjud.UpdateAdmission;

// This is an SCM-only bootstrap, not an admission endpoint. It deliberately
// never reports SERVICE_RUNNING until authenticated peer admission exists.
[SupportedOSPlatform("windows")]
internal static class WindowsUpdateAdmissionService
{
    internal const string ServiceName = "LnwjudUpdateAdmission";
    private const uint ServiceWin32OwnProcess = 0x10;
    private const uint ServiceStopped = 1;
    private const uint ServiceStartPending = 2;
    private const uint ErrorServiceSpecificError = 1066;
    private const uint Unavailable = 125;
    private static readonly ServiceMainCallback MainCallback = ServiceMain;
    private static readonly HandlerCallback ControlCallback = HandleControl;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct ServiceTableEntry
    {
        [MarshalAs(UnmanagedType.LPWStr)] internal string? Name;
        [MarshalAs(UnmanagedType.FunctionPtr)] internal ServiceMainCallback? Callback;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ServiceStatus
    {
        internal uint ServiceType;
        internal uint CurrentState;
        internal uint ControlsAccepted;
        internal uint Win32ExitCode;
        internal uint ServiceSpecificExitCode;
        internal uint CheckPoint;
        internal uint WaitHint;
    }

    [UnmanagedFunctionPointer(CallingConvention.Winapi)]
    private delegate void ServiceMainCallback(uint argumentCount, nint arguments);
    [UnmanagedFunctionPointer(CallingConvention.Winapi)]
    private delegate uint HandlerCallback(uint control, uint eventType, nint eventData, nint context);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "StartServiceCtrlDispatcherW")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool StartServiceCtrlDispatcher([In] ServiceTableEntry[] table);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "RegisterServiceCtrlHandlerExW")]
    private static extern nint RegisterServiceCtrlHandlerEx(string serviceName, HandlerCallback callback, nint context);

    [DllImport("advapi32.dll", SetLastError = true, EntryPoint = "SetServiceStatus")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetServiceStatus(nint handle, ref ServiceStatus status);

    internal static int Run()
    {
        if (!OperatingSystem.IsWindows()) return (int)Unavailable;
        var table = new[]
        {
            new ServiceTableEntry { Name = ServiceName, Callback = MainCallback },
            new ServiceTableEntry { Name = null, Callback = null },
        };
        // A console process cannot impersonate the SCM service dispatcher.
        // Even a real SCM dispatch remains unavailable until peer auth exists.
        try { _ = StartServiceCtrlDispatcher(table); }
        catch (Win32Exception) { }
        return (int)Unavailable;
    }

    private static void ServiceMain(uint argumentCount, nint arguments)
    {
        _ = argumentCount;
        _ = arguments;
        nint handle = 0;
        try
        {
            handle = RegisterServiceCtrlHandlerEx(ServiceName, ControlCallback, 0);
            if (handle == 0) return;
            Report(handle, ServiceStartPending, 0, 0, 30_000);
            // The service token must be LocalService with this exact enabled
            // service SID; journal ownership is not inferred from a PID or name.
            var identity = StoreIdentity.Installed();
            AdmissionCore.RecoverPublication(identity);
            using var core = new AdmissionCore(identity);
            _ = core.Status();
            // No principal factory, pipe listener or installation authority is
            // available. A validated journal is not permission to start work.
        }
        catch
        {
            // Every failed identity, ACL or journal check remains unavailable.
            // Never surface a ready service or convert failure into enrollment.
        }
        finally
        {
            if (handle != 0) Report(handle, ServiceStopped, ErrorServiceSpecificError, Unavailable, 0);
        }
    }

    private static uint HandleControl(uint control, uint eventType, nint eventData, nint context)
    {
        _ = control;
        _ = eventType;
        _ = eventData;
        _ = context;
        // No running service or admitted operation exists to stop.
        return 0;
    }

    private static void Report(nint handle, uint state, uint win32Error, uint specificError, uint waitHint)
    {
        var status = new ServiceStatus
        {
            ServiceType = ServiceWin32OwnProcess,
            CurrentState = state,
            ControlsAccepted = 0,
            Win32ExitCode = win32Error,
            ServiceSpecificExitCode = specificError,
            CheckPoint = state == ServiceStartPending ? 1u : 0u,
            WaitHint = waitHint,
        };
        _ = SetServiceStatus(handle, ref status);
    }
}
