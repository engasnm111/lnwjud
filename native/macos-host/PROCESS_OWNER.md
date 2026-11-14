# macOS managed process ownership

The process-owner source provides an enrolled Endpoint Security path for managed
commands, durable shell tasks and managed process reservations. An ordinary macOS
installation without this enrollment still refuses these writers **before**
creating a reservation. Installing the application alone does not grant Endpoint
Security permission.

## Enrollment and startup

This path requires macOS 13 or later, an Apple-authorized
`com.apple.developer.endpoint-security.client` entitlement on the native host,
Full Disk Access for that host, and administrator installation of the daemon.
Apple controls the entitlement and privacy grant. The application does not
disable SIP, invent an entitlement, or replace this path with a process-group
check. See Apple's [ES client documentation](https://developer.apple.com/documentation/endpointsecurity/es_new_client(_:_:)).

Build and run the native unit suite on a Mac:

```sh
swift test --package-path native/macos-host
swift build -c release --package-path native/macos-host
```

An administrator must deploy the signed native host in a root-owned location,
grant the required Apple permissions, and enroll the **packaged first-party host**
that will make requests. Store its reviewed designated requirement as UTF-8 in:

```text
/Library/Application Support/lnwjud/process-owner/host-requirement.txt
```

The requirement must constrain the first-party identifier and Apple certificate
chain. Do not enroll a generic Node, Electron, shell, development interpreter, or
an arbitrary caller-supplied requirement. The daemon verifies the connecting
process using its kernel audit token, runtime code identity and complete static
code/resource signature. Debugger, interpreter-loading and code-injection
arguments/environment are rejected. A development checkout run under Node is
therefore not an enrolled production host.

The enrolled host must use the hardened runtime. Debug attachment,
disabled library validation, DYLD environment injection and disabled executable
page protection entitlements are rejected even if its designated requirement
matches. See Apple's [signature flags](https://developer.apple.com/documentation/security/seccodesignatureflags)
and [embedded entitlement dictionary](https://developer.apple.com/documentation/security/kseccodeinfoentitlementsdict).

The root directory and all ancestors must be real root-owned directories with
no group/world write access. The requirement is a root-owned regular file with
one hard link and no group/world write access. Its `private` directory must be
mode `0700`. Start the deployed native binary as root with:

```text
lnwjud-macos-host --process-owner-daemon
```

Configure the administrator's service manager to run that exact protected
binary. This source does not automatically install a privileged service or
change macOS privacy settings. Startup exits with a symbolic enrollment error
when these prerequisites are absent. Once started, it creates its private key,
public verification key, journal, lock and Unix socket under the fixed root.
Clients accept replies only from the enrolled root-protected Ed25519 key. The
private key must remain in `private/signing.key`; do not copy or publish it.

## Reservation and recovery behavior

Each attempt binds task, reservation, generation, request digest and application
owner fields before admission. The native daemon additionally binds that attempt
to the authenticated operating-system caller. Payloads run after dropping all
supplementary groups and assuming the actual caller's UID and GID. Requests cannot
choose a different operating-system identity.

Core dumps are disabled before the daemon loads its signing key and remain
disabled in children. Between credential drop and `execve`, XNU's credential-change
flag prevents an unprivileged user from obtaining a task port or attaching a
tracer to the inherited native image. User code executes only after that image
has been replaced. These checks rely on the platform's
[task-port policy](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/kern_proc.c)
and [credential-change policy](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/kern_prot.c).

The native child first stops before executing the command. The journal records
its kernel PID generation before resuming it. The Endpoint Security fork, exec
and exit stream then tracks every observed descendant, including descendants
which change process group or double-fork. Cancellation obtains a Mach task
reference and checks its audit identity before terminating it. A PID lookup or an
empty process group is never a termination certificate.

The journal is persisted before dispatch and before publishing a positive
observation. Replies bind the exact request digest, fresh nonce, kernel boot UUID,
caller UID and attempt identity. Repeating an attempt cannot dispatch a different
operation. A prepared attempt can be aborted without starting user code.

Normal exit releases the reservation only after every tracked descendant has
exited. A dropped/unsequenced event, persistence failure, unknown launch outcome
or same-boot daemon restart keeps affected attempts held as
`termination_unknown`. After a real kernel reboot, the native journal's recorded
boot UUID can prove that its old attempt cannot still be running; reconciliation
then reports an interrupted terminal result. Relaunching the app or daemon in
the same boot does not provide that proof.

Legacy `opaque_uncontained` reservations have no historical native attempt
binding. They remain held. This source does not delete them, use mutable file
timestamps as boot evidence, or infer completion from an absent PID. Preserve
those records for an administrator-led recovery rather than deleting the active
index while old writers may still be alive.

Output is drained to protected native files and bounded to at most 512 KiB per
stream. A host reconnect can read it using checked byte cursors. A crash can leave
output incomplete even when a later reboot proves the command ended; the host
keeps that output limitation visible. The current journal retains at most 4,096
attempts and rejects new attempts at capacity. Do not erase a live journal or
rotate its keys to bypass that limit. An administrative archival/retention
workflow is not included in this change.

## User acceptance on an enrolled Mac

The native code and the following device checks were **not run on the Windows
development machine**. The focused TypeScript tests use an injected native
transport; they are not proof of Apple enrollment or kernel event delivery.

1. Without enrollment, try a durable command and a managed process. Both must
   refuse before adding an active reservation.
2. With enrollment, run an ordinary command and read its output after restarting
   the first-party host. Confirm its reservation is released after native
   termination and output reconciliation.
3. Run a fixture whose child calls `setsid`, double-forks and continues writing
   after its original parent exits. The reservation must remain held until that
   last writer exits. Repeat with cancellation and verify all tracked writers
   end before release.
4. Restart the native daemon while the fixture runs. Its reservation must stay
   held in the same boot. Reboot the Mac, reconnect, and confirm that only the
   journal-bound pre-reboot attempt can recover as interrupted.
5. Exercise the ledger's event-gap, PID-generation reuse, malformed-journal,
   cross-user and operation-replay cases with `swift test`. Inject an event gap
   in a controlled native test harness and confirm the running reservation
   remains held, even after all known PIDs disappear.
6. Attempt RPCs from an unenrolled interpreter, a modified app, a debugger
   invocation, a copied key file and a different OS user. None may read, cancel
   or mint a completion proof for the enrolled owner's attempt.

Record the native build, Apple permission state and actual device outcomes
separately. An unavailable Mac test remains unverified; it must not be reported
as a passing native acceptance check.
