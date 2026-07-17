# Hermes Visual Workbench

A dockable Browser + task-aware quality-control workspace for Hermes Desktop.

Visual Workbench keeps the product workflow in a runtime plugin while Hermes core owns only privileged browser security and generic extension points.

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
- Candidate score, disposition, evidence, repair prompt, per-provider dimension rubric, and selected recommendation.
- Strict 64 KiB-bounded QC JSON import/export with unknown-field and score-range rejection.
- Persisted, versioned job state (`DRAFT` through `ATTACHED`, plus terminal failure/cancel states).
- Native **Capture PNG** affordance for the secure persistent Browser guest.
- Packaged `midjourney-visual-workbench` Hermes workflow skill and deterministic non-billable fixture runner.

The preview is scaled to fit its pane, but the guest page still receives the selected viewport as its real `window.innerWidth` / `window.innerHeight`.

## Install

```bash
npx --yes github:HeiTuz/hermes-visual-workbench
```

Or with Bun:

```bash
bunx github:HeiTuz/hermes-visual-workbench
```

The installer writes:

```text
$HERMES_HOME/desktop-plugins/visual-workbench/plugin.js
$HERMES_HOME/skills/midjourney-visual-workbench/SKILL.md
```

When `HERMES_HOME` is unset, it uses `~/.hermes`.

Hermes Desktop watches this directory and normally hot-loads the plugin. If it does not appear, open the command palette and run **Reload desktop plugins**.

### Update

Run the install command again. Changed plugin and skill files are backed up separately before replacement. The install marker records both hashes.

### Uninstall

```bash
npx --yes github:HeiTuz/hermes-visual-workbench -- --uninstall
```

The uninstaller refuses to delete either managed file when its hash changed. It pins deletion to the expected plugin and skill paths instead of trusting paths stored in the marker. Use `--force` only when you intentionally want to remove local modifications.

### Custom Hermes home or test target

```bash
npx --yes github:HeiTuz/hermes-visual-workbench -- --hermes-home /path/to/.hermes
npx --yes github:HeiTuz/hermes-visual-workbench -- --target /tmp/visual-workbench --skill-target /tmp/midjourney-skill
```

`--target` and `--skill-target` are a required pair so a test install cannot accidentally write the skill into the real Hermes home. Installation preflights regular files, rejects managed symlinks, and rolls back earlier writes if a later managed write fails.

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

The plugin owns workflow and presentation. Hermes core remains authoritative for privileged guest creation, navigation filtering, popup denial, permission handling, attachment handling, and PNG capture bounds.

The plugin does not ship a Python backend and does not copy credentials.

It uses the existing `persist:hermes-browser` partition as-is and never reads, exports, deletes, or migrates its cookies. Midjourney submit, upscale, and variation remain agent approval gates: the plugin displays state and QC but never clicks those controls itself.

Midjourney automation is pinned to the Browser pane inside the Hermes Desktop window. The workflow scopes desktop actions to `app="Hermes"` and explicitly forbids external Chrome, Safari, Arc, Brave, Edge, and isolated `browser_*` sessions. If the internal pane is unavailable, it stops instead of falling back to another browser.

The Browser pane displays a visible **Automation target** affordance. With the privileged guest active it reads `Automation target · Hermes internal Browser pane · persist:hermes-browser`; in iframe fallback it reads `Automation target unavailable`, and the packaged workflow hard-stops as `internal_pane_unavailable` instead of retargeting any external browser or isolated `browser_*` session. Agents must re-verify this affordance from a fresh `app="Hermes"` capture immediately before every pointer, focus, or type action.

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
node scripts/install.mjs --target /tmp/visual-workbench --skill-target /tmp/midjourney-skill
```

Runtime plugin source is plain ESM: no build step and no bundled copy of React or the Hermes SDK.

## License

MIT
