using System.Text.Json.Nodes;
using System.Security.Cryptography;
using Lnwjud.UpdateWorker;

internal static class ReleaseAuthorizationV2Tests
{
    private static int assertions;
    private static void Check(bool value, string message) { assertions++; if (!value) throw new Exception(message); }

    internal static int Run(string fixturePath)
    {
        assertions = 0;
        using var document = ReleaseJson.Parse(File.ReadAllBytes(fixturePath), 65_536);
        var fixture = document.RootElement;
        var policy = ReleaseTrustPolicy.Parse(Wire.Utf8.GetBytes(fixture.GetProperty("policy").GetRawText()));
        var now = Wire.Decimal(fixture.GetProperty("now").GetString()!);
        var time = new ReleaseTimeObservation(true, now);
        byte[] Bytes(string name) => Convert.FromBase64String(fixture.GetProperty(name).GetString()!);
        var first = ReleaseAuthorizationV2.Authenticate(Bytes("baselineEnvelope"), policy, time, ReleaseAuthorizationPurpose.Baseline);
        var renewed = ReleaseAuthorizationV2.Authenticate(Bytes("renewedEnvelope"), policy, new(true, now + 86_400), ReleaseAuthorizationPurpose.Baseline);
        var update = ReleaseAuthorizationV2.Authenticate(Bytes("updateEnvelope"), policy, time, ReleaseAuthorizationPurpose.Update);
        var unsigned = Wire.Utf8.GetBytes(update.Payload.GetRawText());
        var candidate = ReleaseAuthorizationV2.InspectUnsigned(unsigned, policy, time, ReleaseAuthorizationPurpose.Update, update.KeyId);
        Check(candidate.Artifact.Sha256 == SignedRelease.Identity(update.Payload.GetProperty("release").GetProperty("artifact")).Sha256,
            "unsigned inspection binds the candidate without authentication");
        Refused(() => ReleaseAuthorizationV2.InspectUnsigned(unsigned, policy, time, ReleaseAuthorizationPurpose.Baseline, update.KeyId), "unsigned wrong purpose refuses");
        Refused(() => ReleaseAuthorizationV2.InspectUnsigned(unsigned, policy, new(true, now + 3_600), ReleaseAuthorizationPurpose.Update, update.KeyId), "unsigned expired candidate refuses");
        Refused(() => ReleaseAuthorizationV2.InspectUnsigned(unsigned, policy, time, ReleaseAuthorizationPurpose.Update, "unknown"), "unsigned unknown key refuses");
        var badCandidate = JsonNode.Parse(unsigned)!.AsObject(); badCandidate["release"]!["source"]!["commit"] = "bad";
        Refused(() => ReleaseAuthorizationV2.InspectUnsigned(Wire.Encode(badCandidate), policy, time, ReleaseAuthorizationPurpose.Update, update.KeyId), "unsigned malformed candidate refuses");
        var directory = Path.Combine(Path.GetTempPath(), "lnwjud-unsigned-evidence-" + Guid.NewGuid().ToString("N"));
        try { _ = UnsignedEvidencePackage.Open(directory, ReleaseTrustPolicy.Embedded(), time, ReleaseAuthorizationPurpose.Update, update.KeyId); throw new Exception("unconfigured package accepted"); }
        catch (Refusal error) { Check(error.Reason == "RELEASE_TRUST_UNCONFIGURED", "unconfigured policy refuses before opening files"); }
        Directory.CreateDirectory(directory);
        try
        {
            var descriptor = JsonNode.Parse(unsigned)!.AsObject();
            var installer = Wire.Utf8.GetBytes("unsigned installer fixture");
            var provenance = Wire.Utf8.GetBytes("unsigned provenance fixture");
            var artifactBundle = Wire.Utf8.GetBytes("artifact attestation fixture");
            var provenanceBundle = Wire.Utf8.GetBytes("provenance attestation fixture");
            var release = descriptor["release"]!;
            release["artifact"]!["sha256"] = ReleaseTrustPolicy.Hash(installer); release["artifact"]!["sizeBytes"] = Wire.Decimal((ulong)installer.Length);
            release["provenance"]!["sha256"] = ReleaseTrustPolicy.Hash(provenance); release["provenance"]!["sizeBytes"] = Wire.Decimal((ulong)provenance.Length);
            release["buildEvidence"]!["artifactAttestationSha256"] = ReleaseTrustPolicy.Hash(artifactBundle);
            release["buildEvidence"]!["provenanceAttestationSha256"] = ReleaseTrustPolicy.Hash(provenanceBundle);
            var descriptorBytes = Wire.Encode(descriptor);
            File.WriteAllBytes(Path.Combine(directory, "CANDIDATE.json"), descriptorBytes);
            File.WriteAllBytes(Path.Combine(directory, release["artifact"]!["name"]!.GetValue<string>()), installer);
            File.WriteAllBytes(Path.Combine(directory, "PROVENANCE.json"), provenance);
            File.WriteAllBytes(Path.Combine(directory, "artifact.bundle.json"), artifactBundle);
            File.WriteAllBytes(Path.Combine(directory, "provenance.bundle.json"), provenanceBundle);
            using (var package = UnsignedEvidencePackage.Open(directory, policy, time, ReleaseAuthorizationPurpose.Update, update.KeyId))
            {
                Check(package.CandidateSha256 == ReleaseTrustPolicy.Hash(descriptorBytes), "retains exact inspected descriptor digest");
                package.Files.RecheckAll();
                Check(package.Candidate.Artifact.Sha256 == ReleaseTrustPolicy.Hash(installer), "pins actual candidate files");
                foreach (var name in new[] { "CANDIDATE.json", package.Candidate.Artifact.Name, "PROVENANCE.json", "artifact.bundle.json", "provenance.bundle.json" })
                {
                    var locked = false;
                    try { using var file = new FileStream(Path.Combine(directory, name), FileMode.Open, FileAccess.Write, FileShare.ReadWrite | FileShare.Delete); }
                    catch (IOException) { locked = true; }
                    Check(locked, "candidate input stays pinned: " + name);
                }
            }
            File.WriteAllText(Path.Combine(directory, "artifact.bundle.json"), "tampered");
            Refused(() => UnsignedEvidencePackage.Open(directory, policy, time, ReleaseAuthorizationPurpose.Update, update.KeyId), "changed bundle refuses");
        }
        finally { Directory.Delete(directory, true); }
        Check(first.IdentitySha256 == fixture.GetProperty("identitySha256").GetString(), "shared v2 identity");
        Check(typeof(SignedAuthorizationV2).GetProperties(System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.NonPublic)
            .All(property => property.SetMethod is null), "authenticated fields cannot be replaced");
        Check(renewed.IdentitySha256 == first.IdentitySha256 && renewed.EnvelopeSha256 != first.EnvelopeSha256, "renewal preserves identity without reusing envelope");
        Check(ReleaseValues.Text(update.Payload.GetProperty("recovery"), "previousReleaseIdentity") == first.IdentitySha256
            && update.IdentitySha256 == fixture.GetProperty("candidateIdentitySha256").GetString(), "update predecessor is signed");
        Refused(() => ReleaseAuthorizationV2.Authenticate(Bytes("baselineEnvelope"), policy, time, ReleaseAuthorizationPurpose.Update), "baseline cannot be an update");
        Refused(() => ReleaseAuthorizationV2.Authenticate(Bytes("updateEnvelope"), policy, time, ReleaseAuthorizationPurpose.Baseline), "update cannot be a baseline");
        Refused(() => ReleaseAuthorizationV2.Authenticate(Bytes("baselineEnvelope"), policy, new(true, now + 3_600), ReleaseAuthorizationPurpose.Baseline), "expired baseline refuses");
        Refused(() => ReleaseAuthorizationV2.Authenticate(Bytes("baselineEnvelope"), ReleaseTrustPolicy.Embedded(), time, ReleaseAuthorizationPurpose.Baseline), "empty production policy refuses");
        Refused(() => ReleaseAuthorizationV2.Authenticate(new byte[49_153], policy, time, ReleaseAuthorizationPurpose.Baseline), "oversized envelope refuses");
        var envelope = JsonNode.Parse(Bytes("baselineEnvelope"))!.AsObject();
        var signature = Convert.FromBase64String(envelope["signature"]!.GetValue<string>()); signature[0] ^= 1;
        envelope["signature"] = Convert.ToBase64String(signature);
        Refused(() => ReleaseAuthorizationV2.Authenticate(Wire.Encode(envelope), policy, time, ReleaseAuthorizationPurpose.Baseline), "tampered signature refuses");
        var revoked = JsonNode.Parse(fixture.GetProperty("policy").GetRawText())!.AsObject();
        revoked["roots"]![0]!["revoked"] = true;
        var revokedPolicy = ReleaseTrustPolicy.Parse(Wire.Encode(revoked));
        Refused(() => ReleaseAuthorizationV2.Authenticate(Bytes("baselineEnvelope"), revokedPolicy, time, ReleaseAuthorizationPurpose.Baseline), "revoked root refuses");
        RetainedAuthorizationV2 Retain(string name, string identity, string receipt, ulong accepted, ReleaseAuthorizationPurpose purpose = ReleaseAuthorizationPurpose.Baseline)
        {
            var original = Bytes(name);
            return new RetainedAuthorizationV2(original, purpose, ReleaseTrustPolicy.Hash(original), identity, receipt, accepted);
        }
        var receipt = new string('c', 64);
        Refused(() => new RetainedAuthorizationV2([], ReleaseAuthorizationPurpose.Baseline, new string('a', 64), first.IdentitySha256, receipt, now), "empty retained envelope refuses");
        Refused(() => new RetainedAuthorizationV2(new byte[49_153], ReleaseAuthorizationPurpose.Baseline, new string('a', 64), first.IdentitySha256, receipt, now), "oversized retained envelope refuses before copying");
        var retained = Retain("baselineEnvelope", first.IdentitySha256, receipt, now);
        var snapshot = new ReleaseTrustSnapshot(4, 6, 100, now, new HashSet<string>(StringComparer.Ordinal));
        var verified = ReleaseAuthorizationV2.VerifyOffer(Bytes("updateEnvelope"), policy, time, retained, snapshot);
        Check(verified.PreviousIdentitySha256 == first.IdentitySha256 && verified.Candidate.IdentitySha256 == update.IdentitySha256
            && verified.AcceptanceReceiptSha256 == receipt && verified.Generation == 4 && verified.Revision == 6, "offer metadata binds retained evidence and snapshot");
        var later = new ReleaseTimeObservation(true, now + 86_400);
        var refreshedBaseline = Retain("renewedEnvelope", first.IdentitySha256, receipt, later.UnixSeconds);
        var laterSnapshot = new ReleaseTrustSnapshot(4, 6, 100, later.UnixSeconds, new HashSet<string>(StringComparer.Ordinal));
        var oldOffer = ReleaseAuthorizationV2.VerifyOffer(Bytes("renewedUpdateEnvelope"), policy, later, retained, laterSnapshot);
        var renewedOffer = ReleaseAuthorizationV2.VerifyOffer(Bytes("renewedUpdateEnvelope"), policy, later, refreshedBaseline, laterSnapshot);
        Check(oldOffer.Candidate.IdentitySha256 == renewedOffer.Candidate.IdentitySha256
            && oldOffer.PreviousIdentitySha256 == renewedOffer.PreviousIdentitySha256
            && oldOffer.PreviousEnvelopeSha256 != renewedOffer.PreviousEnvelopeSha256, "one successor matches both refreshed baseline cohorts");
        Refused(() => ReleaseAuthorizationV2.VerifyOffer(Bytes("updateEnvelope"), policy, time, null, snapshot), "missing retained evidence refuses");
        Refused(() => ReleaseAuthorizationV2.VerifyOffer(Bytes("updateEnvelope"), policy, time, Retain("baselineEnvelope", new string('d', 64), receipt, now), snapshot), "wrong retained identity refuses");
        Refused(() => ReleaseAuthorizationV2.VerifyOffer(Bytes("updateEnvelope"), policy, time, Retain("baselineEnvelope", first.IdentitySha256, "bad", now), snapshot), "missing receipt reference refuses");
        Refused(() => ReleaseAuthorizationV2.VerifyOffer(Bytes("updateEnvelope"), policy, time, Retain("baselineEnvelope", first.IdentitySha256, receipt, now, ReleaseAuthorizationPurpose.Update), snapshot), "wrong retained purpose refuses");
        Refused(() => ReleaseAuthorizationV2.VerifyOffer(Bytes("updateEnvelope"), policy, time,
            new RetainedAuthorizationV2(Bytes("baselineEnvelope"), ReleaseAuthorizationPurpose.Baseline, new string('d', 64), first.IdentitySha256, receipt, now), snapshot), "tampered retained envelope digest refuses");
        Refused(() => ReleaseAuthorizationV2.VerifyOffer(Bytes("renewedUpdateEnvelope"), policy, later,
            Retain("baselineEnvelope", first.IdentitySha256, receipt, now + 3600), laterSnapshot), "acceptance at expiry refuses");
        Refused(() => ReleaseAuthorizationV2.VerifyOffer(Bytes("updateEnvelope"), policy, time, retained, snapshot with { Generation = 0 }), "zero trust generation refuses");
        Refused(() => ReleaseAuthorizationV2.VerifyOffer(Bytes("updateEnvelope"), policy, time, retained, snapshot with { Revision = 0 }), "zero trust revision refuses");
        Refused(() => ReleaseAuthorizationV2.VerifyOffer(Bytes("updateEnvelope"), policy, time, retained, snapshot with { HighestAcceptedSequence = 101 }), "replay floor refuses");
        Refused(() => ReleaseAuthorizationV2.VerifyOffer(Bytes("updateEnvelope"), policy, time, retained, snapshot with { LastAcceptedTime = now + 1 }), "clock rollback refuses");
        Refused(() => ReleaseAuthorizationV2.VerifyOffer(Bytes("updateEnvelope"), policy, time, retained,
            snapshot with { FailedCandidateDigests = new HashSet<string>(StringComparer.Ordinal) { new string('8', 64) } }), "quarantined candidate refuses");
        var noHistory = JsonNode.Parse(fixture.GetProperty("policy").GetRawText())!.AsObject();
        noHistory["roots"]![0]!["allowHistoricalRecovery"] = false;
        var noHistoryPolicy = ReleaseTrustPolicy.Parse(Wire.Encode(noHistory));
        Refused(() => ReleaseAuthorizationV2.VerifyOffer(Bytes("renewedUpdateEnvelope"), noHistoryPolicy, later, retained, laterSnapshot), "historical policy refuses expired baseline");
        using var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var spki = key.ExportSubjectPublicKeyInfo();
        var expandedPolicy = JsonNode.Parse(fixture.GetProperty("policy").GetRawText())!.AsObject();
        expandedPolicy["roots"]!.AsArray().Add(new JsonObject { ["keyId"] = "negative-fixture", ["algorithm"] = "ecdsa-p256-sha256-p1363",
            ["spkiBase64"] = Convert.ToBase64String(spki), ["spkiSha256"] = ReleaseTrustPolicy.Hash(spki), ["roles"] = new JsonArray("release", "recovery"),
            ["notBefore"] = "0", ["expiresAt"] = "2000000000", ["revoked"] = false, ["allowHistoricalRecovery"] = true });
        var extraPolicy = ReleaseTrustPolicy.Parse(Wire.Encode(expandedPolicy));
        byte[] SignCandidate(Action<JsonObject> change)
        {
            var value = JsonNode.Parse(update.Payload.GetRawText())!.AsObject(); change(value);
            var payloadBytes = Wire.Encode(value);
            var message = System.Text.Encoding.ASCII.GetBytes("lnwjud-update-release-v2\0").Concat(payloadBytes).ToArray();
            var signatureBytes = key.SignData(message, HashAlgorithmName.SHA256, DSASignatureFormat.IeeeP1363FixedFieldConcatenation);
            return Wire.Encode(new JsonObject { ["protocol"] = 2, ["keyId"] = "negative-fixture", ["payload"] = Convert.ToBase64String(payloadBytes), ["signature"] = Convert.ToBase64String(signatureBytes) });
        }
        Refused(() => ReleaseAuthorizationV2.VerifyOffer(SignCandidate(value => value["recovery"]!["previousReleaseIdentity"] = new string('d', 64)), extraPolicy, time, retained, snapshot), "signed wrong predecessor refuses");
        Refused(() => ReleaseAuthorizationV2.VerifyOffer(SignCandidate(value => value["release"]!["compatibility"]!["serviceContractSha256"] = new string('d', 64)), extraPolicy, time, retained, snapshot), "incompatible recovery contract refuses");
        Refused(() => ReleaseAuthorizationV2.VerifyOffer(SignCandidate(value => { value["release"]!["platform"] = "darwin"; value["release"]!["distribution"] = "macos-zip"; value["release"]!["artifact"]!["name"] = "lnwjud-5.9.1-x64.zip"; }), extraPolicy, time, retained, snapshot), "cross-target update refuses");
        Refused(() => ReleaseAuthorizationV2.VerifyOffer(SignCandidate(value => { value["release"]!["version"] = "5.8.9"; value["release"]!["artifact"]!["name"] = "lnwjud-Setup-5.8.9.exe"; }), extraPolicy, time, retained, snapshot), "downgrade version refuses");
        Refused(() => ReleaseAuthorizationV2.VerifyOffer(SignCandidate(value => value["release"]!["releaseSequence"] = "100"), extraPolicy, time, retained, snapshot), "non-increasing sequence refuses");
        var sameVersionNewArtifact = SignCandidate(value => {
            value["release"]!["version"] = "5.9.0";
            value["release"]!["artifact"]!["name"] = "lnwjud-Setup-5.9.0.exe";
            value["release"]!["artifact"]!["sha256"] = new string('9', 64);
        });
        var refreshed = ReleaseAuthorizationV2.VerifyOffer(sameVersionNewArtifact, extraPolicy, time, retained, snapshot);
        Check(refreshed.Candidate.IdentitySha256 != first.IdentitySha256, "signed newer-sequence same-version different-artifact refresh accepted");
        Refused(() => ReleaseAuthorizationV2.VerifyOffer(SignCandidate(value => {
            value["release"]!["version"] = "5.9.0";
            value["release"]!["artifact"]!["name"] = "lnwjud-Setup-5.9.0.exe";
            value["release"]!["artifact"]!["sha256"] = ReleaseValues.Text(first.Payload.GetProperty("release").GetProperty("artifact"), "sha256");
        }), extraPolicy, time, retained, snapshot), "same-version identical-artifact replay refuses");
        Refused(() => ReleaseAuthorizationV2.VerifyOffer(SignCandidate(value => value["recovery"]!["maximumAttempts"] = 2), extraPolicy, time, retained, snapshot), "multiple recovery attempts refuse");
        var updateBaseline = Retain("updateEnvelope", update.IdentitySha256, receipt, now, ReleaseAuthorizationPurpose.Update);
        var next = SignCandidate(value => { value["release"]!["version"] = "5.9.2"; value["release"]!["releaseSequence"] = "102";
            value["release"]!["artifact"]!["name"] = "lnwjud-Setup-5.9.2.exe"; value["release"]!["artifact"]!["sha256"] = new string('9', 64);
            value["recovery"]!["previousReleaseIdentity"] = update.IdentitySha256; });
        var second = ReleaseAuthorizationV2.VerifyOffer(next, extraPolicy, time, updateBaseline, snapshot with { HighestAcceptedSequence = 101 });
        Check(second.PreviousIdentitySha256 == update.IdentitySha256, "accepted update can be the next predecessor");
        var noRecovery = JsonNode.Parse(fixture.GetProperty("policy").GetRawText())!.AsObject();
        noRecovery["roots"]![0]!["roles"] = new JsonArray("release");
        var noRecoveryPolicy = ReleaseTrustPolicy.Parse(Wire.Encode(noRecovery));
        Refused(() => ReleaseAuthorizationV2.VerifyOffer(Bytes("renewedUpdateEnvelope"), noRecoveryPolicy, later, retained, laterSnapshot), "historical root without recovery role refuses");
        Refused(() => ReleaseAuthorizationV2.VerifyOffer(Bytes("renewedUpdateEnvelope"), revokedPolicy, later, retained, laterSnapshot), "currently revoked historical root refuses");
        Console.WriteLine($"RELEASE_AUTHORIZATION_V2_ASSERTIONS_PASSED={assertions}");
        return assertions;
    }

    private static void Refused(Action action, string message)
    {
        var refused = false;
        try { action(); } catch (Refusal) { refused = true; }
        Check(refused, message);
    }
}
