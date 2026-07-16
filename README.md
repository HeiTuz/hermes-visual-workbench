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
- QC profiles for design, generated images, and generated video.
- Persistent plugin state with no separate backend service.

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
```

When `HERMES_HOME` is unset, it uses `~/.hermes`.

Hermes Desktop watches this directory and normally hot-loads the plugin. If it does not appear, open the command palette and run **Reload desktop plugins**.

### Update

Run the install command again. A changed local `plugin.js` is backed up before replacement.

### Uninstall

```bash
npx --yes github:HeiTuz/hermes-visual-workbench -- --uninstall
```

The uninstaller refuses to delete a modified or unmanaged `plugin.js`. Use `--force` only when you intentionally want to remove it.

### Custom Hermes home or test target

```bash
npx --yes github:HeiTuz/hermes-visual-workbench -- --hermes-home /path/to/.hermes
npx --yes github:HeiTuz/hermes-visual-workbench -- --target /tmp/visual-workbench
```

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

## Development

```bash
npm test
node scripts/install.mjs --target /tmp/visual-workbench
```

Runtime plugin source is plain ESM: no build step and no bundled copy of React or the Hermes SDK.

## License

MIT
