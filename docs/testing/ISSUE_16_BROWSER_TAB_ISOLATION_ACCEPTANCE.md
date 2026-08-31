# Issue #16 Browser Tab Isolation Acceptance

Status: acceptance A-H passed for lnwjud `4.29.0` on 2026-08-29; final packaging/provenance verification follows this evidence update.

This record is intentionally redacted. It records only version/transport metadata, tab IDs, harmless URLs, tool names, permission outcomes, and pass/fail evidence. It must not contain cookies, auth headers, page contents, SQL, tokens, or ChatGPT conversation text.

## Normative browser targeting contract

1. Call `dom_cdp` with `action: "list_tabs"`.
2. Match the intended existing tab by exact returned ID plus inspected URL/title.
3. If there is no safe match, call `dom_cdp` with `action: "new_tab"` and retain its returned ID.
4. Pass the same top-level `tab_id` to every target-scoped call or `steps` batch.
5. If the target disappears, stop and re-list; never substitute the first or OS-active tab.
6. Never use native address-bar input as a browser-navigation fallback.

Mutating a ChatGPT tab additionally requires both `allow_protected_tab_action: true` and real `userConfirmed: true`. Full Bypass does not satisfy the explicit-user condition.

## Candidate metadata

| Field | Evidence |
| --- | --- |
| Source branch | `dev` |
| Candidate code commit | `38ab96f` (acceptance evidence is committed afterward; no browser implementation changed during H) |
| Package version | `4.29.0` |
| Installed executable version/path | `C:\Users\ABCz\AppData\Local\Programs\lnwjud\lnwjud.exe`; FileVersion `4.29.0`, ProductVersion `4.29.0.0` |
| MCP transport | A-G: source-built `@lnwjud/capabilities` candidate against real lnwjud-managed Chrome CDP; H: actual ChatGPT request through the installed Secure MCP Tunnel runtime |
| Chrome CDP port/profile | Managed Chrome CDP `127.0.0.1:9222`; disposable lnwjud-managed browser lifecycle used |
| Harmless navigation destinations | A-G: `https://example.com/?issue16=verified`; H: `https://example.com/?issue16=case-h` |

## Acceptance matrix

| Case | Invocation | Expected result | Result | Evidence |
| --- | --- | --- | --- | --- |
| A | `navigate` without `tab_id` while two tabs exist | `INVALID_INPUT`; neither URL changes | **PASS** | Returned `INVALID_INPUT`; request log empty; both managed tab URLs unchanged |
| B | Explicit application `tab_id` while ChatGPT tab is OS-active | Only the application tab navigates | **PASS** | `Page.bringToFront` first targeted the ChatGPT sentinel; subsequent candidate `Page.navigate` dispatched only to application ID `2FD5...FEC3`; sentinel URL remained `https://chatgpt.com/` |
| C | Two-step batch with OS focus/order changes between observations | Every CDP request uses the same application ID | **PASS** | Protocol wrapper reversed target-list order; both `Runtime.evaluate` dispatches remained on application ID `2FD5...FEC3` |
| D | Protected ChatGPT ID without override/confirmation | `PERMISSION_DENIED`; no request/close dispatch | **PASS** | Returned `PERMISSION_DENIED`; request log empty |
| E | Protected ChatGPT ID with override but without `userConfirmed` | `PERMISSION_DENIED` even under Full Bypass | **PASS** | Explicit Full Bypass authorization still returned `PERMISSION_DENIED`; request log empty |
| F | Protected ChatGPT ID with both explicit fields | Only that exact ID is dispatched | **PASS** | Disposable protected target dispatched one `Page.navigate` only to ID `B362...AD91` |
| G | Target closes after selection | Fail with target-not-found; do not choose another tab | **PASS** | Closed disposable target returned `INVALID_INPUT` target-not-found; request log empty; surviving application tab remained unchanged |
| H | Actual ChatGPT/Secure MCP request to navigate a harmless target | Live Logs show `dom_cdp` plus exact `tab_id`; no `computer_use`, `accessibility`, or `input_event` address-bar sequence | **PASS** | Installed 4.29.0 server rejected `navigate` without `tab_id`; actual ChatGPT request then navigated exact ID `5C9D...C950` to `https://example.com/?issue16=case-h`. `mcp-activity.log` recorded `dom_cdp:navigate tab=5C9D...C950`; the H acceptance session contained only `dom_cdp` and bounded `shell` verification calls, with no `computer_use`, `accessibility`, or `input_event` calls |

## Managed Chrome A-G evidence

A-G ran on 2026-08-29 against real lnwjud-managed Chrome on CDP port `9222`, using the source-built 4.29.0 candidate backend and the real CDP protocol. The protected sentinel ID was `B362...AD91` at `https://chatgpt.com/`; the application target ID was `2FD5...FEC3` at `https://example.com/`. The acceptance harness wrapped only `listTabs`/`request` for bounded dispatch evidence while delegating all browser operations to the real `NodeBrowserCdpProtocol`. Case C deliberately reversed the returned target-list ordering between resolutions; both batch requests still used the same application ID. No cookies, page payloads, credentials, or conversation contents were recorded.

## Actual ChatGPT / Secure MCP Tunnel H evidence

After installing 4.29.0, the local executable reported FileVersion `4.29.0` / ProductVersion `4.29.0.0`. Through this ChatGPT conversation's Secure MCP connection, `dom_cdp status` initially reported no managed browser, then `launch` opened a managed `https://example.com/` target. A direct `navigate` without `tab_id` failed server-side validation with `Target-scoped DOM actions require tab_id`, proving the installed runtime is enforcing the candidate contract even if the host-retained displayed tool schema has stale descriptive metadata. The client then listed tabs, selected exact ID `5C9D...C950`, and navigated only that target to `https://example.com/?issue16=case-h`.

The local `mcp-activity.log` recorded the target summary `dom_cdp:navigate tab=5C9D...C950`. For the H acceptance session beginning at 2026-08-29T11:17:00Z, grouped activity contained only `dom_cdp` and bounded `shell` verification calls; there were no `computer_use`, `accessibility`, or `input_event` calls. This distinguishes the successful CDP navigation from the address-bar/native-input failure mode described in the original report.

## Final sign-off

All acceptance cases A-H pass with redacted evidence. Issue #16 browser target isolation is accepted for the 4.29.0 candidate. Final repository status, pushed commit, rebuilt installer provenance, and SHA-256 values are verified separately after this evidence file is committed.
