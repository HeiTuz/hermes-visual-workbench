# Midjourney Web Bridge API

**Status:** live local control surface — selector registry `mj-web-2026-07-19.v3`  
**Owner:** user-local `hermes-visual-workbench`; no upstream Hermes PR/release is implied.

## Decision

Midjourney control moves out of macOS coordinate automation. The supported control plane is a local HTTP API backed by the authenticated, visible Hermes Desktop Browser guest (`persist:hermes-browser`) and a versioned CDP recipe.

CUA remains only for visual recovery and final pixel QC. It is not a submission transport.

This bridge does **not** call undocumented Midjourney backend endpoints and does not read, export, log, or persist cookies, headers, tokens, storage, or credentials.

## Implemented seam and billable boundary

`dashboard/plugin_api.py` accepts the strict `midjourney-control` command operation and relays it to the installed Desktop plugin. `scripts/midjourney-control.mjs` discovers loopback Hermes Agent listeners from `/openapi.json`, selects the one that accepts this plugin's `0600` bearer token, queues the command, and waits for the matching result receipt. This disambiguates concurrent profile backends without printing the token.

The installed Desktop host exposes `window.hermesDesktop.browser.control`, a provider-neutral typed seam with strict request unions for bounded semantic snapshot, focus/insertText, local file input, allowlisted click/Enter activation, bounded wait, and verified download. The local `mj-web-2026-07-19.v3` recipe owns every selector and ARIA-name matcher. Callers cannot provide selectors, JavaScript, CDP methods, download URLs, or absolute artifact destinations.

The lifecycle implements draft readback, bounded image upload, role classification, mode conversion, fresh validation receipts, approval-gated one-shot submit/result actions, bounded result discovery, acknowledged-submit linkage, wait/grid/capture/QC, and job-linked download. Every result has `operationId`, lifecycle `state`, bounded `evidence`, and a sanitized `error`. The current Add Images picker can route a file into Start Frame while its Image Prompts tab is open; strict single-role attachment therefore fails closed until an unambiguous role selector and remove control are identified.

Billable activation remains fail-closed. Three approved Creative Upscale attempts were durably reserved but stopped before activation with `Midjourney target upscale is ambiguous or unavailable`; no upscale result or charge was observed. The durable backend ledger atomically reserves billable idempotency keys before dispatch and rejects replay after restart.

## API surface

The transport endpoint is `POST /api/plugins/visual-workbench/command` with `op: "midjourney-control"`, `panelId: "result"`, and an action-specific payload. Results are read from `GET /api/plugins/visual-workbench/control/result?cursor=N`. Callers should use the CLI rather than handling the token.

### CLI commands

| Command | Purpose |
| --- | --- |
| `capabilities` | Reports registry version, implemented actions, and billable approval gates. |
| `navigate --url https://www.midjourney.com/` | Navigates the Browser result panel and assigns a new target identity. |
| `probe` / `state` / `results` | Returns live URL, fixed targets, bounds, bounded sanitized DOM/ARIA evidence, and visible job IDs without URLs or image sources. |
| `settings [--name NAME --value VALUE]` | Opens the slider-shaped settings control beside the composer and reads the panel, or sets aspect preset, model, raw mode, speed, video resolution, or the `P` personalization toggle with post-change readback. Numeric stylization/weirdness/variety and exact aspect ratio remain deterministic `draft --parameters` values. |
| `draft --prompt TEXT --parameters JSON` | Uses typed focus/insertText and requires exact Accessibility value readback. Never submits. |
| `attach --path FILE --role ROLE` / `detach --role ROLE` | Validates one local image and requires exact post-upload role evidence; current live Image Prompt routing fails closed and is not production-ready. |
| `validate` | Issues a short-lived receipt bound to panel, targetId, URL, exact composer value, reference roles, settings, and timestamp. |
| `submit --approve-billable --idempotency-key KEY --validate-receipt RECEIPT --batch-fingerprint 64LOWERHEX` | One-shot typed Enter activation after fresh validation and durable reservation. Requires the validation `batchFingerprint` (64 lowercase hex) so the durable submit ledger can enforce the atomic three-submit-per-batch quota; fails closed without it. Never auto-retries. |
| `wait --timeout-ms N` / `grid` | Samples bounded live state and A–D candidate metadata. |
| `link --operation-id HASH --job-id ID --prompt TEXT` | Binds an acknowledged submit receipt to an exact visible job ID and prompt hash before navigating to the canonical job page. |
| `action --name NAME --candidate A-D ...` | Fixed select/upscale/vary/reroll/pan/zoom controls; all except select require current approval and durable idempotency. |
| `download --job-id ID --filename NAME` | Downloads the visible job image under `~/.hermes/artifacts/midjourney/`, validating URL linkage, MIME/extension, magic bytes, byte count, and dimensions. |
| `capture` / `qc` | Captures the exact Browser target and returns linked QC evidence. |

Example:

```bash
node scripts/midjourney-control.mjs navigate --url https://www.midjourney.com/
node scripts/midjourney-control.mjs probe
node scripts/midjourney-control.mjs settings
node scripts/midjourney-control.mjs settings --name raw --value raw
node scripts/midjourney-control.mjs settings --name personalization --value false
node scripts/midjourney-control.mjs draft --prompt 'studio portrait' --parameters '{"ar":"3:4","raw":true}'
node scripts/midjourney-control.mjs validate
node scripts/midjourney-control.mjs capture
```

`--base-url http://127.0.0.1:PORT` is available for diagnostics; normal use dynamically discovers the current port.

## Host guest-actuation seam

The Desktop host must expose only fixed, typed operations to plugins granted a dedicated capability. It must retain existing ownership checks: guest belongs to the requesting window and uses the configured persistent Browser partition.

Allowed primitives:

- `snapshot`: bounded semantic state for a recipe-defined selector set; text, role, enabled/visible, bounds, and URL only.
- `focusText`: focus a validated recipe target and insert bounded text.
- `setFileInput`: set one approved local file on a validated `<input type=file>` recipe target.
- `activate`: invoke one validated recipe target's click/keyboard action.
- `waitFor`: wait for a bounded predicate built from the above snapshot fields.
- `capture` and `download`: existing bounded media/evidence flow.

Forbidden primitives:

- generic `Runtime.evaluate`
- `Network.*`, cookie APIs, storage APIs, request headers, or arbitrary page source extraction
- arbitrary CDP methods or arbitrary CSS/JavaScript supplied by an API caller
- unbounded DOM/HTML reads

The **recipe is local, declarative, versioned, and allowlisted**. API callers send an intent such as `attach-reference` or `submit`; they never send selectors or JavaScript.

## Fail-closed rules

1. The bridge checks the visible route and authenticated Create composer before every mutation.
2. Reference role is observed after upload. A `start-frame`, animation, or wrong-slot attachment is a hard failure, never an inferred success.
3. `submit`, `upscale`, `vary`, `reroll`, `pan`, and `zoom` require an explicit billable confirmation and idempotency key.
4. The result card must match the draft prompt fingerprint and preflight settings before any result action.
5. Navigation, selector mismatch, stale target identity, unsupported model mode, or changed settings invalidate the pending action.
6. No automatic retry after a possible billable click. The bridge first searches the newest creation feed for a matching card.
7. Downloads write verified provenance under `~/.hermes/artifacts/midjourney/<job-id>/`; billable reservations are atomically persisted under the plugin data directory. Neither stores credentials or browser-session data.

## Current acceptance boundary

Non-billable live acceptance covers exact acknowledged-submit linkage to job `32728f26-45f7-4bc6-be7b-80b4288e5ee6`, restart-safe duplicate-submit rejection, a verified A-D composite grid, verified 1024×1024 JPEG download, 1536×2048 capture, QC state, dynamic listener discovery, and bearer behavior `401/401/200`. Attachment upload was attempted with a 32-pixel fixture; the picker routed it to Start Frame and the bridge rejected the requested Image Prompt role. The composer was returned to Image mode and no submission was made. Style Reference and Omni were not live-smoked.

The original submit is acknowledged under operation hash `b20d14d835b346f3ce907f2146c72d8f395660490330c6ce3dbd602fbe767472`; replay returned `existing=true`, `queued=false`, and did not click again. Approved upscale attempts failed before activation because the live job page exposes `Subtle`/`Creative` controls outside the current fixed target resolver. `vary`, `reroll`, `pan`, and `zoom` were not exercised. No credit-consuming continuation was observed.

## Rollback

The installer creates timestamped backups before replacing managed files. To roll back the Desktop plugin:

```bash
cp ~/.hermes/desktop-plugins/visual-workbench/backups/plugin/plugin.js-<timestamp>.bak \
  ~/.hermes/desktop-plugins/visual-workbench/plugin.js
```

Then run **Reload desktop plugins** from the Hermes command palette. Backend rollbacks use the corresponding files under `~/.hermes/plugins/visual-workbench/backups/`, followed by a Hermes Agent backend restart. Do not delete `control.token`; rollback preserves the existing local credential and its `0600` mode.

## Acceptance evidence

A feature is complete only when a real authenticated Midjourney browser guest demonstrates the target action with:

- preflight snapshot proving the intended role/control;
- post-action visible state or matching creation card;
- sanitized operation receipt and artifact provenance;
- a fresh capture/QC record for any generated grid; and
- no cookie, token, storage, or raw network payload in the logs or artifact.
