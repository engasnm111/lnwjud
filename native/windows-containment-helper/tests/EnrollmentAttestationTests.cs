using System.IO.Pipes;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Lnwjud.UpdateWorker;

namespace Lnwjud.Containment;

internal static class EnrollmentAttestationTests
{
    private static int assertions;
    private static void Check(bool value, string message) { assertions++; if (!value) throw new Exception(message); }
    internal static void Ownership()
    {
        var root = Path.Combine(Path.GetTempPath(), "lnwjud-attestation-tests-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            foreach (var stage in new[] { "before_process_create", "after_create_before_membership", "before_resume", "after_registration_before_resume", "after_resume_before_reply" })
            {
                var file = Path.Combine(root, "pin"); File.WriteAllText(file, "fixture");
                var pins = new EnrollmentPackageFiles(root); _ = pins.Read("pin", 32);
                var owner = new ContainedProcess.LaunchOwnership();
                var cancelAttempts = 0;
                using var output = new AnonymousPipeServerStream(PipeDirection.In, HandleInheritability.None);
                using var error = new AnonymousPipeServerStream(PipeDirection.In, HandleInheritability.None);
                ContainedProcess.Fault = (point, _) => { if (point == stage) throw new IOException("FIXTURE_FAULT"); };
                var failed = false;
                try
                {
                    _ = ContainedProcess.Start(Environment.ProcessPath!, ["noop"], root,
                        new Dictionary<string, string> { ["SystemRoot"] = Environment.GetFolderPath(Environment.SpecialFolder.Windows) },
                        output.ClientSafePipeHandle.DangerousGetHandle(), error.ClientSafePipeHandle.DangerousGetHandle(), owner);
                }
                catch (IOException) { failed = true; }
                Check(failed, "injected launch fault observed " + stage);
                ContainedProcess.Fault = (point, _) => {
                    if (point == "before_cancel") cancelAttempts++;
                    if (point == "before_job_query") throw new IOException("QUERY_UNKNOWN");
                };
                Check(!owner.CancelAndObserveZero(TimeSpan.FromMilliseconds(20)), "unknown Job keeps ownership " + stage);
                Check(Locked(file), "pin retained through unknown Job " + stage);
                var refusedRelease = false;
                try { owner.ReleaseAfterZero(); } catch (InvalidOperationException) { refusedRelease = true; }
                Check(refusedRelease, "cannot release before zero " + stage);
                ContainedProcess.Fault = null;
                Check(owner.CancelAndObserveZero(TimeSpan.FromSeconds(10)), "actual Job zero " + stage);
                owner.ReleaseAfterZero(); pins.Dispose();
                Check(cancelAttempts > 0, "query fault still attempts cancellation " + stage);
                Check(!Locked(file), "pin released after zero " + stage);
            }
        }
        finally { ContainedProcess.Fault = null; Directory.Delete(root, true); }
        Console.WriteLine("ENROLLMENT_OWNERSHIP_ASSERTIONS_PASSED=" + assertions);
    }
    private static bool Locked(string path)
    {
        try { using var file = new FileStream(path, FileMode.Open, FileAccess.Write, FileShare.ReadWrite | FileShare.Delete); return false; }
        catch (IOException) { return true; }
    }

    internal static int Verifier(string[] args)
    {
        var environment = Environment.GetEnvironmentVariables().Cast<System.Collections.DictionaryEntry>()
            .ToDictionary(entry => (string)entry.Key, entry => (string)entry.Value!);
        File.AppendAllText(Path.Combine(Environment.CurrentDirectory, "commands.jsonl"), JsonSerializer.Serialize(new { args, environment }) + "\n");
        if (args.SequenceEqual(new[] { "version" })) { Console.WriteLine("gh version 2.102.0 (fixture)"); return 0; }
        if (args.Length != 22 || args[0] != "attestation" || args[1] != "verify") return 37;
        var modeFile = Path.Combine(Path.GetDirectoryName(args[2])!, "fixture-mode");
        var mode = File.Exists(modeFile) ? File.ReadAllText(modeFile) : "valid";
        if (mode == "nonzero") { Console.Error.WriteLine("raw fixture secret must never be forwarded"); return 38; }
        if (mode == "overflow") { Console.Write(new string('x', 4 * 1024 * 1024 + 1)); return 0; }
        if (mode == "combined-overflow") { Console.Write(new string('x', 2 * 1024 * 1024)); Console.Error.Write(new string('y', 2 * 1024 * 1024 + 1)); return 0; }
        if (mode == "stderr-utf8") { Console.OpenStandardError().WriteByte(255); return 0; }
        if (mode == "empty") return 0;
        if (mode == "invalid-utf8") { Console.OpenStandardOutput().WriteByte(255); return 0; }
        if (mode == "wait") { Thread.Sleep(150_000); return 0; }
        Console.Write(File.ReadAllText(args[2] + ".verified.json"));
        return 0;
    }

    internal static void Adapter(bool timeoutOnly = false)
    {
        assertions = 0;
        var verifierDirectory = Path.Combine(AppContext.BaseDirectory, "update-attestation");
        if (Directory.Exists(verifierDirectory)) throw new Exception("Fixture output directory must be fresh");
        Directory.CreateDirectory(verifierDirectory);
        var image = Path.Combine(verifierDirectory, "gh.exe");
        foreach (var file in Directory.GetFiles(AppContext.BaseDirectory))
            File.Copy(file, Path.Combine(verifierDirectory, Path.GetFileName(file)));
        File.Copy(Environment.ProcessPath!, image);
        try
        {
            using var fixture = new EvidenceFixture();
            fixture.Metadata.Policy["verifier"]!["sha256"] = ReleaseTrustPolicy.Hash(File.ReadAllBytes(image));
            foreach (var subject in new[] { fixture.Release.Artifact, fixture.Release.Provenance })
                File.WriteAllText(Path.Combine(fixture.DirectoryPath, subject.Name + ".verified.json"), fixture.Attestation(subject).ToJsonString());
            var commands = new List<JsonElement>();
            AttestationOwner.RunResponse = _ => Wire.Encode(fixture.Run);
            AttestationOwner.Observe = (stage, scratch) =>
            {
                if (stage == "pins_ready" || stage == "command_finished")
                {
                    foreach (var name in new[] { "RELEASE.json", "ENROLLMENT.json", "lnwjud-Setup-5.9.1.exe", "PROVENANCE.json", "artifact.bundle.json", "provenance.bundle.json" })
                    {
                        var input = Path.Combine(fixture.DirectoryPath, name);
                        Check(Locked(input), "all six inputs pinned " + name);
                        if (stage == "pins_ready") RequireRenameAndDeleteDenied(input);
                    }
                    Check(Locked(image), "verifier remains pinned");
                    if (stage == "pins_ready") RequireRenameAndDeleteDenied(image);
                }
                if (stage == "command_finished") commands = File.ReadAllLines(Path.Combine(scratch, "commands.jsonl")).Select(line => JsonDocument.Parse(line).RootElement.Clone()).ToList();
            };
            AttestationPreflightResult Verify() => EnrollmentAttestationPreflight.VerifyPackage(fixture.DirectoryPath, fixture.Policy, ReleaseSchema.Embedded(), fixture.Metadata.Time);
            if (timeoutOnly)
            {
                AttestationOwner.Observe = null;
                File.WriteAllText(Path.Combine(fixture.DirectoryPath, "fixture-mode"), "wait");
                var timer = System.Diagnostics.Stopwatch.StartNew();
                var timeout = Verify();
                Check(timeout is AttestationPreflightResult.Refused { Reason: "RELEASE_ATTESTATION_TIMEOUT" }, "actual fixed command timeout");
                Check(timer.Elapsed >= TimeSpan.FromSeconds(120) && timer.Elapsed < TimeSpan.FromSeconds(145), "timeout bound plus cleanup grace");
                Check(!Locked(image) && !Locked(Path.Combine(fixture.DirectoryPath, "RELEASE.json")), "timeout releases pins only after observed zero");
                Console.WriteLine("ENROLLMENT_TIMEOUT_ASSERTIONS_PASSED=" + assertions);
                return;
            }
            var result = Verify();
            Check(result is AttestationPreflightResult.Authenticated, "real fixed adapter authenticates isolated fixture " + result);
            Check(commands.Count == 3, "exactly version and two verify commands");
            Check(commands[0].GetProperty("args").EnumerateArray().Select(x => x.GetString()).SequenceEqual(new[] { "version" }), "fixed version argv");
            for (var i = 1; i < 3; i++)
            {
                var actual = commands[i].GetProperty("args").EnumerateArray().Select(x => x.GetString()).ToArray();
                var subject = i == 1 ? fixture.Release.Artifact : fixture.Release.Provenance;
                var authority = fixture.Policy.Sources[0];
                var expected = new[] { "attestation", "verify", Path.Combine(fixture.DirectoryPath, subject.Name), "--repo", "engasnm111/lnwjud",
                    "--bundle", Path.Combine(fixture.DirectoryPath, i == 1 ? "artifact.bundle.json" : "provenance.bundle.json"), "--cert-oidc-issuer", authority.Issuer,
                    "--signer-workflow", "engasnm111/lnwjud/.github/workflows/trusted.yml", "--signer-digest", authority.BuilderDigest,
                    "--source-digest", new string('a', 40), "--source-ref", "refs/heads/main", "--deny-self-hosted-runners", "--predicate-type", "https://slsa.dev/provenance/v1", "--format", "json" };
                Check(actual.SequenceEqual(expected), "exact verify argv " + i);
            }
            foreach (var command in commands)
            {
                var environment = command.GetProperty("environment");
                var allowed = new HashSet<string>(new[] { "SystemRoot", "WINDIR", "PATH", "TEMP", "TMP", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "GH_CONFIG_DIR", "GH_HOST", "GH_PROMPT_DISABLED", "GH_NO_UPDATE_NOTIFIER", "GH_NO_EXTENSION_UPDATE_NOTIFIER", "NO_COLOR" }, StringComparer.OrdinalIgnoreCase);
                Check(environment.EnumerateObject().All(property => allowed.Contains(property.Name)), "environment contains only allowlist");
                Check(environment.GetProperty("GH_HOST").GetString() == "github.com", "fixed host");
                Check(environment.GetProperty("PATH").GetString() == Environment.SystemDirectory, "system path only");
            }
            Check(!Locked(image) && !Locked(Path.Combine(fixture.DirectoryPath, "RELEASE.json")), "successful adapter releases pins after zero");
            var unsignedRelease = new JsonObject();
            foreach (var name in new[] { "product", "releaseId", "channel", "platform", "architecture", "distribution", "version", "releaseSequence", "source", "buildEvidence", "artifact", "provenance", "compatibility" })
                unsignedRelease[name] = fixture.Payload[name]!.DeepClone();
            var descriptor = new JsonObject { ["protocol"] = 2, ["policyRevision"] = 1, ["kind"] = "baseline", ["release"] = unsignedRelease,
                ["issuedAt"] = fixture.Payload["issuedAt"]!.DeepClone(), ["notBefore"] = fixture.Payload["notBefore"]!.DeepClone(), ["expiresAt"] = fixture.Payload["expiresAt"]!.DeepClone() };
            var descriptorBytes = Wire.Encode(descriptor);
            File.WriteAllBytes(Path.Combine(fixture.DirectoryPath, "CANDIDATE.json"), descriptorBytes);
            var observedUnsignedPins = false;
            AttestationOwner.Observe = (stage, _) => {
                if (stage == "pins_ready") observedUnsignedPins = Locked(image) && Locked(Path.Combine(fixture.DirectoryPath, "CANDIDATE.json"));
            };
            CandidateAttestationResult VerifyUnsigned() => CandidateAttestationPreflight.VerifyPackage(fixture.DirectoryPath, fixture.Policy,
                fixture.Metadata.Time, ReleaseAuthorizationPurpose.Baseline, "test-only");
            var unsignedResult = VerifyUnsigned();
            Check(unsignedResult is CandidateAttestationResult.Observed observed && observed.CandidateSha256 == ReleaseTrustPolicy.Hash(descriptorBytes), "unsigned evidence binds descriptor bytes");
            Check(observedUnsignedPins, "unsigned candidate and verifier remain pinned during verification");
            Check(!Locked(image) && !Locked(Path.Combine(fixture.DirectoryPath, "CANDIDATE.json")), "unsigned cleanup releases pins");
            File.WriteAllText(Path.Combine(fixture.DirectoryPath, "fixture-mode"), "nonzero");
            Check(VerifyUnsigned() is CandidateAttestationResult.Refused, "unsigned verifier failure refuses");
            Check(!Locked(image) && !Locked(Path.Combine(fixture.DirectoryPath, "CANDIDATE.json")), "unsigned refusal releases after cleanup");
            File.Delete(Path.Combine(fixture.DirectoryPath, "fixture-mode"));
            AttestationOwner.Observe = null;
            foreach (var mode in new[] { "nonzero", "overflow", "combined-overflow", "invalid-utf8", "stderr-utf8", "empty" })
            {
                File.WriteAllText(Path.Combine(fixture.DirectoryPath, "fixture-mode"), mode);
                Check(Verify() is AttestationPreflightResult.Refused, "child failure refuses " + mode);
                Check(!Locked(image), "child failure confirms zero before release " + mode);
            }
            File.Delete(Path.Combine(fixture.DirectoryPath, "fixture-mode"));
            fixture.Metadata.Policy["verifier"]!["version"] = "9.9.9";
            Check(Verify() is AttestationPreflightResult.Refused { Reason: "RELEASE_VERIFIER_UNTRUSTED" }, "wrong version refused");
            fixture.Metadata.Policy["verifier"]!["version"] = "2.102.0";
            var hash = fixture.Metadata.Policy["verifier"]!["sha256"]!.GetValue<string>();
            fixture.Metadata.Policy["verifier"]!["sha256"] = new string('0', 64);
            Check(Verify() is AttestationPreflightResult.Refused { Reason: "RELEASE_VERIFIER_UNTRUSTED" }, "wrong image refused");
            fixture.Metadata.Policy["verifier"]!["sha256"] = hash;
            foreach (var name in new[] { "artifact.bundle.json", "provenance.bundle.json", "lnwjud-Setup-5.9.1.exe", "PROVENANCE.json" })
            {
                var path = Path.Combine(fixture.DirectoryPath, name); var saved = File.ReadAllBytes(path);
                File.WriteAllBytes(path, new byte[saved.Length]);
                Check(Verify() is AttestationPreflightResult.Refused, "changed signed input refuses " + name);
                File.Delete(path);
                Check(Verify() is AttestationPreflightResult.Refused, "missing signed input refuses " + name);
                File.WriteAllBytes(path, saved);
            }
            AttestationOwner.RunResponse = _ => Encoding.UTF8.GetBytes("{\"status\":\"completed\"}");
            Check(Verify() is AttestationPreflightResult.Refused, "injected bytes still require run predicate");
            AttestationOwner.RunResponse = _ => Wire.Encode(fixture.Run);
            foreach (var stage in new[] { "after_create_before_membership", "before_resume", "after_resume_before_reply" })
            {
                ContainedProcess.Fault = (point, _) => { if (point == stage) throw new IOException("FIXTURE_LAUNCH_FAILURE"); };
                Check(Verify() is AttestationPreflightResult.Refused, "adapter launch fault refuses " + stage);
                Check(!Locked(image), "adapter launch fault releases after zero " + stage);
                ContainedProcess.Fault = null;
            }
            ContainedProcess.Fault = (point, _) => { if (point is "after_create_before_membership" or "before_job_query") throw new IOException("FIXTURE_UNKNOWN"); };
            var held = Verify();
            Check(held is AttestationPreflightResult.Held, "unknown Job returns owned Held");
            Check(Locked(image) && Locked(Path.Combine(fixture.DirectoryPath, "RELEASE.json")), "Held retains verifier and package");
            ContainedProcess.Fault = null;
            Check(((AttestationPreflightResult.Held)held).Owner.TryFinishCleanup(TimeSpan.FromSeconds(10)), "Held settles after query restoration");
            Check(!Locked(image), "Held releases after actual zero");
            ContainedProcess.Fault = (point, _) => { if (point is "after_create_before_membership" or "before_cancel") throw new IOException("FIXTURE_CANCEL_UNKNOWN"); };
            var cancelHeld = Verify();
            Check(cancelHeld is AttestationPreflightResult.Held && Locked(image), "failed cancellation retains ownership");
            ContainedProcess.Fault = null;
            Check(((AttestationPreflightResult.Held)cancelHeld).Owner.TryFinishCleanup(TimeSpan.FromSeconds(10)), "failed cancellation later reaches actual zero");
        }
        finally
        {
            ContainedProcess.Fault = null; AttestationOwner.Observe = null; AttestationOwner.RunResponse = null;
            Directory.Delete(verifierDirectory, true);
        }
        Console.WriteLine("ENROLLMENT_ADAPTER_ASSERTIONS_PASSED=" + assertions);
    }

    internal static void ProductionAssembly(string path)
    {
        var assembly = System.Reflection.Assembly.LoadFile(Path.GetFullPath(path));
        var owner = assembly.GetType("Lnwjud.Containment.AttestationOwner", true)!;
        var members = owner.GetMembers(System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Static);
        Check(!members.Any(member => member.Name.Contains("RunResponse") || member.Name.Contains("Observe")), "production assembly excludes entire fixture seam");
        Check(assembly.GetType("EvidenceFixture") is null && assembly.GetType("Lnwjud.Containment.EnrollmentAttestationTests") is null, "production excludes fixture keys and setup");
        Console.WriteLine("PRODUCTION_SEAM_ASSERTIONS_PASSED=" + assertions);
    }

    private static void RequireRenameAndDeleteDenied(string path)
    {
        var renamed = false;
        try { File.Move(path, path + ".moved"); renamed = true; }
        catch (IOException) { }
        if (renamed) File.Move(path + ".moved", path);
        Check(!renamed, "retained handle denies rename " + Path.GetFileName(path));
        var denied = false;
        try { File.Delete(path); } catch (IOException) { denied = true; }
        Check(denied, "retained handle denies deletion " + Path.GetFileName(path));
    }
}
