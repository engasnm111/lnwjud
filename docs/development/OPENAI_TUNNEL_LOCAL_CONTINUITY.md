# OpenAI Secure MCP Tunnel — Local-First Continuity Guide

Status: **v4.11.0 design note**
Goal: keep each user's lnwjud installation local while reusing the OpenAI Secure MCP Tunnel and tunnel-client they already own.

## Recommendation

For lnwjud users who already have an OpenAI Secure MCP Tunnel, the best architecture is:

```text
ChatGPT
   |
   | select tunnel once
   v
OpenAI Secure MCP Tunnel (persistent tunnel_id)
   |
   | outbound control-plane polling
   v
tunnel-client on the user's PC
   |
   v
lnwjud local MCP
```

Do **not** add another public static URL, domain, VPS, Cloudflare tunnel, or lnwjud relay merely to make the connection persistent.

The user's OpenAI tunnel identity is already the stable remote identity.

## What the user installs

Per machine/user:

1. lnwjud Desktop;
2. official `tunnel-client`;
3. their OpenAI `tunnel_id`;
4. their runtime API key;
5. optional Windows startup integration.

No lnwjud-operated server is required.

## What stays local

All of the following remain on the user's machine:

- source code and project files;
- shell/process execution;
- Windows UI automation;
- screenshots/clipboard;
- Git worktrees;
- durable tasks;
- Work Log/audit database;
- permission configuration;
- recovery/checkpoints;
- runtime API key.

OpenAI Secure MCP Tunnel provides the remote transport path to the local MCP server; it does not require lnwjud to make its own MCP port public.

## Stable URL vs stable tunnel identity

The original product question was "how do we get a static URL?"

With the existing OpenAI Tunnel flow, a normal lnwjud user does not actually need to own a literal public URL.

ChatGPT supports:

```text
Connection: Tunnel
select tunnel / paste tunnel_id
```

OpenAI's service routes connector MCP traffic by the tunnel identity. Official tunnel-client documentation describes the connector-facing MCP endpoint and the runtime poll/response endpoints as tunnel-ID scoped.

Therefore the useful invariant is:

```text
same tunnel_id forever
```

not:

```text
user must buy mcp.example.com
```

A local process can restart while the remote tunnel object continues to exist.

## Does this cost extra?

This design adds **no additional lnwjud infrastructure cost**:

- no VPS required;
- no domain required;
- no Cloudflare account required;
- no paid lnwjud relay required;
- no inbound public IP required.

Users still need whatever OpenAI plan, organization permissions, API/runtime credentials, and product access are required for Secure MCP Tunnel and the target ChatGPT/Codex flow.

As of this design date, the reviewed OpenAI documentation does not publish a separate per-tunnel infrastructure price line that lnwjud should hard-code or promise as permanently free. Product/API subscription and usage costs can still apply. Documentation must therefore say **"no extra lnwjud/VPS/domain cost"**, not promise that every OpenAI use case costs $0.

## Why the old custom-relay plan was unnecessary for this requirement

A custom lnwjud relay would require:

- an always-on public server;
- stable DNS/TLS;
- auth implementation;
- worker protocol;
- request routing;
- catalog caching;
- relay database;
- deployment/updates;
- new security surface;
- potentially ongoing hosting cost.

That architecture is useful only if lnwjud wants to become independent of OpenAI Secure MCP Tunnel or support arbitrary remote MCP clients without their own tunnel/control plane.

It is not necessary when the target user already has OpenAI Tunnel and wants local continuity.

## Official tunnel behavior we should leverage

The official tunnel-client documentation describes this runtime path:

```text
OpenAI product
   |
OpenAI tunnel-service MCP endpoint for tunnel
   |
tunnel-service queues command for tunnel_id
   |
tunnel-client polls GET /v1/tunnels/{tunnel_id}/poll
   |
local MCP target
   |
tunnel-client POST /v1/tunnels/{tunnel_id}/response
```

This means the process polling the tunnel can be replaced/restarted without requiring lnwjud to invent a new remote routing identity.

## Native runtime management

Recent official tunnel-client versions expose local runtime management:

```text
tunnel-client runtimes create
tunnel-client runtimes connect
tunnel-client runtimes list
tunnel-client runtimes status
tunnel-client runtimes stop
tunnel-client runtimes rm
```

For lnwjud the preferred alias is:

```text
lnwjud
```

The key idea is:

```text
runtime process = disposable
runtime alias = reconstructable
tunnel_id = persistent
```

Official tunnel-client guidance also states that stopping/disconnecting local runtime supervision leaves the remote tunnel object intact. That is exactly the behavior lnwjud needs for restart recovery.

## Proposed first-time setup

### Existing user

Most v4.10 users already have:

```text
tunnel-client.exe
tunnel_id
runtime API key
```

v4.11 migration should detect the existing profile and import/reuse these values rather than asking the user to create a tunnel again.

### UI flow

```text
Settings > Secure MCP Tunnel

Tunnel client: [detected path]
Tunnel ID:     tunnel_***************
API key:       Saved securely

Persistent runtime: ON
Start with lnwjud:   ON

[Enable / Repair Persistent Runtime]
```

The button must attach to the **existing tunnel**.

## Normal startup behavior

Every Desktop launch:

```text
1. Start local MCP.
2. Get current loopback MCP URL.
3. Read existing saved tunnel identity.
4. Inspect runtime alias `lnwjud`.
5. If healthy and correct -> leave it alone.
6. If absent/stale -> connect same tunnel_id to current MCP URL.
7. Verify health/ready/control-plane polling.
8. Keep observing and reconnecting while enabled.
```

No tunnel creation occurs in this path.

## Network outage behavior

Example:

```text
Internet down
   |
tunnel-client cannot poll
   |
lnwjud local MCP remains alive
local durable tasks remain alive
   |
Internet returns
   |
tunnel-client polling reconnects
   |
same tunnel_id receives work again
```

The UI should say `Reconnecting`, not `Create a new tunnel`.

## Desktop restart behavior

```text
Desktop closes
   |
local MCP endpoint disappears
   |
remote OpenAI tunnel object still exists
   |
Desktop starts again
   |
new loopback MCP endpoint starts
   |
lnwjud reconnects/reconfigures local runtime binding
   |
same tunnel_id
```

The ChatGPT-side tunnel selection should not need to be edited.

## Why local MCP port does not need to be static

A common mistake would be to force a fixed port only to get persistence.

That is unnecessary.

The remote stable identity is the tunnel ID. The local target can change:

```text
boot 1: 127.0.0.1:51820/mcp
boot 2: 127.0.0.1:52111/mcp
```

lnwjud simply repairs the tunnel-client local binding to the current URL.

A dynamic loopback port is safer against conflicts and does not affect the ChatGPT tunnel identity.

## Outcome-driven work vs tunnel continuity

These are different problems.

### Tunnel continuity

Goal:

```text
one call ends
connection/process later restarts
next call still reaches same lnwjud installation/tunnel
```

### Long-running work

A remote MCP command can carry an individual response deadline. That does not justify a run-wide elapsed-time timer or a handoff instruction injected into unrelated tool results.

For long work lnwjud must continue using:

```text
shell/build/test
   -> return durable task_id quickly
   -> task runs locally
   -> tunnel can reconnect
   -> status/result until terminal
```

This is the local-first execution path for naturally asynchronous commands. ChatGPT should continue the remaining reasoning and verification in the same run whenever it remains active, stopping only on completed acceptance or a real blocker.

## Request delivery safety

Official tunnel protocol includes an opaque `request_id` per polled command. Terminal responses echo that ID and tunnel-client has documented retry rules for response delivery.

Important protocol rule:

- retry eligible terminal response delivery with the same correlation/body;
- if response delivery returns `404` because the request is already fulfilled/no longer pending, treat it as terminal;
- do not rerun the local MCP operation simply to manufacture another response.

Therefore lnwjud should not implement its own competing tunnel poller or response retry logic.

The official binary owns that protocol.

## What lnwjud should implement

### Required

- detect supported tunnel-client capabilities/version;
- prefer native long-lived runtime alias management;
- preserve one saved tunnel ID;
- reconnect forever at bounded cadence while enabled;
- distinguish retryable vs auth/operator errors;
- repair changed local MCP URL;
- start automatically after local MCP is ready;
- optional startup at Windows logon;
- health/ready/poll-health visibility;
- same-tunnel reconnect button;
- chaos tests.

### Not required

- custom public hostname;
- custom relay protocol;
- custom tunnel-service clone;
- custom remote request queue;
- cloud database;
- web dashboard;
- DNS provider integration;
- Cloudflare integration;
- mandatory user account.

## Compatibility with current tunnel-controller

Do not delete the existing implementation immediately.

Use an adapter model:

```text
TunnelRuntimeAdapter
   |
   +--> NativeRuntimesAdapter      preferred
   |
   +--> LegacyProfileRunAdapter    existing fallback
```

This lets users with current configurations upgrade without redoing their tunnel.

## Acceptance checklist for a normal end user

A clean v4.11 user story should be:

1. install lnwjud;
2. download/install official tunnel-client;
3. enter/select their existing tunnel ID and save runtime key once;
4. enable Persistent Runtime;
5. configure ChatGPT to that tunnel once;
6. use lnwjud normally;
7. reboot Windows or restart lnwjud;
8. wait for `Connected`;
9. continue using the same ChatGPT tunnel.

No domain or extra server setup appears anywhere in that onboarding.

## Failure UX

### Transient

```text
Reconnecting to existing tunnel...
Tunnel ID unchanged
Retry in 30s
```

### Auth

```text
Tunnel authentication needs attention
Save/rotate runtime API key
Tunnel ID will be preserved
```

### Missing client

```text
Tunnel client not found
Choose tunnel-client.exe
Existing tunnel ID will be preserved
```

### Local MCP stale binding

Repair automatically and report:

```text
Local MCP binding updated
Remote tunnel identity unchanged
```

## Future optional architectures

A self-hosted or managed lnwjud relay can still be explored later for scenarios such as:

- non-OpenAI clients that cannot use Secure MCP Tunnel;
- cross-provider persistent profiles;
- multiple worker devices behind one product profile;
- fleet management;
- OpenAI-independent hosting.

That is a separate product feature. It should not block or complicate v4.11 local continuity.

## Official references

- Secure MCP Tunnel client: https://github.com/openai/tunnel-client
- End-user guide: https://github.com/openai/tunnel-client/blob/master/docs/end-user-guide.md
- Connector flow: https://github.com/openai/tunnel-client/blob/master/docs/connectors.md
- Protocol: https://github.com/openai/tunnel-client/blob/master/docs/protocol.md

Review these again at implementation/release time because tunnel-client lifecycle commands and control-plane behavior can evolve.
