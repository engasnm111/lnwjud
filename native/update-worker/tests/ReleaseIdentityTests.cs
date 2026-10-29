using System.Text.Json;
using System.Text.Json.Nodes;
using Lnwjud.UpdateWorker;

internal static class ReleaseIdentityTests
{
    private static int assertions;
    private static void Check(bool value, string message) { assertions++; if (!value) throw new Exception(message); }

    internal static int Run(string fixturePath)
    {
        assertions = 0;
        using var document = ReleaseJson.Parse(File.ReadAllBytes(fixturePath), 32_768);
        var fixture = document.RootElement;
        var release = fixture.GetProperty("release");
        var schema = ReleaseSchema.Identity();
        var expected = Convert.FromBase64String(fixture.GetProperty("encodedBase64").GetString()!);
        var encoded = schema.EncodeReleaseIdentity(Wire.Utf8.GetBytes(release.GetRawText()));
        Check(encoded.AsSpan().SequenceEqual(expected), "release identity exact shared bytes");
        Check(ReleaseTrustPolicy.Hash(encoded) == fixture.GetProperty("sha256").GetString(), "release identity shared digest");
        var schemaText = Wire.Utf8.GetString(ReleaseJson.Resource("update-release-identity-v1.json")).Replace("\r\n", "\n", StringComparison.Ordinal);
        var crlfSchema = new ReleaseSchema(Wire.Utf8.GetBytes(schemaText.Replace("\n", "\r\n", StringComparison.Ordinal)));
        Check(crlfSchema.EncodeReleaseIdentity(Wire.Utf8.GetBytes(release.GetRawText())).AsSpan().SequenceEqual(encoded), "identity schema pin accepts CRLF");
        var changedSchemaNode = JsonNode.Parse(schemaText)!;
        changedSchemaNode["objects"]!["source"]!["fields"]!["commit"]!["format"] = "sha256";
        var changedSchema = new ReleaseSchema(Wire.Utf8.GetBytes(changedSchemaNode.ToJsonString()));
        try { _ = changedSchema.EncodeReleaseIdentity(Wire.Utf8.GetBytes(release.GetRawText())); throw new Exception("changed identity schema accepted"); }
        catch (Refusal error) { Check(error.Reason == "RELEASE_IDENTITY_SCHEMA_VERSION_MISMATCH", "changed identity schema refuses"); }

        var node = JsonNode.Parse(release.GetRawText())!.AsObject();
        var reordered = Reverse(node);
        Check(Encode(schema, reordered).AsSpan().SequenceEqual(encoded), "release identity ignores object insertion order");
        foreach (var change in new Action<JsonObject>[] {
            value => value["source"]!["commit"] = new string('b', 40),
            value => value["source"]!["runAttempt"] = "3",
            value => value["buildEvidence"]!["artifactAttestationSha256"] = new string('8', 64),
            value => value["artifact"]!["sha256"] = new string('8', 64),
            value => value["provenance"]!["sizeBytes"] = "1235",
            value => value["compatibility"]!["serviceContractSha256"] = new string('8', 64),
            value => value["version"] = "5.9.1",
            value => value["releaseSequence"] = "101",
            value => value["architecture"] = "arm64"
        })
        {
            var altered = (JsonObject)node.DeepClone(); change(altered);
            Check(ReleaseTrustPolicy.Hash(Encode(schema, altered)) != fixture.GetProperty("sha256").GetString(), "immutable field changes identity");
        }
        foreach (var change in new Action<JsonObject>[] {
            value => value["extra"] = "untrusted",
            value => value["source"]!.AsObject().Remove("commit"),
            value => value["source"]!["runAttempt"] = "02",
            value => value["releaseSequence"] = "0100",
            value => value["version"] = "05.9.0",
            value => value["artifact"]!["sha256"] = new string('Z', 64),
            value => value["buildEvidence"]!["sourceTree"] = "dirty"
        })
        {
            var altered = (JsonObject)node.DeepClone(); change(altered);
            var refused = false;
            try { _ = Encode(schema, altered); } catch (Refusal) { refused = true; }
            Check(refused, "invalid immutable identity refuses");
        }
        var missing = (JsonObject)node.DeepClone(); missing.Remove("releaseId");
        var duplicate = "{\"product\":\"lnwjud\"," + missing.ToJsonString()[1..];
        using (var direct = JsonDocument.Parse(duplicate))
        {
            var refused = false;
            try { schema.Validate("release", direct.RootElement); } catch (Refusal) { refused = true; }
            Check(refused, "schema rejects duplicate fields even from a direct JsonDocument");
        }
        try { _ = schema.EncodeReleaseIdentity(Wire.Utf8.GetBytes(duplicate)); throw new Exception("duplicate identity accepted"); }
        catch (Refusal error) { Check(error.Reason == "RELEASE_DUPLICATE_FIELD", "identity parser rejects duplicate fields"); }
        var enrollmentSchema = new ReleaseSchema(ReleaseJson.Resource("update-enrollment-schema.json"));
        foreach (var character in new[] { '\u001f', '\u007f' })
        {
            var image = new JsonObject { ["path"] = "slot" + character, ["sha256"] = new string('a', 64), ["sizeBytes"] = "1" };
            using var imageDocument = ReleaseJson.Parse(Wire.Utf8.GetBytes(image.ToJsonString()), 32_768);
            var refused = false;
            try { enrollmentSchema.Validate("image", imageDocument.RootElement); } catch (Refusal) { refused = true; }
            Check(refused, "schema rejects ASCII control and DEL characters");
        }
        Console.WriteLine($"RELEASE_IDENTITY_ASSERTIONS_PASSED={assertions}");
        return assertions;
    }

    private static byte[] Encode(ReleaseSchema schema, JsonNode node)
    {
        return schema.EncodeReleaseIdentity(Wire.Utf8.GetBytes(node.ToJsonString()));
    }

    private static JsonNode Reverse(JsonNode node)
    {
        if (node is not JsonObject source) return node.DeepClone();
        var result = new JsonObject();
        foreach (var item in source.Reverse()) result.Add(item.Key, Reverse(item.Value!));
        return result;
    }
}
