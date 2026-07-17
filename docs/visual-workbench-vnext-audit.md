# Visual Workbench vNext — Audit

Repo: hermes-visual-workbench, `main` @ fef8ee4, v0.2.1. Evidence lines cite the files as of this commit.

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
| `scripts/lib.mjs`, `scripts/install.mjs` | Hash-pinned installer/uninstaller with marker `.hermes-visual-workbench-install.json`; orthogonal to product model | `scripts/install.mjs`, `tests/install.test.mjs` |
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
6. Cosmetic/peripheral: capture default filename `${state.job.id || 'midjourney'}-…`, fixture artifacts under `artifacts/midjourney/<job-id>/`, skill named `midjourney-visual-workbench`.

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

<!-- Lane B sections follow: 'Workflow & IA audit' and 'Acceptance criteria'. Append below; do not edit Lane A sections above. -->
