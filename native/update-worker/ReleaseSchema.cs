using System.Reflection;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Lnwjud.UpdateWorker;

internal static class ReleaseJson
{
    internal static JsonDocument Parse(ReadOnlySpan<byte> bytes, int maximum, int depth = 12)
    {
        if (bytes.Length == 0 || bytes.Length > maximum || bytes.StartsWith(new byte[] { 239, 187, 191 })) throw new Refusal("RELEASE_JSON_INVALID");
        _ = Wire.Utf8.GetString(bytes);
        var document = JsonDocument.Parse(bytes.ToArray(), new JsonDocumentOptions { MaxDepth = depth });
        try { Validate(document.RootElement); return document; }
        catch { document.Dispose(); throw; }
    }

    private static void Validate(JsonElement value)
    {
        if (value.ValueKind == JsonValueKind.Object)
        {
            var names = new HashSet<string>(StringComparer.Ordinal);
            foreach (var property in value.EnumerateObject())
            {
                _ = Wire.Utf8.GetBytes(property.Name);
                if (!names.Add(property.Name)) throw new Refusal("RELEASE_DUPLICATE_FIELD");
                Validate(property.Value);
            }
        }
        else if (value.ValueKind == JsonValueKind.Array)
            foreach (var item in value.EnumerateArray()) Validate(item);
        else if (value.ValueKind == JsonValueKind.String) _ = Wire.Utf8.GetBytes(value.GetString()!);
    }

    internal static byte[] Resource(string name)
    {
        using var resource = Assembly.GetExecutingAssembly().GetManifestResourceStream("Lnwjud.UpdateWorker." + name)
            ?? throw new Refusal("RELEASE_SCHEMA_UNAVAILABLE");
        if (resource.Length > 65_536) throw new Refusal("RELEASE_SCHEMA_INVALID");
        using var memory = new MemoryStream(); resource.CopyTo(memory); return memory.ToArray();
    }
}

internal sealed class ReleaseSchema
{
    private readonly JsonElement schema;
    internal ReleaseSchema(byte[] bytes)
    {
        using var document = ReleaseJson.Parse(bytes, 65_536);
        schema = document.RootElement.Clone();
        if (schema.GetProperty("protocol").GetInt32() != 1) throw new Refusal("RELEASE_SCHEMA_UNSUPPORTED");
    }
    internal static ReleaseSchema Embedded() => new(ReleaseJson.Resource("update-release-schema.json"));
    internal int EnvelopeBytes => schema.GetProperty("limits").GetProperty("envelopeBytes").GetInt32();
    internal int PayloadBytes => schema.GetProperty("limits").GetProperty("payloadBytes").GetInt32();
    internal int Depth => schema.GetProperty("limits").GetProperty("maxDepth").GetInt32();
    internal void Validate(string name, JsonElement value)
    {
        if (value.ValueKind != JsonValueKind.Object) throw new Refusal("RELEASE_SCHEMA_INVALID");
        var fields = schema.GetProperty("objects").GetProperty(name).GetProperty("fields");
        if (value.EnumerateObject().Count() != fields.EnumerateObject().Count()) throw new Refusal("RELEASE_SCHEMA_INVALID");
        foreach (var property in value.EnumerateObject())
        {
            if (!fields.TryGetProperty(property.Name, out var descriptor)) throw new Refusal("RELEASE_SCHEMA_INVALID");
            ValidateValue(descriptor, property.Value);
        }
    }
    private void ValidateValue(JsonElement descriptor, JsonElement value)
    {
        var kind = descriptor.GetProperty("kind").GetString();
        if (kind == "object") { Validate(descriptor.GetProperty("object").GetString()!, value); return; }
        if (kind == "integer")
        {
            if (value.ValueKind != JsonValueKind.Number || !Regex.IsMatch(value.GetRawText(), "\\A[0-9]+\\z", RegexOptions.CultureInvariant)
                || !value.TryGetInt32(out var number)) throw new Refusal("RELEASE_SCHEMA_INVALID");
            if (descriptor.TryGetProperty("constant", out var constant) && number != constant.GetInt32()
                || descriptor.TryGetProperty("min", out var minimum) && number < minimum.GetInt32()
                || descriptor.TryGetProperty("max", out var maximum) && number > maximum.GetInt32()) throw new Refusal("RELEASE_SCHEMA_INVALID");
            return;
        }
        if (kind != "string" || value.ValueKind != JsonValueKind.String) throw new Refusal("RELEASE_SCHEMA_INVALID");
        var text = value.GetString()!;
        if (text.Any(c => c > 127) || descriptor.TryGetProperty("maxLength", out var length) && text.Length > length.GetInt32()) throw new Refusal("RELEASE_SCHEMA_INVALID");
        if (descriptor.TryGetProperty("constant", out var expected) && text != expected.GetString()) throw new Refusal("RELEASE_SCHEMA_INVALID");
        if (descriptor.TryGetProperty("pattern", out var pattern))
        {
            var match = Regex.Match(text, pattern.GetString()!, RegexOptions.CultureInvariant, TimeSpan.FromMilliseconds(100));
            if (!match.Success || match.Index != 0 || match.Length != text.Length) throw new Refusal("RELEASE_SCHEMA_INVALID");
        }
        if (descriptor.TryGetProperty("format", out var format))
        {
            switch (format.GetString())
            {
                case "uint64": _ = Wire.Decimal(text); break;
                case "positive-uint64": if (Wire.Decimal(text) == 0) throw new Refusal("RELEASE_SCHEMA_INVALID"); break;
                case "unix-seconds": if (Wire.Decimal(text) > 253402300799) throw new Refusal("RELEASE_SCHEMA_INVALID"); break;
                case "base64": _ = ReleaseValues.Base64(text); break;
                case "semver": _ = StableVersion.Parse(text); break;
                case "sha256": if (!Wire.Digest(text)) throw new Refusal("RELEASE_SCHEMA_INVALID"); break;
                case "sha1": if (text.Length != 40 || !text.All(c => c is >= '0' and <= '9' or >= 'a' and <= 'f')) throw new Refusal("RELEASE_SCHEMA_INVALID"); break;
                default: throw new Refusal("RELEASE_SCHEMA_UNSUPPORTED");
            }
        }
    }
}

internal readonly record struct StableVersion(int Major, int Minor, int Patch) : IComparable<StableVersion>
{
    internal static StableVersion Parse(string value)
    {
        var components = value.Split('.');
        if (components.Length != 3) throw new Refusal("RELEASE_VERSION_INVALID");
        var numbers = components.Select(part =>
        {
            var number = Wire.Decimal(part);
            return number <= int.MaxValue ? (int)number : throw new Refusal("RELEASE_VERSION_INVALID");
        }).ToArray();
        return new StableVersion(numbers[0], numbers[1], numbers[2]);
    }
    public int CompareTo(StableVersion other) => Major != other.Major ? Major.CompareTo(other.Major)
        : Minor != other.Minor ? Minor.CompareTo(other.Minor) : Patch.CompareTo(other.Patch);
}

internal static class ReleaseValues
{
    internal static byte[] Base64(string value)
    {
        if (value.Length == 0 || value.Length % 4 != 0) throw new Refusal("RELEASE_BASE64_INVALID");
        byte[] decoded;
        try { decoded = Convert.FromBase64String(value); }
        catch (FormatException) { throw new Refusal("RELEASE_BASE64_INVALID"); }
        if (Convert.ToBase64String(decoded) != value) throw new Refusal("RELEASE_BASE64_INVALID");
        return decoded;
    }
    internal static string Text(JsonElement value, string name) => value.GetProperty(name).GetString()!;
    internal static ulong Number(JsonElement value, string name) => Wire.Decimal(Text(value, name));
}
