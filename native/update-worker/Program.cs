using System.Runtime.Versioning;
using System.Text.Json.Nodes;

namespace Lnwjud.UpdateWorker;

internal static class Program
{
    private static int Main(string[] args)
    {
        if (!OperatingSystem.IsWindows()) return 125;
        return Run(args);
    }

    [SupportedOSPlatform("windows")]
    private static int Run(string[] args)
    {
        if (args.Length != 5 || args[0] != "--stdio" || args[1] != "--state-root" || args[3] != "--installation-id" || !Wire.Digest(args[4])) return 125;
        UpdateWorkerCore? core = null;
        var failure = "OWNER_UNAVAILABLE";
        try { core = new UpdateWorkerCore(args[2], args[4]); }
        catch (Refusal error) { failure = error.Reason; }
        catch (Exception) { failure = "STATE_ROOT_UNVERIFIED"; }
        using (core)
        using (var input = Console.OpenStandardInput())
        using (var output = Console.OpenStandardOutput())
        {
            var line = new List<byte>();
            var oversized = false;
            var consumed = 0;
            while (true)
            {
                var next = input.ReadByte();
                if (next < 0) return 0;
                if (++consumed > 1_048_576) return 125;
                if (next != 10)
                {
                    if (line.Count < Wire.MaximumLineBytes) line.Add((byte)next); else oversized = true;
                    continue;
                }
                JsonObject reply;
                string? requestId = null;
                try
                {
                    if (oversized) throw new Refusal("REQUEST_TOO_LARGE");
                    var command = Wire.Parse(line.ToArray()); requestId = command.RequestId;
                    reply = core is null ? UpdateWorkerCore.Envelope(args[4], requestId, null, null,
                        new JsonObject { ["kind"] = "held", ["reason"] = failure, ["safeToStart"] = false }) : core.Execute(command);
                }
                catch (Exception error)
                {
                    reply = UpdateWorkerCore.Envelope(args[4], requestId, null, null, new JsonObject
                    { ["kind"] = "error", ["reason"] = error is Refusal refusal ? refusal.Reason : "INVALID_REQUEST" });
                }
                var bytes = Wire.Encode(reply); output.Write(bytes); output.WriteByte(10); output.Flush();
                line.Clear(); oversized = false; consumed = 0;
            }
        }
    }
}
