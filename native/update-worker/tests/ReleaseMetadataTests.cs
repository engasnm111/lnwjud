using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using System.Text.Json;
using Lnwjud.UpdateWorker;

internal static class ReleaseMetadataTests
{
    private const ulong Now = 1_800_000_000;
    private static int assertions;
    private static readonly ReleaseSchema Schema = ReleaseSchema.Embedded();
    private static void Check(bool value, string message) { assertions++; if (!value) throw new Exception(message); }
    private static string Digest(char character) => new(character, 64);
    private static string ArtifactName(string version, string platform, string architecture) =>
        platform == "win32" ? "lnwjud-Setup-" + version + ".exe" : $"lnwjud-{version}-{architecture}.zip";
    private static JsonObject Identity(string version, char hash, string platform, string architecture, string size = "1000") => new()
    { ["name"] = ArtifactName(version, platform, architecture), ["sha256"] = Digest(hash), ["sizeBytes"] = size };
    private static JsonObject Provenance(char hash) => new() { ["name"] = "PROVENANCE.json", ["sha256"] = Digest(hash), ["sizeBytes"] = "200" };
    private static JsonObject Payload(string version, ulong sequence, string previousVersion, ulong previousSequence,
        string previousEnvelope, char artifact, char provenance, char previousArtifact, char previousProvenance, ulong issued, ulong expires,
        string platform, string architecture, string distribution) => new()
    {
        ["protocol"] = 1, ["product"] = "lnwjud", ["policyRevision"] = 1, ["releaseId"] = "release-" + version,
        ["channel"] = "stable", ["platform"] = platform, ["architecture"] = architecture, ["distribution"] = distribution,
        ["version"] = version, ["releaseSequence"] = Wire.Decimal(sequence), ["issuedAt"] = Wire.Decimal(issued), ["notBefore"] = Wire.Decimal(issued), ["expiresAt"] = Wire.Decimal(expires),
        ["source"] = new JsonObject { ["repository"] = "https://github.com/engasnm111/lnwjud", ["commit"] = new string('a', 40), ["workflow"] = ".github/workflows/ci.yml", ["ref"] = "refs/heads/main", ["runId"] = "123", ["runAttempt"] = "1" },
        ["buildEvidence"] = new JsonObject { ["kind"] = "github-artifact-attestation-v1", ["artifactAttestationSha256"] = Digest('1'), ["provenanceAttestationSha256"] = Digest('2'), ["sourceTree"] = "clean" },
        ["artifact"] = Identity(version, artifact, platform, architecture), ["provenance"] = Provenance(provenance),
        ["previous"] = new JsonObject { ["version"] = previousVersion, ["releaseSequence"] = Wire.Decimal(previousSequence), ["envelopeSha256"] = previousEnvelope, ["artifact"] = Identity(previousVersion, previousArtifact, platform, architecture), ["provenance"] = Provenance(previousProvenance) },
        ["compatibility"] = new JsonObject { ["migrationContractSha256"] = Digest('f'), ["workerContractSha256"] = Digest('f'), ["serviceContractSha256"] = Digest('f') },
        ["recoveryAuthorization"] = new JsonObject { ["purpose"] = "failed-candidate-only", ["candidateArtifactSha256"] = Digest(artifact), ["candidateReleaseSequence"] = Wire.Decimal(sequence), ["previousEnvelopeSha256"] = previousEnvelope,
            ["previousArtifactSha256"] = Digest(previousArtifact), ["previousProvenanceSha256"] = Digest(previousProvenance), ["expiresAt"] = Wire.Decimal(expires), ["maximumAttempts"] = 1 }
    };

    internal sealed class Fixture : IDisposable
    {
        internal readonly ECDsa Key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        internal readonly JsonObject Policy;
        internal readonly RetainedInstallationBaseline Baseline;
        internal readonly JsonObject Offer;
        internal ReleaseTrustSnapshot Snapshot = new(4, 6, 100, Now - 1000, new HashSet<string>(StringComparer.Ordinal));
        internal readonly ReleaseTimeObservation Time = new(true, Now);
        private readonly string platform;
        private readonly string architecture;
        private readonly string distribution;
        internal Fixture(string platform = "win32", string architecture = "x64", string distribution = "windows-nsis")
        {
            this.platform = platform; this.architecture = architecture; this.distribution = distribution;
            var spki = Key.ExportSubjectPublicKeyInfo();
            Policy = new JsonObject
            {
                ["protocol"] = 1, ["revision"] = 1,
                ["roots"] = new JsonArray(new JsonObject { ["keyId"] = "test-only", ["algorithm"] = "ecdsa-p256-sha256-p1363", ["spkiBase64"] = Convert.ToBase64String(spki), ["spkiSha256"] = ReleaseTrustPolicy.Hash(spki),
                    ["roles"] = new JsonArray("release", "recovery"), ["notBefore"] = "0", ["expiresAt"] = Wire.Decimal(Now + 1_000_000), ["revoked"] = false, ["allowHistoricalRecovery"] = true }),
                ["authorities"] = new JsonArray(new JsonObject { ["repository"] = "https://github.com/engasnm111/lnwjud", ["workflow"] = ".github/workflows/ci.yml", ["ref"] = "refs/heads/main",
                    ["builderWorkflowUri"] = "https://github.com/engasnm111/lnwjud/.github/workflows/trusted.yml@" + new string('a', 40), ["builderDigest"] = new string('a', 40),
                    ["buildConfigUri"] = "https://github.com/engasnm111/lnwjud/.github/workflows/ci.yml@refs/heads/main", ["buildConfigDigestRule"] = "source-commit",
                    ["issuer"] = "https://token.actions.githubusercontent.com", ["runnerEnvironment"] = "github-hosted" }),
                ["verifier"] = new JsonObject { ["version"] = "2.102.0", ["sha256"] = Digest('6'), ["filename"] = "gh.exe" },
                ["limits"] = new JsonObject { ["maximumValiditySeconds"] = "86400", ["maximumFutureSkewSeconds"] = "300", ["maximumPackageBytes"] = "2147483648", ["maximumProvenanceBytes"] = "1048576" }
            };
            var original = Payload("5.9.0", 100, "5.8.0", 99, Digest('5'), 'b', 'c', '3', '4', Now - 100_000, Now - 50_000, platform, architecture, distribution);
            var originalEnvelope = Sign(original);
            Baseline = new RetainedInstallationBaseline(originalEnvelope, ReleaseTrustPolicy.Hash(originalEnvelope), "5.9.0", 100,
                new ReleaseArtifact(ArtifactName("5.9.0", platform, architecture), Digest('b'), 1000), new ReleaseArtifact("PROVENANCE.json", Digest('c'), 200),
                new ReleaseContracts(Digest('f'), Digest('f'), Digest('f')), Now - 90_000, Digest('7'));
            Offer = Payload("5.9.1", 101, "5.9.0", 100, Baseline.EnvelopeSha256, 'd', 'e', 'b', 'c', Now - 100, Now + 1000, platform, architecture, distribution);
        }
        internal byte[] Sign(JsonObject payload) => SignBytes(Wire.Encode(payload));
        internal byte[] SignBytes(byte[] payload, string domain = "lnwjud-update-release-v1\0", DSASignatureFormat format = DSASignatureFormat.IeeeP1363FixedFieldConcatenation)
        {
            var message = Encoding.ASCII.GetBytes(domain).Concat(payload).ToArray();
            return Wire.Encode(new JsonObject { ["protocol"] = 1, ["keyId"] = "test-only", ["payload"] = Convert.ToBase64String(payload), ["signature"] = Convert.ToBase64String(Key.SignData(message, HashAlgorithmName.SHA256, format)) });
        }
        internal ReleaseMetadataVerification Verify(byte[]? envelope = null, ReleaseTrustPolicy? policy = null, RetainedInstallationBaseline? baseline = null, ReleaseTrustSnapshot? snapshot = null, ReleaseTimeObservation? time = null) =>
            ReleaseMetadataVerifier.VerifyOffer(envelope ?? Sign(Offer), policy ?? ReleaseTrustPolicy.Parse(Wire.Encode(Policy)), Schema, baseline ?? Baseline, snapshot ?? Snapshot, time ?? Time);
        public void Dispose() => Key.Dispose();
    }

    internal static int Run()
    {
        assertions = 0;
        using var fixture = new Fixture();
        foreach (var mutation in new Action<JsonObject>[] {
            p => p["authorities"]!.AsArray().Add(p["authorities"]![0]!.DeepClone()),
            p => p["authorities"]![0]!["builderDigest"] = "not-a-digest",
            p => p["authorities"]![0]!["buildConfigUri"] = "https://github.com/other/repository",
            p => p["authorities"]![0]!["builderWorkflowUri"] = "https://example.com/builder",
            p => p["verifier"]!["version"] = "latest"
        })
        {
            var policy = (JsonObject)fixture.Policy.DeepClone(); mutation(policy);
            var refused = false; try { _ = ReleaseTrustPolicy.Parse(Wire.Encode(policy)); } catch (Refusal) { refused = true; }
            Check(refused, "strict authority/verifier policy rejects ambiguous or malformed configuration");
        }
        var accepted = fixture.Verify();
        Check(accepted is ReleaseMetadataVerification.Authenticated, "metadata positive " + accepted);
        var metadata = ((ReleaseMetadataVerification.Authenticated)accepted).Metadata;
        Check(metadata.HistoricalPreviousEligibilityOnly && metadata.Receipt.ExpectedGeneration == 4 && metadata.Receipt.ExpectedRevision == 6, "metadata receipt bound to snapshot with recovery eligibility only");
        var before = fixture.Snapshot.Digest;
        _ = fixture.Verify(); Check(fixture.Snapshot.Digest == before, "verification never mutates trust floor");
        Check(fixture.Verify(policy: ReleaseTrustPolicy.Embedded()) is ReleaseMetadataVerification.Refused { Reason: "RELEASE_TRUST_UNCONFIGURED" }, "production embedded roots empty");
        Check(EnrollmentPreflight.VerifyPackage("not-an-absolute-path", ReleaseTrustPolicy.Embedded(), Schema, fixture.Time)
            is EnrollmentPreflightResult.Refused { Reason: "RELEASE_TRUST_UNCONFIGURED" }, "enrollment preflight refuses empty policy before opening a package");
        RunEnrollment(fixture);
        Check(ReleaseMetadataVerifier.VerifyOffer(fixture.Sign(fixture.Offer), ReleaseTrustPolicy.Parse(Wire.Encode(fixture.Policy)), Schema, null, fixture.Snapshot, fixture.Time)
            is ReleaseMetadataVerification.Refused { Reason: "RELEASE_TRUSTED_BASELINE_UNAVAILABLE" }, "missing installed baseline refuses");
        Check(fixture.Verify(time: new(false, Now)) is ReleaseMetadataVerification.Refused, "unknown clock");
        Check(fixture.Verify(time: new(true, Now - 2000)) is ReleaseMetadataVerification.Refused { Reason: "RELEASE_CLOCK_ROLLBACK" }, "clock rollback");
        Check(fixture.Verify(snapshot: fixture.Snapshot with { HighestAcceptedSequence = 99 }) is ReleaseMetadataVerification.Refused { Reason: "RELEASE_TRUST_STATE_INVALID" }, "replay floor cannot fall below committed baseline");
        Check(fixture.Verify(snapshot: fixture.Snapshot with { HighestAcceptedSequence = 100 }) is ReleaseMetadataVerification.Authenticated, "next candidate advances from committed baseline");
        Check(fixture.Verify(snapshot: fixture.Snapshot with { HighestAcceptedSequence = 101 }) is ReleaseMetadataVerification.Refused { Reason: "RELEASE_REPLAY_OR_DOWNGRADE" }, "accepted sequence cannot be reoffered after rollback");
        Check(fixture.Verify(snapshot: fixture.Snapshot with { FailedCandidateDigests = new HashSet<string> { Digest('d') } }) is ReleaseMetadataVerification.Refused, "failed candidate quarantine");
        Check(fixture.Verify(baseline: fixture.Baseline with { NativeAcceptanceReceiptSha256 = "" }) is ReleaseMetadataVerification.Refused, "unsigned baseline missing native receipt");
        Check(fixture.Verify(baseline: fixture.Baseline with { EnvelopeSha256 = Digest('0') }) is ReleaseMetadataVerification.Refused, "retained original envelope exact digest");
        Check(fixture.Verify(fixture.SignBytes(Encoding.UTF8.GetBytes(" \n" + fixture.Offer.ToJsonString() + "\n"))) is ReleaseMetadataVerification.Authenticated, "verify exact payload bytes rather than reserialized JSON");

        using (var macArm = new Fixture("darwin", "arm64", "macos-zip"))
        {
            Check(macArm.Verify() is ReleaseMetadataVerification.Authenticated, "macOS arm64 updater artifact identity accepted");
            var windowsArtifact = (JsonObject)macArm.Offer.DeepClone();
            windowsArtifact["artifact"]!["name"] = "lnwjud-Setup-5.9.1.exe";
            Check(macArm.Verify(macArm.Sign(windowsArtifact)) is ReleaseMetadataVerification.Refused { Reason: "RELEASE_ARTIFACT_IDENTITY_INVALID" }, "cross-target Windows package refused for macOS");
            var wrongDistribution = (JsonObject)macArm.Offer.DeepClone();
            wrongDistribution["distribution"] = "windows-nsis";
            Check(macArm.Verify(macArm.Sign(wrongDistribution)) is ReleaseMetadataVerification.Refused, "macOS NSIS distribution refused");
        }
        using (var macX64 = new Fixture("darwin", "x64", "macos-zip"))
            Check(macX64.Verify() is ReleaseMetadataVerification.Authenticated, "macOS x64 updater artifact identity accepted");
        using (var macBaseline = new Fixture("darwin", "arm64", "macos-zip"))
            Check(fixture.Verify(baseline: macBaseline.Baseline) is ReleaseMetadataVerification.Refused, "baseline from another update target refused");

        foreach (var mutate in new Action<JsonObject>[] {
            node => node["platform"] = "darwin", node => node["architecture"] = "arm64", node => node["channel"] = "preview",
            node => node["product"] = "another", node => node["version"] = "05.9.1", node => node["version"] = "5.9.1-beta",
            node => node["version"] = "2147483648.1.1", node => node["releaseSequence"] = "0101", node => node["releaseSequence"] = "18446744073709551616",
            node => node["releaseSequence"] = "0", node => node["releaseSequence"] = "100", node => node["issuedAt"] = "253402300800",
            node => node["issuedAt"] = Wire.Decimal(Now + 301), node => node["notBefore"] = Wire.Decimal(Now - 99), node => node["expiresAt"] = Wire.Decimal(Now),
            node => node["expiresAt"] = Wire.Decimal(Now + 86401), node => node["policyRevision"] = 2, node => node["policyRevision"] = JsonNode.Parse("1.0"),
            node => node["source"]!["repository"] = "https://github.com/other/project", node => node["source"]!["ref"] = "refs/heads/dev",
            node => node["source"]!["workflow"] = ".github/workflows/other.yml", node => node["source"]!["runId"] = "0", node => node["source"]!["runAttempt"] = "01",
            node => node["buildEvidence"]!["sourceTree"] = "dirty", node => node["buildEvidence"]!["kind"] = "unsigned-json",
            node => node["artifact"]!["name"] = "../setup.exe", node => node["artifact"]!["name"] = "lnwjud-Setup-5.9.2.exe",
            node => node["artifact"]!["sizeBytes"] = "2147483649", node => node["provenance"]!["sizeBytes"] = "1048577",
            node => node["provenance"]!["sha256"] = Digest('a').ToUpperInvariant(), node => node["previous"]!["version"] = "5.8.9",
            node => node["previous"]!["artifact"]!["sha256"] = Digest('a'), node => node["compatibility"]!["workerContractSha256"] = Digest('a'),
            node => node["recoveryAuthorization"]!["maximumAttempts"] = 2, node => node["recoveryAuthorization"]!["candidateArtifactSha256"] = Digest('a'),
            node => node["recoveryAuthorization"]!["expiresAt"] = Wire.Decimal(Now + 1001), node => node["extra"] = true,
            node => node["recoveryAuthorization"]!["expiresAt"] = Wire.Decimal(Now - 1),
            node => node["source"]!["extra"] = true, node => node["source"] = null
        })
        {
            var changed = (JsonObject)fixture.Offer.DeepClone(); mutate(changed);
            Check(fixture.Verify(fixture.Sign(changed)) is ReleaseMetadataVerification.Refused, "signed invalid payload refused " + changed.ToJsonString());
        }
        EncodingAndCrypto(fixture);
        PolicyAndRecovery(fixture);
        ImmutableInputs(fixture);
        Console.WriteLine($"UPDATE_RELEASE_METADATA_ASSERTIONS_PASSED={assertions}");
        return assertions;
    }

    private static void RunEnrollment(Fixture fixture)
    {
        var directory = Path.Combine(Path.GetTempPath(), "lnwjud-enrollment-test-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            var installer = Encoding.UTF8.GetBytes("ephemeral fixture installer");
            var provenance = Encoding.UTF8.GetBytes("ephemeral fixture provenance");
            var artifactName = ArtifactName("5.9.1", "win32", "x64");
            var artifactHash = ReleaseTrustPolicy.Hash(installer);
            var provenanceHash = ReleaseTrustPolicy.Hash(provenance);
            var release = (JsonObject)fixture.Offer.DeepClone();
            release["artifact"] = new JsonObject { ["name"] = artifactName, ["sha256"] = artifactHash, ["sizeBytes"] = Wire.Decimal((ulong)installer.Length) };
            release["provenance"] = new JsonObject { ["name"] = "PROVENANCE.json", ["sha256"] = provenanceHash, ["sizeBytes"] = Wire.Decimal((ulong)provenance.Length) };
            release["recoveryAuthorization"]!["candidateArtifactSha256"] = artifactHash;
            var releaseBytes = fixture.Sign(release);
            var layout = new JsonObject
            {
                ["protocol"] = 1, ["product"] = "lnwjud", ["policyRevision"] = 1,
                ["releaseId"] = release["releaseId"]!.DeepClone(), ["channel"] = "stable", ["platform"] = "win32",
                ["architecture"] = "x64", ["distribution"] = "windows-nsis", ["version"] = "5.9.1",
                ["releaseSequence"] = "101", ["releaseEnvelopeSha256"] = ReleaseTrustPolicy.Hash(releaseBytes),
                ["source"] = release["source"]!.DeepClone(), ["artifact"] = release["artifact"]!.DeepClone(),
                ["provenance"] = release["provenance"]!.DeepClone(),
                ["layout"] = new JsonObject
                {
                    ["stableLauncher"] = Image("lnwjud.exe", '1'),
                    ["stableService"] = Image("native/lnwjud-containment.exe", '2'),
                    ["slotApplication"] = Image("slots/A/lnwjud.exe", '3'),
                    ["slotManifest"] = Image("slots/A/manifest.json", '4')
                }
            };
            var policy = ReleaseTrustPolicy.Parse(Wire.Encode(fixture.Policy));
            void Put(JsonObject value, byte[]? envelope = null)
            {
                File.WriteAllBytes(Path.Combine(directory, EnrollmentPreflight.ReleaseFile), envelope ?? fixture.Sign(value));
                File.WriteAllBytes(Path.Combine(directory, EnrollmentPreflight.LayoutFile), fixture.SignBytes(Wire.Encode(layout), "lnwjud-enrollment-layout-v1\0"));
            }
            EnrollmentPreflightResult Verify() => EnrollmentPreflight.VerifyPackage(directory, policy, Schema, fixture.Time);
            File.WriteAllBytes(Path.Combine(directory, artifactName), installer);
            File.WriteAllBytes(Path.Combine(directory, "PROVENANCE.json"), provenance);
            Put(release, releaseBytes);
            var authenticated = Verify();
            Check(authenticated is EnrollmentPreflightResult.Authenticated { ReleaseId: "release-5.9.1" }, "detached signed metadata and pinned package authenticate without a baseline: " + authenticated);
            Check(fixture.Verify(fixture.Sign(release), baseline: fixture.Baseline with { NativeAcceptanceReceiptSha256 = "" })
                is ReleaseMetadataVerification.Refused, "enrollment does not relax ordinary offer baseline");
            File.WriteAllBytes(Path.Combine(directory, EnrollmentPreflight.LayoutFile), fixture.Sign(layout));
            Check(Verify() is EnrollmentPreflightResult.Refused, "release signature cannot authenticate enrollment domain");
            Put(release, releaseBytes);
            var missingSignature = JsonNode.Parse(File.ReadAllBytes(Path.Combine(directory, EnrollmentPreflight.LayoutFile)))!.AsObject();
            missingSignature.Remove("signature");
            File.WriteAllBytes(Path.Combine(directory, EnrollmentPreflight.LayoutFile), Wire.Encode(missingSignature));
            Check(Verify() is EnrollmentPreflightResult.Refused, "missing enrollment signature refused");
            Put(release, releaseBytes);
            var tamperedSignature = JsonNode.Parse(File.ReadAllBytes(Path.Combine(directory, EnrollmentPreflight.LayoutFile)))!.AsObject();
            tamperedSignature["signature"] = Convert.ToBase64String(new byte[64]);
            File.WriteAllBytes(Path.Combine(directory, EnrollmentPreflight.LayoutFile), Wire.Encode(tamperedSignature));
            Check(Verify() is EnrollmentPreflightResult.Refused, "tampered enrollment signature refused");
            Put(release, releaseBytes);
            var wrongBinding = (JsonObject)layout.DeepClone();
            wrongBinding["releaseEnvelopeSha256"] = Digest('a');
            File.WriteAllBytes(Path.Combine(directory, EnrollmentPreflight.LayoutFile), fixture.SignBytes(Wire.Encode(wrongBinding), "lnwjud-enrollment-layout-v1\0"));
            Check(Verify() is EnrollmentPreflightResult.Refused { Reason: "ENROLLMENT_RELEASE_BINDING_INVALID" }, "signed release envelope digest binds layout");
            void RefuseLayout(Action<JsonObject> change, string message)
            {
                var changed = (JsonObject)layout.DeepClone(); change(changed);
                File.WriteAllBytes(Path.Combine(directory, EnrollmentPreflight.LayoutFile), fixture.SignBytes(Wire.Encode(changed), "lnwjud-enrollment-layout-v1\0"));
                Check(Verify() is EnrollmentPreflightResult.Refused, message);
            }
            RefuseLayout(value => value["source"]!["ref"] = "refs/heads/dev", "layout source must equal authenticated release source");
            RefuseLayout(value => value["policyRevision"] = 2, "layout policy revision must match embedded policy");
            RefuseLayout(value => value["layout"]!["slotApplication"]!["path"] = "../evil.exe", "traversal role refused");
            RefuseLayout(value => value["layout"]!["slotApplication"]!["path"] = "C:/evil.exe", "absolute role refused");
            RefuseLayout(value => value["layout"]!["slotApplication"]!["path"] = "slots/A/file.exe:stream", "ADS role refused");
            RefuseLayout(value => value["layout"]!["slotApplication"]!["path"] = "slots/A/file. ", "trailing alias role refused");
            RefuseLayout(value => value["layout"]!["slotApplication"]!["path"] = "NUL/file.exe", "reserved device role refused");
            RefuseLayout(value => value["layout"]!["slotApplication"]!["path"] = "SLOTS/a/MANIFEST.JSON", "case-insensitive duplicate role path refused");
            RefuseLayout(value => value["extra"] = true, "extra layout field refused");
            RefuseLayout(value => value["layout"]!["slotApplication"] = new JsonArray(), "array in fixed role refused");
            var duplicatePayload = Encoding.UTF8.GetBytes(Encoding.UTF8.GetString(Wire.Encode(layout))
                .Replace("\"protocol\":1,", "\"protocol\":1,\"protocol\":1,", StringComparison.Ordinal));
            File.WriteAllBytes(Path.Combine(directory, EnrollmentPreflight.LayoutFile), fixture.SignBytes(duplicatePayload, "lnwjud-enrollment-layout-v1\0"));
            Check(Verify() is EnrollmentPreflightResult.Refused, "duplicate signed payload field refused");
            Put(release, releaseBytes);
            File.WriteAllBytes(Path.Combine(directory, artifactName), Encoding.UTF8.GetBytes("changed fixture installer"));
            Check(Verify() is EnrollmentPreflightResult.Refused, "installer size mismatch refused");
            File.WriteAllBytes(Path.Combine(directory, artifactName), installer);
            File.WriteAllBytes(Path.Combine(directory, artifactName), Encoding.UTF8.GetBytes(new string('x', installer.Length)));
            Check(Verify() is EnrollmentPreflightResult.Refused { Reason: "ENROLLMENT_ARTIFACT_DIGEST_MISMATCH" }, "installer digest mismatch refused");
            File.WriteAllBytes(Path.Combine(directory, artifactName), installer);
            File.WriteAllBytes(Path.Combine(directory, "PROVENANCE.json"), Encoding.UTF8.GetBytes(new string('x', provenance.Length)));
            Check(Verify() is EnrollmentPreflightResult.Refused { Reason: "ENROLLMENT_ARTIFACT_DIGEST_MISMATCH" }, "provenance digest mismatch refused");
            File.Delete(Path.Combine(directory, "PROVENANCE.json"));
            Check(Verify() is EnrollmentPreflightResult.Refused { Reason: "ENROLLMENT_PACKAGE_FILE_MISSING" }, "missing fixed provenance refused");
            File.WriteAllBytes(Path.Combine(directory, "PROVENANCE.json"), provenance);
            File.Delete(Path.Combine(directory, artifactName));
            Check(Verify() is EnrollmentPreflightResult.Refused { Reason: "ENROLLMENT_PACKAGE_FILE_MISSING" }, "missing signed installer refused");
            File.WriteAllBytes(Path.Combine(directory, artifactName), installer);
            File.Delete(Path.Combine(directory, EnrollmentPreflight.LayoutFile));
            Check(Verify() is EnrollmentPreflightResult.Refused { Reason: "ENROLLMENT_PACKAGE_FILE_MISSING" }, "missing fixed enrollment sidecar refused");
            Put(release, releaseBytes);
            File.Delete(Path.Combine(directory, EnrollmentPreflight.ReleaseFile));
            Check(Verify() is EnrollmentPreflightResult.Refused { Reason: "ENROLLMENT_PACKAGE_FILE_MISSING" }, "missing fixed release sidecar refused");
            Put(release, releaseBytes);
            var wrongTarget = (JsonObject)release.DeepClone(); wrongTarget["platform"] = "darwin";
            Put(wrongTarget);
            Check(Verify() is EnrollmentPreflightResult.Refused, "wrong release target refused");
            Put(release, releaseBytes);
            var wrongSource = (JsonObject)release.DeepClone(); wrongSource["source"]!["ref"] = "refs/heads/dev";
            Put(wrongSource);
            Check(Verify() is EnrollmentPreflightResult.Refused { Reason: "RELEASE_SOURCE_UNTRUSTED" }, "untrusted release source refused");
            Put(release, releaseBytes);
            Check(EnrollmentPreflight.VerifyPackage(directory, policy, Schema, new ReleaseTimeObservation(false, Now))
                is EnrollmentPreflightResult.Refused { Reason: "RELEASE_TIME_UNAVAILABLE" }, "unusable time refused");
            Check(EnrollmentPreflight.VerifyPackage(directory, policy, Schema, new ReleaseTimeObservation(true, Now + 1_001))
                is EnrollmentPreflightResult.Refused { Reason: "RELEASE_TIME_INVALID" }, "expired release refused");
            File.WriteAllBytes(Path.Combine(directory, EnrollmentPreflight.ReleaseFile), fixture.SignBytes(Wire.Encode(release), "lnwjud-enrollment-layout-v1\0"));
            Check(Verify() is EnrollmentPreflightResult.Refused, "enrollment signature cannot authenticate release domain");
        }
        finally { Directory.Delete(directory, true); }
    }

    private static JsonObject Image(string path, char hash) => new()
    { ["path"] = path, ["sha256"] = Digest(hash), ["sizeBytes"] = "1" };

    private static void EncodingAndCrypto(Fixture fixture)
    {
        var encoded = fixture.Sign(fixture.Offer);
        foreach (var mutate in new Action<JsonObject>[] {
            node => node["keyId"] = "unknown", node => node["protocol"] = 2, node => node["extra"] = true,
            node => node["signature"] = Convert.ToBase64String(new byte[64]), node => node["signature"] = Convert.ToBase64String(new byte[63]),
            node => node["signature"] = node["signature"]!.GetValue<string>() + "\n",
            node => node["payload"] = "!!!!", node => node["payload"] = Convert.ToBase64String(new byte[32769]),
            node => node["payload"] = Convert.ToBase64String(Encoding.UTF8.GetBytes(fixture.Offer.ToJsonString() + " "))
        })
        {
            var changed = JsonNode.Parse(encoded)!.AsObject(); mutate(changed);
            Check(fixture.Verify(Wire.Encode(changed)) is ReleaseMetadataVerification.Refused, "bad envelope/signature refused");
        }
        Check(fixture.Verify(fixture.SignBytes(Wire.Encode(fixture.Offer), "wrong-domain\0")) is ReleaseMetadataVerification.Refused, "domain separation");
        Check(fixture.Verify(fixture.SignBytes(Wire.Encode(fixture.Offer), format: DSASignatureFormat.Rfc3279DerSequence)) is ReleaseMetadataVerification.Refused, "DER signature refused");
        Check(fixture.Verify(Encoding.UTF8.GetBytes("{\"protocol\":1,\"protocol\":1}")) is ReleaseMetadataVerification.Refused, "duplicate outer key");
        var duplicate = fixture.Offer.ToJsonString().Replace("\"product\":\"lnwjud\"", "\"product\":\"lnwjud\",\"pr\\u006fduct\":\"lnwjud\"");
        Check(fixture.Verify(fixture.SignBytes(Encoding.UTF8.GetBytes(duplicate))) is ReleaseMetadataVerification.Refused, "escaped duplicate payload key");
        Check(fixture.Verify(fixture.SignBytes(new byte[] { 0xff })) is ReleaseMetadataVerification.Refused, "invalid UTF8");
        Check(fixture.Verify(fixture.SignBytes(Encoding.UTF8.GetPreamble().Concat(Wire.Encode(fixture.Offer)).ToArray())) is ReleaseMetadataVerification.Refused, "payload BOM");
        Check(fixture.Verify(new byte[49153]) is ReleaseMetadataVerification.Refused, "oversized outer envelope");
        var surrogate = fixture.Offer.ToJsonString().Replace("release-5.9.1", "\\uD800");
        Check(fixture.Verify(fixture.SignBytes(Encoding.UTF8.GetBytes(surrogate))) is ReleaseMetadataVerification.Refused, "unpaired escaped surrogate");
    }
    private static void PolicyAndRecovery(Fixture fixture)
    {
        foreach (var mutate in new Action<JsonObject>[] {
            node => node["roots"]![0]!["revoked"] = true, node => node["roots"]![0]!["allowHistoricalRecovery"] = false,
            node => node["roots"]![0]!["roles"] = new JsonArray("release"), node => node["roots"]![0]!["notBefore"] = Wire.Decimal(Now + 1),
            node => node["roots"]![0]!["expiresAt"] = Wire.Decimal(Now), node => {
                node["authorities"]![0]!["ref"] = "refs/heads/dev";
                node["authorities"]![0]!["buildConfigUri"] = "https://github.com/engasnm111/lnwjud/.github/workflows/ci.yml@refs/heads/dev";
            }
        })
        {
            var changed = (JsonObject)fixture.Policy.DeepClone(); mutate(changed);
            Check(fixture.Verify(policy: ReleaseTrustPolicy.Parse(Wire.Encode(changed))) is ReleaseMetadataVerification.Refused, "key/history/source policy enforced");
        }
        var envelope = fixture.Sign(fixture.Offer);
        var snapshot = fixture.Snapshot with { HighestAcceptedSequence = 101, FailedCandidateDigests = new HashSet<string> { Digest('d') } };
        var context = new FailedUpdateRecoveryContext(Guid.NewGuid().ToString("D"), ReleaseTrustPolicy.Hash(envelope), Digest('d'), 101, fixture.Baseline.EnvelopeSha256, snapshot.Generation, snapshot.Revision, 1);
        var policy = ReleaseTrustPolicy.Parse(Wire.Encode(fixture.Policy));
        RecoveryMetadataVerification Verify(FailedUpdateRecoveryContext? failed = null, ReleaseTrustSnapshot? state = null, ReleaseTimeObservation? time = null) =>
            ReleaseMetadataVerifier.VerifyRecoveryMetadata(envelope, policy, Schema, fixture.Baseline, state ?? snapshot, time ?? fixture.Time, failed ?? context);
        Check(Verify() is RecoveryMetadataVerification.Authenticated, "fresh exact recovery metadata with retained expired baseline");
        Check(Verify(context with { RemainingAttempts = 0 }) is RecoveryMetadataVerification.Refused, "second recovery attempt refused");
        Check(Verify(context with { CandidateArtifactSha256 = Digest('a') }) is RecoveryMetadataVerification.Refused, "wrong failed candidate");
        Check(Verify(context with { CandidateEnvelopeSha256 = Digest('a') }) is RecoveryMetadataVerification.Refused, "wrong candidate envelope");
        Check(Verify(context with { BaselineEnvelopeSha256 = Digest('a') }) is RecoveryMetadataVerification.Refused, "wrong recovery baseline");
        Check(Verify(context with { AcceptedTrustRevision = 5 }) is RecoveryMetadataVerification.Refused, "stale trust position");
        Check(Verify(state: snapshot with { HighestAcceptedSequence = 102 }) is RecoveryMetadataVerification.Refused, "newer accepted transaction cannot recover old candidate");
        Check(Verify(time: new(true, Now + 1001)) is RecoveryMetadataVerification.Refused, "expired current recovery authorization");
        Check(Verify(state: snapshot with { FailedCandidateDigests = new HashSet<string>() }) is RecoveryMetadataVerification.Refused, "no failed transaction quarantine");
        foreach (var mutate in new Action<JsonObject>[] {
            node => node["roots"]![0]!["algorithm"] = "ecdsa-p384-sha384", node => node["roots"]![0]!["roles"] = new JsonArray("release", "release"),
            node => node["roots"]![0]!["spkiSha256"] = Digest('0'), node => node["revision"] = 2,
            node => node["roots"]![0]!["extra"] = true,
            node => node["authorities"]![0]!["buildConfigDigestRule"] = "*",
            node => { node["authorities"]![0]!.AsObject().Remove("buildConfigDigestRule"); node["authorities"]![0]!["buildConfigDigest"] = new string('a', 40); }
        })
        {
            var changed = (JsonObject)fixture.Policy.DeepClone(); mutate(changed);
            var refused = false; try { _ = ReleaseTrustPolicy.Parse(Wire.Encode(changed)); } catch (Refusal) { refused = true; }
            Check(refused, "malformed policy refused");
        }
        var canonical = fixture.Key.ExportSubjectPublicKeyInfo();
        var nonCanonical = new byte[canonical.Length + 1]; nonCanonical[0] = 0x30; nonCanonical[1] = 0x81; nonCanonical[2] = canonical[1]; canonical.AsSpan(2).CopyTo(nonCanonical.AsSpan(3));
        var nonDerPolicy = (JsonObject)fixture.Policy.DeepClone(); nonDerPolicy["roots"]![0]!["spkiBase64"] = Convert.ToBase64String(nonCanonical); nonDerPolicy["roots"]![0]!["spkiSha256"] = ReleaseTrustPolicy.Hash(nonCanonical);
        var rejected = false; try { _ = ReleaseTrustPolicy.Parse(Wire.Encode(nonDerPolicy)); } catch (Refusal) { rejected = true; }
        Check(rejected, "noncanonical DER SPKI rejected even with matching declared digest");
        using var wrongCurve = ECDsa.Create(ECCurve.NamedCurves.nistP384);
        var wrongSpki = wrongCurve.ExportSubjectPublicKeyInfo();
        nonDerPolicy["roots"]![0]!["spkiBase64"] = Convert.ToBase64String(wrongSpki); nonDerPolicy["roots"]![0]!["spkiSha256"] = ReleaseTrustPolicy.Hash(wrongSpki);
        rejected = false; try { _ = ReleaseTrustPolicy.Parse(Wire.Encode(nonDerPolicy)); } catch (Refusal) { rejected = true; }
        Check(rejected, "non-P256 root rejected");
    }

    private static void ImmutableInputs(Fixture fixture)
    {
        var keyBytes = fixture.Key.ExportSubjectPublicKeyInfo(); var retained = keyBytes.ToArray();
        var roles = new HashSet<string> { "release", "recovery" };
        var root = new ReleaseRoot("isolated", keyBytes, roles, 0, Now + 1000, false, true);
        keyBytes[0] ^= 1; roles.Clear();
        Check(root.Spki.SequenceEqual(retained) && root.Roles.Contains("release") && root.Roles.Contains("recovery"), "root key bytes and role policy cannot drift after digest binding");
        var failed = new HashSet<string> { Digest('a') };
        var snapshot = new ReleaseTrustSnapshot(1, 2, 100, Now, failed); var digest = snapshot.Digest;
        failed.Clear(); failed.Add(Digest('d'));
        Check(snapshot.Digest == digest && snapshot.FailedCandidateDigests.Contains(Digest('a')) && !snapshot.FailedCandidateDigests.Contains(Digest('d')), "quarantine snapshot frozen against caller mutation");
        var original = fixture.Baseline.OriginalEnvelope.ToArray();
        var baseline = new RetainedInstallationBaseline(original, fixture.Baseline.EnvelopeSha256, fixture.Baseline.Version, fixture.Baseline.Sequence,
            fixture.Baseline.Artifact, fixture.Baseline.Provenance, fixture.Baseline.Contracts, fixture.Baseline.AcceptedAt, fixture.Baseline.NativeAcceptanceReceiptSha256);
        original[0] ^= 1;
        Check(ReleaseTrustPolicy.Hash(baseline.OriginalEnvelope) == baseline.EnvelopeSha256, "retained baseline bytes copied before authentication");
    }

    internal static int RunInterop(string filename)
    {
        var before = assertions;
        using var document = ReleaseJson.Parse(File.ReadAllBytes(filename), 131_072, 16);
        var fixture = document.RootElement;
        var policy = ReleaseTrustPolicy.Parse(Encoding.UTF8.GetBytes(fixture.GetProperty("policy").GetRawText()));
        var candidate = ReleaseValues.Base64(ReleaseValues.Text(fixture, "candidateEnvelope"));
        var originalBytes = ReleaseValues.Base64(ReleaseValues.Text(fixture, "baselineEnvelope"));
        using var originalEnvelope = ReleaseJson.Parse(originalBytes, Schema.EnvelopeBytes);
        using var original = ReleaseJson.Parse(ReleaseValues.Base64(ReleaseValues.Text(originalEnvelope.RootElement, "payload")), Schema.PayloadBytes);
        var baselinePayload = original.RootElement;
        var contract = baselinePayload.GetProperty("compatibility");
        var baseline = new RetainedInstallationBaseline(originalBytes, ReleaseTrustPolicy.Hash(originalBytes), ReleaseValues.Text(baselinePayload, "version"), ReleaseValues.Number(baselinePayload, "releaseSequence"),
            SignedRelease.Identity(baselinePayload.GetProperty("artifact")), SignedRelease.Identity(baselinePayload.GetProperty("provenance")),
            new ReleaseContracts(ReleaseValues.Text(contract, "migrationContractSha256"), ReleaseValues.Text(contract, "workerContractSha256"), ReleaseValues.Text(contract, "serviceContractSha256")),
            ReleaseValues.Number(fixture, "baselineAcceptedAt"), ReleaseValues.Text(fixture, "baselineAcceptanceReceiptSha256"));
        var trust = fixture.GetProperty("trust");
        static ulong FixtureNumber(JsonElement value, string name) => value.GetProperty(name).ValueKind == JsonValueKind.String
            ? ReleaseValues.Number(value, name) : value.GetProperty(name).GetUInt64();
        var snapshot = new ReleaseTrustSnapshot(FixtureNumber(trust, "generation"), FixtureNumber(trust, "revision"), ReleaseValues.Number(trust, "highestAcceptedSequence"), ReleaseValues.Number(trust, "lastAcceptedTime"),
            trust.GetProperty("failedCandidateDigests").EnumerateArray().Select(value => value.GetString()!).ToHashSet(StringComparer.Ordinal));
        var time = new ReleaseTimeObservation(true, ReleaseValues.Number(fixture, "now"));
        var result = ReleaseMetadataVerifier.VerifyOffer(candidate, policy, Schema, baseline, snapshot, time);
        Check(result is ReleaseMetadataVerification.Authenticated, "actual Node to .NET metadata interoperability " + result);
        Check(ReleaseMetadataVerifier.VerifyOffer(candidate, ReleaseTrustPolicy.Embedded(), Schema, baseline, snapshot, time)
            is ReleaseMetadataVerification.Refused { Reason: "RELEASE_TRUST_UNCONFIGURED" }, "Node disposable fixture cannot enter production policy");
        var changed = candidate.ToArray(); changed[^3] ^= 1;
        Check(ReleaseMetadataVerifier.VerifyOffer(changed, policy, Schema, baseline, snapshot, time) is ReleaseMetadataVerification.Refused, "changed Node envelope refused");
        if (fixture.TryGetProperty("malformedCases", out var malformed))
            foreach (var item in malformed.EnumerateArray()) Check(ReleaseMetadataVerifier.VerifyOffer(ReleaseValues.Base64(ReleaseValues.Text(item, "envelope")), policy, Schema, baseline, snapshot, time)
                is ReleaseMetadataVerification.Refused, "shared malformed fixture " + ReleaseValues.Text(item, "name"));
        Console.WriteLine($"UPDATE_RELEASE_NODE_NATIVE_INTEROP_PASSED={assertions - before}");
        return assertions - before;
    }
}
