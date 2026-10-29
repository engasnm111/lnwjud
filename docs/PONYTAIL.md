# Ponytail integration (v5.9.0)

This is the **lnwjud** integration of [DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail), not the upstream agent installer.

## Upstream pin and update policy

- Latest stable release checked on **2026-10-21**: [v5.3.2](https://github.com/DietrichGebert/ponytail/releases/tag/v5.3.2), tag commit `16352ac229eb08a9598dcae48fe9f2b342567d86`.
- On that date upstream `main` was `09c434ab73ca43761c5d8b0c5d341926c2fba710`, eight commits ahead of the tag. The upstream compare listed no changes to any of the six `skills/ponytail*/SKILL.md` files; newer commits changed host hooks, CI, docs or benchmarks, not the vendored skills. We pin stable rather than incorporate untested unreleased hooks.
- The repository already has all six v5.3.2-adapted skills under `.agents/skills/`: `ponytail`, `ponytail-review`, `ponytail-audit`, `ponytail-debt`, `ponytail-gain`, `ponytail-help`. Each `SOURCE.md` records its upstream path, exact pinned commit, content digest, and MIT license. `.agents/skills/ponytail/references/lnwjud.md` documents local adaptations.
- For the existing vendoring verification receipt and exact SHA-256 values, see local-only `.audit/v5.9.0-skills.validation.json` and `.audit/v5.9.0-skills.md` (ignored audit artifacts; not published documentation). Those are earlier **static** checks; they are not proof that the just-installed runtime, new application changes or current installers pass.

## Activation and modes

The native policy defaults to **OFF** unless configured. Mode precedence is **Current Goal > Workspace > Global**. Available modes are `off`, `lite`, `full` and `ultra`; changing or reading a skill document alone does not silently enable a persistent mode. Local workspace configuration is in `.lnwjud/project-profile.json` and is not a repository deliverable.

When Ponytail is active for a coding mutation, the gateway requires exact bundled `bundled:agent-skills/ponytail` activation scoped to the current session, workspace and Goal as applicable. A similarly named workspace or user skill, a catalog listing, or a matcher hit cannot impersonate the bundled skill. Goal-fenced mutations retain their current `goalLease`. FULL and ULTRA durable coding-goal completion requires a fresh exact bundled `ponytail-review` and an up-to-date `review_changes` observation after the latest code mutation.

No upstream code-executing hooks, band UI, telemetry, plugin setup scripts or shell activation helpers are installed as part of the six document-only skills. Upstream benchmark figures are **not** measured lnwjud results.

## v5.9.0 release acceptance

Before publishing v5.9.0, verify:

1. All six expected skills, licenses, source pins and local links against the official v5.3.2 Git tag; repeat the repository validator `python -X utf8 .audit/v5.9.0-skills.validate.py`.
2. Native policy precedence and default OFF, collision rejection, direct exact activation after zero-result matching, session-only suppression/resume, `tool_batch` child enforcement and stale-review protection.
3. Setup/Portable and macOS/Linux target-native packages include all six bundled sibling skills and valid `SOURCE.md`/MIT license material. Record verifiable artifact digests.
4. Bilingual in-app What's New, [README](../README.md), [RELEASE_NOTES](../RELEASE_NOTES.md), full release checklist, automated tests and exact-SHA CI must agree.

**Current limitation (2026-10-21):** The installed Windows service reports RUNNING and v5.9.0 now acquires Writer Lease generation 42 and resumes the existing Goal. However, the latest direct shell smoke task `fe44af91-3a7f-462b-9bd1-ef795005008c` failed before dispatch with `PIPE_LAUNCH_SESSION_CHANGE_FAILED` (Windows `TokenSessionId` normalization), while `process_start` returned `INTERNAL_ERROR`. A subsequent local build produced a candidate whose installed native manifest agrees with the workspace helper/pin SHA256 declarations; actual installed executable-byte hashing is still unverified. The numeric Win32 diagnostic and pre-dispatch abort changes are included, but on 2026-10-21 the new `shell` smoke attempts returned exit `-1` without output and `process_start` returned `INTERNAL_ERROR`; installed-service acceptance remains blocked. Windows Sandbox verification also timed out without a terminal exit receipt. Ponytail/installer acceptance, independent review and hosted CI remain pending; do not delete unknown reservations, merge, publish or close issues based on these checks.

## ภาษาไทย

Ponytail ที่รวมใน lnwjud ใช้ **v5.3.2 รุ่น Stable ล่าสุด** ณ วันที่ตรวจสอบ โดยตรึง Commit และเก็บไฟล์ Skill ทั้งหกพร้อม MIT License และข้อมูลที่มา ไม่ได้ติดตั้ง Hook หรือสคริปต์ของ Upstream โดยอัตโนมัติ

โหมดเริ่มต้น **ปิด** และใช้ลำดับสิทธิ์ `Goal > Workspace > Global` การเปิดใช้งานโหมดไม่ใช่การอนุญาตให้ข้าม Writer Lease, Security หรือ CI ต้องทดสอบบน Runtime ที่ติดตั้งและแพ็กเกจจริงก่อนออก v5.9.0
