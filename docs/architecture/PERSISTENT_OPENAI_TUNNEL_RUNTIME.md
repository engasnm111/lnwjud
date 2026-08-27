# Persistent OpenAI Tunnel Runtime Architecture

Status: **proposed for v4.11.0**
Design principle: **OpenAI tunnel identity is persistent; local runtime processes are replaceable.**

## Why this architecture

lnwjud users already have a local MCP runtime and can already use OpenAI Secure MCP Tunnel. The missing feature is not another public relay. It is reliable local supervision so the same OpenAI tunnel remains attached to the current local lnwjud MCP endpoint after process restarts or network interruptions.

The architecture must remain local-first:

- all tools execute on the user's machine;
- local permission/recovery policy remains authoritative;
- tunnel-client runs on the user's machine;
- runtime credentials remain on the user's machine;
- no mandatory lnwjud cloud, VPS, public domain, Cloudflare, or inbound firewall rule is introduced.

## Stable identity

The stable remote identity is the OpenAI Secure MCP Tunnel `tunnel_id`.

ChatGPT's supported flow is:

```text
Settings / Connectors
Connection: Tunnel
select existing tunnel or paste tunnel_id
```

The user should perform that association once. Local runtime repairs must not create or swap the tunnel ID.

Official tunnel-client behavior routes work by tunnel identity:

```text
GET  /v1/tunnels/{tunnel_id}/poll
POST /v1/tunnels/{tunnel_id}/response
```

The connector-facing endpoint is owned by OpenAI's tunnel service. lnwjud does not need to publish its own static HTTPS hostname.

## Target topology

```text
OpenAI-hosted product
        |
        | same tunnel_id
        v
OpenAI Secure MCP Tunnel control plane/service
        |
        | outbound polling / response delivery
        v
+-----------------------------------+
| tunnel-client on user's machine   |
| alias: lnwjud                     |
| persistent local supervision      |
+----------------+------------------+
                 |
                 | loopback HTTP
                 v
http://127.0.0.1:<port>/mcp
                 |
                 v
+-----------------------------------+
| lnwjud Desktop MCP                |
| application-global lifecycle      |
+----------------+------------------+
                 |
                 v
Existing application services / tools / durable tasks
```

## Existing source foundation

### Desktop MCP lifecycle

`apps/desktop/src/main/mcp-lifecycle.ts`

- owns one application-global HTTP MCP listener;
- returns the current loopback URL;
- listener lifecycle is independent of tunnel-client process lifetime.

### Tunnel integration

`apps/desktop/src/main/tunnel-controller.ts`

Already provides:

- saved tunnel-client path;
- saved protected runtime API key;
- profile configuration;
- tunnel doctor;
- tunnel ownership locking;
- health/log inspection;
- process start/stop;
- bounded auto-restart;
- rewriting local MCP target to current Desktop loopback URL.

### Tunnel profile

`apps/desktop/src/main/tunnel-profile.ts`

Already ensures Secure Tunnel targets the live Desktop HTTP MCP rather than requiring a fresh stdio MCP child per tunnel process.

### Durable work

`packages/capabilities/src/durable-shell-task-store.ts`

Long work is already represented independently of one remote MCP call or one tunnel connection.

## New component: TunnelRuntimeReconciler

The v4.11 controller should be desired-state based rather than child-process based.

```text
Desired state
  enabled = true
  tunnel_id = saved tunnel identity
  runtime_alias = lnwjud
  local_mcp_url = current Desktop endpoint

Observed state
  tunnel-client available?
  alias exists?
  process running?
  health OK?
  ready OK?
  control-plane poll healthy?
  alias tunnel ID correct?
  local target correct?

Reconcile
  no-op / connect / repair / wait for auth / retry
```

This component must not own or recreate the remote tunnel object itself.

## Native runtime adapter

Prefer official tunnel-client runtime management when supported:

```text
tunnel-client runtimes connect
tunnel-client runtimes status
tunnel-client runtimes stop
```

The adapter normalizes the CLI output into internal state.

Suggested interface:

```ts
interface TunnelRuntimeAdapter {
  features(): Promise<TunnelClientFeatures>;
  status(alias: string): Promise<TunnelRuntimeStatus>;
  connect(input: TunnelConnectInput): Promise<TunnelRuntimeStatus>;
  stop(alias: string): Promise<TunnelRuntimeStatus>;
}
```

`TunnelConnectInput` includes references to protected credentials, the immutable `tunnelId`, and the current local MCP URL.

For older tunnel-client versions that lack native runtime lifecycle commands, adapt the existing `run --profile lnwjud` implementation behind the same interface.

## Identity model

### Remote identity

```text
tunnel_id
```

Persistent until the user explicitly changes it.

### Local runtime identity

```text
runtime alias = lnwjud
process PID
client instance ID
health URL
```

Ephemeral/rebuildable.

### Local MCP identity

```text
127.0.0.1:<current-port>/mcp
```

May change between Desktop launches.

The reconciler bridges the stable remote identity to the current local MCP identity.

## Startup sequencing

Correct sequence:

```text
Desktop bootstrap
   |
   +--> application services ready
   |
   +--> start Desktop MCP HTTP
   |
   +--> obtain actual endpoint
   |
   +--> start TunnelRuntimeReconciler
           |
           +--> load tunnel identity / secret references
           +--> inspect native runtime alias
           +--> reconcile target URL
           +--> verify health/readiness/polling
```

Incorrect sequence:

```text
start tunnel-client
then wait for Desktop MCP to appear
```

The local target must exist before reconnecting the remote runtime.

## Reconnect state machine

Suggested normalized states:

```text
disabled
config_missing
starting
connected
reconnecting
auth_required
local_mcp_unavailable
client_missing
error
```

Transient errors retry forever while enabled, with capped backoff.

```text
1s
2s
4s
8s
15s
30s
60s + jitter
```

Do not use a permanent `MAX_AUTO_RESTARTS = 5` stop condition for the persistent mode. A burst counter can change UI severity or slow retries but must not abandon the user's tunnel indefinitely after temporary instability.

## Error classification

### Retry automatically

- local tunnel-client process unexpectedly exited;
- DNS/connectivity failure;
- temporary OpenAI control-plane unavailability;
- retryable HTTP 429/5xx behavior surfaced by tunnel-client;
- local runtime alias stale;
- Desktop MCP URL changed.

### Wait for operator repair

- 401/403 authentication/authorization;
- saved runtime key unavailable/revoked;
- tunnel ID no longer accessible;
- tunnel-client executable missing;
- profile/config invalid in a non-repairable way.

After operator repair, reconnect the same tunnel ID.

## Local MCP binding repair

On Desktop restart the local endpoint can change:

```text
before: http://127.0.0.1:51821/mcp
after:  http://127.0.0.1:51907/mcp
```

Required behavior:

```text
tunnel_id = unchanged
runtime alias = unchanged logical alias
local binding = update/reconnect to new URL
ChatGPT configuration = untouched
```

The current profile-rewrite logic can be reused for the compatibility backend.

## Ownership and duplicate prevention

Only one local runtime should drain a given lnwjud profile unless explicitly supported by future tunnel-client semantics.

Reuse the existing tunnel ownership lock to avoid:

- Desktop spawning one runtime while a Windows startup task owns another;
- old script process and Desktop both serving the same profile;
- reconnect race creating duplicate local runtimes.

Native runtime alias state should become another observation source, not a reason to remove the lock abruptly.

## Protocol correlation

The official tunnel protocol already gives each polled command an opaque `request_id` and requires it to be echoed in response delivery. Terminal response retries preserve exact correlation and body, and a response `404` means the command is no longer pending and the local MCP operation must not be replayed merely to produce another response.

v4.11 should rely on official tunnel-client behavior instead of reimplementing the tunnel wire protocol.

If request IDs become observable at the local integration boundary, lnwjud may attach them to Activity/Work Log diagnostics, but they must remain opaque.

## Long-running work boundary

Transport persistence does not override remote request deadlines.

For work that can exceed interactive tool-call limits:

```text
remote call
   |
   +--> start durable local task
   |
   +--> return task_id promptly

connection may disappear

later call
   |
   +--> status/result(task_id)
```

The durable task store is the continuity mechanism for execution. Tunnel persistence is the continuity mechanism for subsequent access to that execution.

## Schema/catalog behavior

Transport reconnect and schema refresh are separate concerns.

### Same lnwjud schema

Restarting Desktop/tunnel-client should not require connector reconfiguration. Acceptance testing should verify the same configured tunnel continues serving the unchanged catalog.

### Changed schema

If a lnwjud upgrade changes tool metadata/schema, supported ChatGPT behavior may require its normal connector refresh. v4.11 must not introduce a fake proxy catalog just to hide legitimate schema changes.

This keeps the implementation local and avoids a second catalog control plane.

## Security boundary

Nothing about persistent reconnect bypasses local protections.

The existing local runtime remains final authority for:

- Active Project selection;
- canonical path checks;
- Full/Balanced/Safe profiles;
- destructive operation settings;
- critical files;
- Recovery Trash/checkpoints;
- process/task ownership;
- plugin/capability restrictions;
- native approval where still required.

Tunnel-client transports requests. It does not grant permission to execute them.

## Secret handling

Runtime API key:

- encrypted/protected locally;
- passed via supported environment/file reference where possible;
- never committed;
- never printed in Work Log;
- never embedded in support bundles;
- rotation preserves tunnel identity.

Tunnel ID is an identifier rather than the runtime bearer secret, but logs/UI should still avoid unnecessary full exposure where masking is practical.

## Windows startup mode

Optional feature:

```text
Start persistent tunnel at Windows logon
```

It may use a Scheduled Task or native tunnel-client supervision. Requirements:

- same runtime alias;
- same tunnel ID;
- shared ownership discipline;
- Desktop can observe an externally started healthy runtime;
- Desktop must not kill another verified healthy owner just to take ownership;
- Stop/Reconfigure must be explicit.

## Observability

Desktop should expose:

```text
Tunnel identity
Runtime alias
Runtime state
Process running
Health
Ready
Control-plane polling
Current local MCP URL
Reconnect count
Last connected time
Last transient error
Operator action required
```

No raw API keys.

## Acceptance statement

```text
ChatGPT is configured once to tunnel_id X
        |
tunnel-client exits / Desktop restarts / network drops
        |
lnwjud restores the local runtime using tunnel_id X
        |
OpenAI tunnel begins draining to the current local MCP again
        |
next tool call works
        |
no new tunnel and no public URL are created
```

That is the complete v4.11 architecture target.

## Explicit non-goals

Do not add in v4.11:

- lnwjud relay server;
- persistent public domain owned by lnwjud;
- Cloudflare integration as a requirement;
- WebSocket worker protocol;
- profile routing service;
- cloud catalog cache;
- account/device fleet database;
- custom OAuth server;
- multi-device failover.

Those are independent future features and are not necessary for local persistent OpenAI Tunnel continuity.
