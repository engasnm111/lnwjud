using System.Diagnostics;
using System.IO.Pipes;
using System.Net;
using System.Text.Json;
using Lnwjud.UpdateWorker;

namespace Lnwjud.Containment;

internal abstract record AttestationPreflightResult
{
    internal sealed record Authenticated(EnrollmentPreflightResult.Authenticated Metadata) : AttestationPreflightResult;
    internal sealed record Refused(string Reason) : AttestationPreflightResult;
    internal sealed record Held(AttestationOwner Owner) : AttestationPreflightResult;
}

internal static class EnrollmentAttestationPreflight
{
    internal static AttestationPreflightResult VerifyPackage(string directory, ReleaseTrustPolicy policy, ReleaseSchema schema, ReleaseTimeObservation time)
    {
        var owner = new AttestationOwner();
        AttestationPreflightResult result;
        try { result = new AttestationPreflightResult.Authenticated(owner.Verify(directory, policy, schema, time)); }
        catch (Refusal error) { result = new AttestationPreflightResult.Refused(error.Reason); }
        catch { result = new AttestationPreflightResult.Refused("RELEASE_ATTESTATION_REFUSED"); }
        return owner.TryFinishCleanup(TimeSpan.FromSeconds(10)) ? result : new AttestationPreflightResult.Held(owner);
    }
}

internal abstract record CandidateAttestationResult
{
    internal sealed record Observed(string CandidateSha256) : CandidateAttestationResult;
    internal sealed record Refused(string Reason) : CandidateAttestationResult;
    internal sealed record Held(AttestationOwner Owner) : CandidateAttestationResult;
}

internal static class CandidateAttestationPreflight
{
    internal static CandidateAttestationResult VerifyPackage(string directory, ReleaseTrustPolicy policy, ReleaseTimeObservation time,
        ReleaseAuthorizationPurpose purpose, string keyId)
    {
        var owner = new AttestationOwner();
        CandidateAttestationResult result;
        try { result = new CandidateAttestationResult.Observed(owner.VerifyUnsigned(directory, policy, time, purpose, keyId)); }
        catch (Refusal error) { result = new CandidateAttestationResult.Refused(error.Reason); }
        catch { result = new CandidateAttestationResult.Refused("RELEASE_ATTESTATION_REFUSED"); }
        return owner.TryFinishCleanup(TimeSpan.FromSeconds(10)) ? result : new CandidateAttestationResult.Held(owner);
    }
}

internal sealed class AttestationOwner
{
    private AuthenticatedEnrollmentPackage? package;
    private UnsignedEvidencePackage? unsignedPackage;
    private EnrollmentPackageFiles? verifier;
    private string? scratch;
    private readonly Stopwatch work = Stopwatch.StartNew();
    private readonly List<Attempt> attempts = [];
    private bool released;
#if NATIVE_CONTAINMENT_TESTS
    internal static Func<ReleaseEvidenceCandidate, byte[]>? RunResponse { get; set; }
    internal static Action<string, string>? Observe { get; set; }
#endif
    private sealed class Attempt
    {
        internal readonly ContainedProcess.LaunchOwnership Ownership = new();
        internal readonly AnonymousPipeServerStream Output = new(PipeDirection.In, HandleInheritability.None);
        internal readonly AnonymousPipeServerStream Error = new(PipeDirection.In, HandleInheritability.None);
        internal Task<byte[]>? OutputRead, ErrorRead;
        internal int Bytes;
        internal string State = "created";
    }

    internal EnrollmentPreflightResult.Authenticated Verify(string directory, ReleaseTrustPolicy policy, ReleaseSchema schema, ReleaseTimeObservation time)
    {
        package = EnrollmentPreflight.OpenAuthenticated(directory, policy, schema, time);
        VerifyEvidence(ReleaseEvidenceCandidate.FromSigned(package.Release), package.Files, policy);
        return package.Metadata;
    }

    internal string VerifyUnsigned(string directory, ReleaseTrustPolicy policy, ReleaseTimeObservation time,
        ReleaseAuthorizationPurpose purpose, string keyId)
    {
        unsignedPackage = UnsignedEvidencePackage.Open(directory, policy, time, purpose, keyId);
        VerifyEvidence(unsignedPackage.Candidate, unsignedPackage.Files, policy);
        return unsignedPackage.CandidateSha256;
    }

    private void VerifyEvidence(ReleaseEvidenceCandidate candidate, EnrollmentPackageFiles files, ReleaseTrustPolicy policy)
    {
        var source = candidate.Payload.GetProperty("source");
        var authority = policy.SelectSource(ReleaseValues.Text(source, "repository"), ReleaseValues.Text(source, "workflow"), ReleaseValues.Text(source, "ref"));
        files.PinBundle("artifact.bundle.json", ReleaseValues.Text(candidate.Payload.GetProperty("buildEvidence"), "artifactAttestationSha256"));
        files.PinBundle("provenance.bundle.json", ReleaseValues.Text(candidate.Payload.GetProperty("buildEvidence"), "provenanceAttestationSha256"));
        var configured = policy.Verifier ?? throw new Refusal("RELEASE_TRUST_UNCONFIGURED");
        if (configured.Filename != "gh.exe") throw new Refusal("RELEASE_VERIFIER_UNTRUSTED");
        verifier = new EnrollmentPackageFiles(Path.Combine(AppContext.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar), "update-attestation"));
        var image = verifier.Read("gh.exe", 256 * 1024 * 1024);
        if (ReleaseTrustPolicy.Hash(image) != configured.Sha256) throw new Refusal("RELEASE_VERIFIER_UNTRUSTED");
        scratch = Directory.CreateTempSubdirectory("lnwjud-attestation-").FullName;
#if NATIVE_CONTAINMENT_TESTS
        Observe?.Invoke("pins_ready", scratch);
#endif
        var version = Wire.Utf8.GetString(RunCommand(["version"])).Split('\n')[0].TrimEnd('\r');
        if (!version.StartsWith($"gh version {configured.Version} ", StringComparison.Ordinal)) throw new Refusal("RELEASE_VERIFIER_UNTRUSTED");
        ReleaseBuildEvidence.RequireRun(ReadRun(candidate), candidate);
        foreach (var (subject, bundle) in new[] { (candidate.Artifact, "artifact.bundle.json"), (SignedRelease.Identity(candidate.Payload.GetProperty("provenance")), "provenance.bundle.json") })
        {
            var output = RunCommand(["attestation", "verify", files.AbsolutePath(subject.Name), "--repo", "engasnm111/lnwjud",
                "--bundle", files.AbsolutePath(bundle), "--cert-oidc-issuer", authority.Issuer,
                "--signer-workflow", authority.BuilderWorkflowUri["https://github.com/".Length..].Split('@')[0],
                "--signer-digest", authority.BuilderDigest, "--source-digest", ReleaseValues.Text(source, "commit"),
                "--source-ref", ReleaseValues.Text(source, "ref"), "--deny-self-hosted-runners",
                "--predicate-type", "https://slsa.dev/provenance/v1", "--format", "json"]);
            ReleaseBuildEvidence.RequireAttestation(output, candidate, subject, authority);
        }
        ReleaseBuildEvidence.RequireProvenance(files.Read("PROVENANCE.json", checked((int)policy.MaximumProvenance)), candidate);
        files.RecheckAll(); verifier.RecheckAll();
        RequireWorkTime();
    }

    private void RequireWorkTime()
    {
        if (work.Elapsed >= TimeSpan.FromSeconds(480)) throw new Refusal("RELEASE_ATTESTATION_TIMEOUT");
    }

    private byte[] ReadRun(ReleaseEvidenceCandidate release)
    {
        RequireWorkTime();
#if NATIVE_CONTAINMENT_TESTS
        if (RunResponse is not null) return RunResponse(release);
#endif
        var source = release.Payload.GetProperty("source");
        using var cancellation = new CancellationTokenSource(TimeSpan.FromSeconds(Math.Min(120, 480 - work.Elapsed.TotalSeconds)));
        using var handler = new HttpClientHandler { UseDefaultCredentials = false, Credentials = null, UseProxy = false,
            Proxy = null, AllowAutoRedirect = false, UseCookies = false, AutomaticDecompression = DecompressionMethods.None };
        using var client = new HttpClient(handler) { Timeout = Timeout.InfiniteTimeSpan };
        using var request = new HttpRequestMessage(HttpMethod.Get,
            $"https://api.github.com/repos/engasnm111/lnwjud/actions/runs/{ReleaseValues.Text(source, "runId")}/attempts/{ReleaseValues.Text(source, "runAttempt")}");
        request.Headers.UserAgent.ParseAdd("lnwjud-enrollment-attestation/1");
        request.Headers.Accept.ParseAdd("application/vnd.github+json");
        using var response = client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellation.Token).GetAwaiter().GetResult();
        if (!response.IsSuccessStatusCode || response.Content.Headers.ContentLength > ReleaseBuildEvidence.MaximumOutput)
            throw new Refusal("RELEASE_BUILD_RUN_REFUSED");
        using var body = response.Content.ReadAsStreamAsync(cancellation.Token).GetAwaiter().GetResult();
        using var bytes = new MemoryStream(); var buffer = new byte[8192];
        while (true)
        {
            var count = body.ReadAsync(buffer.AsMemory(), cancellation.Token).AsTask().GetAwaiter().GetResult();
            if (count == 0) return bytes.ToArray();
            if (bytes.Length + count > ReleaseBuildEvidence.MaximumOutput) throw new Refusal("RELEASE_BUILD_RUN_REFUSED");
            bytes.Write(buffer, 0, count);
        }
    }

    private byte[] RunCommand(string[] arguments)
    {
        RequireWorkTime();
        var attempt = new Attempt(); attempts.Add(attempt);
        var windows = Environment.GetFolderPath(Environment.SpecialFolder.Windows);
        var environment = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase) {
            ["SystemRoot"] = windows, ["WINDIR"] = windows, ["PATH"] = Environment.SystemDirectory,
            ["TEMP"] = scratch!, ["TMP"] = scratch!, ["HOME"] = scratch!, ["USERPROFILE"] = scratch!,
            ["APPDATA"] = scratch!, ["LOCALAPPDATA"] = scratch!, ["GH_CONFIG_DIR"] = scratch!,
            ["GH_HOST"] = "github.com", ["GH_PROMPT_DISABLED"] = "1", ["GH_NO_UPDATE_NOTIFIER"] = "1",
            ["GH_NO_EXTENSION_UPDATE_NOTIFIER"] = "1", ["NO_COLOR"] = "1"
        };
        attempt.OutputRead = Task.Run(() => Read(attempt.Output, attempt));
        attempt.ErrorRead = Task.Run(() => Read(attempt.Error, attempt));
        ContainedProcess process;
        try
        {
            process = ContainedProcess.Start(verifier!.AbsolutePath("gh.exe"), arguments, scratch!, environment,
                attempt.Output.ClientSafePipeHandle.DangerousGetHandle(), attempt.Error.ClientSafePipeHandle.DangerousGetHandle(), attempt.Ownership);
        }
        finally
        {
            attempt.Output.DisposeLocalCopyOfClientHandle(); attempt.Error.DisposeLocalCopyOfClientHandle();
        }
        attempt.State = "running";
        var timer = Stopwatch.StartNew();
        while (process.ActiveProcesses != 0)
        {
            RequireWorkTime();
#if NATIVE_CONTAINMENT_TESTS
            Observe?.Invoke("command_wait", scratch!);
#endif
            if (timer.Elapsed >= TimeSpan.FromSeconds(120)) throw new Refusal("RELEASE_ATTESTATION_TIMEOUT");
            if (attempt.OutputRead.IsFaulted || attempt.ErrorRead.IsFaulted) throw new Refusal("RELEASE_ATTESTATION_OUTPUT_INVALID");
            Thread.Sleep(10);
        }
        attempt.State = "job_zero";
        if (!Task.WaitAll([attempt.OutputRead, attempt.ErrorRead], TimeSpan.FromSeconds(10))) throw new Refusal("RELEASE_ATTESTATION_DRAIN_UNRESOLVED");
        if (process.ExitCode != 0) throw new Refusal("RELEASE_ATTESTATION_EXIT_REFUSED");
        var output = attempt.OutputRead.Result;
        _ = Wire.Utf8.GetString(output); _ = Wire.Utf8.GetString(attempt.ErrorRead.Result);
#if NATIVE_CONTAINMENT_TESTS
        Observe?.Invoke("command_finished", scratch!);
#endif
        attempt.State = "verified_exit";
        return output;
    }

    private static byte[] Read(Stream stream, Attempt attempt)
    {
        using var bytes = new MemoryStream(); var buffer = new byte[8192];
        while (true)
        {
            var count = stream.Read(buffer, 0, buffer.Length);
            if (count == 0) return bytes.ToArray();
            if (Interlocked.Add(ref attempt.Bytes, count) > ReleaseBuildEvidence.MaximumOutput) throw new Refusal("RELEASE_ATTESTATION_OUTPUT_INVALID");
            bytes.Write(buffer, 0, count);
        }
    }

    internal bool TryFinishCleanup(TimeSpan slice)
    {
        try { return FinishCleanup(slice); }
        catch { return false; }
    }

    private bool FinishCleanup(TimeSpan slice)
    {
        if (released) return true;
        var timer = Stopwatch.StartNew();
        foreach (var attempt in attempts)
        {
            if (!attempt.Ownership.CancelAndObserveZero(slice > timer.Elapsed ? slice - timer.Elapsed : TimeSpan.Zero)) return false;
            attempt.State = "cleanup_zero";
            attempt.Output.DisposeLocalCopyOfClientHandle(); attempt.Error.DisposeLocalCopyOfClientHandle();
            var readers = new[] { attempt.OutputRead, attempt.ErrorRead }.Where(task => task is not null).Cast<Task>().ToArray();
            try { if (!Task.WaitAll(readers, slice > timer.Elapsed ? slice - timer.Elapsed : TimeSpan.Zero)) return false; }
            catch (AggregateException) { if (readers.Any(task => !task.IsCompleted)) return false; }
        }
        foreach (var attempt in attempts)
        {
            attempt.Ownership.ReleaseAfterZero(); attempt.Output.Dispose(); attempt.Error.Dispose();
        }
        package?.Dispose(); unsignedPackage?.Dispose(); verifier?.Dispose();
        released = true;
        if (scratch is not null) { try { Directory.Delete(scratch, true); } catch { } }
        return true;
    }
}
