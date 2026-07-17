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
const PLUGIN_VERSION = '0.3.0'
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
  },
  midjourney: {
    label: 'Midjourney QC',
    description: 'Strict A/B/C/D scoring, evidence, repair prompts, and production recommendation.',
    checks: [
      ['promptFidelity', 'Prompt fidelity'],
      ['composition', 'Composition'],
      ['identityReferenceFidelity', 'Identity / reference fidelity'],
      ['anatomyGeometry', 'Anatomy & geometry'],
      ['artifacts', 'Artifacts'],
      ['typography', 'Typography'],
      ['colorMaterialFidelity', 'Color & material fidelity'],
      ['productionReadiness', 'Production readiness']
    ]
  }
}

// WORKBENCH_CORE_BEGIN
const PERSISTED_SCHEMA_VERSION = 2
const QC_DOCUMENT_SCHEMA_VERSION = 1
const MAX_QC_JSON_BYTES = 64 * 1024
const CANDIDATE_IDS = ['A', 'B', 'C', 'D']
const DISPOSITIONS = ['PASS', 'REPAIR', 'REJECT']
const QC_PROFILE_IDS = ['design', 'higgsfield-image', 'higgsfield-video', 'midjourney']
const JOB_STATES = [
  'DRAFT', 'READY', 'SUBMITTED', 'GENERATING', 'GRID_READY', 'QC_RUNNING',
  'SELECTED', 'UPSCALING', 'DOWNLOADED', 'ATTACHED', 'FAILED', 'CANCELLED'
]
const JOB_TRANSITIONS = {
  DRAFT: ['READY', 'FAILED', 'CANCELLED'], READY: ['SUBMITTED', 'FAILED', 'CANCELLED'],
  SUBMITTED: ['GENERATING', 'FAILED', 'CANCELLED'], GENERATING: ['GRID_READY', 'FAILED', 'CANCELLED'],
  GRID_READY: ['QC_RUNNING', 'FAILED', 'CANCELLED'], QC_RUNNING: ['SELECTED', 'FAILED', 'CANCELLED'],
  SELECTED: ['UPSCALING', 'DOWNLOADED', 'FAILED', 'CANCELLED'],
  UPSCALING: ['DOWNLOADED', 'FAILED', 'CANCELLED'], DOWNLOADED: ['ATTACHED', 'FAILED', 'CANCELLED'],
  ATTACHED: [], FAILED: [], CANCELLED: []
}
const QC_DIMENSIONS = [
  'promptFidelity', 'composition', 'identityReferenceFidelity', 'anatomyGeometry',
  'artifacts', 'typography', 'colorMaterialFidelity', 'productionReadiness'
]

function blankCandidate(id) {
  return {
    id, summary: '', score: 0, disposition: 'REJECT', evidence: [], repairPrompt: '',
    dimensions: Object.fromEntries(QC_DIMENSIONS.map(key => [key, { score: 0, evidence: '' }]))
  }
}

function blankCandidates() {
  return Object.fromEntries(CANDIDATE_IDS.map(id => [id, blankCandidate(id)]))
}

function blankJob() {
  return { id: '', state: 'DRAFT', brief: '', createdAt: '', updatedAt: '' }
}

const DEFAULT_BROWSER_PANELS = {
  result: { url: '', preset: 'desktop', width: 1440, height: 900 },
  reference: { url: '', preset: 'mobile', width: 390, height: 844 }
}

const DEFAULT_STATE = {
  schemaVersion: PERSISTED_SCHEMA_VERSION,
  browserSplit: false,
  browserPanels: DEFAULT_BROWSER_PANELS,
  qcProfile: 'design',
  evaluations: {},
  job: blankJob(),
  candidates: blankCandidates(),
  selectedCandidate: null,
  qcJson: '',
  capture: null
}

let pluginContext = null
let state = { ...DEFAULT_STATE }
const listeners = new Set()
const browserWebviews = new Map()

function persistedState() {
  return {
    schemaVersion: PERSISTED_SCHEMA_VERSION,
    browserSplit: state.browserSplit,
    browserPanels: state.browserPanels,
    qcProfile: state.qcProfile,
    evaluations: state.evaluations,
    job: state.job,
    candidates: state.candidates,
    selectedCandidate: state.selectedCandidate,
    qcJson: state.qcJson,
    capture: state.capture
  }
}

function restoredState(saved) {
  const source = isRecord(saved) ? saved : {}
  const legacyUrl = typeof source.browserUrl === 'string' ? source.browserUrl : ''
  const savedCandidates = isRecord(source.candidates) ? source.candidates : {}
  return {
    ...DEFAULT_STATE,
    schemaVersion: PERSISTED_SCHEMA_VERSION,
    browserSplit: source.browserSplit === true,
    browserPanels: {
      result: restoredPanel(source.browserPanels?.result, DEFAULT_BROWSER_PANELS.result, legacyUrl),
      reference: restoredPanel(source.browserPanels?.reference, DEFAULT_BROWSER_PANELS.reference)
    },
    qcProfile: QC_PROFILE_IDS.includes(source.qcProfile) ? source.qcProfile : DEFAULT_STATE.qcProfile,
    evaluations: restoredEvaluations(source.evaluations),
    job: restoredJob(source.job),
    candidates: Object.fromEntries(CANDIDATE_IDS.map(id => [id, restoredCandidate(savedCandidates[id], id)])),
    selectedCandidate: CANDIDATE_IDS.includes(source.selectedCandidate) ? source.selectedCandidate : null,
    qcJson: typeof source.qcJson === 'string' ? source.qcJson : '',
    capture: restoredCapture(source.capture)
  }
}

function schemaError(path, message) {
  throw new Error(`${path}: ${message}`)
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
}

function restoredDimension(value) {
  const source = isRecord(value) ? value : {}
  return {
    score: Number.isInteger(source.score) && source.score >= 0 && source.score <= 100 ? source.score : 0,
    evidence: typeof source.evidence === 'string' ? source.evidence : ''
  }
}

function restoredCandidate(value, id) {
  const source = isRecord(value) ? value : {}
  const dimensions = isRecord(source.dimensions) ? source.dimensions : {}
  return {
    id,
    summary: typeof source.summary === 'string' ? source.summary : '',
    score: Number.isInteger(source.score) && source.score >= 0 && source.score <= 100 ? source.score : 0,
    disposition: DISPOSITIONS.includes(source.disposition) ? source.disposition : 'REJECT',
    evidence: Array.isArray(source.evidence)
      ? source.evidence.filter(item => typeof item === 'string').slice(0, 20)
      : [],
    repairPrompt: typeof source.repairPrompt === 'string' ? source.repairPrompt : '',
    dimensions: Object.fromEntries(QC_DIMENSIONS.map(key => [key, restoredDimension(dimensions[key])]))
  }
}

function restoredJob(value) {
  const source = isRecord(value) ? value : {}
  return {
    id: typeof source.id === 'string' ? source.id : '',
    state: JOB_STATES.includes(source.state) ? source.state : 'DRAFT',
    brief: typeof source.brief === 'string' ? source.brief : '',
    createdAt: typeof source.createdAt === 'string' ? source.createdAt : '',
    updatedAt: typeof source.updatedAt === 'string' ? source.updatedAt : ''
  }
}

function restoredPanel(value, defaults, legacyUrl = '') {
  const source = isRecord(value) ? value : {}
  return {
    url: typeof source.url === 'string' ? source.url : legacyUrl,
    preset: typeof source.preset === 'string' ? source.preset : defaults.preset,
    width: Number.isFinite(source.width) && source.width >= 240 ? source.width : defaults.width,
    height: Number.isFinite(source.height) && source.height >= 240 ? source.height : defaults.height
  }
}

function restoredEvaluations(value) {
  if (!isRecord(value)) return {}
  return Object.fromEntries(Object.entries(value).flatMap(([profileId, checks]) => {
    if (!isRecord(checks)) return []
    const restoredChecks = Object.fromEntries(Object.entries(checks).flatMap(([checkId, evaluation]) => {
      if (!isRecord(evaluation)) return []
      return [[checkId, {
        status: ['pass', 'fail', 'na', 'pending'].includes(evaluation.status) ? evaluation.status : 'pending',
        note: typeof evaluation.note === 'string' ? evaluation.note : ''
      }]]
    }))
    return [[profileId, restoredChecks]]
  }))
}

function restoredCapture(value) {
  if (!isRecord(value) || !['result', 'reference'].includes(value.panelId)) return null
  if (!Number.isInteger(value.width) || value.width <= 0 || !Number.isInteger(value.height) || value.height <= 0) return null
  return {
    panelId: value.panelId,
    width: value.width,
    height: value.height,
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : '',
    path: typeof value.path === 'string' ? value.path : ''
  }
}

function exactKeys(value, expected, path) {
  if (!isRecord(value)) schemaError(path, 'must be an object')
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    const unknown = actual.filter(key => !wanted.includes(key))
    const missing = wanted.filter(key => !actual.includes(key))
    schemaError(path, [unknown.length ? `unknown fields ${unknown.join(', ')}` : '', missing.length ? `missing fields ${missing.join(', ')}` : ''].filter(Boolean).join('; '))
  }
}

function boundedString(value, path, max, allowEmpty = true) {
  if (typeof value !== 'string') schemaError(path, 'must be a string')
  if (!allowEmpty && !value.trim()) schemaError(path, 'must not be empty')
  if (value.length > max) schemaError(path, `must be at most ${max} characters`)
  return value
}

function boundedScore(value, path) {
  if (!Number.isInteger(value) || value < 0 || value > 100) schemaError(path, 'must be an integer from 0 to 100')
  return value
}

function isoTimestamp(value, path) {
  boundedString(value, path, 64, false)
  if (!Number.isFinite(Date.parse(value))) schemaError(path, 'must be an ISO timestamp')
  return value
}

function validateCandidate(value, path, expectedId) {
  exactKeys(value, ['id', 'summary', 'score', 'disposition', 'evidence', 'repairPrompt', 'dimensions'], path)
  if (value.id !== expectedId) schemaError(`${path}.id`, `must be ${expectedId}`)
  if (!DISPOSITIONS.includes(value.disposition)) schemaError(`${path}.disposition`, `must be one of ${DISPOSITIONS.join(', ')}`)
  if (!Array.isArray(value.evidence) || value.evidence.length > 20) schemaError(`${path}.evidence`, 'must be an array with at most 20 items')
  exactKeys(value.dimensions, QC_DIMENSIONS, `${path}.dimensions`)
  return {
    id: expectedId,
    summary: boundedString(value.summary, `${path}.summary`, 2000),
    score: boundedScore(value.score, `${path}.score`),
    disposition: value.disposition,
    evidence: value.evidence.map((item, index) => boundedString(item, `${path}.evidence[${index}]`, 1000, false)),
    repairPrompt: boundedString(value.repairPrompt, `${path}.repairPrompt`, 4000),
    dimensions: Object.fromEntries(QC_DIMENSIONS.map(key => {
      const dimension = value.dimensions[key]
      exactKeys(dimension, ['score', 'evidence'], `${path}.dimensions.${key}`)
      return [key, {
        score: boundedScore(dimension.score, `${path}.dimensions.${key}.score`),
        evidence: boundedString(dimension.evidence, `${path}.dimensions.${key}.evidence`, 2000)
      }]
    }))
  }
}

function validateQcDocument(input) {
  const text = typeof input === 'string' ? input : JSON.stringify(input)
  if (new TextEncoder().encode(text).byteLength > MAX_QC_JSON_BYTES) schemaError('$', `JSON exceeds ${MAX_QC_JSON_BYTES} bytes`)
  let value
  try { value = typeof input === 'string' ? JSON.parse(input) : input } catch (error) {
    schemaError('$', `malformed JSON (${error instanceof Error ? error.message : String(error)})`)
  }
  exactKeys(value, ['schemaVersion', 'job', 'selectedCandidate', 'candidates', 'generatedAt'], '$')
  if (value.schemaVersion !== QC_DOCUMENT_SCHEMA_VERSION) schemaError('$.schemaVersion', `must be ${QC_DOCUMENT_SCHEMA_VERSION}`)
  exactKeys(value.job, ['id', 'state', 'brief', 'createdAt', 'updatedAt'], '$.job')
  if (!JOB_STATES.includes(value.job.state)) schemaError('$.job.state', `must be one of ${JOB_STATES.join(', ')}`)
  const job = {
    id: boundedString(value.job.id, '$.job.id', 128, false),
    state: value.job.state,
    brief: boundedString(value.job.brief, '$.job.brief', 8000),
    createdAt: isoTimestamp(value.job.createdAt, '$.job.createdAt'),
    updatedAt: isoTimestamp(value.job.updatedAt, '$.job.updatedAt')
  }
  if (value.selectedCandidate !== null && !CANDIDATE_IDS.includes(value.selectedCandidate)) schemaError('$.selectedCandidate', 'must be null or A, B, C, D')
  if (!Array.isArray(value.candidates) || value.candidates.length !== 4) schemaError('$.candidates', 'must contain exactly four candidates')
  return {
    schemaVersion: QC_DOCUMENT_SCHEMA_VERSION,
    job,
    selectedCandidate: value.selectedCandidate,
    candidates: value.candidates.map((candidate, index) => validateCandidate(candidate, `$.candidates[${index}]`, CANDIDATE_IDS[index])),
    generatedAt: isoTimestamp(value.generatedAt, '$.generatedAt')
  }
}

function qcDocumentFromState() {
  return validateQcDocument({
    schemaVersion: QC_DOCUMENT_SCHEMA_VERSION,
    job: state.job,
    selectedCandidate: state.selectedCandidate,
    candidates: CANDIDATE_IDS.map(id => state.candidates[id]),
    generatedAt: new Date().toISOString()
  })
}

// Provider descriptor registry. Midjourney is the first adapter: its QC wire
// format is the frozen schema-v1 document contract (`validateQcDocument`).
// Descriptor dimensions MUST be drawn from the persisted schema-v2 candidate
// dimension vocabulary (`QC_DIMENSIONS`) so structured review state stays
// storable without a persisted-schema bump; `assertProviderRegistry` enforces
// this at module init.
const PROVIDERS = Object.freeze({
  midjourney: Object.freeze({
    id: 'midjourney',
    label: 'Midjourney QC',
    profileId: 'midjourney',
    candidateIds: CANDIDATE_IDS,
    structuredReview: true,
    dimensions: QC_DIMENSIONS,
    dimensionLabels: Object.freeze({
      promptFidelity: 'Prompt fidelity',
      composition: 'Composition',
      identityReferenceFidelity: 'Identity / reference fidelity',
      anatomyGeometry: 'Anatomy & geometry',
      artifacts: 'Artifacts',
      typography: 'Typography',
      colorMaterialFidelity: 'Color & material fidelity',
      productionReadiness: 'Production readiness'
    }),
    chatImageToolNames: Object.freeze(['midjourney']),
    qcDocument: Object.freeze({
      schemaVersion: QC_DOCUMENT_SCHEMA_VERSION,
      maxBytes: MAX_QC_JSON_BYTES,
      validate: validateQcDocument
    }),
    automation: Object.freeze({
      target: 'hermes-internal-browser-pane',
      appScope: 'Hermes',
      partition: 'persist:hermes-browser',
      externalBrowserFallback: 'forbidden',
      unavailableState: 'internal_pane_unavailable'
    })
  }),
  'higgsfield-image': Object.freeze({
    id: 'higgsfield-image',
    label: 'Higgsfield Image QC',
    profileId: 'higgsfield-image',
    candidateIds: CANDIDATE_IDS,
    structuredReview: true,
    dimensions: Object.freeze([
      'promptFidelity',
      'identityReferenceFidelity',
      'anatomyGeometry',
      'artifacts',
      'colorMaterialFidelity',
      'typography',
      'composition'
    ]),
    dimensionLabels: Object.freeze({
      promptFidelity: 'Prompt adherence',
      identityReferenceFidelity: 'Subject / product identity',
      anatomyGeometry: 'Anatomy & geometry',
      artifacts: 'Artifacts & cleanup',
      colorMaterialFidelity: 'Color grade & critical colors',
      typography: 'Text, logo & labels',
      composition: 'Framing & crop'
    }),
    chatImageToolNames: Object.freeze(['higgsfield']),
    qcDocument: null,
    automation: null
  })
})

const PROVIDER_IDS = Object.freeze(Object.keys(PROVIDERS))

function assertProviderRegistry() {
  for (const providerId of PROVIDER_IDS) {
    const provider = PROVIDERS[providerId]
    if (provider.id !== providerId) throw new Error(`Provider ${providerId}: id must match its registry key`)
    if (!QC_PROFILE_IDS.includes(provider.profileId)) throw new Error(`Provider ${providerId}: profileId must be a known QC profile`)
    if (provider.candidateIds !== CANDIDATE_IDS) throw new Error(`Provider ${providerId}: candidateIds must reuse the shared candidate vocabulary`)
    for (const key of provider.dimensions) {
      if (!QC_DIMENSIONS.includes(key)) throw new Error(`Provider ${providerId}: dimension ${key} is not storable in persisted schema v2`)
      if (typeof provider.dimensionLabels[key] !== 'string' || !provider.dimensionLabels[key]) {
        throw new Error(`Provider ${providerId}: dimension ${key} must have a label`)
      }
    }
  }
}
assertProviderRegistry()

function providerForProfile(profileId) {
  for (const providerId of PROVIDER_IDS) {
    if (PROVIDERS[providerId].profileId === profileId) return PROVIDERS[providerId]
  }
  return null
}
// WORKBENCH_CORE_END

function setState(patch) {
  state = { ...state, ...patch }
  pluginContext?.storage.set('workbench.v2', persistedState())
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
  const video = mediaKind(input.src) === 'video' || toolName.includes('generate_video')
  const matches = PROVIDER_IDS
    .map(providerId => PROVIDERS[providerId])
    .filter(provider => provider.chatImageToolNames.some(name => toolName.includes(name)))
  // A provider owning a full QC wire format outranks the video heuristic; other
  // structured providers yield to it (e.g. video-generating tool variants).
  const wireProvider = matches.find(provider => provider.qcDocument)
  if (wireProvider) return wireProvider.profileId
  if (video) return 'higgsfield-video'
  return matches.length ? matches[0].profileId : 'design'
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

function BrowserSurface({ panelId, url }) {
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
      ref: element => {
        if (element) browserWebviews.set(panelId, element)
        else browserWebviews.delete(panelId)
      },
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

function ViewportStage({ panel, panelId }) {
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
      children: jsx(BrowserSurface, { panelId, url: panel.url })
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
      children: jsx(BrowserSurface, { panelId, url: panel.url })
    })
  })
}

function BrowserPanel({ panelId, title }) {
  const workbench = useWorkbench()
  const panel = workbench.browserPanels[panelId] || DEFAULT_BROWSER_PANELS[panelId]
  const [draft, setDraft] = useState(panel.url)
  const [captureStatus, setCaptureStatus] = useState('')
  const viewport = viewportFor(panel)

  useEffect(() => setDraft(panel.url), [panel.url])

  const navigate = () => setBrowserPanel(panelId, { url: normalizeUrl(draft) })
  const setPreset = preset => {
    const dimensions = VIEWPORT_PRESETS[preset] || {}
    setBrowserPanel(panelId, { preset, width: dimensions.width || panel.width, height: dimensions.height || panel.height })
  }
  const capturePng = async () => {
    const browserApi = window.hermesDesktop?.browser
    const guestId = browserWebviews.get(panelId)?.getWebContentsId?.()
    if (!browserApi?.capture || !browserApi?.saveCapture || !Number.isInteger(guestId)) {
      setCaptureStatus('Capture unavailable')
      return
    }
    setCaptureStatus('Capturing…')
    try {
      const capture = await browserApi.capture(guestId)
      if (!capture?.captureId || !Number.isInteger(capture.width) || !Number.isInteger(capture.height)) {
        throw new Error('Host returned an invalid capture')
      }
      const saved = await browserApi.saveCapture(capture.captureId, `${state.job.id || 'midjourney'}-${panelId}.png`)
      setState({
        capture: {
          panelId,
          width: capture.width,
          height: capture.height,
          createdAt: capture.createdAt,
          path: saved?.canceled ? '' : String(saved?.path || '')
        }
      })
      setCaptureStatus(saved?.canceled ? `Captured ${capture.width}×${capture.height} · save cancelled` : `Saved ${capture.width}×${capture.height}`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setCaptureStatus(message)
      host.notify({ kind: 'error', message: `Browser capture failed: ${message}` })
    }
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
            : null,
          jsx(Button, {
            disabled: !panel.url || mediaKind(panel.url) !== 'page' || !window.hermesDesktop?.browser?.capture,
            onClick: capturePng,
            size: 'xs',
            variant: 'outline',
            children: 'Capture PNG'
          })
        ]
      }),
      captureStatus
        ? jsx('div', { style: { color: 'var(--ui-text-tertiary)', fontSize: 10, padding: '0 10px 6px' }, children: captureStatus })
        : null,
      jsx('div', {
        style: { flex: 1, minHeight: 0, overflow: 'hidden' },
        children: jsx(ViewportStage, { panel, panelId })
      })
    ]
  })
}

function automationTarget() {
  for (const providerId of PROVIDER_IDS) {
    if (PROVIDERS[providerId].automation) return PROVIDERS[providerId].automation
  }
  return null
}

function AutomationTargetBadge() {
  const automation = automationTarget()
  const pinned = Boolean(window.hermesDesktop?.browser?.capture)
  if (!automation) return null
  return jsxs('div', {
    'aria-label': 'Automation target',
    role: 'status',
    style: {
      alignItems: 'center',
      color: pinned ? 'var(--ui-text-tertiary)' : 'var(--ui-text-quaternary)',
      display: 'flex',
      fontSize: 10,
      gap: 5,
      padding: '0 12px 8px'
    },
    children: [
      jsx(Codicon, { name: pinned ? 'verified' : 'circle-slash' }),
      jsx('span', {
        children: pinned
          ? `Automation target · ${automation.appScope} internal Browser pane · ${automation.partition}`
          : `Automation target unavailable · iframe fallback — agents stop as ${automation.unavailableState}`
      })
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
      jsx(AutomationTargetBadge, {}),
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

function dispositionVariant(disposition) {
  if (disposition === 'PASS') return 'default'
  if (disposition === 'REJECT') return 'destructive'
  return 'warn'
}

function JobEditor({ workbench }) {
  const updateJob = patch => {
    const now = new Date().toISOString()
    setState({ job: { ...workbench.job, ...patch, createdAt: workbench.job.createdAt || now, updatedAt: now } })
  }
  const transition = nextState => {
    const allowed = JOB_TRANSITIONS[workbench.job.state] || []
    if (!allowed.includes(nextState)) return
    updateJob({ state: nextState })
  }

  return jsxs('div', {
    style: { padding: '10px 12px' },
    children: [
      jsxs('div', {
        style: { alignItems: 'center', display: 'flex', gap: 6 },
        children: [
          jsx(Badge, { variant: ['FAILED', 'CANCELLED'].includes(workbench.job.state) ? 'destructive' : 'muted', children: workbench.job.state }),
          jsx('span', { style: { color: 'var(--ui-text-quaternary)', fontSize: 10 }, children: 'Status only · does not trigger Midjourney actions' })
        ]
      }),
      jsx(Input, {
        'aria-label': 'Midjourney job ID',
        onChange: event => updateJob({ id: event.target.value }),
        placeholder: 'job-id',
        style: { marginTop: 8 },
        value: workbench.job.id
      }),
      jsx(Textarea, {
        'aria-label': 'Midjourney job brief',
        onChange: event => updateJob({ brief: event.target.value }),
        placeholder: 'Normalized image brief',
        style: { marginTop: 8, minHeight: 56 },
        value: workbench.job.brief
      }),
      jsx('div', {
        style: { display: 'flex', flexWrap: 'wrap', gap: 5, marginTop: 8 },
        children: (JOB_TRANSITIONS[workbench.job.state] || []).map(nextState =>
          jsx(Button, { onClick: () => transition(nextState), size: 'xs', variant: 'outline', children: `Mark ${nextState}` }, nextState)
        )
      })
    ]
  })
}

function CandidateCard({ candidate, provider, selected }) {
  const update = patch => setState({ candidates: { ...state.candidates, [candidate.id]: { ...candidate, ...patch } } })
  const updateDimension = (key, patch) => update({
    dimensions: { ...candidate.dimensions, [key]: { ...candidate.dimensions[key], ...patch } }
  })

  return jsxs('div', {
    style: {
      borderBottom: '1px solid var(--ui-stroke-tertiary)',
      boxShadow: selected ? 'inset 3px 0 0 var(--ui-accent)' : 'none',
      padding: '10px 12px'
    },
    children: [
      jsxs('div', {
        style: { alignItems: 'center', display: 'flex', gap: 6 },
        children: [
          jsx('strong', { style: { fontSize: 15 }, children: candidate.id }),
          jsx(Badge, { variant: dispositionVariant(candidate.disposition), children: candidate.disposition }),
          jsx(Badge, { variant: 'muted', children: `${candidate.score}/100` }),
          jsx(Button, {
            onClick: () => setState({ selectedCandidate: candidate.id }),
            size: 'xs',
            style: { marginLeft: 'auto' },
            variant: selected ? 'default' : 'outline',
            children: selected ? 'Selected' : 'Select'
          })
        ]
      }),
      jsx(Textarea, {
        'aria-label': `Candidate ${candidate.id} summary`,
        onChange: event => update({ summary: event.target.value }),
        placeholder: 'Candidate summary',
        style: { marginTop: 8, minHeight: 48 },
        value: candidate.summary
      }),
      jsxs('div', {
        style: { display: 'grid', gap: 6, gridTemplateColumns: '80px minmax(0, 1fr)', marginTop: 6 },
        children: [
          jsx(Input, {
            'aria-label': `Candidate ${candidate.id} score`,
            max: 100,
            min: 0,
            onChange: event => update({ score: Math.max(0, Math.min(100, Number(event.target.value) || 0)) }),
            type: 'number',
            value: candidate.score
          }),
          jsx('select', {
            'aria-label': `Candidate ${candidate.id} disposition`,
            onChange: event => update({ disposition: event.target.value }),
            style: {
              background: 'var(--ui-surface-secondary)', border: '1px solid var(--ui-stroke-secondary)',
              borderRadius: 5, color: 'var(--ui-text-primary)', padding: '0 6px'
            },
            value: candidate.disposition,
            children: DISPOSITIONS.map(value => jsx('option', { value, children: value }, value))
          })
        ]
      }),
      jsx(Textarea, {
        'aria-label': `Candidate ${candidate.id} evidence`,
        onChange: event => update({ evidence: event.target.value.split('\n').map(item => item.trim()).filter(Boolean).slice(0, 20) }),
        placeholder: 'Evidence · one item per line',
        style: { marginTop: 6, minHeight: 48 },
        value: candidate.evidence.join('\n')
      }),
      jsx(Textarea, {
        'aria-label': `Candidate ${candidate.id} repair prompt`,
        onChange: event => update({ repairPrompt: event.target.value }),
        placeholder: 'Repair prompt when disposition is REPAIR',
        style: { marginTop: 6, minHeight: 48 },
        value: candidate.repairPrompt
      }),
      jsx('div', {
        style: { display: 'grid', gap: 6, marginTop: 8 },
        children: provider.dimensions.map(key => {
          const label = provider.dimensionLabels[key]
          const dimension = candidate.dimensions[key] || { score: 0, evidence: '' }
          return jsxs('div', {
            style: { alignItems: 'center', display: 'grid', gap: 6, gridTemplateColumns: 'minmax(0, 1fr) 62px' },
            children: [
              jsx(Input, {
                'aria-label': `Candidate ${candidate.id} ${label} evidence`,
                onChange: event => updateDimension(key, { evidence: event.target.value }),
                placeholder: `${label} evidence`,
                value: dimension.evidence
              }),
              jsx(Input, {
                'aria-label': `Candidate ${candidate.id} ${label} score`,
                max: 100,
                min: 0,
                onChange: event => updateDimension(key, { score: Math.max(0, Math.min(100, Number(event.target.value) || 0)) }),
                type: 'number',
                value: dimension.score
              })
            ]
          }, key)
        })
      })
    ]
  })
}

function StructuredReviewPane({ provider, workbench }) {
  const [draft, setDraft] = useState(workbench.qcJson || '')
  const [importError, setImportError] = useState('')
  useEffect(() => setDraft(workbench.qcJson || ''), [workbench.qcJson])
  const wire = provider.qcDocument

  const importQc = () => {
    try {
      const document = wire.validate(draft)
      const formatted = JSON.stringify(document, null, 2)
      setState({
        job: document.job,
        candidates: Object.fromEntries(document.candidates.map(candidate => [candidate.id, candidate])),
        selectedCandidate: document.selectedCandidate,
        qcJson: formatted,
        qcProfile: provider.profileId
      })
      setDraft(formatted)
      setImportError('')
      host.notify({ kind: 'success', message: `Imported ${provider.label} for ${document.job.id}` })
    } catch (error) {
      setImportError(error instanceof Error ? error.message : String(error))
    }
  }
  const exportQc = async () => {
    try {
      const formatted = JSON.stringify(qcDocumentFromState(), null, 2)
      setState({ qcJson: formatted })
      setDraft(formatted)
      setImportError('')
      if (typeof navigator.clipboard?.writeText !== 'function') {
        host.notify({ kind: 'success', message: 'QC JSON exported · clipboard unavailable' })
        return
      }
      try {
        await navigator.clipboard.writeText(formatted)
        host.notify({ kind: 'success', message: 'QC JSON exported and copied' })
      } catch (clipboardError) {
        const message = clipboardError instanceof Error ? clipboardError.message : String(clipboardError)
        host.notify({ kind: 'warning', message: `QC JSON exported · clipboard copy failed: ${message}` })
      }
    } catch (error) {
      setImportError(error instanceof Error ? error.message : String(error))
    }
  }

  return jsxs('div', {
    style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 },
    children: [
      jsx(PanelIntro, { title: provider.label, description: QC_PROFILES[provider.profileId].description }),
      jsx('div', { style: { padding: '0 12px 8px' }, children: jsx(ProfileSelect, { value: workbench.qcProfile }) }),
      jsx(Separator, {}),
      jsx(ScrollArea, {
        style: { flex: 1, minHeight: 0 },
        children: jsxs('div', {
          children: [
            wire ? jsx(JobEditor, { workbench }) : null,
            wire ? jsx(Separator, {}) : null,
            wire
              ? jsxs('div', {
                  style: { padding: '10px 12px' },
                  children: [
                    jsx(Textarea, {
                      'aria-label': `${provider.label} JSON`,
                      onChange: event => setDraft(event.target.value),
                      placeholder: `Paste strict schema-version ${wire.schemaVersion} QC JSON`,
                      style: { minHeight: 120 },
                      value: draft
                    }),
                    importError
                      ? jsx('div', { role: 'alert', style: { color: 'var(--ui-danger, #f87171)', fontSize: 10, marginTop: 6 }, children: importError })
                      : null,
                    jsxs('div', {
                      style: { display: 'flex', gap: 6, marginTop: 8 },
                      children: [
                        jsx(Button, { onClick: importQc, size: 'xs', children: 'Import QC JSON' }),
                        jsx(Button, { onClick: exportQc, size: 'xs', variant: 'outline', children: 'Export QC JSON' })
                      ]
                    })
                  ]
                })
              : null,
            workbench.capture
              ? jsx('div', {
                  style: { color: 'var(--ui-text-tertiary)', fontSize: 10, padding: '0 12px 10px' },
                  children: `Capture ${workbench.capture.width}×${workbench.capture.height}${workbench.capture.path ? ` · ${workbench.capture.path}` : ''}`
                })
              : null,
            ...provider.candidateIds.map(id => jsx(CandidateCard, {
              candidate: workbench.candidates[id],
              provider,
              selected: workbench.selectedCandidate === id
            }, id))
          ]
        })
      })
    ]
  })
}

function QcPane() {
  const workbench = useWorkbench()
  const provider = providerForProfile(workbench.qcProfile)
  if (provider?.structuredReview) return jsx(StructuredReviewPane, { provider, workbench })
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
        children: profile.checks.map(([id, label]) => jsx(CheckRow, { checkId: id, label, profileId: workbench.qcProfile }, id))
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
    const savedV2 = ctx.storage.get('workbench.v2', null)
    const savedV1 = ctx.storage.get('workbench.v1', DEFAULT_STATE)
    state = restoredState(savedV2 || savedV1)
    if (!savedV2) ctx.storage.set('workbench.v2', persistedState())

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
