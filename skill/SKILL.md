---
name: renderline
description: Generate through Higgsfield and Midjourney, then capture, QC, compare, select, and repair across those results plus materialized ImgGen2 artifacts without touching credentials or spending credits without current-turn approval.
version: 0.8.1
platforms: [macos]
metadata:
  hermes:
    tags: [midjourney, visual-qc, computer-use, vision]
    category: creative
---

# Renderline

Use this skill for Higgsfield or Midjourney generation, or for QC/comparison/selection of any materialized image or video—including artifacts produced by ImgGen2. Renderline is the final visual-quality authority; it does not compile prompts or silently switch providers.

## Lane ownership

- **Higgsfield:** Renderline owns the production lane and QC surface. Use the native Higgsfield MCP procedure for model discovery, upload, generation, and terminal job evidence; then link the exact completed result in Renderline before judging it.
- **Midjourney:** Renderline owns the authenticated Hermes Desktop Browser-pane workflow and the existing approval-gated grid/QC procedure below.
- **ImgGen2:** ImgGen2 owns direct-native execution only. It hands Renderline the materialized output path, provider, model, prompt digest, and input-reference summary. Renderline imports the exact file or delivery URL, captures evidence, then judges it under the same QC authority as Higgsfield and Midjourney.

There is no automatic cross-lane fallback. A provider change, paid rerun, Midjourney variation/upscale, or new Higgsfield job needs the approval appropriate to that action.

## Hard boundaries

- Resolve `$HERMES_HOME` first; default to `~/.hermes`. Store run evidence under `$HERMES_HOME/artifacts/renderline/<job-id>/`; preserve the original materialized ImgGen2 artifact in place and record its path/hash rather than moving it.
- Never read, print, export, delete, move, or migrate Chromium cookies, tokens, Local State, IndexedDB, or credentials. Authentication is verified visually only.
- Never enter credentials.
- A Midjourney submit, upscale, or variation is credit-consuming. Perform it only when the user's current message explicitly approves that exact action and scope. Old approval, a saved job, or this skill is not approval.
- Default to `DRAFT → READY` and stop before submit.
- Browser authority is the Browser pane rendered inside the Hermes Desktop window, backed by `persist:hermes-browser`. Scope every GUI capture and action to `computer_use(..., app="Hermes")` and confirm the target window belongs to Hermes before interacting.
- Never use `browser_navigate`, any `browser_*` tool, or an external browser application such as Chrome, Safari, Arc, Brave, or Edge for this workflow. Those are different browser sessions and do not carry the Hermes internal Browser pane state.
- If the Hermes internal Browser pane cannot be found, opened, captured, or controlled, stop as `internal_pane_unavailable`; the provider registry's automation descriptor is the canonical source of this state name. Never fall back to an external browser.
- Pinned-target precondition (hard stop): immediately before every pointer, focus, or type action, re-verify from a fresh `app="Hermes"` capture that the action target is the internal Browser pane inside the Hermes Desktop window and that the pane's visible **Automation target** affordance reads `Hermes internal Browser pane · persist:hermes-browser`. If the affordance reads `Automation target unavailable`, or the pane cannot be re-verified, stop as `internal_pane_unavailable`. Never retarget an external browser (Chrome, Safari, Arc, Brave, Edge) or an isolated `browser_*` session.
- Use real pointer/focus/type events inside the Hermes window. Do not execute arbitrary page JavaScript and do not mutate DOM state directly.
- Bound every wait and retry. Never duplicate a submission after an uncertain click.

## State machine

`DRAFT → READY → SUBMITTED → GENERATING → GRID_READY → QC_RUNNING → SELECTED → UPSCALING → DOWNLOADED → ATTACHED`

Any nonterminal state may terminate as `FAILED` or `CANCELLED`. Do not skip live states merely to make a report look complete. Fixture/existing-feed QC may import a document already marked `GRID_READY` without claiming a live submission occurred.

## Workflow

1. Normalize the brief. Create a filesystem-safe job ID and write `request.json` plus `provenance.json` with timestamps, source, approval status, and no secrets.
2. Capture `app="Hermes"`, locate the Hermes titlebar **Browser** control, and open the Browser pane inside that same Hermes window. Confirm the pane's **Automation target** affordance shows `Hermes internal Browser pane · persist:hermes-browser` before any interaction. Navigate only through the pane's own address field. Verify the visible URL is `midjourney.com` and the rendered page looks authenticated. If the pane is unavailable or the affordance reads `Automation target unavailable`, stop as `internal_pane_unavailable`; if a login screen appears, stop as `login_required`. Do not open Chrome or another external browser and do not handle credentials.
3. Prepare the exact prompt and set the job to `READY`. Show the user what would be submitted.
4. Before the first submit click, re-read the current user turn. Without explicit approval, stop at `READY` and report that no credits were spent.
5. With approval, keep every background pointer/focus/type action scoped to `app="Hermes"` and the internal Browser pane. After the submit event, write a duplicate-prevention marker before any retry. If acknowledgement is uncertain, stop and inspect; never click submit again blindly.
6. Detect completion from fresh rendered screenshots with bounded polling. Do not rely on sleep alone.
7. In the Browser pane, press **Review in QC** on the Result target. Confirm **Inspection status** shows `LINKED`, the same Midjourney URL, viewport, and Fit/Actual mode, plus `READ ONLY`. Press **Capture evidence** there (or **Capture PNG** when a saved file is required); confirm `CAPTURE READY` and that the evidence dimensions belong to that same URL before copying a saved capture under the job artifact directory.
8. Analyze the visible four-cell grid with Hermes vision. Label candidates in reading order: A top-left, B top-right, C bottom-left, D bottom-right.
9. Score all eight dimensions from 0–100: prompt fidelity, composition, identity/reference fidelity, anatomy/geometry, artifacts, typography, color/material fidelity, production readiness.
10. Assign each candidate exactly one disposition: `PASS`, `REPAIR`, or `REJECT`. Record concise evidence and a repair prompt when repairable.
11. Produce strict QC JSON matching Renderline schema version 1. In the already-linked Quality Control pane, confirm **Midjourney QC**, paste into **Import QC JSON**, and press **Import QC JSON**. Confirm the target card, capture evidence, four candidates, and selected recommendation render together.
12. Recommend one candidate. Upscale or vary only with fresh explicit approval. Download/attach only the chosen result and record visible result references plus local paths.

## ImgGen2 artifact intake

For a direct-native artifact, do not regenerate or rehost it. Require the materialized local path plus provider, model, prompt digest, and input-reference summary from ImgGen2. Verify the file exists and is non-empty, point the Renderline Result target to that exact absolute path (the pane resolves local paths as `file://`), attach `imggen2-native` provider evidence, then `link → capture → score-candidate → select-candidate`. Renderline selects `Native Image QC` or `Native Video QC` from that evidence; never force the artifact into a Higgsfield or Midjourney profile. Read back the linked target before reporting a verdict. If the target cannot render, report `artifact_intake_failed`; do not score from a filename, prior screenshot, or remembered prompt.

This intake does not pretend an ImgGen2 file is a Higgsfield or Midjourney job. Preserve provider provenance as supplied, make any provenance gap explicit.

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
## Agent-driven QC

Use the dashboard session token; do not embed or log it. From a shell inside the Hermes backend (e.g. the desktop-spawned agent), resolve the endpoint and token, submit a v1 command, then poll its result:

```sh
TOKEN="$HERMES_DASHBOARD_SESSION_TOKEN"   # injected into the backend env by Hermes Desktop
BPID=$(for p in $(pgrep -f 'hermes_cli.main serve'); do ps eww $p | grep -q "$TOKEN" && echo $p && break; done)
PORT=$(lsof -nP -a -p "$BPID" -iTCP -sTCP:LISTEN | awk 'NR==2{sub(".*:","",$9); print $9}')
BASE="http://127.0.0.1:$PORT/api/plugins/renderline"
curl -sS -X POST "$BASE/command" \
  -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
  --data '{"id":"qc-1","op":"status","payload":{}}'
curl -sS "$BASE/result/qc-1" -H "Authorization: Bearer $TOKEN"
```

If `TOKEN` is empty or `POST /command` fails, Hermes Desktop is not running: skip mirroring and continue with tool-based QC only.

Poll `GET /result/<id>` until it returns `200` rather than `{ "pending": true }`. Each acknowledgement contains `ok`, `error`, `summary`, and the current status snapshot.

- Design sequence: `set-target` → `link` → `page-checks` → `set-check` for the review rows.
- Higgsfield sequence: `set-target` → `link` → `capture` → `score-candidate` → `select-candidate`.
- Commands that edit QC reject an unlinked or `STALE` review context. Relink the current Browser-pane target after navigation, viewport changes, swaps, provenance changes, or load failure, then retry the rejected command.

### Command-envelope and live-backend pitfalls

- `panelId` is operation-specific, not a universal envelope field. Include it for panel-scoped operations such as `link`; omit it for global `status`. A `status` command carrying `panelId` is rejected with `panelId is not allowed for this op`.
- Prefer the injected `$HERMES_DASHBOARD_SESSION_TOKEN`. If the agent shell does not inherit it but Desktop is live, identify the `hermes_cli.main serve` PID, read that process environment without printing the token, and derive its listening port with `lsof`. Treat this as endpoint discovery; never log or persist the token.
- After `link`, verify with `status`; if the acknowledgement wrapper does not expose `reviewContext` where expected, read `GET /state` with the same bearer token rather than guessing the schema. Summarize `panelId`, `targetId`, `profileId`, `mediaKind`, `stale/staleReason`, and `providerJobId`. An empty `providerJobId` is a real provenance gap and must be reported, not inferred from the URL.
## Non-billable verification

Use an existing feed screenshot or the package fixture. A valid dry run is: create artifact directory → write request/provenance → copy capture → validate/write QC JSON → import it through the real pane → show the recommendation. Explicitly record `billableActionsExecuted: []`.

Zero-cost E2E smoke (isolated, repeatable): resolve the Hermes backend interpreter first (`PY="$HERMES_HOME/hermes-agent/venv/bin/python"`; fall back to `python3` only when that file is absent), then run `$PY "$HERMES_HOME/plugins/renderline-telegram/e2e_smoke.py"`. This avoids a system-Python/compiled-`pydantic_core` mismatch while exercising the same FastAPI environment as Desktop. The smoke runs the full simulated chain — bridge create/attach/review → `request_selection(B)` → Desktop relay ack on the real WORKBENCH_CORE → `plugin_api` ack write → readback → bridge commit — plus an imggen2-native provenance persist/restore round-trip check (`providerJobId` must survive an emulated Desktop restart) and negative paths (stale revision, cross-scope, used reply token), entirely under a temp `HERMES_HOME`, and proves production state is untouched. Prints `E2E-OK` on success. Run both regression suites with the same `$PY`: `-m unittest discover -s "$HERMES_HOME/plugins/renderline-telegram" -p 'test_*.py'` and `-s "$HERMES_HOME/plugins/renderline/dashboard" -p 'test_*.py'`. For current Higgsfield CLI readback use `higgsfield generate list --json` or `higgsfield generate get <job_id> --json`; legacy `show_generations` is not a valid command.

## Recovery

- Managed install drift is repaired by `~/.hermes/scripts/renderline-update-reconcile.py`, launched by `com.eusin.renderline.reconcile` on Hermes/Renderline update paths and every five minutes. It runs the canonical source suite, performs a transactional `--update`, verifies managed hashes and dashboard tests, and rolls back on post-install failure. Unknown compatibility failures create `~/.hermes/state/renderline-reconcile/needs-adaptive-patch.json`; the local `Renderline adaptive compatibility repair` cron patches only the canonical source, reruns the full suite, and invokes the same transactional reconciler.
- Inspect `~/.hermes/state/renderline-reconcile/latest.json` and `~/.hermes/logs/renderline-reconcile.log` before manual intervention. Use `node ~/src/Renderline/scripts/install.mjs --verify` for an immediate managed-file check. Do not hand-edit installed copies; patch `~/src/Renderline`, test, then run the reconciler with `--force`.
- Login missing: stop and ask the user to authenticate manually in the persistent Browser pane.
- Import rejected: preserve the pane's prior state, fix only the reported schema violation, and import once more.
- Internal Browser pane unavailable: stop as `internal_pane_unavailable`; do not launch or reuse an external browser.
- Capture unavailable: use a background screenshot scoped to `app="Hermes"`; do not access browser storage.
- Uncertain submit/upscale click: stop. Inspect rendered UI before any retry.
