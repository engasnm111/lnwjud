namespace Lnwjud.UpdateAdmission;

internal static class Program
{
    private static int Main(string[] args)
    {
        if (OperatingSystem.IsWindows() && args.Length == 1 && args[0] == "service")
            return WindowsUpdateAdmissionService.Run();
        if (OperatingSystem.IsWindows() && args.Length == 3 && args[0] == "stage-image")
        {
            try
            {
                WindowsUpdateAdmissionImageStager.StageImage(args[1], args[2]);
                Console.WriteLine("MAINTENANCE_IMAGE_STAGED_NOT_AUTHENTICATED");
                return 0;
            }
            catch (Exception error)
            {
                Console.Error.WriteLine(error is Refusal refusal
                    ? refusal.Reason : "MAINTENANCE_SERVICE_IMAGE_UNVERIFIED");
                return 125;
            }
        }
        if (OperatingSystem.IsWindows() && args.Length == 2 && args[0] == "provision-service")
        {
            try
            {
                WindowsUpdateAdmissionProvisioner.ProvisionService(args[1]);
                Console.WriteLine("MAINTENANCE_SERVICE_PROVISIONED_NOT_ENROLLED");
                return 0;
            }
            catch (Exception error)
            {
                Console.Error.WriteLine(error is Refusal refusal
                    ? refusal.Reason : "MAINTENANCE_SERVICE_PROVISIONING_REFUSED");
                return 125;
            }
        }
        Console.Error.WriteLine("MAINTENANCE_REGISTRY_UNCONFIGURED");
        return 125;
    }
}
