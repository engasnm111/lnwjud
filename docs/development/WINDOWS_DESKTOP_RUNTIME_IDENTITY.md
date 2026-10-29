# Windows desktop loaded-runtime identity and control: supported evidence and gaps

**Status:** No supported, issuer-authenticated, read-only *loaded desktop runtime attestation* contract has been established for v5.8.7 or the inspected v5.9.0 source. This is a capability-gap statement, not a claim that inspecting process lists can determine the identity of the running desktop host.

## Existing read-only APIs (inspected v5.9.0)

| Tool | Accepted input | What it establishes | What it does not establish |
| --- | --- | --- | --- |
| `windows_environment` | `{}` | Windows environment metadata, subject to Windows host availability | No bound desktop PID + kernel creation time, image/bundle hash, session control owner or authenticated loaded-runtime receipt |
| `system_info` | `{}` | General host/runtime environment observations | Not a challenge-bound attestation of the executing desktop image |
| `process_context` | `{ "top_count": 10 }` (optional positive integer) | A bounded process-context observation | No authoritative proof that any listed process is the current lnwjud desktop instance; no exact launch-owner/rollback binding |
| `call_history` | `{ "workspaceId": "<workspace-id>", "limit": 20 }` | Server-observed correlated MCP tool-call records within authorized workspace scope | No authenticated desktop-process creation time or proof of which executable is currently loaded |

The tool names and shown argument names above were inspected on an installed **v5.9.0** tool registry; they must not be represented as a formally audited v5.8.7 historical contract. Read-only tools do not intentionally launch, restart or update the desktop, but permissions and host-specific observation coverage still apply. `process_context` is a process inventory, not a guaranteed side-effect-free inspection of all Windows processes under all access profiles.

## Requested loaded-runtime proof: unavailable

- **PID reuse-safe identity:** no supported response binding the live lnwjud desktop PID to Windows kernel creation time (or equally strong verified identity).
- **Executing image and loaded bundle:** no issuer-authenticated, fresh receipt binding that process to its actually loaded application bundle, digest, source commit, installed version, and Data/Goal-store location metadata.
- **Control boundary:** no documented read-only response binding that same runtime identity to its desktop launch owner, authorized restart target and rollback policy.
- **Receipt locator:** no publicly specified, stable, issuer-authenticated locator for such a loaded-desktop-runtime receipt. **No locator should be invented.**
- **Freshness and issuer:** no declared challenge-bound issuer, timestamp and lifetime for a combined proof; report `UNSUPPORTED` or `UNKNOWN` rather than a synthetic success.

GitHub Release `SHA256SUMS`, `RELEASE_MANIFEST`, packaged native-worker evidence and source CI are **build/artifact provenance**, not proof of the image loaded in a live desktop process. A durable task receipt and server call history do not close this gap. Hashing a file on disk after the fact also cannot prove it is the image mapped into the current process.

## Permitted observation / current hold

This is documentation only. No installer, update worker, managed writer, lease mutation, restart, service control, global scan or private diagnostic collection is performed to answer Issue #220. A future implementation would require a versioned, authorized read-only schema and a trusted operating-system evidence issuer that binds PID creation time, image/bundle and control owner to one challenge-bound observation; until independently verified, treat the full requested contract as **CAPABILITY_GAP / HOLD**.

Related: [Issue #220](https://github.com/engasnm111/lnwjud/issues/220), [Issue #222](https://github.com/engasnm111/lnwjud/issues/222).
