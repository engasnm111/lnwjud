# Windows containment service

The first-party Windows x64 executable is a self-contained .NET 8 program. Process creation does not compile or execute PowerShell. The application supplies packaged helper and N-API pin paths with embedded SHA-256 values. Caller arguments, PATH and environment variables cannot select the authority.

## Build and installation

Run `powershell -NoProfile -NonInteractive -File scripts/build-windows-containment-helper.ps1`. Build products under `artifacts/win-x64/` include `lnwjud-containment.exe`, `lnwjud-containment-pin.node` and `manifest.json`. The pin requires Visual Studio x64 C++ tools and cached Node N-API headers. Packaging embeds their digests independently of the adjacent manifest.

An all-users Setup installs the LocalSystem SCM service from its protected Program Files `resources/native-containment` directory. The service stores its private ledger under protected ProgramData. Its ACL excludes ordinary user writes, and reparse paths are refused. Per-user and Portable executables never register a service from a writable extraction directory. They can use an already installed service only when its protected image and exact package hash match. Otherwise managed operations fail closed. Existing per-user installs may retain their scope during upgrade. Choose all-users in Setup, preserving user data during any required uninstall.

The client authenticates the named-pipe server through SCM process identity, protected image layout, expected image hash and LocalSystem SID. The service captures the real pipe caller SID and duplicates its primary token. Process launches use that token in its original session, without changing `TokenSessionId` to the LocalSystem service session. Import filesystem operations impersonate that caller and Git validation uses a caller-token process. LocalSystem ownership of the ledger never authorizes elevated user Git or filesystem work.

## Protocol and authority

Protocol 3 uses length-bounded JSON frames and commands `prepare`, `run`, `inspect`, `cancel`, `read_output`, `abort`, `control` and `inspect_control`. Requests bind task, reservation, attempt, generation, owner client/session, workspace and request digest. The service derives the operation digest and rejects identity changes or replay. Its durable abort-before-launch tombstone prevents late preparation or dispatch from reviving a cancelled attempt.

The production CLI exposes service install/uninstall, service execution, RPC and an output observer. Legacy `run-v2`, profile-key and caller-file receipt mechanisms are not production launch authorities. Historical fault-test code is not an application fallback. Missing service proof remains unknown rather than falling back to PowerShell, an ordinary launcher or a legacy JSON receipt.

The service creates the target suspended inside a kill-on-close Job, verifies Job membership and resumes once. Completion, timeout and cancellation require a fresh zero-active-process query. Process completion and reservation release are distinct observations. The TypeScript adapter accepts terminal proof only when the complete binding matches and the service confirms reservation release. Restart retains unresolved dispatched attempts and never relaunches them. A dispatched attempt without a persistently recorded post-membership target PID remains unverified even if its named Job is absent. If verified Job membership was recorded and the Job is now empty or gone, recovery verifies process termination but reports `interrupted` with reserved failure code 125, never an invented successful target exit. Legacy profile-key code is explicitly excluded from the production executable.

Ordinary service processes share the opaque-writer domain. Import publication promotes its exact attempt to exclusive admission and conflicts with every other held writer. The import hold survives process exit until service-owned publication is verified. Stage creation, native identities and publication intent are durable. Interrupted publication is reconciled by original parent/stage/destination identities, never by blindly repeating a rename or treating a matching Git HEAD as ownership. Failed or unverifiable transactions remain quarantined.

## Current observation limits

The TypeScript facade still uses a helper observer for output and service inspection. Bounded stdout/stderr is retained in service memory. Output persistence and a one-shot caller facade are not claimed complete by the core import migration. Installed SCM behavior, upgrade/rollback/uninstall with unresolved work, lifetime distinctions and restart/output acceptance remain separate release checks. Helper-only or mocked TypeScript tests do not establish those checks.

The N-API bootstrap pins the helper file and ancestor names before hashing and launch. Its own path and digest belong to the trusted host installation. This does not claim resistance to replacing the host/bootstrap before loading it. Packaged Electron acceptance verifies N-API resolution against Electron rather than a system Node executable.

## Verification

Run `dotnet run --project native/windows-containment-helper/tests/ContainmentNativeTests.csproj -c Release` for native Job, caller identity, durable admission, pipe authentication, import identity and fault tests. Fault hooks compile only with `NATIVE_CONTAINMENT_TESTS`; the production project excludes test sources. Protocol-client unit tests use injected clients and do not prove SCM installation or authentication.

Real installed-service tests require the matching all-users Setup. Restricted-policy acceptance must use an actual Restricted child host without an Execution Policy bypass. Local unsigned Authenticode state is independent from SHA/provenance integrity and is permitted without a configured signing certificate. Windows 11 local evidence does not establish Windows 10, hosted CI, macOS/Linux, release or customer acceptance.
