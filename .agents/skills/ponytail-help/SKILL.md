---
name: ponytail-help
description: >
  Quick reference for ponytail levels, skills and commands. One-shot display.
  Use for /ponytail-help, "ponytail help", "how do I use ponytail".
---

For lnwjud, first read [repository integration](../ponytail/references/lnwjud.md). It controls activation, source discovery, and host-specific guidance below.

# Ponytail Help

Display this reference card when invoked. One-shot, do NOT change mode,
write flag files, or persist anything.

## Levels

| Level | Trigger | What change |
|-------|---------|-------------|
| **Lite** | `/ponytail lite` | Build what was asked, name the smaller option in one line. |
| **Full** | `/ponytail` | The smallest complete change, a check where the logic needs one, and a reply that names what was skipped and any risk. Default. |
| **Ultra** | `/ponytail ultra` | Also questions the request and pushes back before building. |

Level sticks until changed or session end.

## Skills

| Skill | Trigger | What it does |
|-------|---------|--------------|
| **ponytail** | `/ponytail` | Lazy mode itself: least new code, clear replies that name skipped work and risks. |
| **ponytail-review** | `/ponytail-review` | Quality review of a diff: bugs, security, load, missing tests, speed, what to cut. Each finding says what goes wrong and how to fix it. |
| **ponytail-audit** | `/ponytail-audit` | The same quality review for the whole repo, ranked. |
| **ponytail-debt** | `/ponytail-debt` | Harvest `shortcut:` comments into a tracked ledger. |
| **ponytail-gain** | `/ponytail-gain` | Measured-impact scoreboard: less code, less cost, more speed. |
| **ponytail-help** | `/ponytail-help` | This card. |

In this workspace, use the exposed names such as `$ponytail`, `$ponytail-review`,
or `$ponytail-help`. If a separately installed plugin exposes namespaced skills,
use its actual advertised name, such as `$ponytail:ponytail-review`. Slash forms
above describe hosts that support those commands.

## Deactivate

Say "stop ponytail", "normal mode", or `/ponytail off`. This ends the requested
mode; persistent lnwjud policy changes still require the user's instruction.

## lnwjud settings

Native lnwjud defaults automatic activation to `off`. It resolves Goal override,
then workspace profile `ponytail.mode`, then global `ponytailMode`. Use the native
settings or the currently advertised Goal API for an authorized policy change.
Upstream `PONYTAIL_DEFAULT_MODE`, external config files, and Claude Code defaults
do not override lnwjud's policy.

## Host features and updates

The upstream v5.3.2 plugin also has a Claude Code band and board. This workspace
vendors six skill documents and their MIT license only. It does not install
hooks, command handlers, telemetry, band scripts, or session-history import.
Report those features unavailable here unless a separate host installation is
actually present. A help request does not authorize installing or trusting one.

For a requested workspace update, verify the latest stable release at the
upstream repository, pin its commit, review all changed documents, retain the
repository integration rules, and refresh each `SOURCE.md`. Plugin-manager
commands update a separately installed host plugin, not these vendored files.

## More

Full docs + examples: https://github.com/DietrichGebert/ponytail
