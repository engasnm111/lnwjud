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
    private static JsonObject Identity(string version, char hash, string size = "1000") => new()
    { ["name"] = "lnwjud-Setup-" + version + ".exe", ["sha256"] = Digest(hash), ["sizeBytes"] = size };
    private static JsonObject Provenance(char hash) => new() { ["name"] = "PROVENANCE.json", ["sha256"] = Digest(hash), ["sizeBytes"] = "200" };
    private static JsonObject Payload(string version, ulong sequence, string previousVersion, ulong previousSequence,
        string previousEnvelope, char artifact, char provenance, char previousArtifact, char previousProvenance, ulong issued, ulong expires) => new()
    {
        ["protocol"] = 1, ["product"] = "lnwjud", ["policyRevision"] = 1, ["releaseId"] = "release-" + version,
        ["channel"] = "stable", ["platform"] = "win32", ["architecture"] = "x64", ["distribution"] = "windows-nsis",
        ["version"] = version, ["releaseSequence"] = Wire.Decimal(sequence), ["issuedAt"] = Wire.Decimal(issued), ["notBefore"] = Wire.Decimal(issued), ["expiresAt"] = Wire.Decimal(expires),
        ["source"] = new JsonObject { ["repository"] = "https://github.com/engasnm111/lnwjud", ["commit"] = new string('a', 40), ["workflow"] = ".github/workflows/ci.yml", ["ref"] = "refs/heads/main", ["runId"] = "123", ["runAttempt"] = "1" },
        ["buildEvidence"] = new JsonObject { ["kind"] = "github-artifact-attestation-v1", ["artifactAttestationSha256"] = Digest('1'), ["provenanceAttestationSha256"] = Digest('2'), ["sourceTree"] = "clean" },
        ["artifact"] = Identity(version, artifact), ["provenance"] = Provenance(provenance),
        ["previous"] = new JsonObject { ["version"] = previousVersion, ["releaseSequence"] = Wire.Decimal(previousSequence), ["envelopeSha256"] = previousEnvelope, ["artifact"] = Identity(previousVersion, previousArtifact), ["provenance"] = Provenance(previousProvenance) },
        ["compatibility"] = new JsonObject { ["migrationContractSha256"] = Digest('f'), ["workerContractSha256"] = Digest('f'), ["serviceContractSha256"] = Digest('f') },
        ["recoveryAuthorization"] = new JsonObject { ["purpose"] = "failed-candidate-only", ["candidateArtifactSha256"] = Digest(artifact), ["candidateReleaseSequence"] = Wire.Decimal(sequence), ["previousEnvelopeSha256"] = previousEnvelope,
            ["previousArtifactSha256"] = Digest(previousArtifact), ["previousProvenanceSha256"] = Digest(previousProvenance), ["expiresAt"] = Wire.Decimal(expires), ["maximumAttempts"] = 1 }
    };

    private sealed class Fixture : IDisposable
    {
        internal readonly ECDsa Key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        internal readonly JsonObject Policy;
        internal readonly RetainedInstallationBaseline Baseline;
        internal readonly JsonObject Offer;
        internal ReleaseTrustSnapshot Snapshot = new(4, 6, 100, Now - 1000, new HashSet<string>(StringComparer.Ordinal));
        internal readonly ReleaseTimeObservation Time = new(true, Now);
        internal Fixture()
        {
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
            var original = Payload("5.9.0", 100, "5.8.0", 99, Digest('5'), 'b', 'c', '3', '4', Now - 100_000, Now - 50_000);
            var originalEnvelope = Sign(original);
            Baseline = new RetainedInstallationBaseline(originalEnvelope, ReleaseTrustPolicy.Hash(originalEnvelope), "5.9.0", 100,
                new ReleaseArtifact("lnwjud-Setup-5.9.0.exe", Digest('b'), 1000), new ReleaseArtifact("PROVENANCE.json", Digest('c'), 200),
                new ReleaseContracts(Digest('f'), Digest('f'), Digest('f')), Now - 90_000, Digest('7'));
            Offer = Payload("5.9.1", 101, "5.9.0", 100, Baseline.EnvelopeSha256, 'd', 'e', 'b', 'c', Now - 100, Now + 1000);
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
        var accepted = fixture.Verify();
        Check(accepted is ReleaseMetadataVerification.Authenticated, "metadata positive " + accepted);
        var metadata = ((ReleaseMetadataVerification.Authenticated)accepted).Metadata;
        Check(metadata.HistoricalPreviousEligibilityOnly && metadata.Receipt.ExpectedGeneration == 4 && metadata.Receipt.ExpectedRevision == 6, "metadata receipt bound to snapshot with recovery eligibility only");
        var before = fixture.Snapshot.Digest;
        _ = fixture.Verify(); Check(fixture.Snapshot.Digest == before, "verification never mutates trust floor");
        Check(fixture.Verify(policy: ReleaseTrustPolicy.Embedded()) is ReleaseMetadataVerification.Refused { Reason: "RELEASE_TRUST_UNCONFIGURED" }, "production embedded roots empty");
        Check(ReleaseMetadataVerifier.VerifyOffer(fixture.Sign(fixture.Offer), ReleaseTrustPolicy.Parse(Wire.Encode(fixture.Policy)), Schema, null, fixture.Snapshot, fixture.Time)
            is ReleaseMetadataVerification.Refused { Reason: "RELEASE_TRUSTED_BASELINE_UNAVAILABLE" }, "missing installed baseline refuses");
        Check(fixture.Verify(time: new(false, Now)) is ReleaseMetadataVerification.Refused, "unknown clock");
        Check(fixture.Verify(time: new(true, Now - 2000)) is ReleaseMetadataVerification.Refused { Reason: "RELEASE_CLOCK_ROLLBACK" }, "clock rollback");
        Check(fixture.Verify(snapshot: fixture.Snapshot with { HighestAcceptedSequence = 101 }) is ReleaseMetadataVerification.Refused, "replay floor");
        Check(fixture.Verify(snapshot: fixture.Snapshot with { FailedCandidateDigests = new HashSet<string> { Digest('d') } }) is ReleaseMetadataVerification.Refused, "failed candidate quarantine");
        Check(fixture.Verify(baseline: fixture.Baseline with { NativeAcceptanceReceiptSha256 = "" }) is ReleaseMetadataVerification.Refused, "unsigned baseline missing native receipt");
        Check(fixture.Verify(baseline: fixture.Baseline with { EnvelopeSha256 = Digest('0') }) is ReleaseMetadataVerification.Refused, "retained original envelope exact digest");
        Check(fixture.Verify(fixture.SignBytes(Encoding.UTF8.GetBytes(" \n" + fixture.Offer.ToJsonString() + "\n"))) is ReleaseMetadataVerification.Authenticated, "verify exact payload bytes rather than reserialized JSON");

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
            node => node["roots"]![0]!["expiresAt"] = Wire.Decimal(Now), node => node["authorities"]![0]!["ref"] = "refs/heads/dev"
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
