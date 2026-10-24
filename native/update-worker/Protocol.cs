using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Lnwjud.UpdateWorker;

internal sealed class Refusal(string reason) : Exception(reason)
{
    internal string Reason { get; } = reason;
}

internal sealed record Command(string RequestId, string Name, string? ReleaseId = null,
    int PolicyRevision = 0, ulong ExpectedGeneration = 0, ulong ExpectedRevision = 0);

internal static class Wire
{
    internal const int MaximumLineBytes = 65_536;
    internal const string BuildId = "lnwjud-update-worker-bootstrap-v1";
    internal static readonly UTF8Encoding Utf8 = new(false, true);

    internal static JsonObject Object(byte[] bytes)
    {
        using var document = JsonDocument.Parse(bytes, new JsonDocumentOptions { MaxDepth = 24 });
        ValidateUnique(document.RootElement);
        if (document.RootElement.ValueKind != JsonValueKind.Object) throw new Refusal("INVALID_OBJECT");
        return JsonNode.Parse(document.RootElement.GetRawText())?.AsObject() ?? throw new Refusal("INVALID_OBJECT");
    }

    private static void ValidateUnique(JsonElement element)
    {
        if (element.ValueKind == JsonValueKind.Object)
        {
            var names = new HashSet<string>(StringComparer.Ordinal);
            foreach (var property in element.EnumerateObject())
            {
                if (!names.Add(property.Name)) throw new Refusal("DUPLICATE_FIELD");
                ValidateUnique(property.Value);
            }
        }
        else if (element.ValueKind == JsonValueKind.Array)
            foreach (var item in element.EnumerateArray()) ValidateUnique(item);
    }

    internal static void Fields(JsonObject value, params string[] allowed)
    {
        var names = new HashSet<string>(allowed, StringComparer.Ordinal);
        if (value.Any(property => !names.Contains(property.Key))) throw new Refusal("UNKNOWN_FIELD");
        if (allowed.Any(name => !value.ContainsKey(name))) throw new Refusal("MISSING_FIELD");
    }

    internal static string Text(JsonObject value, string field)
    {
        if (value[field] is not JsonValue node || !node.TryGetValue<string>(out var text)) throw new Refusal("INVALID_FIELD");
        return text;
    }

    internal static int Integer(JsonObject value, string field)
    {
        if (value[field] is not JsonValue node || !node.TryGetValue<int>(out var number)) throw new Refusal("INVALID_FIELD");
        return number;
    }

    internal static bool Identifier(string value, int maximum = 128) => value.Length is >= 1 && value.Length <= maximum
        && value.All(c => c is >= 'A' and <= 'Z' or >= 'a' and <= 'z' or >= '0' and <= '9' or '.' or '_' or '-');

    internal static bool Digest(string value) => value.Length == 64 && value.All(c => c is >= '0' and <= '9' or >= 'a' and <= 'f');

    internal static ulong Decimal(string value)
    {
        if (value.Length is < 1 or > 20 || (value.Length > 1 && value[0] == '0')
            || !value.All(c => c is >= '0' and <= '9')
            || !ulong.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out var number)) throw new Refusal("INVALID_POSITION");
        return number;
    }

    internal static string Decimal(ulong value) => value.ToString(CultureInfo.InvariantCulture);

    internal static Command Parse(byte[] bytes)
    {
        if (bytes.Length > MaximumLineBytes) throw new Refusal("REQUEST_TOO_LARGE");
        _ = Utf8.GetString(bytes);
        var value = Object(bytes);
        if (Integer(value, "protocol") != 1) throw new Refusal("UNSUPPORTED_PROTOCOL");
        var id = Text(value, "requestId");
        var command = Text(value, "command");
        if (!Identifier(id)) throw new Refusal("INVALID_REQUEST_ID");
        if (command is "capabilities" or "recover" or "status")
        {
            Fields(value, "protocol", "requestId", "command");
            return new Command(id, command);
        }
        if (command != "request") throw new Refusal("UNKNOWN_COMMAND");
        Fields(value, "protocol", "requestId", "command", "releaseId", "policyRevision", "expectedGeneration", "expectedRevision");
        var release = Text(value, "releaseId");
        var policy = Integer(value, "policyRevision");
        if (!Identifier(release) || policy < 1) throw new Refusal("INVALID_REQUEST");
        return new Command(id, command, release, policy,
            Decimal(Text(value, "expectedGeneration")), Decimal(Text(value, "expectedRevision")));
    }

    internal static byte[] Encode(JsonObject value) => Utf8.GetBytes(value.ToJsonString());
}
