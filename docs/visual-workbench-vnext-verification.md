# Visual Workbench vNext — Lane E Verification

Reviewer: worker-5 (Lane E, critic). Baseline: clean `main` @ fef8ee4 (v0.2.1). Reviewed integration: leader head 526afe0 (core registry 02253b7, schema/restore freeze d745f71, descriptor UI routing c7fc49b, pinning docs 526afe0), then finding-resolution commits ae50b09 (F1–F3) and 3123e62 (F4–F5) — final verified head **3123e62, v0.3.0**. Frozen slice: S1 provider-adapter core extraction, minimal cut (no persisted-schema bump) + mandatory internal-browser pinning enforcement (`docs/visual-workbench-vnext-audit.md`, "Frozen slice").

## Before/after matrix

| Check | Before (fef8ee4) | After (526afe0) |
| --- | --- | --- |
| `npm test` (`node --check plugin.js && node --test tests/*.test.mjs`) | PASS — 22/22 | PASS — 30/30 (8 new tests; none weakened, none removed) |
| `npm run fixture:e2e` | PASS (accidental default-home artifact — cleaned up) | PASS against sandboxed `HERMES_HOME` (`/tmp/hvw-worker5-fixture.mBPEgL`, and `/tmp/hvw-worker5-rendered/home` job `worker5-review`) |
| QC document schema v1 strictness | Enforced (exact keys, 4 candidates A–D, 8 dimensions, int 0–100, 64 KiB bound) | **Byte-for-byte frozen.** `git diff fef8ee4 526afe0 -- scripts/qc-core.mjs` = 93 insertions, 0 deletions (append-only registry); WORKBENCH_CORE additions in `plugin.js` are likewise append-only before the END marker. New regressions: top-level `provider` rejected as unknown field; byte-for-byte import→export round trip; exact-64-KiB accept / +1-byte reject; frozen error strings verified live in rendered smoke (`$: unknown fields bogus; missing fields candidates, generatedAt, job, selectedCandidate`) |
| Prior-good-state after import failure | Test PASS | Test PASS (untouched) + verified live: invalid import showed `role=alert` and left restored job/candidates intact |
| Persisted schema | v2, lenient repair, v0.1 `browserUrl` migration | **Unchanged (no bump)** — new test restores a fully-populated v0.2.1 v2 snapshot deep-equal with no silent migration; v0.1 migration test untouched |
| Runtime/core parity | Behavioral parity test PASS | PASS + new registry parity test (`Function`-evaluated WORKBENCH_CORE `PROVIDERS/PROVIDER_IDS/providerForProfile` deep-equal to `qc-core.mjs`) |
| Provider seam | None — `QcPane` hard `=== 'midjourney'` branch; `CandidateCard` read `QC_PROFILES.midjourney.checks` | Registry with Midjourney as first adapter; `providerForProfile` routes `QcPane`; descriptor-driven `CandidateCard` labels; `assertProviderRegistry` enforces schema-v2-storable dimensions at module init; higgsfield-image proves the seam (own 7-dimension descriptor, `qcDocument: null`) |
| `qcProfileFor` routing | Substring ladder | Registry-driven; independently proven equivalent — 66-case cross-product harness (11 tool names × 6 srcs), 0 diffs |
| Internal-browser pinning | Skill prose only (`internal_browser_unavailable`) | Core automation descriptor (`hermes-internal-browser-pane`, `appScope: Hermes`, `persist:hermes-browser`, `externalBrowserFallback: forbidden`, `unavailableState: internal_pane_unavailable`) + structural test asserting the frozen descriptor shape; `AutomationTargetBadge` (`role=status`) in Browser pane; SKILL.md pinned-target hard-stop precondition before every pointer/focus/type action; README security boundary paragraph. Badge/README/SKILL strings mutually consistent with runtime output (verified rendered) |
| Pane independence / Result–Reference split | Structural | Preserved — `PaneTitlebarToggle` untouched; verified rendered: clicking Browser toggle changed only the Browser pane state, QC unaffected; split grid untouched (element-tree smoke "Result above Reference two-row grid" ok) |
| Restart behavior | v2 restore | Verified rendered: after app kill + relaunch, profile=midjourney, job `worker5-review`, 4 candidates, `Selected` state and badge all restored from `workbench.v2` |
| Accessibility | aria-labels/aria-pressed throughout | New badge: `role=status` + `aria-label="Automation target"`; QC pane tab order verified in rendered host: profile select → card select → summary → score → disposition → evidence → repair → dimension rows (DOM order). Pre-existing gaps (no focus move to `role=alert`, 4-button status groups without radio semantics) unchanged — out of frozen-slice scope |
| Narrow viewport | — | Verified rendered at 900×760: badge wraps without clipping (`badgeClipped:false`), no horizontal document overflow; QC pane right-edge clipping at very narrow windows is host pane-layout behavior, identical geometry to v0.2.1 (pane widths 560/330 unchanged) |
| Scope creep vs frozen slice | n/a | None found: diff touches exactly the frozen files; S2/S3/schema bump/skill rename all absent |

## Exact commands and results

```
npm test                                        # 30/30 PASS at 526afe0 (and 22/22 at fef8ee4 baseline)
HERMES_HOME=$(mktemp -d) npm run fixture:e2e    # ok:true, sandboxed home
node /tmp/hvw-worker4-smoke/smoke.mjs           # SMOKE PASSED: 8/8 (plugin.js copy verified sha256-identical to 526afe0)
node <66-case qcProfileFor equivalence harness> # cases=66 diffs=0
# Rendered smoke (installed /Applications/Hermes.app, host build feat/desktop-browser-qc-workbench, CDP :9226):
HERMES_HOME=/tmp/hvw-worker5-rendered/home node scripts/install.mjs        # sandboxed install (desktop-plugins + skills)
HERMES_HOME=... HERMES_DESKTOP_USER_DATA_DIR=... Hermes --remote-debugging-port=9226
node /tmp/hvw-worker5-rendered/inspect.mjs <fixture qc.json>               # phase 1: badge, panes, live import, strict reject
node /tmp/hvw-worker5-rendered/inspect2.mjs                                # phase 2: 5/5 — restart restore, higgsfield labels, narrow
```

Phase-1 script FAILs were selector-heuristic bugs in the probe (wrong `Job ID` label guess, `Select` vs `Selected` count), re-verified green in phase 2 with exact labels; product behavior was correct throughout (import success toast `Imported Midjourney QC for worker5-review` captured on screen).

## Artifact paths

- Screenshots: `/tmp/hvw-worker5-rendered/shot-desktop-restored.png` (desktop, populated midjourney QC), `shot-narrow-900.png` (900×760), `shot-desktop-midjourney.png`, `shot-desktop-higgsfield.png` (import-toast frame).
- Inspection scripts + logs: `/tmp/hvw-worker5-rendered/inspect.mjs`, `inspect2.mjs`, `launch*.log`.
- Sandboxed fixture job: `/tmp/hvw-worker5-rendered/home/artifacts/midjourney/worker5-review/`.
- Element-tree smoke: `/tmp/hvw-worker4-smoke/smoke.mjs` (worker-4's; run independently by Lane E).

## Findings ledger — ALL RESOLVED

| ID | Severity | Finding | Repro | Resolution |
| --- | --- | --- | --- | --- |
| F1 | HIGH (release blocker) | Five `.gjc/state/sdk/*.json` runtime session files with live ws tokens committed on `main` | `git diff --name-only fef8ee4 526afe0 \| grep .gjc/state` | **RESOLVED @ ae50b09** — files purged from tracking, `.gjc/` gitignored; re-verified: `git ls-files '.gjc*'` = 0 |
| F2 | MEDIUM (release blocker) | No version bump for a feature slice — package/manifest/plugin/SKILL all 0.2.1 | `node -e 'console.log(require("./package.json").version)'` | **RESOLVED @ ae50b09** — 0.3.0 across package.json, manifest.json, `PLUGIN_VERSION`, SKILL.md frontmatter; alignment test green |
| F3 | MEDIUM | `tests/install.test.mjs` pinning test asserted superseded `internal_browser_unavailable`, passing only via SKILL.md rename note | read test vs `skill/SKILL.md:25` | **RESOLVED @ ae50b09** — test asserts canonical `internal_pane_unavailable` and `doesNotMatch` the superseded name; SKILL.md rename note removed |
| F4 | LOW-MED | Shared A–D candidate store across structured providers undocumented — profile switch relabels the same review data (observed live) | import midjourney fixture → switch profile to Higgsfield Image | **RESOLVED @ 3123e62** — README feature list now documents the single shared store after the provider-registry bullet |
| F5 | LOW | `JobEditor` hard-coded `Midjourney job ID`/`Midjourney job brief` aria-labels though gated on `provider.qcDocument` | `plugin.js` (pre-fix :979,986) | **RESOLVED @ 3123e62** — labels derived from descriptor (`provider.label.replace(/ QC$/,'')`); verified byte-identical to v0.2.1 for Midjourney (`Midjourney job ID` / `Midjourney job brief` / `does not trigger Midjourney actions`) |

### Post-fix re-verification (at 3123e62)

```
npm test                              # 30/30 PASS, node --check clean
node /tmp/hvw-worker4-smoke/smoke.mjs # SMOKE PASSED: 8/8 (plugin.js copy = 3123e62 working tree)
git ls-files '.gjc*' | wc -l          # 0
node -e '...versions...'              # pkg 0.3.0, manifest 0.3.0, plugin 0.3.0, skill 0.3.0
```

## Limitations

- Rendered smoke used the **installed** Hermes.app (host build `feat/desktop-browser-qc-workbench`, v0.17.0), not a fresh build of the PR #65647 checkout: `/tmp/hermes-pr-65647-privacy/head/apps/desktop` is source-only (no `node_modules`/`dist`; build needs full monorepo install + Electron download). The installed host already exposes the gated capabilities (privileged webview active — badge showed pinned mode), so coverage is equivalent for this slice.
- Narrow-width testing used CDP viewport emulation + 900px window; a true 390px device frame is not reachable in the desktop shell.
- Sandboxed app bootstrap reused the machine's existing Hermes CLI (`~/.local/bin/hermes`) via the app's own `HERMES_DESKTOP_USER_DATA_DIR` sandbox; real `~/.hermes` was never read or written by the plugin/skill install (verified paths under `/tmp/hvw-worker5-rendered/home`). One pre-review baseline fixture artifact accidentally written to the real home by the repo's default `fixture:e2e` was deleted (`~/.hermes/artifacts/midjourney/fixture-v1-20260717060907`, my own run's output).

## Rollback instructions

- Full slice rollback: `git revert 3123e62 ae50b09 526afe0 c7fc49b d745f71 02253b7` on main (finding-fixes+docs+UI+tests+core, newest first), or hard-reset the release branch to fef8ee4 (v0.2.1) — no persisted-schema change shipped, so any client that ran the new build restores cleanly on v0.2.1 (`workbench.v2` shape unchanged; verified by the frozen-snapshot test both ways).
- Version-only rollback is not meaningful: reverting ae50b09 alone would restore both the 0.2.1 version and the leaked `.gjc` state files — always revert the full stack or nothing.
- No installer/manifest layout changes shipped; no action needed in any installed Hermes home.
