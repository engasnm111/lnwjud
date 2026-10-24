---
name: ponytail-debt
description: >
  List every `shortcut:` comment (and older `ponytail:` ones) as a debt ledger. One-shot report,
  changes nothing. Use for "ponytail debt", "what did ponytail defer", "list the
  shortcuts", /ponytail-debt.
---

For lnwjud, first read [repository integration](../ponytail/references/lnwjud.md). It controls activation, source discovery, and host-specific guidance below.

Every deliberate ponytail shortcut is marked with a `shortcut:` comment naming
its ceiling and upgrade path (older code may say `ponytail:`). This collects them into one ledger so a deferral
can't quietly become permanent.

## Scan

Query CodeGraph first when `.codegraph/` exists. Comment markers are not
fully represented by a symbol graph, so then scan them with `rg`, honoring
`.gitignore` and excluding Git metadata, dependencies, and build output:

```sh
rg -n --hidden --glob "!.git/**" --glob "!**/node_modules/**" --glob "!**/dist/**" --glob "!**/build/**" '(#|//|/\*) ?(shortcut|ponytail):' .
```

Add comment prefixes for the actual language when needed.

If the user names their own marker word (`/ponytail-debt TODO`), scan for that literal marker instead, escaping regex characters.

Each hit is one ledger row. The comment prefix keeps prose that merely mentions
the convention out of the ledger. Skip hits that are not a deferral, like a note
about a keyboard shortcut.

## Output

One row per marker, grouped by file:

`<file>:<line>, <what was simplified>. ceiling: <the limit named>. upgrade: <the trigger to revisit>.`

The convention is `shortcut: <ceiling>, <upgrade path>`, so pull the ceiling
and the trigger straight from the comment. Want an owner per row too? add
`git blame -L<line>,<line>`.

Flag the rot risk: any marker comment that names no upgrade path or
trigger gets a `no-trigger` tag, those are the ones that silently rot.

End with `<N> markers, <M> with no trigger.` Nothing found: `No shortcut debt. Clean ledger.`

## Boundaries

Reads and reports only, changes nothing. When the user requests a saved ledger, write it to the requested path
(or `PONYTAIL-DEBT.md` when no path is given). A report-only request does not authorize a saved ledger. One-shot.
