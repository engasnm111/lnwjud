namespace Lnwjud.UpdateAdmission;

internal static class Program
{
    private static int Main(string[] args)
    {
        if (OperatingSystem.IsWindows() && args.Length == 1 && args[0] == "service")
            return WindowsUpdateAdmissionService.Run();
        Console.Error.WriteLine("MAINTENANCE_REGISTRY_UNCONFIGURED");
        return 125;
    }
}
