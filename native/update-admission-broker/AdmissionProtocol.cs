using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Lnwjud.UpdateAdmission;

internal sealed class Refusal(string reason) : Exception(reason)
{
    internal string Reason { get; } = reason;
}

internal sealed record AdmissionCommand(string RequestId, string Name, JsonObject Fields);

internal static class AdmissionProtocol
{
    internal const string Domain = "lnwjud-windows-maintenance-v1";
    internal const int FrameBytes = 16_384;
    internal static readonly UTF8Encoding Utf8 = new(false, true);

    internal static JsonObject Object(ReadOnlySpan<byte> bytes, int maximum)
    {
        if (bytes.Length is 0 || bytes.Length > maximum || bytes.StartsWith(new byte[] { 239, 187, 191 })) throw new Refusal("ADMISSION_JSON_INVALID");
        _ = Utf8.GetString(bytes);
        using var doc = JsonDocument.Parse(bytes.ToArray(), new JsonDocumentOptions { MaxDepth = 16 });
        Unique(doc.RootElement);
        return JsonNode.Parse(doc.RootElement.GetRawText()) as JsonObject ?? throw new Refusal("ADMISSION_JSON_INVALID");
    }

    private static void Unique(JsonElement value)
    {
        if (value.ValueKind == JsonValueKind.Object)
        {
            var seen = new HashSet<string>(StringComparer.Ordinal);
            foreach (var field in value.EnumerateObject())
            {
                _ = Utf8.GetBytes(field.Name);
                if (!seen.Add(field.Name)) throw new Refusal("ADMISSION_DUPLICATE_FIELD");
                Unique(field.Value);
            }
        }
        else if (value.ValueKind == JsonValueKind.Array) foreach (var item in value.EnumerateArray()) Unique(item);
        else if (value.ValueKind == JsonValueKind.String) _ = Utf8.GetBytes(value.GetString()!);
    }

    internal static void Fields(JsonObject value, params string[] names)
    {
        if (value.Count != names.Length || names.Any(name => !value.ContainsKey(name))) throw new Refusal("ADMISSION_FIELDS_INVALID");
    }

    internal static string Text(JsonObject value, string name) => value[name] is JsonValue node && node.TryGetValue<string>(out var text)
        ? text : throw new Refusal("ADMISSION_FIELD_INVALID");
    internal static bool Identifier(string text) => text.Length is >= 1 and <= 128 && text.All(c => char.IsAsciiLetterOrDigit(c) || c is '-' or '_' or '.');
    internal static bool Digest(string text) => text.Length == 64 && text.All(c => c is >= 'a' and <= 'f' or >= '0' and <= '9');
    internal static ulong Number(JsonObject value, string name) => Decimal(Text(value, name));
    internal static ulong Decimal(string text)
    {
        if (text.Length is < 1 or > 20 || text.Length > 1 && text[0] == '0' || !text.All(char.IsAsciiDigit)
            || !ulong.TryParse(text, NumberStyles.None, CultureInfo.InvariantCulture, out var result)) throw new Refusal("ADMISSION_POSITION_INVALID");
        return result;
    }
    internal static string Decimal(ulong value) => value.ToString(CultureInfo.InvariantCulture);
    internal static byte[] Encode(JsonObject value) => Utf8.GetBytes(value.ToJsonString());

    internal static AdmissionCommand Decode(ReadOnlySpan<byte> bytes)
    {
        var value = Object(bytes, FrameBytes);
        if (value["protocol"] is not JsonValue version || !version.TryGetValue<int>(out var protocol) || protocol != 1
            || version.ToJsonString() != "1") throw new Refusal("ADMISSION_PROTOCOL_UNSUPPORTED");
        var id = Text(value, "requestId"); var command = Text(value, "command");
        if (!Identifier(id)) throw new Refusal("ADMISSION_REQUEST_ID_INVALID");
        var additional = command switch
        {
            "status" or "register" => Array.Empty<string>(),
            "enter" => ["participantId", "sequence", "kind"],
            "promote" => ["participantId", "sequence", "parentPermitId", "attemptId"],
            "settle" => ["permitId"],
            "quiesce" => ["participantId"],
            "close" or "seal" or "recover_owner" or "reopen" => ["transactionId", "expectedGeneration", "expectedRevision"],
            _ => throw new Refusal("ADMISSION_COMMAND_UNKNOWN"),
        };
        Fields(value, new[] { "protocol", "requestId", "command" }.Concat(additional).ToArray());
        foreach (var field in additional)
        {
            var text = Text(value, field);
            if (field is "expectedGeneration" or "expectedRevision" or "sequence") _ = Decimal(text);
            else if (!Identifier(text)) throw new Refusal("ADMISSION_IDENTIFIER_INVALID");
        }
        if (command == "enter" && Text(value, "kind") is not ("startup" or "call" or "background")) throw new Refusal("ADMISSION_KIND_INVALID");
        return new AdmissionCommand(id, command, value);
    }
}
