using System.Buffers.Binary;
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
    private readonly string sourceDigest;
    internal ReleaseSchema(byte[] bytes)
    {
        if (bytes.Length > 65_536) throw new Refusal("RELEASE_SCHEMA_INVALID");
        var snapshot = bytes.ToArray();
        using var document = ReleaseJson.Parse(snapshot, 65_536);
        schema = document.RootElement.Clone();
        sourceDigest = ReleaseTrustPolicy.Hash(Wire.Utf8.GetBytes(Wire.Utf8.GetString(snapshot).Replace("\r\n", "\n", StringComparison.Ordinal)));
        if (schema.GetProperty("protocol").GetInt32() != 1) throw new Refusal("RELEASE_SCHEMA_UNSUPPORTED");
    }
    internal static ReleaseSchema Embedded() => new(ReleaseJson.Resource("update-release-schema.json"));
    internal static ReleaseSchema Identity() => new(ReleaseJson.Resource("update-release-identity-v1.json"));
    internal static ReleaseSchema AuthorizationV2()
    {
        var value = new ReleaseSchema(ReleaseJson.Resource("update-release-authorization-v2.json"));
        if (value.sourceDigest != "ad9d956016199f1519bf0b4ff0e784991ddd49ca239614021882b064eb802ab6")
            throw new Refusal("RELEASE_AUTHORIZATION_SCHEMA_VERSION_MISMATCH");
        return value;
    }
    internal int EnvelopeBytes => schema.GetProperty("limits").GetProperty("envelopeBytes").GetInt32();
    internal int PayloadBytes => schema.GetProperty("limits").GetProperty("payloadBytes").GetInt32();
    internal int Depth => schema.GetProperty("limits").GetProperty("maxDepth").GetInt32();
    internal byte[] EncodeReleaseIdentity(ReadOnlySpan<byte> bytes)
    {
        if (sourceDigest != "35349e5d31e1cab882e18c5c4808d8f65a6ca6a21200d3f0ea78507bb8e47458")
            throw new Refusal("RELEASE_IDENTITY_SCHEMA_VERSION_MISMATCH");
        using var document = ReleaseJson.Parse(bytes, PayloadBytes, Depth);
        var release = document.RootElement;
        Validate("release", release);
        using var output = new MemoryStream();
        output.Write(Wire.Utf8.GetBytes("lnwjud-update-release-identity-v1\0"));
        EncodeIdentityObject(output, "release", release);
        return output.ToArray();
    }
    private void EncodeIdentityObject(Stream output, string name, JsonElement value)
    {
        var fields = schema.GetProperty("objects").GetProperty(name).GetProperty("fields").EnumerateObject()
            .OrderBy(field => field.Name, StringComparer.Ordinal).ToArray();
        output.WriteByte((byte)'O'); WriteIdentityCount(output, fields.Length);
        foreach (var field in fields)
        {
            WriteIdentityText(output, field.Name);
            var descriptor = field.Value;
            var item = value.GetProperty(field.Name);
            var kind = descriptor.GetProperty("kind").GetString();
            if (kind == "object") EncodeIdentityObject(output, descriptor.GetProperty("object").GetString()!, item);
            else if (kind == "string") { output.WriteByte((byte)'S'); WriteIdentityText(output, item.GetString()!); }
            else throw new Refusal("RELEASE_SCHEMA_UNSUPPORTED");
        }
    }
    private static void WriteIdentityText(Stream output, string value)
    {
        var bytes = Wire.Utf8.GetBytes(value);
        WriteIdentityCount(output, bytes.Length); output.Write(bytes);
    }
    private static void WriteIdentityCount(Stream output, int value)
    {
        Span<byte> bytes = stackalloc byte[4];
        BinaryPrimitives.WriteUInt32BigEndian(bytes, checked((uint)value)); output.Write(bytes);
    }
    internal void Validate(string name, JsonElement value)
    {
        if (value.ValueKind != JsonValueKind.Object) throw new Refusal("RELEASE_SCHEMA_INVALID");
        var fields = schema.GetProperty("objects").GetProperty(name).GetProperty("fields");
        if (value.EnumerateObject().Count() != fields.EnumerateObject().Count()) throw new Refusal("RELEASE_SCHEMA_INVALID");
        var names = new HashSet<string>(StringComparer.Ordinal);
        foreach (var property in value.EnumerateObject())
        {
            if (!names.Add(property.Name) || !fields.TryGetProperty(property.Name, out var descriptor)) throw new Refusal("RELEASE_SCHEMA_INVALID");
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
        if (text.Any(c => c < ' ' || c > '~') || descriptor.TryGetProperty("maxLength", out var length) && text.Length > length.GetInt32()) throw new Refusal("RELEASE_SCHEMA_INVALID");
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
