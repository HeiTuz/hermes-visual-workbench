import {
  atom,
  Badge,
  Button,
  Codicon,
  EmptyState,
  host,
  Input,
  ScrollArea,
  Separator,
  Textarea,
  Tip,
  useValue
} from '@hermes/plugin-sdk'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

const PLUGIN_ID = 'visual-workbench'
const PLUGIN_VERSION = '0.1.0'
const BROWSER_PANE_ID = `${PLUGIN_ID}:browser`
const QC_PANE_ID = `${PLUGIN_ID}:qc`
const CLOSED_PANE_ATOM = atom(false)

const QC_PROFILES = {
  design: {
    label: 'Design QC',
    description: 'Layout, type, spacing, accessibility, and brand fidelity.',
    checks: [
      ['composition', 'Composition & hierarchy'],
      ['typography', 'Typography'],
      ['spacing', 'Grid & spacing'],
      ['contrast', 'Contrast & accessibility'],
      ['responsive', 'Responsive behavior'],
      ['clipping', 'Overflow & clipping'],
      ['reference', 'Brand / reference fidelity']
    ]
  },
  'higgsfield-image': {
    label: 'Higgsfield Image QC',
    description: 'Generation fidelity, identity, anatomy, artifacts, and product-critical details.',
    checks: [
      ['prompt', 'Prompt adherence'],
      ['identity', 'Subject / product identity'],
      ['anatomy', 'Anatomy & geometry'],
      ['artifacts', 'Artifacts & cleanup'],
      ['color', 'Color grade & critical colors'],
      ['text', 'Text, logo & labels'],
      ['framing', 'Framing & crop']
    ]
  },
  'higgsfield-video': {
    label: 'Higgsfield Video QC',
    description: 'Temporal consistency, motion, camera, audio sync, and generation artifacts.',
    checks: [
      ['prompt', 'Prompt adherence'],
      ['identity', 'Identity continuity'],
      ['motion', 'Motion & physics'],
      ['camera', 'Camera continuity'],
      ['temporal', 'Temporal consistency'],
      ['audio', 'Lip sync & audio'],
      ['artifacts', 'Artifacts & flicker'],
      ['framing', 'Framing & crop']
    ]
  }
}

const DEFAULT_BROWSER_PANELS = {
  result: { url: '', preset: 'desktop', width: 1440, height: 900 },
  reference: { url: '', preset: 'mobile', width: 390, height: 844 }
}

const DEFAULT_STATE = {
  browserSplit: false,
  browserPanels: DEFAULT_BROWSER_PANELS,
  qcProfile: 'design',
  evaluations: {}
}

let pluginContext = null
let state = { ...DEFAULT_STATE }
const listeners = new Set()

function persistedState() {
  return {
    browserSplit: state.browserSplit,
    browserPanels: state.browserPanels,
    qcProfile: state.qcProfile,
    evaluations: state.evaluations
  }
}

function restoredState(saved) {
  const legacyUrl = typeof saved?.browserUrl === 'string' ? saved.browserUrl : ''
  return {
    ...DEFAULT_STATE,
    ...saved,
    browserPanels: {
      result: {
        ...DEFAULT_BROWSER_PANELS.result,
        ...saved?.browserPanels?.result,
        url: saved?.browserPanels?.result?.url || legacyUrl
      },
      reference: { ...DEFAULT_BROWSER_PANELS.reference, ...saved?.browserPanels?.reference }
    }
  }
}

function setState(patch) {
  state = { ...state, ...patch }
  pluginContext?.storage.set('workbench.v1', persistedState())
  listeners.forEach(listener => listener())
}

function setBrowserPanel(panelId, patch) {
  const panel = state.browserPanels[panelId] || DEFAULT_BROWSER_PANELS[panelId]
  setState({ browserPanels: { ...state.browserPanels, [panelId]: { ...panel, ...patch } } })
}

function subscribe(listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function useWorkbench() {
  return useSyncExternalStore(subscribe, () => state, () => state)
}

function PaneTitlebarToggle({ codicon, label, paneId }) {
  const paneApi = host.panes
  const open = useValue(paneApi?.open?.(paneId) || CLOSED_PANE_ATOM)
  const action = open ? `Hide ${label}` : `Show ${label}`

  if (!paneApi?.toggle) return null

  return jsx(Tip, {
    label: action,
    children: jsx(Button, {
      'aria-label': action,
      'aria-pressed': open,
      onClick: () => paneApi.toggle(paneId),
      size: 'icon-titlebar',
      style: { color: open ? 'var(--ui-text-primary)' : 'var(--ui-text-quaternary)' },
      type: 'button',
      variant: 'ghost',
      children: jsx(Codicon, { name: codicon })
    })
  })
}

function normalizeUrl(raw) {
  const value = String(raw || '').trim()
  if (!value) return ''
  if (/^(https?|file|data):/i.test(value)) return value
  if (value.startsWith('/')) return `file://${value}`
  return `https://${value}`
}

function mediaKind(url) {
  const path = String(url || '').split(/[?#]/, 1)[0].toLowerCase()
  if (/\.(png|jpe?g|webp|gif|avif|bmp|svg)$/.test(path) || /^data:image\//i.test(url)) return 'image'
  if (/\.(mp4|mov|webm|mkv|avi)$/.test(path)) return 'video'
  return 'page'
}

function qcProfileFor(input) {
  const toolName = String(input.toolName || '').toLowerCase()
  if (mediaKind(input.src) === 'video' || toolName.includes('generate_video')) return 'higgsfield-video'
  if (toolName.includes('higgsfield')) return 'higgsfield-image'
  return 'design'
}

function statusVariant(status) {
  if (status === 'pass') return 'default'
  if (status === 'fail') return 'destructive'
  if (status === 'na') return 'muted'
  return 'warn'
}

const VIEWPORT_PRESETS = {
  responsive: { label: 'Responsive' },
  desktop: { label: 'Desktop · 1440×900', width: 1440, height: 900 },
  laptop: { label: 'Laptop · 1280×800', width: 1280, height: 800 },
  tablet: { label: 'Tablet · 768×1024', width: 768, height: 1024 },
  mobile: { label: 'Mobile · 390×844', width: 390, height: 844 },
  custom: { label: 'Custom' }
}

function viewportFor(panel) {
  const preset = VIEWPORT_PRESETS[panel.preset] || VIEWPORT_PRESETS.custom
  return {
    responsive: panel.preset === 'responsive',
    width: Math.max(240, Number(preset.width || panel.width) || 1440),
    height: Math.max(240, Number(preset.height || panel.height) || 900)
  }
}

function PanelIntro({ title, description }) {
  return jsxs('div', {
    style: { padding: '12px 12px 8px' },
    children: [
      jsx('div', { style: { fontSize: 13, fontWeight: 650 }, children: title }),
      jsx('div', {
        style: { color: 'var(--ui-text-tertiary)', fontSize: 11, lineHeight: 1.45, marginTop: 3 },
        children: description
      })
    ]
  })
}

function BrowserSurface({ url }) {
  const kind = mediaKind(url)
  const hasPrivilegedBrowser = Boolean(window.hermesDesktop?.browser?.capture)

  if (!url) {
    return jsx(EmptyState, { title: 'No target', description: 'Paste a URL or open a file from the Files pane.' })
  }

  if (kind === 'image') {
    return jsx('img', {
      alt: 'QC target',
      src: url,
      style: { display: 'block', height: '100%', objectFit: 'contain', width: '100%' }
    })
  }

  if (kind === 'video') {
    return jsx('video', {
      controls: true,
      src: url,
      style: { display: 'block', height: '100%', objectFit: 'contain', width: '100%' }
    })
  }

  if (hasPrivilegedBrowser) {
    return jsx('webview', {
      allowpopups: 'false',
      partition: 'persist:hermes-browser',
      src: url,
      style: { border: 0, display: 'flex', height: '100%', width: '100%' }
    })
  }

  return jsx('iframe', {
    referrerPolicy: 'no-referrer',
    sandbox: 'allow-forms allow-scripts allow-same-origin',
    src: url,
    style: { border: 0, height: '100%', width: '100%' },
    title: 'Visual Workbench Browser'
  })
}

function ViewportStage({ panel }) {
  const containerRef = useRef(null)
  const [bounds, setBounds] = useState({ width: 0, height: 0 })
  const viewport = viewportFor(panel)

  useEffect(() => {
    const element = containerRef.current
    if (!element) return
    const update = () => setBounds({ width: element.clientWidth, height: element.clientHeight })
    update()
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  if (viewport.responsive) {
    return jsx('div', {
      ref: containerRef,
      style: { height: '100%', minHeight: 0, overflow: 'hidden', width: '100%' },
      children: jsx(BrowserSurface, { url: panel.url })
    })
  }

  const scale = Math.min(bounds.width / viewport.width || 1, bounds.height / viewport.height || 1, 1)

  return jsx('div', {
    ref: containerRef,
    style: {
      background: 'var(--ui-surface-secondary)',
      height: '100%',
      minHeight: 0,
      overflow: 'hidden',
      position: 'relative',
      width: '100%'
    },
    children: jsx('div', {
      style: {
        background: 'var(--ui-surface-primary)',
        boxShadow: 'inset 0 0 0 1px var(--ui-stroke-secondary)',
        height: viewport.height,
        left: '50%',
        overflow: 'hidden',
        position: 'absolute',
        top: '50%',
        transform: `translate(-50%, -50%) scale(${scale})`,
        transformOrigin: 'center center',
        width: viewport.width
      },
      children: jsx(BrowserSurface, { url: panel.url })
    })
  })
}

function BrowserPanel({ panelId, title }) {
  const workbench = useWorkbench()
  const panel = workbench.browserPanels[panelId] || DEFAULT_BROWSER_PANELS[panelId]
  const [draft, setDraft] = useState(panel.url)
  const viewport = viewportFor(panel)

  useEffect(() => setDraft(panel.url), [panel.url])

  const navigate = () => setBrowserPanel(panelId, { url: normalizeUrl(draft) })
  const setPreset = preset => {
    const dimensions = VIEWPORT_PRESETS[preset] || {}
    setBrowserPanel(panelId, { preset, width: dimensions.width || panel.width, height: dimensions.height || panel.height })
  }

  return jsxs('div', {
    style: {
      borderBottom: '1px solid var(--ui-stroke-secondary)',
      display: 'flex',
      flexDirection: 'column',
      minHeight: 0,
      overflow: 'hidden'
    },
    children: [
      jsxs('div', {
        style: { alignItems: 'center', display: 'flex', gap: 6, padding: '7px 10px' },
        children: [
          jsx('strong', { style: { fontSize: 11, minWidth: 58 }, children: title }),
          jsx('span', {
            style: { color: 'var(--ui-text-quaternary)', fontSize: 9, marginLeft: 'auto' },
            children: viewport.responsive ? 'RESPONSIVE' : `${viewport.width}×${viewport.height}`
          })
        ]
      }),
      jsxs('div', {
        style: { display: 'grid', gap: 6, gridTemplateColumns: 'minmax(0, 1fr) auto', padding: '0 10px 7px' },
        children: [
          jsx(Input, {
            'aria-label': `${title} URL or file path`,
            onChange: event => setDraft(event.target.value),
            onKeyDown: event => {
              if (event.key === 'Enter') navigate()
            },
            placeholder: 'https://… or /path/to/media',
            value: draft
          }),
          jsx(Button, { onClick: navigate, size: 'sm', children: 'Open' })
        ]
      }),
      jsxs('div', {
        style: { display: 'flex', gap: 6, padding: '0 10px 7px' },
        children: [
          jsx('select', {
            'aria-label': `${title} viewport preset`,
            onChange: event => setPreset(event.target.value),
            style: {
              background: 'var(--ui-surface-secondary)',
              border: '1px solid var(--ui-stroke-secondary)',
              borderRadius: 5,
              color: 'var(--ui-text-primary)',
              fontSize: 10,
              height: 26,
              minWidth: 145,
              padding: '0 6px'
            },
            value: panel.preset,
            children: Object.entries(VIEWPORT_PRESETS).map(([id, preset]) =>
              jsx('option', { value: id, children: preset.label }, id)
            )
          }),
          panel.preset === 'custom'
            ? jsxs('span', {
                style: { alignItems: 'center', display: 'flex', gap: 4 },
                children: [
                  jsx(Input, {
                    'aria-label': `${title} viewport width`,
                    min: 240,
                    onChange: event => setBrowserPanel(panelId, { width: Number(event.target.value) || 240 }),
                    style: { height: 26, width: 66 },
                    type: 'number',
                    value: panel.width
                  }),
                  jsx('span', { style: { color: 'var(--ui-text-quaternary)', fontSize: 10 }, children: '×' }),
                  jsx(Input, {
                    'aria-label': `${title} viewport height`,
                    min: 240,
                    onChange: event => setBrowserPanel(panelId, { height: Number(event.target.value) || 240 }),
                    style: { height: 26, width: 66 },
                    type: 'number',
                    value: panel.height
                  })
                ]
              })
            : null
        ]
      }),
      jsx('div', { style: { flex: 1, minHeight: 0, overflow: 'hidden' }, children: jsx(ViewportStage, { panel }) })
    ]
  })
}

function BrowserPane() {
  const workbench = useWorkbench()
  return jsxs('div', {
    style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 },
    children: [
      jsx(PanelIntro, {
        title: 'Browser',
        description: window.hermesDesktop?.browser?.capture
          ? 'Independent result/reference viewports · secure persistent webview session'
          : 'Independent result/reference viewports · portable iframe mode'
      }),
      jsxs('div', {
        style: { display: 'flex', gap: 6, padding: '0 12px 10px' },
        children: [
          jsx(Button, {
            onClick: () => setState({ browserSplit: false }),
            size: 'xs',
            variant: workbench.browserSplit ? 'outline' : 'default',
            children: 'Single'
          }),
          jsx(Button, {
            onClick: () => setState({ browserSplit: true }),
            size: 'xs',
            variant: workbench.browserSplit ? 'default' : 'outline',
            children: 'Top–Bottom Split'
          }),
          jsx(Button, {
            disabled: !workbench.browserSplit,
            onClick: () =>
              setState({
                browserPanels: {
                  result: workbench.browserPanels.reference,
                  reference: workbench.browserPanels.result
                }
              }),
            size: 'xs',
            variant: 'outline',
            children: 'Swap'
          })
        ]
      }),
      jsx(Separator, {}),
      jsxs('div', {
        style: {
          display: 'grid',
          flex: 1,
          gridTemplateRows: workbench.browserSplit ? 'minmax(0, 1fr) minmax(0, 1fr)' : 'minmax(0, 1fr)',
          minHeight: 0,
          overflow: 'hidden'
        },
        children: [
          jsx(BrowserPanel, { panelId: 'result', title: 'Result' }),
          workbench.browserSplit ? jsx(BrowserPanel, { panelId: 'reference', title: 'Reference' }) : null
        ]
      })
    ]
  })
}

function ProfileSelect({ value }) {
  return jsx('select', {
    'aria-label': 'QC profile',
    onChange: event => setState({ qcProfile: event.target.value }),
    style: {
      background: 'var(--ui-surface-secondary)',
      border: '1px solid var(--ui-stroke-secondary)',
      borderRadius: 6,
      color: 'var(--ui-text-primary)',
      fontSize: 12,
      height: 30,
      padding: '0 8px',
      width: '100%'
    },
    value,
    children: Object.entries(QC_PROFILES).map(([id, profile]) => jsx('option', { value: id, children: profile.label }, id))
  })
}

function CheckRow({ checkId, label, profileId }) {
  const workbench = useWorkbench()
  const evaluation = workbench.evaluations[profileId]?.[checkId] || { status: 'pending', note: '' }

  const update = patch => {
    const profile = { ...(workbench.evaluations[profileId] || {}) }
    profile[checkId] = { ...evaluation, ...patch }
    setState({ evaluations: { ...workbench.evaluations, [profileId]: profile } })
  }

  return jsxs('div', {
    style: { borderBottom: '1px solid var(--ui-stroke-secondary)', padding: '10px 12px' },
    children: [
      jsxs('div', {
        style: { alignItems: 'center', display: 'flex', gap: 8, justifyContent: 'space-between' },
        children: [
          jsx('span', { style: { fontSize: 12, fontWeight: 550 }, children: label }),
          jsx(Badge, { variant: statusVariant(evaluation.status), children: evaluation.status.toUpperCase() })
        ]
      }),
      jsx('div', {
        style: { display: 'grid', gap: 5, gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', marginTop: 8 },
        children: ['pass', 'fail', 'na', 'pending'].map(status =>
          jsx(Button, {
            onClick: () => update({ status }),
            size: 'xs',
            variant: evaluation.status === status ? 'default' : 'outline',
            children: status === 'pending' ? 'WAIT' : status.toUpperCase()
          }, status)
        )
      }),
      jsx(Textarea, {
        onChange: event => update({ note: event.target.value }),
        placeholder: 'Evidence / repair note',
        style: { marginTop: 8, minHeight: 54 },
        value: evaluation.note
      })
    ]
  })
}

function QcPane() {
  const workbench = useWorkbench()
  const profile = QC_PROFILES[workbench.qcProfile] || QC_PROFILES.design
  const values = Object.values(workbench.evaluations[workbench.qcProfile] || {})
  const failed = values.filter(value => value.status === 'fail').length
  const passed = values.filter(value => value.status === 'pass').length
  const hasResult = Boolean(workbench.browserPanels.result.url)
  const hasReference = Boolean(workbench.browserPanels.reference.url)

  return jsxs('div', {
    style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 },
    children: [
      jsx(PanelIntro, { title: profile.label, description: profile.description }),
      jsx('div', { style: { padding: '0 12px 8px' }, children: jsx(ProfileSelect, { value: workbench.qcProfile }) }),
      jsxs('div', {
        style: { display: 'flex', gap: 6, padding: '0 12px 10px' },
        children: [
          jsx(Badge, { variant: failed ? 'destructive' : 'muted', children: `${failed} FAIL` }),
          jsx(Badge, { variant: passed ? 'default' : 'muted', children: `${passed} PASS` }),
          jsx('span', {
            style: { color: 'var(--ui-text-quaternary)', fontSize: 10, marginLeft: 'auto' },
            children: hasResult && hasReference ? 'RESULT + REFERENCE' : hasResult ? 'RESULT LINKED' : 'NO TARGET'
          })
        ]
      }),
      jsx(Separator, {}),
      jsx(ScrollArea, {
        style: { flex: 1, minHeight: 0 },
        children: profile.checks.map(([id, label]) =>
          jsx(CheckRow, { checkId: id, label, profileId: workbench.qcProfile }, id)
        )
      })
    ]
  })
}

export default {
  id: PLUGIN_ID,
  name: 'Visual Workbench',
  version: PLUGIN_VERSION,
  register(ctx) {
    pluginContext = ctx
    state = restoredState(ctx.storage.get('workbench.v1', DEFAULT_STATE))

    ctx.registerMany([
      {
        id: 'toggle-browser-pane',
        area: 'titleBar.appControls',
        order: 10,
        render: () => jsx(PaneTitlebarToggle, { codicon: 'globe', label: 'Browser pane', paneId: BROWSER_PANE_ID })
      },
      {
        id: 'toggle-qc-pane',
        area: 'titleBar.appControls',
        order: 20,
        render: () => jsx(PaneTitlebarToggle, { codicon: 'checklist', label: 'Quality Control pane', paneId: QC_PANE_ID })
      },
      {
        id: 'open-image-in-browser',
        area: 'chat.imageActions',
        order: 10,
        data: {
          codicon: 'globe',
          label: 'Open as Result',
          onSelect: input => {
            setBrowserPanel('result', { url: input.src })
            host.panes?.setOpen?.(BROWSER_PANE_ID, true)
          }
        }
      },
      {
        id: 'set-image-as-reference',
        area: 'chat.imageActions',
        order: 20,
        data: {
          codicon: 'references',
          label: 'Set as Reference',
          onSelect: input => {
            setBrowserPanel('reference', { url: input.src })
            setState({ browserSplit: true })
            host.panes?.setOpen?.(BROWSER_PANE_ID, true)
          }
        }
      },
      {
        id: 'open-image-in-qc',
        area: 'chat.imageActions',
        order: 30,
        data: {
          codicon: 'pass',
          label: 'Open in task QC',
          onSelect: input => {
            setBrowserPanel('result', { url: input.src })
            setState({ qcProfile: qcProfileFor(input) })
            host.panes?.setOpen?.(BROWSER_PANE_ID, true)
            host.panes?.setOpen?.(QC_PANE_ID, true)
          }
        }
      },
      {
        id: 'browser',
        area: 'panes',
        title: 'Browser',
        data: { placement: 'right', dock: { pane: 'workspace', pos: 'right' }, width: '560px' },
        render: () => jsx(BrowserPane, {})
      },
      {
        id: 'qc',
        area: 'panes',
        title: 'Quality Control',
        data: { placement: 'right', dock: { pane: BROWSER_PANE_ID, pos: 'right' }, width: '330px' },
        render: () => jsx(QcPane, {})
      }
    ])
  }
}
