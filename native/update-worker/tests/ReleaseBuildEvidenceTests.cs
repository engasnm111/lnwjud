using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Lnwjud.UpdateWorker;

internal sealed class EvidenceFixture : IDisposable
{
    internal readonly ReleaseMetadataTests.Fixture Metadata = new();
    internal readonly JsonObject Payload;
    internal readonly JsonObject Provenance;
    internal readonly string DirectoryPath = Path.Combine(Path.GetTempPath(), "lnwjud-evidence-" + Guid.NewGuid().ToString("N"));
    internal ReleaseTrustPolicy Policy => ReleaseTrustPolicy.Parse(Wire.Encode(Metadata.Policy));
    internal SignedRelease Release => ReleaseMetadataVerifier.AuthenticateInitial(Metadata.Sign(Payload), Policy, ReleaseSchema.Embedded(), Metadata.Time);
    internal JsonObject Run => new() { ["status"] = "completed", ["conclusion"] = "success", ["event"] = "push",
        ["head_sha"] = new string('a', 40), ["head_branch"] = "main", ["path"] = ".github/workflows/ci.yml", ["id"] = 123, ["run_attempt"] = 1 };
    internal EvidenceFixture()
    {
        Directory.CreateDirectory(DirectoryPath);
        Payload = (JsonObject)Metadata.Offer.DeepClone();
        var installer = Encoding.UTF8.GetBytes("isolated installer fixture");
        Payload["artifact"]!["sha256"] = ReleaseTrustPolicy.Hash(installer);
        Payload["artifact"]!["sizeBytes"] = Wire.Decimal((ulong)installer.Length);
        Payload["recoveryAuthorization"]!["candidateArtifactSha256"] = ReleaseTrustPolicy.Hash(installer);
        Provenance = new JsonObject { ["product"] = "lnwjud", ["version"] = "5.9.1", ["platform"] = "win32", ["arch"] = "x64",
            ["source"] = new JsonObject { ["repository"] = "https://github.com/engasnm111/lnwjud", ["commit"] = new string('a', 40), ["dirty"] = false },
            ["build"] = new JsonObject { ["environment"] = "github-actions", ["runId"] = "123", ["runAttempt"] = "1", ["ref"] = "refs/heads/main" },
            ["artifacts"] = new JsonArray(Payload["artifact"]!.DeepClone()) };
        var provenance = Wire.Encode(Provenance);
        Payload["provenance"]!["sha256"] = ReleaseTrustPolicy.Hash(provenance);
        Payload["provenance"]!["sizeBytes"] = Wire.Decimal((ulong)provenance.Length);
        File.WriteAllBytes(Path.Combine(DirectoryPath, "lnwjud-Setup-5.9.1.exe"), installer);
        File.WriteAllBytes(Path.Combine(DirectoryPath, "PROVENANCE.json"), provenance);
        foreach (var kind in new[] { "artifact", "provenance" })
        {
            var bundle = Encoding.UTF8.GetBytes("isolated " + kind + " bundle");
            File.WriteAllBytes(Path.Combine(DirectoryPath, kind + ".bundle.json"), bundle);
            Payload["buildEvidence"]![kind + "AttestationSha256"] = ReleaseTrustPolicy.Hash(bundle);
        }
        WriteMetadata();
    }
    internal void WriteMetadata()
    {
        var releaseBytes = Metadata.Sign(Payload);
        var layout = new JsonObject { ["protocol"] = 1, ["product"] = "lnwjud", ["policyRevision"] = 1,
            ["releaseEnvelopeSha256"] = ReleaseTrustPolicy.Hash(releaseBytes) };
        foreach (var name in new[] { "releaseId", "channel", "platform", "architecture", "distribution", "version", "releaseSequence", "source", "artifact", "provenance" })
            layout[name] = Payload[name]!.DeepClone();
        var roles = new JsonObject();
        foreach (var name in new[] { "stableLauncher", "stableService", "slotApplication", "slotManifest" })
            roles[name] = new JsonObject { ["path"] = name + ".exe", ["sha256"] = new string('1', 64), ["sizeBytes"] = "1" };
        layout["layout"] = roles;
        File.WriteAllBytes(Path.Combine(DirectoryPath, "RELEASE.json"), releaseBytes);
        File.WriteAllBytes(Path.Combine(DirectoryPath, "ENROLLMENT.json"), Metadata.SignBytes(Wire.Encode(layout), "lnwjud-enrollment-layout-v1\0"));
    }
    internal JsonArray Attestation(ReleaseArtifact identity)
    {
        var authority = Policy.Sources[0];
        return new JsonArray(new JsonObject { ["verificationResult"] = new JsonObject {
            ["signature"] = new JsonObject { ["certificate"] = new JsonObject {
                ["issuer"] = authority.Issuer, ["subjectAlternativeName"] = authority.BuilderWorkflowUri,
                ["sourceRepositoryURI"] = authority.Repository, ["sourceRepositoryDigest"] = new string('a', 40),
                ["sourceRepositoryRef"] = authority.Ref, ["buildSignerURI"] = authority.BuilderWorkflowUri,
                ["buildSignerDigest"] = authority.BuilderDigest, ["buildConfigURI"] = authority.BuildConfigUri,
                ["buildConfigDigest"] = new string('a', 40), ["runnerEnvironment"] = "github-hosted",
                ["runInvocationURI"] = authority.Repository + "/actions/runs/123/attempts/1" } },
            ["verifiedTimestamps"] = new JsonArray(new JsonObject { ["type"] = "Tlog", ["uri"] = "https://rekor.sigstore.dev",
                ["timestamp"] = DateTimeOffset.FromUnixTimeSeconds((long)Release.Number("issuedAt")).ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", System.Globalization.CultureInfo.InvariantCulture) }),
            ["statement"] = new JsonObject { ["predicateType"] = "https://slsa.dev/provenance/v1", ["subject"] = new JsonArray(new JsonObject {
                ["name"] = identity.Name, ["digest"] = new JsonObject { ["sha256"] = identity.Sha256 } }) } } });
    }
    public void Dispose() { Metadata.Dispose(); Directory.Delete(DirectoryPath, true); }
}

internal static class ReleaseBuildEvidenceTests
{
    private static int assertions;
    private static byte[] Bytes(JsonNode value) => Encoding.UTF8.GetBytes(value.ToJsonString());
    private static void Accept(Action action, string name) { action(); assertions++; }
    private static void Refuse(Action action, string name)
    {
        try { action(); } catch { assertions++; return; }
        throw new Exception("Expected refusal " + name);
    }
    internal static int Run()
    {
        assertions = 0;
        using var fixture = new EvidenceFixture();
        var release = fixture.Release; var authority = fixture.Policy.Sources[0];
        var candidate = ReleaseEvidenceCandidate.FromSigned(release);
        ReleaseEvidenceCandidate unsignedCandidate;
        using (var document = JsonDocument.Parse(Bytes(fixture.Payload)))
            unsignedCandidate = new ReleaseEvidenceCandidate(document.RootElement, release.Number("issuedAt"));
        void Attestation(JsonNode value) => ReleaseBuildEvidence.RequireAttestation(Bytes(value), candidate, release.Artifact, authority);
        var valid = fixture.Attestation(release.Artifact);
        foreach (var token in new[] { "-1", "1.0", "1e0", "9007199254740992" })
        {
            var unknownNumber = valid.DeepClone(); unknownNumber[0]!["unrelated"] = JsonNode.Parse(token);
            Refuse(() => Attestation(unknownNumber), "producer rejects unknown-field numeric token " + token);
        }
        Accept(() => Attestation(valid), "bound attestation");
        Accept(() => Attestation(new JsonArray(valid[0]!.DeepClone(), valid[0]!.DeepClone())), "multiple matching entries");
        Accept(() => Attestation(new JsonArray(new JsonObject(), valid[0]!.DeepClone())), "unmatched entry does not hide valid entry");
        var fraction = valid.DeepClone(); fraction[0]!["verificationResult"]!["verifiedTimestamps"]![0]!["timestamp"] = "2026-01-01T00:00:00.123456789Z";
        Accept(() => Attestation(fraction), "nine fractional digits");
        var tooMany = valid.DeepClone(); var times = tooMany[0]!["verificationResult"]!["verifiedTimestamps"]!.AsArray();
        while (times.Count < 16) times.Add(times[0]!.DeepClone());
        Accept(() => Attestation(tooMany), "sixteen timestamps");
        times.Add(times[0]!.DeepClone()); Refuse(() => Attestation(tooMany), "timestamp bound");
        var manyEntries = new JsonArray(); for (var i = 0; i < 65; i++) manyEntries.Add(valid[0]!.DeepClone());
        Refuse(() => Attestation(manyEntries), "entry bound");
        Accept(() => ReleaseBuildEvidence.RequireRun(Bytes(fixture.Run), candidate), "exact run");
        Accept(() => ReleaseBuildEvidence.RequireProvenance(Bytes(fixture.Provenance), candidate), "bound provenance");
        Accept(() => ReleaseBuildEvidence.RequireProvenance(Bytes(fixture.Provenance), unsignedCandidate), "candidate survives source document disposal");
        foreach (var field in valid[0]!["verificationResult"]!["signature"]!["certificate"]!.AsObject().Select(pair => pair.Key).ToArray())
        {
            var mutated = valid.DeepClone(); mutated[0]!["verificationResult"]!["signature"]!["certificate"]![field] = "wrong";
            Refuse(() => Attestation(mutated), "certificate " + field);
        }
        foreach (var mutation in new Action<JsonNode>[] {
            v => v[0]!["verificationResult"]!["signature"] = null,
            v => v[0]!["verificationResult"]!["statement"]!["predicateType"] = "wrong",
            v => v[0]!["verificationResult"]!["statement"]!["subject"]![0]!["name"] = "wrong",
            v => v[0]!["verificationResult"]!["statement"]!["subject"]![0]!["digest"]!["sha256"] = new string('f', 64),
            v => v[0]!["verificationResult"]!["verifiedTimestamps"] = new JsonArray(),
            v => v[0]!["verificationResult"]!["verifiedTimestamps"]![0]!["type"] = "TimestampAuthority",
            v => v[0]!["verificationResult"]!["verifiedTimestamps"]![0]!["extra"] = true,
            v => v[0]!["verificationResult"]!["verifiedTimestamps"]!.AsArray().Add(new JsonObject { ["type"] = "Tlog", ["uri"] = "http://bad", ["timestamp"] = "2000-01-01T00:00:00Z" })
        }) { var changed = valid.DeepClone(); mutation(changed); Refuse(() => Attestation(changed), "evidence shape"); }
        foreach (var timestamp in new[] { "2026-02-30T00:00:00Z", "2026-01-01T00:00:60Z", "1969-12-31T23:59:59Z", "9999-12-31T23:59:59Z", "2026-01-01T00:00:00.1234567890Z", "2026-01-01T00:00:00+00:00" })
        {
            var changed = valid.DeepClone(); changed[0]!["verificationResult"]!["verifiedTimestamps"]![0]!["timestamp"] = timestamp;
            Refuse(() => Attestation(changed), "timestamp " + timestamp);
        }
        foreach (var uri in new[] { "http://example.com", "https://user@example.com", "https://example.com/#fragment", "relative", "https://" })
        {
            var changed = valid.DeepClone(); changed[0]!["verificationResult"]!["verifiedTimestamps"]![0]!["uri"] = uri;
            Refuse(() => Attestation(changed), "timestamp URI");
        }
        foreach (var field in fixture.Run.Select(pair => pair.Key))
        {
            var changed = fixture.Run; changed[field] = "wrong";
            Refuse(() => ReleaseBuildEvidence.RequireRun(Bytes(changed), candidate), "run " + field);
        }
        foreach (var token in new[] { "1.23e2", "123.0", "9007199254740992", "-123", "null" })
            Refuse(() => ReleaseBuildEvidence.RequireRun(Encoding.UTF8.GetBytes(fixture.Run.ToJsonString().Replace("\"id\":123", "\"id\":" + token)), candidate), "run integer " + token);
        foreach (var field in new[] { "product", "version", "platform", "arch" })
        {
            var changed = fixture.Provenance.DeepClone(); changed[field] = "wrong";
            Refuse(() => ReleaseBuildEvidence.RequireProvenance(Bytes(changed), candidate), "provenance " + field);
        }
        foreach (var section in new[] { "source", "build" })
            foreach (var field in fixture.Provenance[section]!.AsObject().Select(pair => pair.Key))
            {
                var changed = fixture.Provenance.DeepClone(); changed[section]![field] = "wrong";
                Refuse(() => ReleaseBuildEvidence.RequireProvenance(Bytes(changed), candidate), "provenance " + section + field);
            }
        foreach (var field in new[] { "name", "sha256", "sizeBytes" })
        {
            var changed = fixture.Provenance.DeepClone(); changed["artifacts"]![0]![field] = "wrong";
            Refuse(() => ReleaseBuildEvidence.RequireProvenance(Bytes(changed), candidate), "provenance artifact " + field);
        }
        var duplicated = fixture.Provenance.DeepClone(); duplicated["artifacts"]!.AsArray().Add(duplicated["artifacts"]![0]!.DeepClone());
        Refuse(() => ReleaseBuildEvidence.RequireProvenance(Bytes(duplicated), candidate), "duplicate artifact");
        foreach (var bytes in new[] { new byte[] { 0xff }, new byte[ReleaseBuildEvidence.MaximumOutput + 1], Encoding.UTF8.GetPreamble().Concat(Bytes(valid)).ToArray(),
            Encoding.UTF8.GetBytes("[{\"verificationResult\":{},\"verificationResult\":{}}]"), Encoding.UTF8.GetBytes(new string('[', 65) + new string(']', 65)) })
            Refuse(() => ReleaseBuildEvidence.RequireAttestation(bytes, candidate, release.Artifact, authority), "strict JSON");
        Console.WriteLine("RELEASE_BUILD_EVIDENCE_ASSERTIONS_PASSED=" + assertions);
        return assertions;
    }
}
