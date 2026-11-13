using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;
using Lnwjud.UpdateWorker;

internal static class WindowsBaselineLayoutTests
{
    internal static int Run(JsonElement fixture, ReleaseTimeObservation time)
    {
        var assertions = 0;
        var appHash = new string('a', 64);
        JsonObject File(string path, ulong size = 1, string? hash = null) => new()
        {
            ["path"] = path, ["sizeBytes"] = Wire.Decimal(size), ["sha256"] = hash ?? appHash,
        };
        JsonObject Manifest(params JsonObject[] extra) => new()
        {
            ["schemaVersion"] = 1,
            ["files"] = new JsonArray(new[] { File("lnwjud.exe", 2) }.Concat(extra).Cast<JsonNode?>().ToArray()),
        };
        JsonObject Layout(byte[] manifest) => new()
        {
            ["schemaVersion"] = 1, ["product"] = "lnwjud", ["platform"] = "win32", ["architecture"] = "x64", ["slot"] = "A",
            ["roles"] = new JsonObject
            {
                ["stableLauncher"] = File("lnwjud.exe"),
                ["stableService"] = File("resources/native-containment/lnwjud-containment.exe"),
                ["slotApplication"] = File("slots/A/lnwjud.exe", 2),
                ["slotManifest"] = File("slots/A/manifest.json", (ulong)manifest.Length, ReleaseTrustPolicy.Hash(manifest)),
            },
        };
        WindowsBaselineLayout Parse(JsonObject layout) => WindowsBaselineLayout.Parse(Wire.Encode(layout), new string('b', 64));
        void Check(bool passed, string name)
        {
            assertions++;
            if (!passed) throw new Exception("installed layout: " + name);
        }
        void Refused(Action operation, string name)
        {
            try { operation(); }
            catch (Refusal) { assertions++; return; }
            throw new Exception("installed layout accepted: " + name);
        }
        void InvalidManifest(JsonObject manifest, string name)
        {
            var bytes = Wire.Encode(manifest);
            Refused(() => Parse(Layout(bytes)).ReadManifest(bytes), name);
        }
        var bytes = Wire.Encode(Manifest(File("resources/app.asar"), File("empty.txt", 0)));
        var valid = Parse(Layout(bytes));
        var files = valid.ReadManifest(bytes);
        Check(files.Count == 3 && files["empty.txt"].SizeBytes == 0 && files["lnwjud.exe"].Sha256 == appHash, "complete inventory and zero-byte files");
        var changed = bytes.ToArray(); changed[0] ^= 1;
        Refused(() => valid.ReadManifest(changed), "manifest byte tampering");
        InvalidManifest(Manifest(File("LNWJUD.EXE", 2)), "case-colliding files");
        InvalidManifest(Manifest(File("resources"), File("resources/app.asar")), "file used as directory");
        InvalidManifest(Manifest(File("resources/app.asar"), File("resources")), "directory used as file");
        InvalidManifest(Manifest(File("resources/a"), File("RESOURCES/b")), "case-colliding directories");
        InvalidManifest(Manifest(File("manifest.json/child")), "manifest used as directory");
        InvalidManifest(Manifest(File("MANIFEST.JSON/child")), "manifest alias used as directory");
        foreach (var path in new[] { "../escape", "a/./b", "/root", "a//b", "a\\b", "a:stream", "CON", "CON .txt", "NUL.txt", "com0", "lpt9.txt", "trail.", "trail ", "a/manifest.json/..", "manifest.json", "MANIFEST.JSON", "x\u007f", "caf\u00e9" })
            InvalidManifest(Manifest(File(path)), "unsafe path " + path);
        var wrongApp = Manifest(); wrongApp["files"]![0]!["sha256"] = new string('c', 64);
        InvalidManifest(wrongApp, "application role mismatch");
        InvalidManifest(Manifest(File("large", WindowsBaselineLayout.MaximumSlotBytes)), "total size bound");
        InvalidManifest(Manifest(File("large", WindowsBaselineLayout.MaximumSlotBytes + 1)), "individual size bound");
        var numericSize = Manifest(); numericSize["files"]![0]!["sizeBytes"] = 2;
        InvalidManifest(numericSize, "numeric size instead of decimal string");
        var noncanonicalSize = Manifest(); noncanonicalSize["files"]![0]!["sizeBytes"] = "02";
        InvalidManifest(noncanonicalSize, "noncanonical decimal size");
        var wrongArray = Manifest(); wrongArray["files"] = "not an array";
        InvalidManifest(wrongArray, "wrong files type");
        var noFiles = new JsonObject { ["schemaVersion"] = 1, ["files"] = new JsonArray() };
        InvalidManifest(noFiles, "empty inventory");
        var excessive = Manifest(Enumerable.Range(0, WindowsBaselineLayout.MaximumFiles).Select(i => File("file-" + i, 0)).ToArray());
        InvalidManifest(excessive, "file-count bound");
        var extra = Layout(bytes); extra["unexpected"] = true;
        Refused(() => Parse(extra), "extra layout field");
        foreach (var field in new[] { "schemaVersion", "product", "platform", "architecture", "slot" })
        {
            var invalid = Layout(bytes); invalid[field] = false;
            Refused(() => Parse(invalid), "wrong layout type " + field);
        }
        var redirected = Layout(bytes); redirected["roles"]!["stableService"]!["path"] = "elsewhere/service.exe";
        Refused(() => Parse(redirected), "redirected stable service");
        var tooLarge = Layout(bytes); tooLarge["roles"]!["slotManifest"]!["sizeBytes"] = Wire.Decimal((ulong)WindowsBaselineLayout.MaximumManifestBytes + 1);
        Refused(() => Parse(tooLarge), "manifest byte bound");
        var duplicate = Wire.Utf8.GetBytes(Wire.Utf8.GetString(Wire.Encode(Layout(bytes))).Replace("\"product\":", "\"product\":\"lnwjud\",\"product\":", StringComparison.Ordinal));
        Refused(() => WindowsBaselineLayout.Parse(duplicate, new string('b', 64)), "duplicate JSON field");
        using var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var publicKey = key.ExportSubjectPublicKeyInfo();
        var policy = JsonNode.Parse(fixture.GetProperty("policy").GetRawText())!.AsObject();
        policy["roots"]!.AsArray().Add(new JsonObject
        {
            ["keyId"] = "baseline-layout-test", ["algorithm"] = "ecdsa-p256-sha256-p1363",
            ["spkiBase64"] = Convert.ToBase64String(publicKey), ["spkiSha256"] = ReleaseTrustPolicy.Hash(publicKey),
            ["roles"] = new JsonArray("release", "recovery"), ["notBefore"] = "0", ["expiresAt"] = "2000000000",
            ["revoked"] = false, ["allowHistoricalRecovery"] = true,
        });
        var testPolicy = ReleaseTrustPolicy.Parse(Wire.Encode(policy));
        var originalPolicy = ReleaseTrustPolicy.Parse(Wire.Utf8.GetBytes(fixture.GetProperty("policy").GetRawText()));
        var original = ReleaseAuthorizationV2.Authenticate(Convert.FromBase64String(fixture.GetProperty("baselineEnvelope").GetString()!),
            originalPolicy, time, ReleaseAuthorizationPurpose.Baseline);
        var payload = JsonNode.Parse(original.Payload.GetRawText())!.AsObject();
        var installer = Wire.Utf8.GetBytes("layout-bound installer test bytes");
        var artifactBundle = Wire.Utf8.GetBytes("layout artifact attestation test bytes");
        var provenanceBundle = Wire.Utf8.GetBytes("layout provenance attestation test bytes");
        var release = payload["release"]!;
        release["artifact"]!["sha256"] = ReleaseTrustPolicy.Hash(installer);
        release["artifact"]!["sizeBytes"] = Wire.Decimal((ulong)installer.Length);
        release["buildEvidence"]!["artifactAttestationSha256"] = ReleaseTrustPolicy.Hash(artifactBundle);
        release["buildEvidence"]!["provenanceAttestationSha256"] = ReleaseTrustPolicy.Hash(provenanceBundle);
        var layoutBytes = Wire.Encode(Layout(bytes));
        JsonObject Provenance() => new()
        {
            ["installedLayout"] = new JsonObject
            {
                ["name"] = "INSTALL-LAYOUT.json", ["sizeBytes"] = Wire.Decimal((ulong)layoutBytes.Length),
                ["sha256"] = ReleaseTrustPolicy.Hash(layoutBytes),
            },
        };
        var directory = Path.Combine(Path.GetTempPath(), "lnwjud-layout-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            void WritePackage(JsonObject provenance, byte[] layout)
            {
                var provenanceBytes = Wire.Encode(provenance);
                release["provenance"]!["sha256"] = ReleaseTrustPolicy.Hash(provenanceBytes);
                release["provenance"]!["sizeBytes"] = Wire.Decimal((ulong)provenanceBytes.Length);
                var payloadBytes = Wire.Encode(payload);
                var message = Wire.Utf8.GetBytes("lnwjud-update-release-v2\0").Concat(payloadBytes).ToArray();
                var envelope = new JsonObject
                {
                    ["protocol"] = 2, ["keyId"] = "baseline-layout-test", ["payload"] = Convert.ToBase64String(payloadBytes),
                    ["signature"] = Convert.ToBase64String(key.SignData(message, HashAlgorithmName.SHA256, DSASignatureFormat.IeeeP1363FixedFieldConcatenation)),
                };
                System.IO.File.WriteAllBytes(Path.Combine(directory, "RELEASE.json"), Wire.Encode(envelope));
                System.IO.File.WriteAllBytes(Path.Combine(directory, release["artifact"]!["name"]!.GetValue<string>()), installer);
                System.IO.File.WriteAllBytes(Path.Combine(directory, "PROVENANCE.json"), provenanceBytes);
                System.IO.File.WriteAllBytes(Path.Combine(directory, "artifact.bundle.json"), artifactBundle);
                System.IO.File.WriteAllBytes(Path.Combine(directory, "provenance.bundle.json"), provenanceBundle);
                System.IO.File.WriteAllBytes(Path.Combine(directory, "INSTALL-LAYOUT.json"), layout);
            }
            void RejectedBinding(JsonObject provenance, byte[] layout, string name)
            {
                WritePackage(provenance, layout);
                using var package = AuthenticatedBaselinePackage.Open(directory, testPolicy, time);
                Refused(() => package.ReadInstalledLayout(), name);
            }
            WritePackage(Provenance(), layoutBytes);
            using (var package = AuthenticatedBaselinePackage.Open(directory, testPolicy, time))
            {
                Check(package.ReadInstalledLayout().Sha256 == ReleaseTrustPolicy.Hash(layoutBytes), "authenticated provenance binds exact layout bytes");
                package.Files.RecheckAll();
                var locked = false;
                try { using var writer = new FileStream(Path.Combine(directory, "INSTALL-LAYOUT.json"), FileMode.Open, FileAccess.Write, FileShare.ReadWrite | FileShare.Delete); }
                catch (IOException) { locked = true; }
                Check(locked, "authenticated layout retains deny-write handle");
            }
            RejectedBinding(new JsonObject(), layoutBytes, "missing signed layout binding");
            var extraIdentity = Provenance(); extraIdentity["installedLayout"]!["extra"] = true;
            RejectedBinding(extraIdentity, layoutBytes, "extra identity field");
            var badSize = Provenance(); badSize["installedLayout"]!["sizeBytes"] = Wire.Decimal((ulong)layoutBytes.Length + 1);
            RejectedBinding(badSize, layoutBytes, "signed layout size mismatch");
            var badName = Provenance(); badName["installedLayout"]!["name"] = "other.json";
            RejectedBinding(badName, layoutBytes, "signed redirected layout name");
            var changedLayout = layoutBytes.ToArray(); changedLayout[^2] ^= 1;
            RejectedBinding(Provenance(), changedLayout, "layout tampering beneath authenticated provenance");
        }
        finally { Directory.Delete(directory, true); }
        Console.WriteLine("Windows installed layout assertions: " + assertions);
        return assertions;
    }
}
