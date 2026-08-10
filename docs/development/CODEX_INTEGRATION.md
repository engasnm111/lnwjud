# Codex integration

lnwjud delegates only to a locally discovered Codex CLI. The MCP/application boundary owns workspace validation, permission checks, process handles, bounded logs, and audit metadata.

## Discovery and execution

Codex discovery searches the current Windows `PATH` using the normal executable extensions, then runs only:

- `codex --version`
- `codex --help`

It does not read Codex credential files, environment tokens, prompts, or account state. The selected executable is started with an argument array and `shell: false`; the workspace canonical root is its working directory.

`codex_run` returns a `codexTaskId` and underlying process handle. The client should poll `codex_task_status`, read bounded `codex_task_logs`, inspect `git_diff`, and run the relevant project command before accepting a change. `codex_stop` is available for an owned task that must be cancelled.

Audit records keep the task id, prompt byte length, and prompt hash. Prompt text and full Codex output are not persisted as audit metadata.

## Manual real-Codex smoke

Run this procedure only on a disposable local workspace and only when a human explicitly accepts that a real Codex invocation may consume provider quota.

1. Confirm the packaged or development command is the intended `lnwjud` build.
2. Run `lnwjud codex doctor`. It should report whether the local executable is available and its detected capability state.
3. Create or select a disposable workspace with one small tracked file. Do not place secrets in it.
4. Start the local MCP transport with `lnwjud mcp --stdio --workspace <workspace-path>` using the MCP client under test.
5. Call `codex_status` first. Verify that the result reports installation/capabilities without exposing credentials.
6. If the human reviewer approves one real invocation, call `codex_run` with a narrowly scoped instruction such as reviewing the disposable file. Do not automate retries, quota polling, or repeated prompts.
7. Poll `codex_task_status`, inspect `codex_task_logs`, call `git_diff`, and run the fixture's project test. Confirm all changed paths remain inside the workspace.
8. Stop the task if it does not terminate as expected, then remove the disposable workspace after capturing only sanitized pass/fail evidence.

The automated release gate uses a fake executable and never consumes real Codex quota. A missing real Codex installation is an optional warning, not permission to inspect credentials or fabricate a successful smoke result.
