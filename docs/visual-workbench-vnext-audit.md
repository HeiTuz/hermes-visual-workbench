# Renderline vNext — Audit

Repo: renderline, `main` @ fef8ee4, v0.2.1. Evidence lines cite the files as of this commit.

## Architecture audit

*(Owner: Lane A. Lane B owns "Workflow & IA audit" and "Acceptance criteria" below.)*

### Module boundaries

| Module | Role | Evidence |
| --- | --- | --- |
| `plugin.js` (1183 lines, single-file plain ESM, no build step) | Entire runtime plugin: UI constants, core model, React panes, host registration | whole file |
| `plugin.js` zone 1 — header (1–80) | SDK imports, pane IDs, `QC_PROFILES` checklist definitions (design, higgsfield-image, higgsfield-video, midjourney) | `plugin.js:24-79` |
| `plugin.js` zone 2 — `WORKBENCH_CORE` (81–351) | Persisted-state model (schema v2), QC document schema v1 validator, job state machine, lenient restore/repair | markers at `plugin.js:81` and `plugin.js:351` |
| `plugin.js` zone 3 — UI (353–1184) | Store (`setState`/`useSyncExternalStore`), `BrowserPane`/`BrowserPanel`/`ViewportStage`/`BrowserSurface`, `QcPane`/`MidjourneyQcPane`/`CandidateCard`/`JobEditor`/`CheckRow`, `register()` contributions | `plugin.js:353,502,555,699,824,869,970,1066,1101` |
| `scripts/qc-core.mjs` (283 lines) | Standalone, exported duplicate of the core: `validateQcDocument`, `migratePersistedState`, `transitionJob`, `nextJobStates`, `qcDocumentFromState`, constants | whole file |
| `scripts/lib.mjs`, `scripts/install.mjs` | Hash-pinned installer/uninstaller with marker `.renderline-install.json`; orthogonal to product model | `scripts/install.mjs`, `tests/install.test.mjs` |
| `scripts/fixture-e2e.mjs` | Non-billable artifact job generator; consumes `qc-core.mjs` `validateQcDocument` | `scripts/fixture-e2e.mjs:7` |
| `tests/*.test.mjs` | qc-core unit + parity + installer + fixture e2e; gate `npm test` = `node --check plugin.js && node --test tests/*.test.mjs` | `package.json` scripts |

**Structural duplication (the central architectural fact).** The `WORKBENCH_CORE` section of `plugin.js` is a hand-maintained copy of `scripts/qc-core.mjs`. The plugin cannot `import` the script: it is a single-file runtime plugin and the installer copies only `plugin.js` + `skill/SKILL.md` to the Hermes home (`scripts/install.mjs`, README "The installer writes"). Parity is enforced *behaviorally*, not textually, by `tests/plugin-runtime-core.test.mjs`, which slices the source between the `// WORKBENCH_CORE_BEGIN/END` markers, evaluates it with `Function(...)`, and `deepEqual`s validator and restore output against `qc-core.mjs`. Known benign divergences: `boundedString(value, path, max, allowEmpty)` is positional in `plugin.js:` vs options-object in `qc-core.mjs`; `qc-core.mjs` `isoTimestamp` supports `allowEmpty`, plugin's does not; plugin `restoredState` closes over module `DEFAULT_STATE`/`state` while `qc-core.mjs` exposes the pure `migratePersistedState(saved, defaults)` and `qcDocumentFromState(state, generatedAt)`. Any core work MUST land in both places and keep the parity test green.

### Persisted schema v2 shape

Written on every `setState` to storage key `workbench.v2` (`plugin.js:353-357`); restored in `register()` with fallback to legacy `workbench.v1` (`plugin.js:1105-1110` region):

```
{
  schemaVersion: 2,
  browserSplit: boolean,
  browserPanels: { result, reference: { url, preset, width>=240, height>=240 } },
  qcProfile: 'design'|'higgsfield-image'|'higgsfield-video'|'midjourney',
  evaluations: { [profileId]: { [checkId]: { status: pass|fail|na|pending, note } } },
  job: { id, state ∈ JOB_STATES, brief, createdAt, updatedAt },
  candidates: { A,B,C,D: { id, summary, score 0-100 int, disposition ∈ PASS|REPAIR|REJECT,
                           evidence: string[≤20], repairPrompt,
                           dimensions: { <8 fixed keys>: { score, evidence } } } },
  selectedCandidate: null|'A'|'B'|'C'|'D',
  qcJson: string,           // last imported/exported formatted QC JSON
  capture: null | { panelId: result|reference, width, height, createdAt, path }
}
```

Two validation regimes, deliberately asymmetric:

- **Restore is lenient repair** — `restoredState`/`migratePersistedState` never throw; every field falls back per-key (bogus profile → `design`, bogus job state → `DRAFT`, non-array evidence → `[]`, partial dimensions deep-merged with zeros). Covered by `tests/qc-core.test.mjs` ("repairs malformed persisted candidate fields…") and `tests/plugin-runtime-core.test.mjs`.
- **Import is strict fail-closed** — `validateQcDocument` enforces exact key sets at every level, integer 0–100 scores, exactly four candidates in A,B,C,D order, ISO timestamps, 64 KiB byte bound (`MAX_QC_JSON_BYTES`), and throws on the first violation. `MidjourneyQcPane.importQc` calls `setState` only after validation succeeds, so prior good state is preserved on failure (`plugin.js:975-992` region; test "does not mutate prior good state when an import fails").

v1→v2 migration precedent: legacy `browserUrl` string is folded into `browserPanels.result.url` (`restoredPanel(..., legacyUrl)`), and `register()` writes `workbench.v2` immediately if only v1 existed. This is the pattern any explicit v2→v3 migration must follow: read old key, repair-map into new defaults, write new key once, never silently drop data.

### Coupling: Midjourney specifics vs generic job/candidate/review flow

Already provider-neutral in the core:

- `JOB_STATES`/`JOB_TRANSITIONS` (DRAFT→…→ATTACHED + FAILED/CANCELLED) name no provider.
- Job fields (`id/state/brief/createdAt/updatedAt`), dispositions, evidence, repairPrompt, `selectedCandidate` are generic review vocabulary.
- Browser pane, viewport presets, capture, and checklist profiles (`evaluations`) are fully provider-agnostic.

Midjourney hard-coding (the coupling to break, with exact sites):

1. `QC_DIMENSIONS` — the eight rubric keys are a module constant baked into `blankCandidate`, `restoredCandidate`, `validateCandidate`, and `exactKeys(value.dimensions, QC_DIMENSIONS, …)` in both `plugin.js` and `qc-core.mjs`. There is no notion of "dimension set per provider".
2. Candidate cardinality/labels — `CANDIDATE_IDS = ['A','B','C','D']` and "exactly four candidates" are constants of schema v1 (`validateQcDocument`), mirroring Midjourney's 2×2 grid.
3. `CandidateCard` renders dimension labels from `QC_PROFILES.midjourney.checks` directly (`plugin.js:940` region) — UI reads the Midjourney profile even though it renders per-candidate structured review.
4. `QcPane` hard-branches: `if (workbench.qcProfile === 'midjourney') return jsx(MidjourneyQcPane, …)` (`plugin.js:1069`). Every other profile gets only the flat `CheckRow` checklist; structured candidate review is unreachable for Higgsfield profiles despite the state model supporting it.
5. `qcProfileFor(input)` routes by tool-name substring sniffing (`'midjourney'`, `'higgsfield'`, `'generate_video'`) (`plugin.js:410-415`) — a de-facto provider router with no registry.
6. Cosmetic/peripheral: capture default filename `${state.job.id || 'midjourney'}-…`, fixture artifacts under `artifacts/midjourney/<job-id>/`, skill named `renderline`.

Net: the *data model* is ~80% provider-agnostic already; the provider coupling lives in (a) the fixed dimension vocabulary inside the schema-v1 validator and (b) the UI routing/labeling. That makes an adapter extraction cheap in the core and mostly additive in the UI — but the strict schema v1 (exact 8 dimension keys, exactly 4 candidates) is a frozen contract that adapters must treat as the *Midjourney adapter's wire format*, not as the generic model.

### Host-capability fallback paths

Gated on NousResearch/hermes-agent#65647 capabilities (`manifest.json` `fullHostCapabilities`):

| Capability absent | Fallback | Evidence |
| --- | --- | --- |
| `host.panes.toggle` | `PaneTitlebarToggle` returns `null`; `useValue` falls back to `CLOSED_PANE_ATOM` | `plugin.js:377-400` region |
| `window.hermesDesktop.browser.capture` | `BrowserSurface` renders sandboxed `iframe` (`sandbox="allow-forms allow-scripts allow-same-origin"`, `referrerPolicy="no-referrer"`) instead of privileged `webview`; **Capture PNG** button disabled; `PanelIntro` copy switches to "portable iframe mode" | `plugin.js:461-499,707-709` regions |
| `navigator.clipboard.writeText` | Export still succeeds; notify downgrades to "clipboard unavailable" | `MidjourneyQcPane.exportQc` |
| `chat.imageActions` / `titleBar.appControls` areas | Contributions simply don't render on old hosts; pane registration itself stays portable | README compatibility table |

Any new UI must preserve this "capability-probe, degrade, never throw" pattern.

### Extension seams (existing, usable today)

1. **`WORKBENCH_CORE` markers** — a *tested* seam: the parity test guarantees the section is self-contained (evaluable via `Function`), so core changes are mechanically verifiable against `qc-core.mjs`. This is the natural insertion point for a provider registry.
2. **`QC_PROFILES` record** — adding a checklist profile is one entry; but structured review is gated by the hard `=== 'midjourney'` branch (seam blocked at `QcPane`).
3. **`qcProfileFor`** — single routing choke point for chat-image → profile mapping; becomes adapter matching.
4. **`ctx.registerMany` contribution list** — additive host registration.
5. **`scripts/qc-core.mjs` exports** — already the canonical importable core for tests/fixtures; provider registry exported here is immediately consumable by `fixture-e2e.mjs` and tests.

## Ranked thesis

Ranking axes: user value, regression risk against the hard lines (schema v1 byte-for-byte, prior-good-state, pane independence), and coherence (does it split cleanly into Lane C core + Lane D UI halves).

### 1. Provider-adapter core extraction (RECOMMENDED)

Introduce a provider descriptor registry in the core and make Midjourney the first adapter; unlock structured candidate review for the Higgsfield profiles from their own descriptors.

- **Shape:** `PROVIDERS = { midjourney: { id, label, profileId, candidateIds: ['A','B','C','D'], dimensions: QC_DIMENSIONS, dimensionLabels, qcDocument: { schemaVersion: 1, validate } }, 'higgsfield-image': {...}, 'higgsfield-video': {...} }`. `validateQcDocument` stays *exactly* as-is as the Midjourney adapter's validator (schema v1 frozen: same exact-key sets, same error strings, same 64 KiB bound). `QcPane` routes structured review through the active provider descriptor instead of `=== 'midjourney'`; `CandidateCard` takes dimension labels from the descriptor instead of `QC_PROFILES.midjourney.checks`; `qcProfileFor` resolves via registry match.
- **Persisted schema:** v2→v3 bump is avoidable in the minimal cut — the active provider is derivable from `qcProfile`, and per-provider candidate state can key `candidates` storage by provider only if multiple providers persist simultaneously. If Lane C decides multi-provider candidate state is in scope, the bump must be explicit (`workbench.v3` key, v2-blob restore regression test, v1-blob still restoring through the existing chain).
- **File impact:** `plugin.js` WORKBENCH_CORE (registry + descriptor-driven blank/restore/validate plumbing, ~+80 lines) and UI (`QcPane`, `MidjourneyQcPane`→ generalized pane shell, `CandidateCard`, `qcProfileFor`); `scripts/qc-core.mjs` (mirror registry exports); `tests/qc-core.test.mjs` + `tests/plugin-runtime-core.test.mjs` (parity + v1 byte-for-byte regressions + new adapter edges); `README.md`, `skill/SKILL.md` (docs only).
- **Value: high** — directly delivers the product thesis (cockpit, not importer); Higgsfield image/video gain the structured A/B/C/D review the state model already supports. **Risk: medium**, tightly mitigated: schema v1 validator is untouched-or-byte-equivalent, guarded by the existing parity test plus new snapshot regressions. **Coherence: high** — the split falls exactly on the WORKBENCH_CORE marker, matching Lane C/D file ownership.

### 2. Multi-job queue / job history

Persist multiple jobs (`jobs: { [id]: job }` + per-job candidates/QC JSON), job switcher UI, restart-safe queue.

- **File impact:** WORKBENCH_CORE (mandatory v2→v3 bump: `job`/`candidates`/`selectedCandidate`/`qcJson` become per-job records), `qc-core.mjs` migration, heavy new restore-regression surface; UI needs a job list + switcher inside the 330px QC pane.
- **Value: medium-high** (real production workflows are multi-job). **Risk: high** — unavoidable schema migration touching every persisted field, largest prior-good-state blast radius, and UI real-estate pressure in a narrow pane. **Coherence: medium** — core and UI halves are separable but the migration dominates. Better as the *second* slice once the provider registry exists (jobs should be provider-tagged, which argues for doing slice 1 first).

### 3. Review-session UX (guided A/B/C/D compare flow)

Keyboard-driven candidate walkthrough: quadrant focus in the Browser pane, per-candidate disposition hotkeys, review progress indicator, jump-to-next-unreviewed.

- **File impact:** almost entirely UI zone (`MidjourneyQcPane`, `CandidateCard`, new keyboard handling), thin-to-zero core change (possibly a transient `reviewCursor`, deliberately *not* persisted to avoid any schema question).
- **Value: medium** — polishes the existing single-provider flow but doesn't widen the product. **Risk: low-medium** (focus/keyboard regressions, pane-independence must be re-verified). **Coherence: medium** — Lane C would be nearly idle; poor fit for a two-lane implementation gate.

### Recommendation to leader

Freeze **Slice 1 (provider-adapter core extraction)**, minimal cut = no persisted-schema bump (provider derived from `qcProfile`), with these measurable acceptance criteria:

1. `npm test` green (`node --check plugin.js && node --test tests/*.test.mjs`), zero existing-test modifications that weaken assertions.
2. Schema v1 frozen: the existing valid/invalid QC document corpus (valid fixture, oversize, unknown-field, missing-field, out-of-range) produces *identical accept/reject outcomes and error messages* pre/post change; a top-level `provider` field is rejected as an unknown field. New regression test asserts this against the v0.2.1 behavior.
3. Prior-good-state preserved: failed import after a successful import leaves state deep-equal to the pre-failure snapshot (existing test retained, plus a runtime-core variant).
4. Parity test still passes: WORKBENCH_CORE slice remains self-contained and behaviorally equal to `scripts/qc-core.mjs`, including the new registry.
5. Restore regression: a persisted v2 blob captured from v0.2.1 restores deep-equal to v0.2.1's `restoredState` output (no silent migration); legacy v1 `browserUrl` path still works.
6. Adapter proof: at least one non-Midjourney provider (higgsfield-image) renders structured candidate review from its own descriptor (own dimension keys/labels), with edge tests for invalid input and restart/restore of its evaluation state.
7. Hard lines re-verified: Browser/QC toggles remain pane-independent; Result/Reference vertical split untouched; `npm run fixture:e2e` unchanged and passing.

## Workflow & IA audit

Evidence base: `plugin.js` @ fef8ee4 (v0.2.1, read in full), `scripts/qc-core.mjs`, `scripts/lib.mjs`, `scripts/fixture-e2e.mjs`, `fixtures/midjourney-grid.svg`, `tests/*.test.mjs`, `README.md`, `skill/SKILL.md`, `manifest.json`.

### Surfaces and entry points

| Surface | Registration | Behavior |
| --- | --- | --- |
| Browser pane | `panes` area, id `renderline:browser`, right dock, 560px | `BrowserPane` (plugin.js:699) |
| Quality Control pane | `panes` area, id `renderline:qc`, docked right of Browser, 330px | `QcPane` (plugin.js:1066) |
| Titlebar toggles | `titleBar.appControls` order 10 (globe → Browser) and 20 (checklist → QC) | `PaneTitlebarToggle` (plugin.js:373). Each button calls `host.panes.toggle(paneId)` for **its own pane only** — pane independence is structural, not incidental. `aria-pressed` mirrors open state. Renders `null` when `host.panes.toggle` is absent (pre-#65647 hosts). |
| Chat-image action: **Open as Result** | `chat.imageActions` order 10 | Sets `browserPanels.result.url`, opens Browser pane. |
| Chat-image action: **Set as Reference** | order 20 | Sets `browserPanels.reference.url`, forces `browserSplit: true`, opens Browser pane. |
| Chat-image action: **Open in task QC** | order 30 | Sets result URL, selects profile via `qcProfileFor` (toolName contains `midjourney` → `midjourney`; video media or `generate_video` → `higgsfield-video`; `higgsfield` → `higgsfield-image`; else `design`), opens **both** panes. |

### Current user workflows

1. **Browser inspection.** `PanelIntro` copy switches on host capability ("secure persistent webview session" vs "portable iframe mode"). Layout controls: `Single` / `Top–Bottom Split` / `Swap` (Swap exchanges the *entire* panel configs — url, preset, dimensions — and is disabled outside split). Split renders Result above Reference in a `minmax(0,1fr)/minmax(0,1fr)` grid — the vertical Result/Reference split that must be preserved. Per panel: URL input (Enter or `Open` commits via `normalizeUrl` — bare host → `https://`, absolute path → `file://`), viewport preset select (`responsive`, `desktop 1440×900`, `laptop 1280×800`, `tablet 768×1024`, `mobile 390×844`, `custom` with min-240 numeric width/height), `Capture PNG` (enabled only when url is a `page` and `window.hermesDesktop.browser.capture` exists).
2. **Media rendering.** `mediaKind` routes by extension/data-URI: image → `<img>`, video → `<video controls>`, page → privileged `<webview partition="persist:hermes-browser">` or sandboxed `<iframe>` fallback. `ViewportStage` centers a real-size guest and scales with `min(fit, 1)` — never upscales; guest keeps true `innerWidth/innerHeight`.
3. **Checklist QC (design / higgsfield-image / higgsfield-video).** `ProfileSelect` → per-profile `CheckRow`s: status buttons `PASS/FAIL/NA/WAIT` (pending), evidence textarea. Header shows `N FAIL` / `N PASS` badges and target linkage (`RESULT + REFERENCE` / `RESULT LINKED` / `NO TARGET`). Evaluations persist per profile, so switching profiles never destroys another profile's answers.
4. **Midjourney QC import path.** `qcProfile === 'midjourney'` swaps the whole pane to `MidjourneyQcPane`: `JobEditor` (state badge, id, brief, transition buttons generated from `JOB_TRANSITIONS` only — illegal transitions are unreachable; "Status only · does not trigger Midjourney actions"), strict JSON textarea + `Import QC JSON` / `Export QC JSON`, capture summary line, four `CandidateCard`s (summary, 0–100 clamped score, disposition select, newline-split evidence capped at 20, repair prompt, eight dimension rows, `Select` with inset accent on the selected card).
5. **Non-billable fixture path.** `npm run fixture:e2e` writes `request.json` / `provenance.json` / `qc.json` / `capture.svg` under `$HERMES_HOME/artifacts/midjourney/<job-id>/` with `billableActionsExecuted: []`; the generated `qc.json` is the deterministic import payload for workflow verification (grid fixture labels A/B/C/D in reading order).

### Information architecture

```
Titlebar ─ [Browser toggle] [QC toggle]                (independent controls)
Browser pane                       Quality Control pane
├─ PanelIntro (capability copy)    ├─ PanelIntro (profile description)
├─ Single | Split | Swap           ├─ ProfileSelect (4 profiles)
├─ Result panel                    ├─ checklist profiles:
│  ├─ URL bar + Open               │  ├─ FAIL/PASS badges + target link
│  ├─ preset + custom W×H          │  └─ CheckRow × profile.checks
│  ├─ Capture PNG + status         └─ midjourney profile:
│  └─ ViewportStage → Surface         ├─ JobEditor (state machine UI)
└─ Reference panel (split only)       ├─ QC JSON import/export + error
   └─ (same controls as Result)       ├─ capture summary (if any)
                                      └─ CandidateCard × A/B/C/D
```

Coupling observation for Lane A's thesis: the QC pane's IA already forks at exactly one point (`QcPane` line 1069: `if (workbench.qcProfile === 'midjourney') return MidjourneyQcPane`) — the natural provider seam is one branch, not scattered.

### UI states inventory

| Surface | Empty | Loading | Error | Populated |
| --- | --- | --- | --- | --- |
| BrowserSurface | `EmptyState` "No target" | none (native webview/iframe load; **gap**: no spinner/progress) | **gap**: navigation failures are silent | img / video / webview / iframe |
| Capture PNG | no status line | `Capturing…` | inline message + `host.notify` error; also "Capture unavailable" when API/guest missing | `Saved W×H` or `Captured W×H · save cancelled` |
| Checklist CheckRow | status `PENDING` (warn badge), empty note | n/a | n/a (status is an enum of buttons) | pass/fail/na + note |
| QC header | `NO TARGET` + `0 FAIL`/`0 PASS` muted | n/a | n/a | counts + `RESULT LINKED` / `RESULT + REFERENCE` |
| Midjourney import | placeholder "Paste strict schema-version 1 QC JSON" | n/a (synchronous) | `role="alert"` inline error with `$path: message` detail; **prior good state preserved** (verified by tests/qc-core.test.mjs "does not mutate prior good state when an import fails") | formatted JSON + success notify |
| Midjourney export | — | n/a | validation of *current state* can fail (e.g. blank job id → `$.job.id: must not be empty`) and is shown in the same alert slot | clipboard copy, or notify-only when clipboard is unavailable |
| JobEditor | `DRAFT` badge, empty fields | n/a | terminal states (`ATTACHED`/`FAILED`/`CANCELLED`) render zero transition buttons | allowed `Mark <STATE>` buttons only |

### Keyboard flow

- URL inputs commit on `Enter`; everything else is pointer-first but uses native focusable controls, so tab order follows DOM order: intro → layout buttons → Result URL → Open → preset → (custom W/H) → Capture → Reference panel (split) → … ; QC pane: profile select → job id → brief → transition buttons → JSON textarea → Import → Export → candidate cards top-to-bottom.
- Every interactive control carries an `aria-label` (verified across BrowserPanel, JobEditor, CandidateCard, MidjourneyQcPane); toggles carry `aria-pressed`.
- **Gaps:** no keyboard shortcuts for pane toggles; import error `role="alert"` is announced but focus is not moved to it; check-status changes are 4-button groups (no radio semantics/arrow-key cycling); native `<select>`s are used for preset/profile/disposition (acceptable, host-styled).

### Persistence and restart behavior

- Single storage key `workbench.v2`, rewritten on **every** `setState` (plugin.js:353) via `persistedState()` — persisted schema v2 shape: `schemaVersion, browserSplit, browserPanels{result,reference}, qcProfile, evaluations, job, candidates, selectedCandidate, qcJson, capture`.
- `register()` restore order: `workbench.v2` → legacy `workbench.v1` (v1 `browserUrl` migrates into the result panel) → defaults; then immediately re-persists as v2. Restore is field-level permissive repair, never throws (invalid scores → 0, unknown dispositions → REJECT, evidence filtered/sliced to 20, panels re-defaulted below 240px) — covered by tests "runtime persisted-state restore repairs malformed and partial candidate data" and "migrates v0.1 persisted state without losing browser and evaluation data".
- Deliberately **not** persisted: URL drafts, capture status line, JSON textarea draft (mirrors persisted `qcJson` via `useEffect`), pane open/closed state (host-owned).
- Sharp edge for any slice touching persistence: import strictness (`validateQcDocument`, throwing) and restore permissiveness (`restoredState`, repairing) are two intentionally different regimes. Acceptance criteria below keep them distinct.

### Host-capability fallback behavior (UI view)

| Missing capability | UI consequence |
| --- | --- |
| `host.panes.toggle` | Titlebar toggles render `null`; panes remain registered/portable |
| `window.hermesDesktop.browser.capture` | iframe surface, Capture PNG disabled, intro copy switches to "portable iframe mode" |
| `navigator.clipboard.writeText` | Export succeeds with "clipboard unavailable" notify instead of copy |
| `host.panes.open` atom | Toggle falls back to `CLOSED_PANE_ATOM` (always shows closed styling) |

## Acceptance criteria

Slice names follow the three candidates fixed in the context snapshot (`.gjc/context/renderline-vnext-20260717T000000Z.md`, "Unknowns"): S1 provider-adapter core extraction, S2 multi-job queue, S3 review-session UX. Lane A owns the final ranking; criteria below are defined for all three so the leader can freeze any of them without another round trip.

### S1 — Provider-adapter core extraction (Lane B recommendation: rank 1)

Value: unlocks every future provider without UI churn. Risk: lowest of the three when framed as behavior-preserving. Coherence: the fork already exists at exactly one line in `QcPane`.

**UI states:** unchanged by contract. The pane must render byte-identical control sets for all four profiles; the `midjourney` profile must still swap to the full `MidjourneyQcPane`.

**Keyboard flow:** unchanged by contract — tab order and `aria-*` attributes identical before/after.

**Acceptance criteria (all measurable):**
1. `npm test` and `npm run fixture:e2e` pass; `node --check plugin.js` clean.
2. QC document schema v1 behavior is byte-for-byte: the same invalid inputs produce the same `$path: message` error strings (regression-tested against the existing error-string assertions in `tests/qc-core.test.mjs`), the 64 KiB bound and exact-key rejection are unchanged, and a valid import→export round trip produces identical formatted JSON.
3. Import failure still preserves prior good state (existing test must stay green untouched).
4. Persisted state: if the slice ships with schema v2 unchanged, `workbench.v2` snapshots from v0.2.1 restore identically (add a frozen-fixture restore test). If a v3 bump is required, it must be explicit (`PERSISTED_SCHEMA_VERSION = 3`, a named migration function, and new tests restoring both v2 and legacy v1 snapshots) — no silent migration.
5. Provider seam is real: a registry (or equivalent) where Midjourney is registered as an adapter; grep-level check — no `midjourney`/`MJ` literals inside the provider-agnostic core paths except the adapter registration itself.
6. Pane independence and Result/Reference vertical split preserved: titlebar toggles still target only their own pane id; split still renders Result above Reference.
7. Rendered smoke (strongest available; #65647 checkout if runnable): screenshots at desktop and ~390px-narrow QC pane widths show no layout diff vs v0.2.1 for all four profiles; limitation documented if the host build is not runnable.

### S2 — Multi-job queue (rank 2)

**UI states:** empty (no jobs → `EmptyState` with a create affordance), populated (job list with active-job highlight mirroring `CandidateCard`'s inset-accent selection idiom), error (duplicate/invalid job id rejected inline; illegal transitions remain unreachable), loading n/a (synchronous local state).

**Keyboard flow:** job list entries focusable in DOM order; Enter activates a job; delete/destructive actions must be explicit buttons with `aria-label`s, never keyboard-only shortcuts.

**Acceptance criteria:** create/switch/delete jobs with per-job `job`, `candidates`, `selectedCandidate`, `qcJson` isolation (switching jobs never bleeds candidate data); restart restores the active job and full queue; requires explicit v2→v3 migration wrapping the existing single job as the first queue entry, tested with a frozen v2 snapshot; QC document schema v1 untouched (it stays a single-job document); export always exports the active job only; `npm test` green with new edge tests (invalid job id, restart mid-queue, oversize import against the active job).

### S3 — Review-session UX (rank 3)

**UI states:** compare mode (two candidates side-by-side reusing the Result/Reference split idiom without breaking panel independence), decision-summary state (disposition totals, selected recommendation), empty (no imported document → prompt to import).

**Keyboard flow:** candidate-to-candidate navigation via focusable cards; summary reachable in tab order after the last card; focus moves to the summary when a review is completed.

**Acceptance criteria:** disposition totals always equal 4 across A–D; summary export validates through the same strict v1 validator; no new persisted fields without an explicit schema decision; import/export and prior-good-state behavior untouched; `npm test` green plus new tests for summary totals and focus-order assertions where testable.

### Cross-slice invariants (apply to whichever slice is frozen)

- Browser and QC panes stay independent; each titlebar control toggles only its pane.
- Result/Reference vertical split preserved.
- No cookie/token/storage/credential access, no DOM hacks into guest pages, no paid Midjourney actions, no publishing.
- Import strictness vs restore permissiveness remain separate regimes; neither is relaxed to make the other simpler.
- Any persisted-schema change is explicit, versioned, and covered by old-snapshot restore regressions.

## Frozen slice (leader decision)

**Slice 1 — provider-adapter core extraction, minimal cut (no persisted-schema bump), plus mandatory internal-browser pinning enforcement.**

Scope, binding on Lanes C and D:

1. **Core (Lane C — WORKBENCH_CORE in `plugin.js`, `scripts/qc-core.mjs`, `scripts/lib.mjs`, `tests/qc-core.test.mjs`, `tests/plugin-runtime-core.test.mjs`):** provider descriptor registry with Midjourney as the first adapter; `validateQcDocument` byte-for-byte frozen as the Midjourney adapter's schema-v1 validator; higgsfield-image descriptor proves the seam; provider derived from `qcProfile` (schema v2 unchanged; frozen v0.2.1 v2-snapshot restore regression required); parity test stays green.
2. **UI (Lane D — `plugin.js` outside the core markers, `README.md`, `skill/SKILL.md`):** `QcPane` routes structured review through the active provider descriptor instead of `=== 'midjourney'`; `CandidateCard` takes dimension labels from the descriptor; `qcProfileFor` resolves via registry; UI states/keyboard flow unchanged by contract for existing profiles.
3. **Internal-browser pinning enforcement (mandatory, split):**
   - Lane D: `skill/SKILL.md` gains hard-stop preconditions — before any pointer/type action the workflow MUST verify the target is the Hermes Desktop window's internal Browser pane (`app="Hermes"` scope assertion), and MUST stop with a named `internal_pane_unavailable` state instead of falling back to any external browser (Chrome/Safari/Arc/Brave/Edge) or isolated `browser_*` session; README security boundary updated to match. Browser pane shows a visible automation-target affordance so agents and users can confirm the pinned target.
   - Lane C: any state the badge needs is exposed via an existing-store accessor, not a new persisted field.
4. **Acceptance:** audit sections "Recommendation to leader" items 1–7 and Lane B "S1" criteria 1–7 plus cross-slice invariants are all binding. Rendered smoke per criterion 7 with documented limitation if the #65647 host build is not runnable.

Out of scope (explicitly): multi-job queue (S2), review-session UX (S3), any persisted-schema bump, any change to strict schema v1 semantics, renaming/moving the packaged skill.
