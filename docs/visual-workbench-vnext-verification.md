# Visual Workbench vNext — Lane E Verification

Status: **BASELINE CAPTURED — awaiting Lane C/D implementation evidence** (frozen slice not yet posted by leader).
Reviewer: worker-5 (Lane E, critic). Baseline captured 2026-07-17 on worktree `worker-5` (branched from clean `main` @ fef8ee4, v0.2.1).

## Before/after matrix

| Check | Before (baseline @ fef8ee4) | After (post C/D) |
| --- | --- | --- |
| `npm test` (`node --check plugin.js && node --test tests/*.test.mjs`) | PASS — 22/22 tests, 0 fail (duration ~571 ms) | _pending_ |
| `npm run fixture:e2e` | PASS — `{"ok":true,...}` fixture artifact job created under `~/.hermes/artifacts/midjourney/fixture-v1-20260717060907` | _pending_ |
| QC document schema v1 strictness | Enforced: `exactKeys` top-level `[schemaVersion, job, selectedCandidate, candidates, generatedAt]`; exactly 4 candidates ordered A–D; per-candidate exact keys `[id, summary, score, disposition, evidence, repairPrompt, dimensions]`; 8 exact dimensions; integer scores 0–100; evidence array ≤ 20 items, items non-empty ≤ 1000 chars; summary ≤ 2000; repairPrompt ≤ 4000; job.id non-empty ≤ 128; brief ≤ 8000; ISO timestamps ≤ 64 chars; 64 KiB byte bound via `TextEncoder` before parse (`scripts/qc-core.mjs:206-240`) | _pending — must be byte-for-byte semantics-identical_ |
| Prior-good-state after import failure | Covered by test "does not mutate prior good state when an import fails" — PASS at baseline | _pending_ |
| Persisted schema | v2 (`PERSISTED_SCHEMA_VERSION = 2`); `restoredState`/`migratePersistedState` repair malformed/partial candidates, v0.1 `browserUrl` → `browserPanels.result.url` legacy path (`plugin.js:143-178`, `scripts/qc-core.mjs:263-283`) | _pending — any bump to v3 must be explicit + old-state restore regression tests_ |
| Runtime/core validator alignment | Test "runtime plugin validator stays behaviorally aligned with the standalone QC core" — PASS at baseline | _pending_ |
| Job transitions | Bounded, `DRAFT→…→ATTACHED` (+FAILED/CANCELLED), unknown state throws (`nextJobStates`/`transitionJob`) | _pending_ |
| Browser/QC pane independence, Result/Reference vertical split | Present at baseline (BrowserPane split panels `result` desktop 1440×900 / `reference` mobile 390×844) | _pending — visual/code inspection_ |
| Rendered smoke (desktop + narrow) | _not yet attempted_ | _pending_ |
| Accessibility (focus order, labels, contrast) | _to review against diff_ | _pending_ |
| Scope creep vs frozen slice | n/a (slice not yet frozen) | _pending_ |

## Exact commands and results (baseline)

```
$ git log --oneline -1        # worker-5 worktree tip (auto-checkpoint of clean main @ fef8ee4)
$ npm test                    # 22 pass / 0 fail
$ npm run fixture:e2e         # ok:true, artifacts under ~/.hermes/artifacts/midjourney/fixture-v1-20260717060907
```

## Artifact paths

- Baseline fixture artifact: `~/.hermes/artifacts/midjourney/fixture-v1-20260717060907/{capture.svg,qc.json}` (non-billable fixture path; created by repo's own `fixture:e2e` script, not an install into `~/.hermes` plugin/skill dirs).

## Limitations

- Rendered smoke path assessed 2026-07-17 (pre-implementation): `/Applications/Hermes.app` is present; CDP port 9225 not currently listening (prior sessions attached via `--remote-debugging-port=9225`, see `/tmp/hermes-installed-cdp.json`). PR #65647 checkout exists at `/tmp/hermes-pr-65647-privacy/head` but `apps/desktop` has no `node_modules` (full Electron dev build would be required). Planned post-C/D smoke: safe test install via `scripts/install.mjs --target/--skill-target` into a temp `HERMES_HOME`, launch installed Hermes.app with that `HERMES_HOME` and a remote-debugging port, CDP screenshots at desktop (1440×900) and narrow (390×844) widths. Never touches real `~/.hermes` plugin/skill dirs.

## Rollback instructions

- _pending — will reference the exact commits/files C and D land._

## Findings ledger

_None yet — populated as task-notes with severity + reproduction once C/D report implementation evidence._
