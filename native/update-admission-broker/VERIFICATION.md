# Isolated verification, 23 October 2026

This is local Windows evidence for the isolated admission core. It does not establish installed service, real peer authentication, complete writer coverage or automatic updater acceptance. The workstation token was not elevated and its TokenOwner equalled TokenUser. No LocalService/service-SID process was provisioned or tested.

Final commands and terminal results:

```text
dotnet run --project native/update-admission-broker/tests/UpdateAdmissionTests.csproj --configuration Debug
PASS 84 admission assertions
exit 0

dotnet build native/update-admission-broker/WindowsUpdateAdmissionBroker.csproj --configuration Release --nologo
Build succeeded. 0 Warning(s), 0 Error(s)
exit 0

native/update-admission-broker/bin/Release/net8.0/win-x64/lnwjud-update-admission-broker.exe
MAINTENANCE_REGISTRY_UNCONFIGURED
exit 125, expected unavailable result
```

The final native harness exercised actual cross-process lock exclusion and a child process exiting after stage flush but before publication. Ordinary open refused the pending file without recovering it. Explicit recovery completed the matching transition and a repeat did nothing. A conflicting predecessor remained unchanged. Missing state after an established closure refused instead of recreating open admission, and the test-only bootstrap marker refused reinitialization.

The fixture verified explicit TokenUser ownership and protected DACLs on lock, stage and published files. A native NULL-DACL fixture, an unsafe existing write grant, a real hard link and a real junction were refused. An unsafe root was not adopted or modified. Missing roots were not created. These checks do not prove ownership creation under a real service SID or elevated CI token.

The state-machine checks included closure racing with entry, late participant quarantine, parent-to-native-job promotion during closure, refusal to release a job with ordinary settlement, job holds surviving restart, epoch-bound quiescence, generation fencing and accepted-disposition reopening. Private synthetic proof factories supplied the evidence in these tests. They do not simulate an actual authenticated service Job observation.

The harness completed 520 sequential calls without retaining completed permit records, preserved an out-of-order predecessor hold, rejected replay after restart, and retired 130 successive participants with separate quiescence and cessation capabilities. Missing or mismatched capabilities refused. Completed update transaction IDs remained replay-protected across a subsequent transaction.

During implementation, compilation caught a nullable owner read and a shadowed local name; both were corrected. The sequence migration first exposed a fixture requesting sequence 3 before sequence 2 existed; the fixture now requests the actual next sequence when checking the closed gate. No timeout was increased and no assertion was removed to obtain the final pass.

Only this new directory was changed. No canonical preparation, integrity pin, installed application, SCM entry, tunnel metadata, version, Git commit or release was changed. The production executable has no endpoint or capability factory and remains unavailable. The remaining production source integrations are listed in README.md.
