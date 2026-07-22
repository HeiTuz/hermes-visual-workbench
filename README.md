# Hermes Renderline

A dockable Browser + task-aware quality-control workspace for Hermes Desktop.

Renderline runs its durable command, result, state, and WebSocket control plane as an independent launchd sidecar. Hermes owns only privileged browser security, generic extension points, and thin replaceable adapters.

## What it gives you

- Independent **Browser** and **Quality Control** panes.
- Standalone Browser and QC toggle icons immediately beside Hermes's Layout button.
- Result / Reference comparison in a top-bottom split.
- Real fixed guest viewports for responsive QC:
  - Desktop `1440×900`
  - Laptop `1280×800`
  - Tablet `768×1024`
  - Mobile `390×844`
  - Custom dimensions
- Independent chat-image actions:
  - **Open as Result**
  - **Set as Reference**
  - **Open in task QC**
- QC profiles for design, generated images, generated video, and provider-driven structured **A/B/C/D** review.
- A core provider registry drives structured candidate review from per-provider dimension descriptors: Midjourney is the first adapter (strict schema-v1 QC JSON wire format, eight-dimension rubric), and Higgsfield Image renders structured review from its own descriptor.
- Structured candidate review state (the A–D cards) is a single shared store: switching between structured providers relabels the same candidates under the new provider's rubric rather than keeping per-provider copies.
- Candidate score, disposition, evidence, repair prompt, per-provider dimension rubric, and selected recommendation.
- Strict 64 KiB-bounded QC JSON import/export with unknown-field and score-range rejection.
- Persisted, versioned job state (`DRAFT` through `ATTACHED`, plus terminal failure/cancel states).
- Native **Capture PNG** affordance for the secure persistent Browser guest.
- Explicit **Review in QC** routing from either Result or Reference, with the linked URL, viewport, Fit/Actual mode, CDP metrics, and matching capture evidence visible in every QC profile.
- A persistent **Inspection status** block in every profile shows target, capture, live target check, review progress, selection state, and provider execution mode instead of leaving blank checks ambiguous.
- Higgsfield image/video results opened from a Higgsfield MCP tool card carry bounded read-only provenance into QC: job ID, status, model, media type, prompt, dimensions, duration/ratio/resolution, result URL, batch size, and reference count. The plugin never submits or polls a generation itself.
- Higgsfield structured results render their real batch count (up to A–D) instead of forcing four empty candidate cards; Midjourney remains strict A/B/C/D and visibly read-only.
- Design QC can run a non-mutating CDP page preflight for current-viewport horizontal overflow, broken images, missing alt text, and unlabeled controls; visual contrast and aesthetic judgments remain manual.
- Capture evidence is invalidated when its Browser URL changes, preventing a stale screenshot from being presented as proof for a new target.
- Packaged `renderline` Hermes workflow skill and deterministic non-billable fixture runner.

The preview is scaled to fit its pane, but the guest page still receives the selected viewport as its real `window.innerWidth` / `window.innerHeight`.

## Install

```bash
npx --yes github:HeiTuz/Renderline
```

Or with Bun:

```bash
bunx github:HeiTuz/Renderline
```

The installer writes:

```text
$HERMES_HOME/desktop-plugins/renderline/plugin.js
$HERMES_HOME/skills/renderline/SKILL.md
$HERMES_HOME/plugins/renderline/plugin.yaml
$HERMES_HOME/plugins/renderline/__init__.py
$HERMES_HOME/plugins/renderline/dashboard/manifest.json
$HERMES_HOME/plugins/renderline/dashboard/plugin_api.py
$HERMES_HOME/desktop-plugins/renderline/scripts/handoff-receipt.mjs
~/Library/Application Support/Renderline/current/sidecar/
~/Library/Application Support/Renderline/venv/
~/Library/LaunchAgents/com.eusin.renderline.sidecar.plist
```

When `HERMES_HOME` is unset, it uses `~/.hermes`.

The launchd sidecar owns the durable ledger, command queue, results, state, authenticated local API, and WebSocket on `127.0.0.1:47821`. It has its own Python virtual environment and survives Hermes backend restarts. Hermes Desktop watches the desktop-plugin directory and normally hot-loads the JavaScript plugin; the small backend adapter requires a backend restart when its contract changes.

### Update

Run the install command again. Hermes adapter files retain their transaction backup, while the sidecar installs an immutable versioned release and atomically advances its `current` symlink. The previous sidecar release remains available for rollback.

### Rollback

Preview or restore the exact newest update transaction:

```bash
npx --yes github:HeiTuz/Renderline -- --rollback --dry-run
npx --yes github:HeiTuz/Renderline -- --rollback
```

Rollback restores only files changed by that transaction, keeps unchanged managed files, removes files that did not exist in the prior marker, and restores the prior marker bytes. It never combines per-file backups from different updates.
### Verification

`--verify` checks that all seven managed files match the current package source. `--verify-installed` is read-only and checks the installed files only against their marker hashes, so it can validate an installation without a checkout-source comparison.

```bash
npx --yes github:HeiTuz/Renderline -- --verify
npx --yes github:HeiTuz/Renderline -- --verify-installed
```


### Uninstall

```bash
npx --yes github:HeiTuz/Renderline -- --uninstall
```

The uninstaller refuses to delete any of the seven managed files when its hash changed. It pins deletion to the expected plugin, skill, backend, dashboard, and receipt paths instead of trusting paths stored in the marker. Use `--force` only when you intentionally want to remove local modifications.

### Custom Hermes home or test target

```bash
npx --yes github:HeiTuz/Renderline -- --hermes-home /path/to/.hermes
npx --yes github:HeiTuz/Renderline -- --target /tmp/renderline --skill-target /tmp/midjourney-skill
```

`--target` and `--skill-target` are a required pair so a test install cannot accidentally write the skill into the real Hermes home. Installation preflights every managed destination, backup, temporary file, marker, and ancestor; rejects containment escapes and symlinks; and rolls back earlier writes and directory creation if a later operation fails.

## Hermes compatibility

Full functionality requires the host capabilities proposed in [NousResearch/hermes-agent#65647](https://github.com/NousResearch/hermes-agent/pull/65647):

- `chat.imageActions`
- `titleBar.appControls`
- `host.panes`
- hardened Electron browser guest + capture bridge

| Hermes host | Behavior |
| --- | --- |
| Host includes #65647 capabilities | Full titlebar toggles, chat-image actions, secure persistent webviews, and capture support |
| Older host | Browser/QC pane registration remains portable; unavailable host-powered controls stay absent and page rendering falls back to a sandboxed iframe |

Until the upstream capability PR is merged, use a Hermes Desktop build containing that PR for the full experience.

## Security boundary

The sidecar owns durable workflow coordination. The desktop plugin owns presentation. Hermes core remains authoritative only for privileged guest creation, navigation filtering, popup denial, permission handling, attachment handling, and PNG capture bounds.

The package ships a bounded independent Python sidecar plus a thin Hermes proxy adapter. The sidecar creates a mode-`0600` control token under `~/Library/Application Support/Renderline`, binds only to loopback, and never copies external provider credentials. Hermes updates can replace or temporarily break the adapter without terminating the sidecar or deleting its durable state.

It uses the existing `persist:hermes-browser` partition as-is and never reads, exports, deletes, or migrates its cookies. Midjourney submit, upscale, and variation remain agent approval gates: the plugin displays state and QC but never clicks those controls itself.

Midjourney automation is pinned to the Browser pane inside the Hermes Desktop window. The workflow scopes desktop actions to `app="Hermes"` and explicitly forbids external Chrome, Safari, Arc, Brave, Edge, and isolated `browser_*` sessions. If the internal pane is unavailable, it stops instead of falling back to another browser.

The Browser pane displays a visible **Automation target** affordance. With the privileged guest active it reads `Automation target · Hermes internal Browser pane · persist:hermes-browser`; in iframe fallback it reads `Automation target unavailable`, and the packaged workflow hard-stops as `internal_pane_unavailable` instead of retargeting any external browser or isolated `browser_*` session. Agents must re-verify this affordance from a fresh `app="Hermes"` capture immediately before every pointer, focus, or type action.
## Delivery boundary

Renderline delivers a handoff receipt only for a selected `PASS` candidate with a complete, verified receipt. It fails closed as `DELIVERY_BLOCKED` when any required evidence, selection, or receipt stage is absent or invalid; do not bypass that state. Recover by repairing the reported stage, recapturing, relinking, or re-running QC as needed, then selecting a present `PASS` candidate and validating a new receipt.

3D is unsupported product-wide: it cannot be captured, reviewed, receipted, or delivered. Design, ImgGen2, and unknown external-provider profiles are local-only evidence; they may be inspected and recorded locally but cannot be submitted, selected for delivery, or used as a provider fallback.

Renderline never reads, prints, exports, stores, or migrates tokens, credentials, cookies, browser storage, or control tokens. Authentication is verified visually only.
## Higgsfield read-only CLI inspection

Existing Higgsfield jobs can still be inspected through the authenticated `higgsfield` CLI without an MCP tool card. `scripts/higgsfield-control.mjs` maps only observation subcommands (`account status`, `generate list`, `soul-id list`, `model list`, `generate get`) and has no argv passthrough, so paid or mutating subcommands are unreachable by construction.

```bash
node scripts/higgsfield-control.mjs evidence --url "<result_url>"
node scripts/higgsfield-control.mjs evidence --job-id "<job-id>"
```

CLI evidence is diagnostic only and cannot be attached to QC through `set-target`. Trusted Web provenance is created inside Hermes: run the typed Higgsfield `observe` action on a completed result, then consume its short-lived one-shot `observationReceipt` with the typed `link` action. The Electron observer verifies the Unlimited UI state and exact result provenance; the plugin strips signed URL data before durable storage.

The bridge never uses the `hf` alias, which commonly resolves to the HuggingFace CLI; it always invokes `higgsfield` (override with `HIGGSFIELD_BIN`). This read-only bridge never triggers generation.

## Non-billable fixture E2E

Create a complete local artifact job without a Midjourney submission:

```bash
npm run fixture:e2e -- --job-id fixture-v1
```

The runner writes `request.json`, `provenance.json`, `qc.json`, and `capture.svg` under:

```text
$HERMES_HOME/artifacts/midjourney/<job-id>/
```

`provenance.json` records `billableActionsExecuted: []`, `cookieDataAccessed: false`, and `credentialsEntered: false`. Import the generated `qc.json` in **Quality Control → Midjourney QC** to verify the rendered four-candidate recommendation path.

## Development

```bash
npm test
node scripts/install.mjs --target /tmp/renderline --skill-target /tmp/midjourney-skill
```

Runtime plugin source is plain ESM: no build step and no bundled copy of React or the Hermes SDK.

## License

MIT
