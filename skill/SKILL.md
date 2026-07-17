---
name: midjourney-visual-workbench
description: Prepare, capture, QC, select, and optionally upscale Midjourney results in Hermes Desktop without touching cookies or spending credits without current-turn approval.
version: 0.2.0
platforms: [macos]
metadata:
  hermes:
    tags: [midjourney, visual-qc, computer-use, vision]
    category: creative
---

# Midjourney Visual Workbench

Use this skill when the user asks to prepare or run a Midjourney job, compare a four-image grid, perform A/B/C/D QC, or import QC into the Visual Workbench pane.

## Hard boundaries

- Resolve `$HERMES_HOME` first; default to `~/.hermes`. Store job artifacts only at `$HERMES_HOME/artifacts/midjourney/<job-id>/`.
- Never read, print, export, delete, move, or migrate Chromium cookies, tokens, Local State, IndexedDB, or credentials. Authentication is verified visually only.
- Never enter credentials.
- A Midjourney submit, upscale, or variation is credit-consuming. Perform it only when the user's current message explicitly approves that exact action and scope. Old approval, a saved job, or this skill is not approval.
- Default to `DRAFT → READY` and stop before submit.
- Use background computer-use with real pointer/focus/type events. Do not execute arbitrary page JavaScript and do not mutate DOM state directly.
- Bound every wait and retry. Never duplicate a submission after an uncertain click.

## State machine

`DRAFT → READY → SUBMITTED → GENERATING → GRID_READY → QC_RUNNING → SELECTED → UPSCALING → DOWNLOADED → ATTACHED`

Any nonterminal state may terminate as `FAILED` or `CANCELLED`. Do not skip live states merely to make a report look complete. Fixture/existing-feed QC may import a document already marked `GRID_READY` without claiming a live submission occurred.

## Workflow

1. Normalize the brief. Create a filesystem-safe job ID and write `request.json` plus `provenance.json` with timestamps, source, approval status, and no secrets.
2. Open the real Hermes Desktop Browser pane. Verify the visible URL is `midjourney.com` and the rendered page looks authenticated. If a login screen appears, stop as `login_required`; do not handle credentials.
3. Prepare the exact prompt and set the job to `READY`. Show the user what would be submitted.
4. Before the first submit click, re-read the current user turn. Without explicit approval, stop at `READY` and report that no credits were spent.
5. With approval, use background pointer/focus/type input. After the submit event, write a duplicate-prevention marker before any retry. If acknowledgement is uncertain, stop and inspect; never click submit again blindly.
6. Detect completion from fresh rendered screenshots with bounded polling. Do not rely on sleep alone.
7. Use the Browser pane's **Capture PNG** action or a background window screenshot. Save/copy the capture under the job artifact directory.
8. Analyze the visible four-cell grid with Hermes vision. Label candidates in reading order: A top-left, B top-right, C bottom-left, D bottom-right.
9. Score all eight dimensions from 0–100: prompt fidelity, composition, identity/reference fidelity, anatomy/geometry, artifacts, typography, color/material fidelity, production readiness.
10. Assign each candidate exactly one disposition: `PASS`, `REPAIR`, or `REJECT`. Record concise evidence and a repair prompt when repairable.
11. Produce strict QC JSON matching Visual Workbench schema version 1. Open the Quality Control pane, select **Midjourney QC**, paste into **Import QC JSON**, and press **Import QC JSON**. Confirm the four candidates and selected recommendation render.
12. Recommend one candidate. Upscale or vary only with fresh explicit approval. Download/attach only the chosen result and record visible result references plus local paths.

## Strict QC document

Top-level fields are exactly: `schemaVersion`, `job`, `selectedCandidate`, `candidates`, `generatedAt`.

- `schemaVersion` is `1`.
- `job` fields are exactly `id`, `state`, `brief`, `createdAt`, `updatedAt`.
- `selectedCandidate` is `null` or `A|B|C|D`.
- `candidates` contains exactly A, B, C, D in that order.
- Candidate fields are exactly `id`, `summary`, `score`, `disposition`, `evidence`, `repairPrompt`, `dimensions`.
- `disposition` is `PASS|REPAIR|REJECT`; scores are integers 0–100.
- Dimension keys are exactly `promptFidelity`, `composition`, `identityReferenceFidelity`, `anatomyGeometry`, `artifacts`, `typography`, `colorMaterialFidelity`, `productionReadiness`; each value is `{ "score": integer, "evidence": string }`.
- Input over 64 KiB, malformed JSON, unknown fields, missing fields, and invalid ranges must be rejected. Never replace prior good state after an import error.

## Non-billable verification

Use an existing feed screenshot or the package fixture. A valid dry run is: create artifact directory → write request/provenance → copy capture → validate/write QC JSON → import it through the real pane → show the recommendation. Explicitly record `billableActionsExecuted: []`.

## Recovery

- Login missing: stop and ask the user to authenticate manually in the persistent Browser pane.
- Import rejected: preserve the pane's prior state, fix only the reported schema violation, and import once more.
- Capture unavailable: use a background Hermes window screenshot; do not access browser storage.
- Uncertain submit/upscale click: stop. Inspect rendered UI before any retry.
