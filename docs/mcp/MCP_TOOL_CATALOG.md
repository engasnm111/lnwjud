# MCP Tool Catalog — V1 narrative catalog and capability notes

Target protocol: MCP `2026-07-28` using TypeScript SDK v2.

Current runtime registry: **231 total tool definitions**, with **195 advertised by default**
and **201 advertised when the six `codex_*` delegation tools are enabled**. Planned and feature-disabled definitions remain in the complete inventory without appearing in normal `tools/list`. The historical 184-tool
snapshot remains a compatibility baseline; the narrative below is intentionally
not a complete generated list.

All tools return structured JSON-compatible output plus concise text where useful. Tool catalog order is deterministic. Desktop MCP uses the selected permission profile. Packaged standalone/headless STDIO keeps `full` as its backward-compatible default but supports `safe`, `balanced`, `full`, and `custom`; Secure Tunnel uses the running Desktop MCP permission profile and Active Project.

> **Phase 00 contract note:** the live `v1.1.4` runtime advertises 53 tools.
> The complete current name/permission/annotation/schema-source matrix is
> [`docs/architecture/TOOL_CONTRACT.md`](../architecture/TOOL_CONTRACT.md),
> and the measured live discovery snapshot is [`docs/benchmarks/BASELINE.md`](../benchmarks/BASELINE.md).
> The numbered narrative below is retained for field-level guidance and
> historical V1 compatibility; it must not be used as a 49-tool count.

## 1. workspace_info

Permission: READ; read-only.

Input:
```ts
{ workspaceId: string }
```

Output includes display name, canonical root, project profile summary and current branch if Git repo.

## 2. workspace_tree

Permission: READ; read-only.

Input:
```ts
{
  workspaceId: string;
  path?: string;
  maxDepth?: number; // 1..8, default 4
  maxEntries?: number; // 1..5000, default 2000
}
```

Ignore heavy dirs by default: `.git`, `node_modules`, `dist`, `build`, `coverage`, `.next`, `vendor`.

## 3. project_snapshot

Permission: READ.

Returns bounded summary: profile, Git status counts, top-level tree, active managed processes and recent error summaries. Must not include source file contents.

## 4. read_file

Permission: READ.

Input:
```ts
{
  workspaceId: string;
  path: string;
  startLine?: number;
  endLine?: number;
}
```

Binary rejected. Default full read max 2 MiB.

## 5. read_files

Permission: READ.

Input list max 20 files; total output cap 4 MiB.

## 6. search_files

Permission: READ.

Filename/path search inside workspace. Output max 500 paths.

## 7. search_text

Permission: READ.

Input:
```ts
{
  workspaceId: string;
  query: string;
  glob?: string;
  maxResults?: number; // <= 500, default 200
}
```

Uses ripgrep direct process invocation; query is an arg, not shell string.

## 8. git_status

Permission: READ.

Porcelain-based parsed output.

## 9. git_diff

Permission: READ.

Input optional path and staged flag. Bounded output with truncation metadata.

## 10. git_log

Permission: READ.

Default 20 commits, max 100. Structured hashes/authors/dates/subjects.

## 11. write_file

Permission: WRITE; modifying.

Writes UTF-8 text. Create checkpoint entry before overwrite. Refuse secret target unless explicit allowed policy permits.

## 12. apply_patch

Permission: WRITE.

Patch format must be explicit unified/app-specific patch representation parsed without invoking shell `patch`. Validate every affected path before applying. Atomic per-file write where possible.

## 13. move_file

Permission: WRITE.

Both source and destination must resolve inside same authorized workspace.

## 14. delete_file

Permission: DANGEROUS; destructive.

Only file/specific empty directory in V1; recursive deletion tool is not exposed. Workspace root deletion always denied.

## 15. process_start

Permission: EXECUTE.

Input:
```ts
{
  workspaceId: string;
  executable: string;
  args: string[];
  cwd?: string;
  timeoutMs?: number;
}
```

This tool is restricted by executable policy; it is not a shell.

Output `{ processId, state }`.

## 16. process_status

Permission: READ.

Input process handle.

## 17. process_logs

Permission: READ.

Input:
```ts
{
  processId: string;
  tailLines?: number;
  sinceSequence?: number;
}
```

Returns stdout/stderr records with sequence numbers and truncation metadata.

## 18. process_stop

Permission: EXECUTE.

Can stop only process IDs created/owned by lnwjud.

## 19–23. project_* commands

- `project_dev`
- `project_test`
- `project_lint`
- `project_typecheck`
- `project_build`

Permission: EXECUTE.

No arbitrary command argument; commands come from detected ProjectProfile. Returns process handle; short commands may be awaited by application wrapper but still use process manager internally.

## 24. codex_status

Permission: READ.

Returns installation/path/version/capability presence only. Must not inspect credential files.

## 25. codex_run

Permission: EXECUTE.

Input:
```ts
{
  workspaceId: string;
  instruction: string;
}
```

Instruction is passed according to detected Codex CLI capability; audit stores hash/length, not content. Returns `codexTaskId` and underlying process handle.

## 26. codex_task_status

Permission: READ.

## 27. codex_task_logs

Permission: READ.

Same bounded log behavior as process logs.

## 28. codex_stop

Permission: EXECUTE.

Stops only Codex process launched by lnwjud.

## Local desktop capabilities

The following sixteen tools are available through the same loopback MCP server when the desktop
runtime is running. They expose the local capability contract while preserving lnwjud's
loopback-only boundary.

## 29. shell

Permission: EXECUTE; direct local executable invocation, not a free-form shell parser.

Supports foreground/background execution, bounded stdout/stderr, task status/logs/result/cancel,
timeouts, dry-run, and canonical working-directory checks inside registered or explicitly
configured local roots. Arguments are passed separately and child processes use `shell: false`.

## 30. dom_cdp

Permission: DANGEROUS; local managed Chrome DevTools Protocol.

Supports launch/status/list-tabs/new-tab/close-tab, navigate, JavaScript evaluation, DOM query,
click, type, wait, screenshot, and batches of up to 100 steps. CDP HTTP and WebSocket endpoints
must remain on loopback.

Target-scoped calls are fail-closed: call `list_tabs`, choose the intended exact returned ID after
checking URL/title, or use `new_tab` and retain its returned ID. Pass the same top-level `tab_id`
to every page-targeted call or `steps` batch. If the target disappears, stop and re-list; never
substitute the first or OS-active tab. Do not use Accessibility, computer-use, or low-level input
to type a URL into a browser address bar as a navigation fallback. A mutation against a ChatGPT
tab additionally requires both `allow_protected_tab_action: true` and real `userConfirmed: true`;
Full Bypass does not count as that explicit-user confirmation.

## 31. accessibility

Permission: DANGEROUS; Microsoft UI Automation on Windows.

Supports application/window discovery, semantic tree inspection, element lookup, focus, values,
invoke/click, selection, menus, and native window actions.

## 32. input_event

Permission: DANGEROUS; current interactive Windows session.

Supports text, paste-style Unicode input, key/hotkey state, pointer movement, click variants,
drag, scroll, button state, release-all, and batched sequences. Use DOM or Accessibility first.

## 33. vision

Permission: READ; local screen capture and optional OCR.

Supports display, region, and window PNG capture. OCR returns a truthful unavailable result when a
local OCR runtime is not installed.

## 34. window

Permission: DANGEROUS; native Windows window management.

Supports list/get-active/get-bounds/get-display/activate/close/minimize/maximize/restore/move,
resize, and `set_window_frame`.

## 35. health

Permission: READ; diagnostics only.

Returns per-tool availability/readiness and does not perform input, browser, or window side effects.

## 36. system_info

Permission: READ; read-only.

Input:
```ts
{
  operation?: 'all' | 'cpu' | 'memory' | 'disks' | 'battery' | 'uptime' | 'os' | 'processes';
  top_count?: number; // 1..50, default 10, for operation processes
}
```

Returns OS, CPU, memory, disk, battery, uptime, and top-process information from Windows CIM/process APIs.

## 37. notification

Permission: EXECUTE.

Input:
```ts
{ action?: 'show'; title: string; message: string }
```

Shows a Windows toast (BurntToast when installed) or a balloon notification otherwise.

## 38. file_dialog

Permission: EXECUTE.

Input:
```ts
{
  action: 'open' | 'save';
  initial_directory?: string;
  filter?: string;         // e.g. "All files (*.*)|*.*"
  multi_select?: boolean;  // open only
  file_name?: string;      // save only
}
```

Opens a native Windows dialog and returns the chosen path(s). The dialog itself does not
read or write files; use the guarded file tools afterwards.

## 39. clipboard

Permission: DANGEROUS.

Input:
```ts
{ action: 'get_text' | 'set_text' | 'get_image'; text?: string }
```

`get_text`/`set_text` read/write clipboard text. `get_image` returns a PNG clipboard image
as base64 when one is present.

## 40. web_fetch

Permission: DANGEROUS.

Input:
```ts
{
  url: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'HEAD'; // default GET
  headers?: { name: string; value: string }[];           // max 64
  body?: string;                                          // POST/PUT/DELETE only
  max_bytes?: number;                                     // default 5 MiB, max 10 MiB
  timeout_seconds?: number;                               // default 60, max 600
}
```

Fetches http/https URLs only. Returns `status`, `status_text`, `url`, `content_type`,
`byte_length`, `truncated`, and `text` (text types) or `data_base64` (binary types).

## 41. audio

Permission: DANGEROUS; microphone and speaker access.

Input:
```ts
{
  action: 'record' | 'play' | 'stop';
  output_path?: string;      // record: .wav target inside configured roots
  file_path?: string;        // play: local audio file
  duration_seconds?: number; // record: 1..600, default 10
}
```

`record` captures the microphone to a WAV file synchronously. `play` plays a local audio
file through MCI. `stop` aborts an ongoing record/play. In non-unrestricted mode, target
paths must resolve inside configured local capability roots.

## 42. screen_record

Permission: DANGEROUS; screen capture.

Input:
```ts
{
  action: 'start' | 'stop' | 'status';
  output_path?: string; // start: .mp4 target
  offset_x?: number; offset_y?: number;
  width?: number; height?: number;
  fps?: number; // 1..60, default 10
}
```

Records the screen to MP4 using `ffmpeg -f gdigrab` (requires ffmpeg on PATH).
`start` spawns a background capture; recording stops automatically after 3600 seconds.
`stop` finalizes the file; `status` reports the active capture. State is kept in
`%TEMP%\lnwjud-screen-record-state.json`.

## 43. office

Permission: DANGEROUS; Microsoft Office COM automation.

Input:
```ts
{
  app: 'excel' | 'word';
  action: 'read' | 'write' | 'read_text' | 'replace' | 'save_as';
  file_path: string;
  target_path?: string;  // save_as
  sheet?: string;        // excel
  range?: string;        // excel read/write, e.g. A1:D10
  values?: unknown;      // excel write
  find?: string;         // word replace
  replace_with?: string; // word replace
}
```

Excel: read/write cell ranges and save-as. Word: read full text, find/replace, save-as.
Requires Microsoft Office installed. COM objects are released after every call.

## 44. scheduler

Permission: DANGEROUS; Windows scheduled tasks.

Input:
```ts
{
  action: 'list' | 'create' | 'delete' | 'run'; // default list
  task_name?: string;    // 1-200 chars [\w .-]
  command?: string;      // create
  arguments?: string[];  // create, max 64
  schedule?: string;     // create, e.g. DAILY
  start_time?: string;   // create, HH:MM, default 09:00
}
```

Manages Windows scheduled tasks with `schtasks.exe` (argument arrays, `shell: false`).

## 44a. wsl_exec and wsl_fs

`wsl_exec` is a scoped Windows-to-WSL runner. It requires a registered
`workspaceId`, takes a Linux `executable` plus `arguments[]`, and maps an
absolute Windows `cwd` only through registered roots. It delegates foreground,
background, wait, logs, result, and cancel to the existing bounded task runner.
Shell interpreters with `-c`/`--command`/`-e` style string execution are
rejected. Environment input is an explicit bounded key/value allowlist; host
environment and arbitrary host paths are not inherited.

`wsl_fs` supports `windows_to_wsl` and `wsl_to_windows` translation plus
Windows-side metadata. It never performs raw `\\wsl$` or `\\wsl.localhost`
read/write. Cross-filesystem performance remains visible to the caller through
the returned mapping metadata and the WSL warning in the architecture contract.

## 44b. vision_annotated_capture and ui_target_action

`vision_annotated_capture` combines Accessibility observation and local screen
capture, filters disabled/offscreen/empty controls, and returns an annotated PNG,
`marks[]`, `observationId`, `observationHash`, and `expiresAt`.
`ui_target_action` requires the workspace owner and mark identity, rejects stale
hashes/TTL, re-finds the Accessibility element, and applies the explicit
permission/confirmation policy before any action.

## 44c. OCR and dynamic routing

The existing `vision` tool retains `action: 'ocr'`. WinRT OCR is optional and
requires a signed sparse package identity plus the packaged C# helper; otherwise
the result is `available: false` with a reason code. `tool_search` and
`route_intent` now expose deterministic scores/reason codes, selected model,
permission metadata, and `authorizationUnchanged`; `tool_dynamic_filter` is the
bounded top-K facade. Local rerank is opt-in and falls back locally.

## 45. skills_list

Permission: READ; read-only skill discovery.

Lists local agent skills discovered from Cursor, Claude, Agents, workspace skill
roots, and lnwjud `extensions.extraSkillRoots`. Optional filters: `query`, `source`.

## 46. skills_read

Permission: READ; read-only skill content access.

Reads `SKILL.md` for a skill id, or a relative path inside that skill folder.
Paths may not escape the skill directory.

## 47. mcp_list

Permission: READ; read-only child MCP discovery.

Lists MCP servers discovered from `%USERPROFILE%\.cursor\mcp.json`,
`%APPDATA%\Claude\claude_desktop_config.json`, and lnwjud settings. lnwjud itself
is excluded to prevent recursion. Default mode enables all other discovered
servers.

## 48. mcp_describe

Permission: READ; read-only child tool-catalog inspection.

Connects to one enabled child MCP server (lazy stdio) and returns tool names,
descriptions, and input schemas.

## 49. mcp_call

Permission: DANGEROUS; full-access meta-tool.

Forwards `{ server, tool, arguments }` to a child MCP server. Child tools may
write, execute, or control the desktop according to that server. Available on
all transports including the Secure MCP Tunnel when the operator chooses to run
the tunnel.

## Annotations

Read-only hints:
`workspace_info`, `workspace_tree`, `project_snapshot`, `read_file`, `read_files`, `search_files`, `search_text`, `git_status`, `git_diff`, `git_log`, `process_status`, `process_logs`, `codex_status`, `codex_task_status`, `codex_task_logs`.

`skills_list`, `skills_read`, `mcp_list`, and `mcp_describe` are read-only and
use `permission: READ`. `mcp_call` remains `DANGEROUS` because the child server
controls its own side effects and the gateway cannot prove the called tool is read-only.

Destructive hint true only where behavior can remove data, notably `delete_file` and future restore operations that overwrite current files.

## Explicit non-tools

The core V1 catalog intentionally has no:
- `run_shell`
- `powershell`
- `cmd`
- `git_reset`
- `git_clean`
- `kill_pid`
- `read_arbitrary_path`

The local capability layer is the separate parity extension documented in
`docs/superpowers/specs/2026-08-11-lnwjud-local-capabilities-design.md`.

The skills/MCP bridge package is `@lnwjud/extensions`.
