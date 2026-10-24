# Release metadata producer

This unit implements the exact shared release envelope contract and disposable Node-to-.NET verification fixtures. It does not install, restore, admit an update transaction, provision trust or activate a release workflow.

Run its tests with `node --test scripts/update-trust/release-envelope.test.mjs scripts/update-trust/pinned-verifier.test.mjs`. The shared `tests/fixtures/update-release/metadata-v1.json` contains only disposable public policy, exact signed envelope bytes and malformed cases. No private test key is retained. Both decoders consume `config/update-release-schema.json`.

Production policy is the fixed tracked `config/update-release-policy.json`, initially empty. The producer accepts no policy, root, verifier path, saved verification-result JSON or `verified` override. Empty authority fails `RELEASE_TRUST_UNCONFIGURED` before inputs or the signing secret are read.

The CLI takes exactly these name/value pairs:

```
node scripts/update-trust/produce-release-envelope.mjs \
  --payload candidate-payload.json --artifact lnwjud-Setup-VERSION.exe \
  --provenance PROVENANCE.json --artifactBundle artifact.bundle.json \
  --provenanceBundle provenance.bundle.json --previousEnvelope previous-envelope.json \
  --previousArtifact previous-package.exe --previousProvenance previous-PROVENANCE.json \
  --keyId CONFIGURED_KEY_ID --output new-envelope.json
```

After actual evidence verification has completed, the protected signer supplies `LNWJUD_UPDATE_RELEASE_PRIVATE_KEY_PEM`. Only then does the producer read/remove that entry, require its derived public SPKI to match the configured root, sign exact bytes and verify its output. Children receive an allowlisted environment without that signing entry. The destination is published without replacing an existing file; symbolic errors omit child diagnostics and key material.

The evidence path checks actual artifact/provenance and bundle bytes, exact selected successful GitHub push run/attempt, verified certificate repository/source/signer/config identities, subjects and verified transparency timestamps. The reusable builder has a fixed immutable `builderDigest`. Caller workflow authority uses only `buildConfigDigestRule: "source-commit"`: its verified certificate digest must equal the exact selected payload source commit, with the configured caller URI/ref. Literal future caller digests and wildcard rules are refused. Workflow predicate claims alone convey no trust. [GitHub CLI verification](https://cli.github.com/manual/gh_attestation_verify) documents the output; the supported timestamp records come from [sigstore-go v1.3.0](https://github.com/sigstore/sigstore-go/blob/v1.3.0/pkg/verify/signed_entity.go).

The Windows x64 executor uses the existing reviewed native pin addon at its fixed staging path, bound to `CONTAINMENT_PIN_SHA256`. As with the Desktop native client, loading that source-bound addon assumes the repository/staged trusted code is not concurrently controlled by an attacker. It checks ordinary module ancestry and its digest before loading. The addon then holds the fixed verifier executable and its ancestors against writes/deletion, hashes the executable after pinning and retains that pin until every child closes. Exact artifact and attestation bundle inputs are pinned before hashing and remain pinned through verification; before/after hashes alone are not an execution or input pin. Children have bounded output/time and the secret environment entry is excluded. Real Windows tests verify blocked file/ancestor renames, writes, input substitution, retained pins during child shutdown and release afterward. Other platforms refuse `RELEASE_VERIFIER_EXECUTION_UNAVAILABLE`. Actual CI attestation compatibility and protected builder/verifier provisioning are still acceptance work.

Previous descriptor verification authenticates exact historical signature and package/provenance identities. An expired descriptor additionally requires explicit historical root permission and current non-revocation. This authenticates release history only. The native consumer separately requires the retained original installation acceptance, trusted baseline, replay/time floors and exact failed transaction before recovery can become eligible. Metadata verification does not execute recovery.
