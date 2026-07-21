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

const PLUGIN_ID = 'renderline'
const PLUGIN_VERSION = '0.7.2'
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
  'imggen2-image': {
    label: 'Native Image QC',
    description: 'Prompt fidelity, subject or product accuracy, geometry, artifacts, critical color, text, and framing for direct-native outputs.',
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
  'imggen2-video': {
    label: 'Native Video QC',
    description: 'Prompt fidelity, identity continuity, motion, camera, temporal consistency, audio, artifacts, and framing for direct-native outputs.',
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
const PERSISTED_SCHEMA_VERSION = 7
const QC_DOCUMENT_SCHEMA_VERSION = 1
const MAX_QC_JSON_BYTES = 64 * 1024
const CANDIDATE_IDS = ['A', 'B', 'C', 'D']
const DISPOSITIONS = ['PASS', 'REPAIR', 'REJECT']
const QC_PROFILE_IDS = ['design', 'higgsfield-image', 'imggen2-image', 'higgsfield-video', 'imggen2-video', 'midjourney']
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

function createId(prefix) {
  return `${prefix}${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6).padEnd(4, '0')}`
}

function validId(value, prefix) {
  return typeof value === 'string' && value.length <= 64 && new RegExp(`^${prefix}[0-9a-z]+-[0-9a-z]{4,}$`).test(value)
}

function mediaKind(url) {
  const path = String(url || '').split(/[?#]/, 1)[0].toLowerCase()
  if (/\.(png|jpe?g|webp|gif|avif|bmp|svg)$/.test(path) || /^data:image\//i.test(url)) return 'image'
  if (/\.(mp4|mov|webm|mkv|avi)$/.test(path)) return 'video'
  return 'page'
}

function viewportFor(panel) {
  const preset = {
    desktop: [1440, 900], laptop: [1280, 800], tablet: [768, 1024], mobile: [390, 844]
  }[panel.preset]
  return {
    preset: panel.preset,
    width: Math.max(240, Number(preset?.[0] || panel.width) || 1440),
    height: Math.max(240, Number(preset?.[1] || panel.height) || 900),
    responsive: panel.preset === 'responsive'
  }
}
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
  result: {
    url: '', targetId: createId('t'), preset: 'desktop', width: 1440, height: 900, displayMode: 'fit', qcProfileHint: '',
    providerEvidence: null, inspection: null
  },
  reference: {
    url: '', targetId: createId('t'), preset: 'mobile', width: 390, height: 844, displayMode: 'fit', qcProfileHint: '',
    providerEvidence: null, inspection: null
  }
}

const DEFAULT_STATE = {
  schemaVersion: PERSISTED_SCHEMA_VERSION,
  browserSplit: false,
  browserPanels: DEFAULT_BROWSER_PANELS,
  qcTargetPanelId: 'result',
  reviewContext: null,
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
const browserMediaElements = new Map()
const browserWebviewSyncInstalled = new WeakSet()
const browserViewportTasks = new Map()

function persistedState() {
  const persisted = {
    schemaVersion: PERSISTED_SCHEMA_VERSION,
    browserSplit: state.browserSplit,
    browserPanels: state.browserPanels,
    qcTargetPanelId: state.qcTargetPanelId,
    reviewContext: state.reviewContext,
    qcProfile: state.qcProfile,
    evaluations: state.evaluations,
    job: state.job,
    candidates: state.candidates,
    selectedCandidate: state.selectedCandidate,
    qcJson: state.qcJson,
    capture: state.capture?.path ? state.capture : null
  }
  return { ...restoredState(persisted), capture: persisted.capture ? restoredCapture(persisted.capture) : null }
}

function restoredState(saved) {
  const source = isRecord(saved) ? saved : {}
  const legacyUrl = typeof source.browserUrl === 'string' ? source.browserUrl : ''
  const savedCandidates = isRecord(source.candidates) ? source.candidates : {}
  const browserPanels = {
    result: restoredPanel(source.browserPanels?.result, DEFAULT_BROWSER_PANELS.result, legacyUrl),
    reference: restoredPanel(source.browserPanels?.reference, DEFAULT_BROWSER_PANELS.reference)
  }
  const reviewContext = restoredReviewContext(source.reviewContext, browserPanels, Number(source.schemaVersion) < 6)
  const restored = {
    ...DEFAULT_STATE,
    schemaVersion: PERSISTED_SCHEMA_VERSION,
    browserSplit: source.browserSplit === true,
    browserPanels,
    qcTargetPanelId: ['result', 'reference'].includes(source.qcTargetPanelId) ? source.qcTargetPanelId : 'result',
    reviewContext,
    qcProfile: QC_PROFILE_IDS.includes(source.qcProfile) ? source.qcProfile : DEFAULT_STATE.qcProfile,
    evaluations: restoredEvaluations(source.evaluations),
    job: restoredJob(source.job),
    candidates: Object.fromEntries(CANDIDATE_IDS.map(id => [id, restoredCandidate(savedCandidates[id], id)])),
    selectedCandidate: CANDIDATE_IDS.includes(source.selectedCandidate) ? source.selectedCandidate : null,
    qcJson: typeof source.qcJson === 'string' ? source.qcJson : '',
    capture: restoredCapture(source.capture)
  }
  if (!restored.capture && Number(source.schemaVersion) < 6 && isRecord(source.capture)) {
    const panel = browserPanels[source.capture.panelId]
    if (panel && source.capture.url === panel.url) {
      restored.capture = restoredCapture({ ...source.capture, targetId: panel.targetId })
    }
  }
  if (restored.capture) {
    const panel = browserPanels[restored.capture.panelId]
    if (!panel || restored.capture.targetId !== panel.targetId || restored.capture.url !== panel.url) restored.capture = null
  }
  if (!reviewContext && source.reviewContext) {
    restored.evaluations = {}
    restored.job = blankJob()
    restored.candidates = blankCandidates()
    restored.selectedCandidate = null
    restored.qcJson = ''
  }
  return restored
}

function schemaError(path, message) {
  throw new Error(`${path}: ${message}`)
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
}

function boundedMetadataString(value, max = 4000) {
  return typeof value === 'string' ? value.slice(0, max) : ''
}
const URL_SECRET_PARAM = /token|sig|signature|expires|apikey|accesskey|keypair|auth|secret|credential|session|cookie|password|(?:^|[^a-z])key(?:$|[^a-z])/i

function sanitizeUrl(value) {
  const raw = boundedMetadataString(value, 4096)
  if (!raw) return ''
  try {
    const url = new URL(raw)
    for (const key of [...url.searchParams.keys()]) {
      const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '')
      if (URL_SECRET_PARAM.test(normalized)) url.searchParams.delete(key)
    }
    if (['http:', 'https:'].includes(url.protocol)) {
      const path = url.pathname === '/' ? '' : url.pathname
      const base = `${url.protocol}//${url.hostname}${path}`
      return url.searchParams.size ? `${base}?${url.searchParams}` : base
    }
    if (!['file:', 'data:'].includes(url.protocol)) return ''
    url.username = ''
    url.password = ''
    url.hash = ''
    return url.toString()
  } catch {
    return ''
  }
}

// Mandatory gate for any future Higgsfield provider invocation.
async function invokeHiggsfieldReadOnly(toolName, invoke, ...args) {
  const operation = String(toolName || '').toLowerCase().replace(/^.*__/, '')
  if (!['show_generations', 'job_status', 'get_generation', 'get_job', 'inspect', 'status'].includes(operation)) {
    throw new Error(`Higgsfield operation ${operation || 'unknown'} is read-only only`)
  }
  return invoke(toolName, ...args)
}

function parsedRecord(value) {
  if (isRecord(value)) return value
  if (typeof value !== 'string' || !value.trim()) return null
  try {
    const parsed = JSON.parse(value)
    return isRecord(parsed) || Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

function providerRecords(value, depth = 0, seen = new Set()) {
  if (depth > 4 || value === null || value === undefined) return []
  if (typeof value === 'string') {
    const parsed = parsedRecord(value)
    return parsed ? providerRecords(parsed, depth + 1, seen) : []
  }
  if (Array.isArray(value)) return value.flatMap(item => providerRecords(item, depth + 1, seen))
  if (!isRecord(value) || seen.has(value)) return []
  seen.add(value)
  const looksLikeGeneration = Boolean(
    value.id || value.jobId || value.job_id || value.model || value.params || value.status || value.type
  )
  const nested = ['structuredContent', 'raw_data', 'result', 'data', 'items', 'generations', 'jobs']
    .flatMap(key => providerRecords(value[key], depth + 1, seen))
  return looksLikeGeneration ? [value, ...nested] : nested
}

function resultUrls(record) {
  const urls = []
  const add = value => {
    if (typeof value === 'string' && /^(?:https?|file|data):/i.test(value)) urls.push(value)
  }
  add(record.url)
  add(record.resultUrl)
  add(record.result_url)
  add(record.min_result_url)
  const results = isRecord(record.results) ? record.results : {}
  add(results.rawUrl)
  add(results.minUrl)
  add(results.url)
  if (Array.isArray(record.outputs)) record.outputs.forEach(output => isRecord(output) && add(output.url))
  return [...new Set(urls)]
}

function comparableUrl(value) {
  return String(value || '').split(/[?#]/, 1)[0]
}

function restoredProviderEvidence(value) {
  if (!isRecord(value)) return null
  if (value.source === 'midjourney') {
    const jobId = boundedMetadataString(value.jobId, 128).toLowerCase()
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(jobId)) return null
    return {
      source: 'midjourney', jobId, operationId: boundedMetadataString(value.operationId, 128),
      resultUrl: sanitizeUrl(value.resultUrl)
    }
  }
  if (value.source === 'imggen2-native') {
    const mediaType = ['image', 'video'].includes(value.mediaType) ? value.mediaType : ''
    const artifactId = boundedMetadataString(value.artifactId, 128) || boundedMetadataString(value.jobId, 128)
    const provider = boundedMetadataString(value.provider, 128)
    const model = boundedMetadataString(value.model, 128)
    if (!mediaType || !artifactId || !provider || !model) return null
    return {
      source: 'imggen2-native', jobId: artifactId, provider, status: 'materialized', model, mediaType,
      prompt: boundedMetadataString(value.promptDigest, 128) || boundedMetadataString(value.prompt, 128),
      resultUrl: sanitizeUrl(value.resultUrl),
      referenceCount: Number.isInteger(value.referenceCount) && value.referenceCount >= 0 ? Math.min(value.referenceCount, 20) : 0,
      checkedAt: boundedMetadataString(value.checkedAt, 64)
    }
  }
  if (!['higgsfield-mcp', 'higgsfield-web'].includes(value.source)) return null
  const width = Number.isFinite(value.width) && value.width > 0 ? Math.round(value.width) : 0
  const height = Number.isFinite(value.height) && value.height > 0 ? Math.round(value.height) : 0
  const duration = Number.isFinite(value.duration) && value.duration > 0 ? value.duration : 0
  const count = Number.isInteger(value.count) && value.count > 0 ? Math.min(value.count, 20) : 1
  const referenceCount = Number.isInteger(value.referenceCount) && value.referenceCount >= 0 ? Math.min(value.referenceCount, 20) : 0
  return {
    source: value.source,
    jobId: boundedMetadataString(value.jobId, 128),
    status: boundedMetadataString(value.status, 64),
    model: boundedMetadataString(value.model, 128),
    soulId: boundedMetadataString(value.soulId, 128),
    mediaType: ['image', 'video', 'audio', '3d'].includes(value.mediaType) ? value.mediaType : '',
    prompt: boundedMetadataString(value.prompt),
    width,
    height,
    duration,
    aspectRatio: boundedMetadataString(value.aspectRatio, 32),
    resolution: boundedMetadataString(value.resolution, 32),
    count,
    referenceCount,
    resultUrl: sanitizeUrl(value.resultUrl),
    createdAt: typeof value.createdAt === 'string' || Number.isFinite(value.createdAt) ? value.createdAt : '',
    checkedAt: boundedMetadataString(value.checkedAt, 64)
  }
}
function providerEvidenceIdentity(evidence) {
  return evidence ? [
    evidence.source, evidence.jobId, evidence.resultUrl, evidence.model,
    evidence.status, evidence.aspectRatio
  ].join('|') : ''
}
function midjourneyJobLocation(rawUrl) {
  try {
    const url = new URL(String(rawUrl || ''))
    const match = url.protocol === 'https:' && !url.username && !url.password && url.port === '' &&
      /^(?:www\.)?midjourney\.com$/.test(url.hostname.toLowerCase()) &&
      url.pathname.match(/^\/jobs\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i)
    const candidateIndex = match && url.search === '' && url.hash === ''
      ? -1
      : match && url.hash === '' && /^index=[0-3]$/.test(url.search.slice(1)) ? Number(url.search.slice(-1)) : null
    return { jobId: match?.[1]?.toLowerCase() || '', candidateIndex }
  } catch { return { jobId: '', candidateIndex: null } }
}
function midjourneyProviderEvidenceForUrl(rawUrl) {
  const location = midjourneyJobLocation(rawUrl)
  return location.jobId && location.candidateIndex !== null
    ? restoredProviderEvidence({ source: 'midjourney', jobId: location.jobId, resultUrl: String(rawUrl) })
    : null
}
function sameMidjourneyCandidateSwitch(previousUrl, nextUrl, linkedJobId) {
  const previous = midjourneyJobLocation(previousUrl)
  const next = midjourneyJobLocation(nextUrl)
  return Boolean(linkedJobId && previous.jobId === String(linkedJobId).toLowerCase() &&
    next.jobId === previous.jobId && previous.candidateIndex !== null &&
    Number.isInteger(next.candidateIndex) && next.candidateIndex >= 0 && previous.candidateIndex !== next.candidateIndex)
}

function providerEvidenceFor(input = {}) {
  const toolName = String(input.toolName || '').toLowerCase()
  if (!toolName.includes('higgsfield')) return null
  const records = providerRecords(input.toolResult)
  const src = String(input.src || '')
  const matching = records.filter(record => resultUrls(record).some(url => url === src))
  if (matching.length !== 1) return null
  const record = matching[0]
  const params = isRecord(record.params) ? record.params : {}
  const mediaType = ['image', 'video', 'audio', '3d'].includes(record.type)
    ? record.type
    : /\.(mp4|mov|webm|mkv|avi)(?:[?#]|$)/i.test(src) ? 'video' : 'image'
  return restoredProviderEvidence({
    source: 'higgsfield-mcp',
    jobId: record.id || record.jobId || record.job_id || '',
    status: record.status || '',
    model: record.model || record.job_set_type || params.model || '',
    soulId: params.custom_reference_id || '',
    mediaType,
    prompt: params.prompt || record.prompt || '',
    width: params.width || record.width || 0,
    height: params.height || record.height || 0,
    duration: params.duration || record.duration || 0,
    aspectRatio: params.aspect_ratio || record.aspect_ratio || '',
    resolution: params.resolution || record.resolution || '',
    count: params.batch_size || params.count || record.count || 1,
    referenceCount: Array.isArray(params.medias) ? params.medias.length : 0,
    resultUrl: src,
    createdAt: record.createdAt || record.created_at || '',
    checkedAt: new Date().toISOString()
  })
}

function restoredInspection(value) {
  if (!isRecord(value)) return null
  return {
    url: sanitizeUrl(value.url),
    summary: boundedMetadataString(value.summary, 1000),
    checkedAt: boundedMetadataString(value.checkedAt, 64)
  }
}

function restoredReviewContext(value, panels, allowLegacy = false) {
  if (!isRecord(value) || !QC_PROFILE_IDS.includes(value.profileId) || !['result', 'reference'].includes(value.panelId)) return null
  const panel = panels[value.panelId]
  const legacy = !Object.hasOwn(value, 'contextId')
  if (legacy) {
    const url = sanitizeUrl(value.url)
    if (!allowLegacy || !url || !panel?.url || url !== panel.url) return null
    return {
      contextId: createId('c'), panelId: value.panelId, targetId: panel.targetId, profileId: value.profileId,
      url, mediaKind: mediaKind(url), viewport: viewportFor(panel),
      providerEvidence: restoredProviderEvidence(panel.providerEvidence), linkedAt: new Date().toISOString(), stale: false, staleReason: ''
    }
  }
  if (!validId(value.contextId, 'c') || !validId(value.targetId, 't') || (!value.stale && !panel?.url) ||
      !['image', 'video', 'page'].includes(value.mediaKind) || !isRecord(value.viewport) ||
      typeof value.stale !== 'boolean' || !['', 'url-changed', 'viewport-changed', 'panels-swapped', 'provenance-changed', 'load-failed'].includes(value.staleReason) ||
      typeof value.linkedAt !== 'string' || value.linkedAt.length > 64) return null
  const url = sanitizeUrl(value.url)
  const viewport = value.viewport
  if (!url || !Number.isFinite(viewport.width) || viewport.width < 240 || !Number.isFinite(viewport.height) ||
      viewport.height < 240 || typeof viewport.preset !== 'string' || typeof viewport.responsive !== 'boolean') return null
  const providerEvidence = restoredProviderEvidence(value.providerEvidence)
  if (!value.stale && (value.targetId !== panel.targetId || url !== panel.url || value.mediaKind !== mediaKind(panel.url) ||
      providerEvidenceIdentity(providerEvidence) !== providerEvidenceIdentity(panel.providerEvidence) ||
      (value.mediaKind === 'page' && JSON.stringify({
        preset: viewport.preset, width: Math.round(viewport.width), height: Math.round(viewport.height), responsive: viewport.responsive
      }) !== JSON.stringify(viewportFor(panel))))) return null
  return {
    contextId: value.contextId, panelId: value.panelId, targetId: value.targetId, profileId: value.profileId,
    url, mediaKind: value.mediaKind,
    viewport: { preset: viewport.preset, width: Math.round(viewport.width), height: Math.round(viewport.height), responsive: viewport.responsive },
    providerEvidence, linkedAt: value.linkedAt,
    stale: value.stale, staleReason: value.staleReason
  }
}

function reviewContextMatches(current, profileId) {
  const panelId = current.qcTargetPanelId || 'result'
  const panel = current.browserPanels[panelId]
  const context = current.reviewContext
  return Boolean(panel?.url && context && !context.stale && context.profileId === profileId &&
    context.panelId === panelId && context.targetId === panel.targetId)
}

function panelLinkedToQc(current, panelId) {
  const panel = current.browserPanels[panelId]
  const context = current.reviewContext
  return Boolean(panel?.url && context && !context.stale && current.qcTargetPanelId === panelId &&
    context.panelId === panelId && context.targetId === panel.targetId && context.profileId === current.qcProfile)
}
function updatePanelState(current, panelId, patch, options = {}, makeId = createId) {
  const panel = current.browserPanels[panelId]
  if (!panel) return current
  const { preserveQcProfileHint = false, preserveProviderEvidence = false, preserveMidjourneyCandidate = false } = options
  const urlChanged = Object.hasOwn(patch, 'url') && patch.url !== panel.url
  const nextUrl = Object.hasOwn(patch, 'url') ? sanitizeUrl(patch.url) : panel.url
  const viewportChanged = ['preset', 'width', 'height'].some(key => Object.hasOwn(patch, key) && patch[key] !== panel[key])
  const provenanceChanged = Object.hasOwn(patch, 'providerEvidence') &&
    providerEvidenceIdentity(patch.providerEvidence) !== providerEvidenceIdentity(panel.providerEvidence)
  const candidateSwitch = urlChanged && preserveMidjourneyCandidate
  const targetChanged = !candidateSwitch && (urlChanged || (viewportChanged && mediaKind(nextUrl) === 'page') || provenanceChanged)
  const staleReason = urlChanged ? 'url-changed' : viewportChanged ? 'viewport-changed' : 'provenance-changed'
  const nextPanel = {
    ...panel, ...patch,
    ...(Object.hasOwn(patch, 'url') ? { url: nextUrl } : {}),
    ...(Object.hasOwn(patch, 'providerEvidence') ? { providerEvidence: restoredProviderEvidence(patch.providerEvidence) } : {}),
    ...(targetChanged ? { targetId: makeId('t'), inspection: null } : {}),
    ...(urlChanged && !preserveQcProfileHint && !Object.hasOwn(patch, 'qcProfileHint') ? { qcProfileHint: '' } : {}),
    ...(urlChanged && !preserveProviderEvidence && !Object.hasOwn(patch, 'providerEvidence') ? { providerEvidence: null } : {})
  }
  const context = current.reviewContext
  const reviewContext = candidateSwitch && context?.panelId === panelId && context.targetId === panel.targetId && !context.stale
    ? { ...context, url: nextUrl, mediaKind: mediaKind(nextUrl), viewport: viewportFor(nextPanel), linkedAt: new Date().toISOString() }
    : targetChanged && context?.panelId === panelId && context.targetId === panel.targetId
      ? { ...context, stale: true, staleReason }
      : context
  return {
    ...current,
    browserPanels: { ...current.browserPanels, [panelId]: nextPanel },
    reviewContext,
    ...((targetChanged || candidateSwitch) && current.capture?.panelId === panelId ? { capture: null } : {})
  }
}

function linkPanelState(current, panelId, input = {}, makeId = createId) {
  const panel = current.browserPanels[panelId]
  if (!panel?.url) return current
  const profileId = QC_PROFILE_IDS.includes(input.profileId)
    ? input.profileId
    : QC_PROFILE_IDS.includes(panel.qcProfileHint) ? panel.qcProfileHint : 'design'
  const inferredProviderEvidence = profileId === 'midjourney' ? midjourneyProviderEvidenceForUrl(panel.url) : null
  const providerEvidence = profileId === 'midjourney' ? inferredProviderEvidence : restoredProviderEvidence(panel.providerEvidence)
  const nextPanel = profileId === 'midjourney' && providerEvidenceIdentity(providerEvidence) !== providerEvidenceIdentity(panel.providerEvidence)
    ? { ...panel, providerEvidence }
    : panel
  const previous = current.reviewContext
  const same = previous && !previous.stale && previous.panelId === panelId &&
    previous.targetId === panel.targetId && previous.profileId === profileId &&
    providerEvidenceIdentity(previous.providerEvidence) === providerEvidenceIdentity(providerEvidence)
  const reviewContext = same ? previous : {
    contextId: input.contextId || makeId('c'), panelId, targetId: panel.targetId, profileId, url: panel.url,
    mediaKind: mediaKind(panel.url), viewport: viewportFor(nextPanel),
    providerEvidence, linkedAt: input.linkedAt || new Date().toISOString(),
    stale: false, staleReason: ''
  }
  return {
    ...current,
    browserPanels: nextPanel === panel ? current.browserPanels : { ...current.browserPanels, [panelId]: nextPanel },
    browserSplit: panelId === 'reference' ? true : current.browserSplit,
    qcProfile: profileId, qcTargetPanelId: panelId, reviewContext,
    ...(same ? {} : {
      evaluations: {}, job: blankJob(), candidates: blankCandidates(), selectedCandidate: null, qcJson: '',
      ...(current.capture?.targetId !== panel.targetId ? { capture: null } : {})
    })
  }
}

function swapPanelsState(current, makeId = createId) {
  const result = current.browserPanels.result
  const reference = current.browserPanels.reference
  if (!result || !reference) return current
  const context = current.reviewContext
  return {
    ...current,
    browserPanels: {
      ...current.browserPanels,
      result: { ...reference, targetId: makeId('t'), inspection: null },
      reference: { ...result, targetId: makeId('t'), inspection: null }
    },
    reviewContext: context && !context.stale && ['result', 'reference'].includes(context.panelId)
      ? { ...context, stale: true, staleReason: 'panels-swapped' }
      : context,
    capture: null
  }
}

function markPanelLoadFailedState(current, panelId) {
  const panel = current.browserPanels[panelId]
  const context = current.reviewContext
  if (!panel || !context || context.stale || context.panelId !== panelId || context.targetId !== panel.targetId) return current
  return {
    ...current,
    reviewContext: { ...context, stale: true, staleReason: 'load-failed' },
    ...(current.capture?.panelId === panelId ? { capture: null } : {})
  }
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
    url: sanitizeUrl(typeof source.url === 'string' ? source.url : legacyUrl),
    targetId: validId(source.targetId, 't') ? source.targetId : createId('t'),
    preset: typeof source.preset === 'string' ? source.preset : defaults.preset,
    width: Number.isFinite(source.width) && source.width >= 240 ? source.width : defaults.width,
    height: Number.isFinite(source.height) && source.height >= 240 ? source.height : defaults.height,
    displayMode: source.displayMode === 'actual' ? 'actual' : 'fit',
    qcProfileHint: QC_PROFILE_IDS.includes(source.qcProfileHint) ? source.qcProfileHint : defaults.qcProfileHint,
    providerEvidence: restoredProviderEvidence(source.providerEvidence),
    inspection: restoredInspection(source.inspection)
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
  if (!isRecord(value) || !['result', 'reference'].includes(value.panelId) || !validId(value.targetId, 't')) return null
  if (!Number.isInteger(value.width) || value.width <= 0 || !Number.isInteger(value.height) || value.height <= 0) return null
  if (typeof value.path !== 'string' || !value.path) return null
  const viewport = isRecord(value.viewport) && Number.isFinite(value.viewport.width) && Number.isFinite(value.viewport.height)
    ? { preset: String(value.viewport.preset || ''), width: Math.round(value.viewport.width), height: Math.round(value.viewport.height), responsive: value.viewport.responsive === true }
    : undefined
  return {
    panelId: value.panelId, targetId: value.targetId, url: sanitizeUrl(value.url),
    width: value.width, height: value.height,
    ...(viewport ? { viewport } : {}),
    createdAt: Number.isFinite(value.createdAt) ? value.createdAt : typeof value.createdAt === 'string' ? value.createdAt : '',
    path: value.path
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
// Descriptor dimensions MUST be drawn from the persisted schema-v7 candidate
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
  }),
  'higgsfield-web': Object.freeze({
    id: 'higgsfield-web',
    label: 'Higgsfield Web — Unlimited',
    profileId: 'higgsfield-image',
    candidateIds: CANDIDATE_IDS,
    structuredReview: true,
    dimensions: Object.freeze(['promptFidelity', 'identityReferenceFidelity', 'anatomyGeometry', 'artifacts', 'colorMaterialFidelity', 'typography', 'composition']),
    dimensionLabels: Object.freeze({
      promptFidelity: 'Prompt adherence',
      identityReferenceFidelity: 'Subject / product identity',
      anatomyGeometry: 'Anatomy & geometry',
      artifacts: 'Artifacts & cleanup',
      colorMaterialFidelity: 'Color grade & critical colors',
      typography: 'Text, logo & labels',
      composition: 'Framing & crop'
    }),
    chatImageToolNames: Object.freeze([]),
    qcDocument: null,
    automation: Object.freeze({
      target: 'hermes-internal-browser-pane',
      recipe: 'higgsfield-web-2026-07-20.v1',
      externalBrowserFallback: 'forbidden'
    })
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
      if (!QC_DIMENSIONS.includes(key)) throw new Error(`Provider ${providerId}: dimension ${key} is not storable in persisted schema v6`)
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

function qcProfileFor(input = {}) {
  const src = String(input.src || '')
  const toolName = String(input.toolName || '').toLowerCase()
  const evidence = restoredProviderEvidence(input.providerEvidence)
  if (evidence?.source === 'imggen2-native') return evidence.mediaType === 'video' ? 'imggen2-video' : 'imggen2-image'
  let hostname = ''
  try { hostname = new URL(src).hostname.toLowerCase() } catch {}
  if (hostname === 'midjourney.com' || hostname.endsWith('.midjourney.com')) return 'midjourney'

  const matches = PROVIDER_IDS
    .map(providerId => PROVIDERS[providerId])
    .filter(provider => provider.chatImageToolNames.some(name => toolName.includes(name)))
  const wireProvider = matches.find(provider => provider.qcDocument)
  if (wireProvider) return wireProvider.profileId
  if (/\.(mp4|mov|webm|mkv|avi)(?:[?#]|$)/i.test(src) || toolName.includes('generate_video')) return 'higgsfield-video'
  return matches.length ? matches[0].profileId : 'design'
}
const AGENT_COMMAND_OPS = ['status', 'set-target', 'link', 'capture', 'inspect', 'page-checks', 'midjourney-probe', 'midjourney-control', 'higgsfield-control', 'set-check', 'score-candidate', 'select-candidate', 'import-qc']
const AGENT_PANEL_IDS = ['result', 'reference']
const AGENT_CHECK_STATUSES = ['pass', 'fail', 'na', 'pending']
const MIDJOURNEY_CONTROL_ACTIONS = ['capabilities', 'state', 'navigate', 'probe', 'results', 'settings', 'draft', 'attach', 'detach', 'validate', 'submit', 'wait', 'link', 'grid', 'action', 'download', 'capture', 'qc']
const HIGGSFIELD_MODELS = ['Seedream 5.0 Lite', 'Nano Banana 2', 'Seedream 4.5']
const HIGGSFIELD_ASPECTS = ['1:1', '9:16', '16:9']
const HIGGSFIELD_GENERATION_STATUSES = ['idle', 'queued', 'generating', 'complete', 'failed', 'unknown']
const HIGGSFIELD_CONTROL_ACTIONS = ['capabilities', 'state', 'navigate', 'draft', 'validate', 'generate', 'results', 'observe', 'link', 'repair', 'qc']

function agentCommandError(message) { return { ok: false, error: message } }
function hasOnlyKeys(value, keys) { return Object.keys(value).every(key => keys.includes(key)) }
function validAgentString(value, max) { return typeof value === 'string' && value.length <= max }
function validateMidjourneyControlPayload(payload) {
  if (!isRecord(payload) || !MIDJOURNEY_CONTROL_ACTIONS.includes(payload.action)) return false
  const common = ['action']
  if (['capabilities', 'state', 'probe', 'results', 'validate', 'grid', 'capture', 'qc'].includes(payload.action)) return hasOnlyKeys(payload, common)
  if (payload.action === 'settings') {
    if (hasOnlyKeys(payload, common)) return true
    if (!hasOnlyKeys(payload, [...common, 'name', 'value']) || !validAgentString(payload.name, 40)) return false
    const choices = {
      aspect: ['portrait', 'square', 'landscape'], model: ['standard', 'hd'], raw: ['standard', 'raw'],
      speed: ['relax', 'fast'], videoResolution: ['sd', 'hd'], personalization: [true, false]
    }
    if (Object.hasOwn(choices, payload.name)) return choices[payload.name].includes(payload.value)
    return false
  }
  if (payload.action === 'download') return hasOnlyKeys(payload, [...common, 'jobId', 'filename']) && validAgentString(payload.jobId, 80) && /^[A-Za-z0-9_-]+$/.test(payload.jobId) && validAgentString(payload.filename, 120) && /^[A-Za-z0-9._-]+\.(?:png|jpe?g|webp|gif|avif|bmp)$/i.test(payload.filename)
  if (payload.action === 'navigate') return hasOnlyKeys(payload, [...common, 'url']) && validAgentString(payload.url, 4096) && /^https:\/\/(?:www\.)?midjourney\.com(?:\/|$)/i.test(payload.url)
  if (payload.action === 'draft') return hasOnlyKeys(payload, [...common, 'prompt', 'parameters']) && validAgentString(payload.prompt, 6000) && payload.prompt.trim().length > 0 && (!Object.hasOwn(payload, 'parameters') || isRecord(payload.parameters))
  if (payload.action === 'attach') return hasOnlyKeys(payload, [...common, 'path', 'role']) && validAgentString(payload.path, 4096) && payload.path.length > 0 && ['start-frame', 'image-prompt', 'style-reference', 'omni-reference'].includes(payload.role)
  if (payload.action === 'detach') return hasOnlyKeys(payload, [...common, 'role']) && ['start-frame', 'image-prompt', 'style-reference', 'omni-reference'].includes(payload.role)
  if (payload.action === 'submit') return hasOnlyKeys(payload, [...common, 'approved', 'idempotencyKey', 'validateReceipt', 'batchFingerprint']) && payload.approved === true && validAgentString(payload.idempotencyKey, 128) && payload.idempotencyKey.length >= 8 && validAgentString(payload.validateReceipt, 80) && payload.validateReceipt.length > 0 && /^[a-f0-9]{64}$/.test(String(payload.batchFingerprint || ''))
  if (payload.action === 'wait') return hasOnlyKeys(payload, [...common, 'timeoutMs']) && (!Object.hasOwn(payload, 'timeoutMs') || Number.isInteger(payload.timeoutMs) && payload.timeoutMs >= 1000 && payload.timeoutMs <= 30000)
  if (payload.action === 'link') return hasOnlyKeys(payload, [...common, 'operationId', 'prompt', 'jobId', 'acknowledged', 'ledgerCreatedAt']) && /^[a-f0-9]{64}$/.test(String(payload.operationId || '')) && validAgentString(payload.prompt, 6000) && payload.prompt.trim().length > 0 && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(payload.jobId || '')) && payload.acknowledged === true && validAgentString(payload.ledgerCreatedAt, 40) && Number.isFinite(Date.parse(payload.ledgerCreatedAt))
  if (payload.action === 'action') {
    const validName = ['select', 'upscale', 'vary', 'reroll', 'pan', 'zoom'].includes(payload.name)
    const validCandidate = !Object.hasOwn(payload, 'candidate') || ['A', 'B', 'C', 'D', '1', '2', '3', '4'].includes(String(payload.candidate))
    const validJob = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(payload.jobId || ''))
    if (payload.name === 'select') return hasOnlyKeys(payload, [...common, 'name', 'candidate', 'jobId']) && validName && Object.hasOwn(payload, 'candidate') && validCandidate && validJob
    return hasOnlyKeys(payload, [...common, 'name', 'candidate', 'jobId', 'approved', 'idempotencyKey']) && validName && validCandidate && validJob && payload.approved === true && validAgentString(payload.idempotencyKey, 128) && payload.idempotencyKey.length >= 8
  }
  return false
}
function validateHiggsfieldControlPayload(payload) {
  if (!isRecord(payload) || !HIGGSFIELD_CONTROL_ACTIONS.includes(payload.action)) return false
  if (['capabilities', 'state', 'validate', 'results', 'observe', 'qc'].includes(payload.action)) return hasOnlyKeys(payload, ['action'])
  if (payload.action === 'navigate') return hasOnlyKeys(payload, ['action', 'url']) && validAgentString(payload.url, 4096) && /^https:\/\/(?:www\.)?higgsfield\.ai(?:\/|$)/i.test(payload.url)
  if (payload.action === 'draft') return hasOnlyKeys(payload, ['action', 'prompt', 'aspect', 'model']) && validAgentString(payload.prompt, 6000) && payload.prompt.trim().length > 0 && HIGGSFIELD_ASPECTS.includes(payload.aspect) && HIGGSFIELD_MODELS.includes(payload.model)
  if (payload.action === 'generate') return hasOnlyKeys(payload, ['action', 'billableConfirmed', 'idempotencyKey', 'validateReceipt', 'batchFingerprint']) && payload.billableConfirmed === true && validAgentString(payload.idempotencyKey, 128) && payload.idempotencyKey.length >= 8 && validAgentString(payload.validateReceipt, 80) && /^[a-f0-9]{64}$/.test(String(payload.batchFingerprint || ''))
  if (payload.action === 'link') return hasOnlyKeys(payload, ['action', 'observationReceipt']) && validAgentString(payload.observationReceipt, 80) && payload.observationReceipt.length > 0
  if (payload.action === 'repair') return hasOnlyKeys(payload, ['action', 'approved']) && payload.approved === true
  return false
}

function validateAgentCommand(value) {
  if (!isRecord(value) || !hasOnlyKeys(value, ['id', 'op', 'panelId', 'payload'])) return agentCommandError('Command must be an object with only id, op, panelId, and payload')
  if (!validAgentString(value.id, 64) || !value.id) return agentCommandError('id must be a non-empty string of at most 64 characters')
  if (!AGENT_COMMAND_OPS.includes(value.op)) return agentCommandError('op is unknown')
  if (!isRecord(value.payload)) return agentCommandError('payload must be an object')
  const needsPanel = ['set-target', 'link', 'capture', 'inspect', 'page-checks', 'midjourney-probe', 'midjourney-control', 'higgsfield-control'].includes(value.op)
  if (needsPanel ? !AGENT_PANEL_IDS.includes(value.panelId) : Object.hasOwn(value, 'panelId')) return agentCommandError(needsPanel ? 'panelId must be result or reference' : 'panelId is not allowed for this op')
  const payload = value.payload
  if (value.op === 'status' && hasOnlyKeys(payload, [])) return { ok: true, command: value }
  if (value.op === 'set-target' && hasOnlyKeys(payload, ['url', 'preset', 'width', 'height', 'providerEvidence']) && validAgentString(payload.url, 4096) && /^(https?|file|data):/i.test(payload.url) && (!Object.hasOwn(payload, 'preset') || validAgentString(payload.preset, 64)) && (!Object.hasOwn(payload, 'width') || Number.isInteger(payload.width) && payload.width >= 240) && (!Object.hasOwn(payload, 'height') || Number.isInteger(payload.height) && payload.height >= 240) && (!Object.hasOwn(payload, 'providerEvidence') || restoredProviderEvidence(payload.providerEvidence)?.source === 'imggen2-native')) return { ok: true, command: value }
  if (value.op === 'link' && hasOnlyKeys(payload, ['profileId']) && (!Object.hasOwn(payload, 'profileId') || QC_PROFILE_IDS.includes(payload.profileId))) return { ok: true, command: value }
  if (['capture', 'inspect', 'page-checks', 'midjourney-probe'].includes(value.op) && hasOnlyKeys(payload, [])) return { ok: true, command: value }
  if (value.op === 'midjourney-control' && validateMidjourneyControlPayload(payload)) return { ok: true, command: value }
  if (value.op === 'higgsfield-control' && validateHiggsfieldControlPayload(payload)) return { ok: true, command: value }
  if (value.op === 'set-check' && hasOnlyKeys(payload, ['profileId', 'checkId', 'status', 'note']) && QC_PROFILE_IDS.includes(payload.profileId) && validAgentString(payload.checkId, 64) && payload.checkId && AGENT_CHECK_STATUSES.includes(payload.status) && (!Object.hasOwn(payload, 'note') || validAgentString(payload.note, 2000))) return { ok: true, command: value }
  if (value.op === 'score-candidate' && hasOnlyKeys(payload, ['candidateId', 'summary', 'score', 'disposition', 'repairPrompt', 'dimensions']) && CANDIDATE_IDS.includes(payload.candidateId) && (!Object.hasOwn(payload, 'summary') || validAgentString(payload.summary, 2000)) && (!Object.hasOwn(payload, 'score') || Number.isInteger(payload.score) && payload.score >= 0 && payload.score <= 100) && (!Object.hasOwn(payload, 'disposition') || DISPOSITIONS.includes(payload.disposition)) && (!Object.hasOwn(payload, 'repairPrompt') || validAgentString(payload.repairPrompt, 4000)) && (!Object.hasOwn(payload, 'dimensions') || isRecord(payload.dimensions) && Object.entries(payload.dimensions).every(([key, dimension]) => QC_DIMENSIONS.includes(key) && isRecord(dimension) && hasOnlyKeys(dimension, ['score', 'evidence']) && Number.isInteger(dimension.score) && dimension.score >= 0 && dimension.score <= 100 && validAgentString(dimension.evidence, 2000)))) return { ok: true, command: value }
  if (value.op === 'select-candidate' && hasOnlyKeys(payload, ['candidateId']) && CANDIDATE_IDS.includes(payload.candidateId)) return { ok: true, command: value }
  if (value.op === 'import-qc' && hasOnlyKeys(payload, ['json']) && validAgentString(payload.json, MAX_QC_JSON_BYTES)) return { ok: true, command: value }
  return agentCommandError(`Invalid payload for ${value.op}`)
}

function agentCandidateReviewed(candidate) {
  return Boolean(candidate?.summary || candidate?.evidence?.length || candidate?.repairPrompt || candidate?.score > 0 ||
    Object.values(candidate?.dimensions || {}).some(dimension => dimension?.score > 0 || dimension?.evidence))
}

function agentStatusSnapshot(current) {
  const context = current.reviewContext
  return {
    qcProfile: current.qcProfile,
    qcTargetPanelId: current.qcTargetPanelId,
    reviewContext: context ? {
      contextId: context.contextId, panelId: context.panelId, targetId: context.targetId, profileId: context.profileId,
      url: sanitizeUrl(context.url), mediaKind: context.mediaKind, stale: context.stale, staleReason: context.staleReason,
      providerJobId: context.providerEvidence?.jobId || ''
    } : null,
    panels: Object.fromEntries(AGENT_PANEL_IDS.map(panelId => {
      const panel = current.browserPanels[panelId] || {}
      return [panelId, { url: sanitizeUrl(panel.url), targetId: panel.targetId || '', mediaKind: mediaKind(panel.url) }]
    })),
    capture: current.capture ? {
      panelId: current.capture.panelId, targetId: current.capture.targetId, url: sanitizeUrl(current.capture.url),
      ...(current.capture.viewport ? { viewport: current.capture.viewport } : {}),
      width: current.capture.width, height: current.capture.height, path: current.capture.path
    } : null,
    evaluations: Object.fromEntries(Object.entries(current.evaluations || {}).map(([profileId, checks]) => [profileId, Object.fromEntries(Object.entries(checks || {}).map(([checkId, evaluation]) => [checkId, { status: evaluation.status }]))])),
    candidates: Object.fromEntries(CANDIDATE_IDS.map(id => {
      const candidate = current.candidates?.[id] || blankCandidate(id)
      return [id, { score: candidate.score, disposition: candidate.disposition, reviewed: agentCandidateReviewed(candidate) }]
    })),
    selectedCandidate: current.selectedCandidate,
    jobState: current.job?.state || 'DRAFT'
  }
}

function applyAgentCommand(current, command, makeId = createId) {
  const guardError = 'Link the target in the Browser pane before editing QC'
  const { op, payload } = command
  if (op === 'status') return { state: current, summary: 'Status snapshot' }
  if (op === 'set-target') {
    const patch = Object.fromEntries(Object.entries(payload).filter(([key]) => ['url', 'preset', 'width', 'height', 'providerEvidence'].includes(key)))
    return { state: updatePanelState(current, command.panelId, patch, {}, makeId), summary: `Set ${command.panelId} target` }
  }
  if (op === 'link') {
    const panel = current.browserPanels[command.panelId]
    const profileId = payload.profileId || (QC_PROFILE_IDS.includes(panel?.qcProfileHint) ? panel.qcProfileHint : qcProfileFor({ src: panel?.url }))
    if (!panel?.url) return { error: `Open a ${command.panelId} target before linking it to Quality Control` }
    return { state: linkPanelState(current, command.panelId, { profileId }, makeId), summary: `Linked ${command.panelId} to ${profileId}` }
  }
  if (op === 'set-check') {
    if (!reviewContextMatches(current, payload.profileId)) return { error: guardError }
    const profile = { ...(current.evaluations[payload.profileId] || {}) }
    profile[payload.checkId] = { ...profile[payload.checkId], status: payload.status, ...(Object.hasOwn(payload, 'note') ? { note: payload.note } : {}) }
    return { state: { ...current, evaluations: { ...current.evaluations, [payload.profileId]: profile } }, summary: `Set ${payload.checkId} to ${payload.status}` }
  }
  if (op === 'score-candidate') {
    if (!reviewContextMatches(current, current.qcProfile)) return { error: guardError }
    const candidate = current.candidates[payload.candidateId]
    const patch = Object.fromEntries(Object.entries(payload).filter(([key]) => ['summary', 'score', 'disposition', 'repairPrompt'].includes(key)))
    if (payload.dimensions) patch.dimensions = { ...candidate.dimensions, ...payload.dimensions }
    return { state: { ...current, candidates: { ...current.candidates, [payload.candidateId]: { ...candidate, ...patch } } }, summary: `Scored candidate ${payload.candidateId}` }
  }
  if (op === 'select-candidate') {
    if (!reviewContextMatches(current, current.qcProfile)) return { error: guardError }
    return { state: { ...current, selectedCandidate: payload.candidateId }, summary: `Selected candidate ${payload.candidateId}` }
  }
  return { error: `${op} is not a pure agent command` }
}
// WORKBENCH_CORE_END

function setState(patch) {
  state = { ...state, ...patch }
  pluginContext?.storage.set('workbench.v7', persistedState())
  listeners.forEach(listener => listener())
}

function setBrowserPanel(panelId, patch, options = {}) {
  setState(updatePanelState(state, panelId, patch, options, createId))
}

function subscribe(listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

const relayedSelectionRequestIds = new Set()
function rememberRelayedSelection(requestId) {
  relayedSelectionRequestIds.add(requestId)
  while (relayedSelectionRequestIds.size > 64) relayedSelectionRequestIds.delete(relayedSelectionRequestIds.values().next().value)
}
async function relayPendingSelection(ctx) {
  let request
  try { request = await ctx.rest('/selection-request') } catch { return }
  if (!isRecord(request) || request.version !== 1 || !validAgentString(request.request_id, 64) || request.request_id === '' ||
      !CANDIDATE_IDS.includes(request.candidate_id) || !Number.isInteger(request.revision) ||
      typeof request.run_id !== 'string' || request.run_id === '' || typeof request.scope !== 'string' || request.scope === '') return
  if (relayedSelectionRequestIds.has(request.request_id)) return
  const ack = async body => {
    try {
      await ctx.rest('/selection-ack', { method: 'POST', body: { version: 1, request_id: request.request_id, ...body } })
      rememberRelayedSelection(request.request_id)
    } catch {}
  }
  const context = state.reviewContext
  const candidate = state.candidates[request.candidate_id]
  const valid = reviewContextMatches(state, state.qcProfile) && candidateHasReview(candidate)
  if (!valid || state.job?.id !== request.run_id) return void await ack({ ok: false, error: 'Desktop review context is absent or stale' })
  if (state.job.state !== 'QC_RUNNING' && state.job.state !== 'GRID_READY') return void await ack({ ok: false, error: 'Desktop review is not selectable' })
  setState({ selectedCandidate: request.candidate_id })
  await ack({ ok: true, candidate_id: request.candidate_id, contextId: context.contextId, revision: request.revision })
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


async function currentBrowserUrl(browserApi, guestId, webview, fallback) {
  const guest = await browserApi.metrics?.(guestId)
  return String(guest?.url || webview?.getURL?.() || fallback)
}

async function captureBrowserPanel(panelId, { save = false } = {}) {
  const panel = state.browserPanels[panelId] || DEFAULT_BROWSER_PANELS[panelId]
  const kind = mediaKind(panel.url)
  const browserApi = window.hermesDesktop?.browser
  const webview = browserWebviews.get(panelId)
  const guestId = webview?.getWebContentsId?.()
  if (!panel.url) {
    throw new Error('Open the linked page in the Browser pane before capturing evidence')
  }

  if (kind === 'image' || kind === 'video') {
    const element = browserMediaElements.get(panelId)
    const currentSrc = String(element?.currentSrc || element?.src || '')
    const ready = kind === 'image'
      ? Boolean(element?.complete && element?.naturalWidth > 0 && element?.naturalHeight > 0)
      : Boolean(element?.readyState >= 2 && element?.videoWidth > 0 && element?.videoHeight > 0)
    if (!element || !ready || comparableUrl(currentSrc) !== comparableUrl(panel.url)) {
      throw new Error('The exact linked media is not ready in the Browser pane')
    }
    const evidence = {
      panelId, targetId: panel.targetId, url: panel.url,
      width: kind === 'image' ? element.naturalWidth : element.videoWidth,
      height: kind === 'image' ? element.naturalHeight : element.videoHeight,
      viewport: viewportFor(panel), createdAt: Date.now(), path: ''
    }
    if (state.browserPanels[panelId]?.targetId !== panel.targetId ||
        JSON.stringify(viewportFor(state.browserPanels[panelId])) !== JSON.stringify(evidence.viewport)) {
      throw new Error('Target changed during capture; evidence was not attached')
    }
    setState({ capture: evidence })
    return { ...evidence, canceled: false }
  }

  if (!browserApi?.capture || !Number.isInteger(guestId)) {
    throw new Error('Open the linked page in the Browser pane before capturing evidence')
  }

  const startTargetId = panel.targetId
  const startUrl = panel.url
  const sourceUrl = await currentBrowserUrl(browserApi, guestId, webview, panel.url)
  if (sourceUrl !== startUrl) {
    throw new Error('Target changed during capture; evidence was not attached')
  }
  const capture = await browserApi.capture(guestId)
  if (!capture?.captureId || !Number.isInteger(capture.width) || !Number.isInteger(capture.height)) {
    throw new Error('Host returned an invalid capture')
  }
  if (state.browserPanels[panelId]?.targetId !== startTargetId ||
      await currentBrowserUrl(browserApi, guestId, webview, startUrl) !== startUrl ||
      JSON.stringify(viewportFor(state.browserPanels[panelId])) !== JSON.stringify(viewportFor(panel))) {
    throw new Error('Target changed during capture; evidence was not attached')
  }

  let path = ''
  let canceled = false
  if (save) {
    if (!browserApi.saveCapture) throw new Error('Capture saving is unavailable')
    const saved = await browserApi.saveCapture(capture.captureId, `${state.job.id || 'visual-qc'}-${panelId}.png`)
    canceled = Boolean(saved?.canceled)
    path = canceled ? '' : String(saved?.path || '')
  }

  if (state.browserPanels[panelId]?.targetId !== startTargetId ||
      await currentBrowserUrl(browserApi, guestId, webview, startUrl) !== startUrl ||
      JSON.stringify(viewportFor(state.browserPanels[panelId])) !== JSON.stringify(viewportFor(panel))) {
    throw new Error('Target changed before evidence was attached')
  }

  const evidence = {
    panelId, targetId: startTargetId, url: startUrl, width: capture.width, height: capture.height,
    viewport: viewportFor(panel), createdAt: capture.createdAt, path
  }
  setState({ capture: evidence })
  return { ...evidence, canceled }
}

async function inspectBrowserPanel(panelId) {
  const browserApi = window.hermesDesktop?.browser
  const webview = browserWebviews.get(panelId)
  const guestId = webview?.getWebContentsId?.()
  const startPanel = state.browserPanels[panelId]
  const startTargetId = startPanel?.targetId
  const startUrl = startPanel?.url
  if (!browserApi?.cdp || !browserApi?.metrics || !Number.isInteger(guestId)) {
    throw new Error('Open the linked page in the Browser pane before inspecting it')
  }
  const [layout, guest] = await Promise.all([
    browserApi.cdp(guestId, 'Page.getLayoutMetrics'),
    browserApi.metrics(guestId)
  ])
  const value = guest?.viewport || {}
  const css = layout?.cssVisualViewport || layout?.visualViewport || {}
  const summary = `CDP CSS ${Math.round(css.clientWidth || value.innerWidth || 0)}×${Math.round(css.clientHeight || value.innerHeight || 0)} · DPR ${value.devicePixelRatio || '?'} · visual ${css.zoom || value.visualViewport?.scale || 1} · guest zoom ${guest?.zoomFactor || '?'}`
  const sourceUrl = String(guest?.url || webview?.getURL?.() || state.browserPanels[panelId]?.url || '')
  const panel = state.browserPanels[panelId]
  if (!panel || panel.targetId !== startTargetId || sourceUrl !== startUrl) {
    throw new Error('Target changed during inspection; results were not attached')
  }
  setState({
    browserPanels: {
      ...state.browserPanels,
      [panelId]: { ...panel, inspection: { url: sourceUrl, summary, checkedAt: new Date().toISOString() } }
    }
  })
  return summary
}

const MIDJOURNEY_SELECTOR_REGISTRY = Object.freeze({
  version: 'mj-web-2026-07-19.v3',
  targets: Object.freeze(['composer', 'settings-toggle', 'personalization-toggle', 'personalization-menu', 'add-images', 'add-start-frame', 'add-style-reference', 'add-omni-reference', 'switch-to-image', 'switch-to-video', 'image-file-input', 'start-frame', 'image-prompt', 'style-reference', 'omni', 'aspect-portrait', 'aspect-square', 'aspect-landscape', 'model-standard', 'model-hd', 'raw-standard', 'raw-on', 'speed-relax', 'speed-fast', 'video-sd', 'video-hd', 'personalization-on', 'personalization-off', 'submit', 'select', 'upscale', 'vary', 'reroll', 'pan', 'zoom', 'result-image', 'result-link'])
})
const HIGGSFIELD_SELECTOR_REGISTRY = Object.freeze({
  version: 'higgsfield-web-2026-07-20.v1',
  targets: Object.freeze(['higgsfield-composer', 'higgsfield-aspect-square', 'higgsfield-aspect-portrait', 'higgsfield-aspect-landscape', 'higgsfield-model-seedream-5-lite', 'higgsfield-model-nano-banana-2', 'higgsfield-model-seedream-4-5', 'higgsfield-generate'])
})
const higgsfieldValidations = new Map()
const higgsfieldObservationReceipts = new Map()
const higgsfieldDrafts = new Map()
const HIGGSFIELD_MODEL_TARGETS = Object.freeze({
  'Seedream 5.0 Lite': 'higgsfield-model-seedream-5-lite',
  'Nano Banana 2': 'higgsfield-model-nano-banana-2',
  'Seedream 4.5': 'higgsfield-model-seedream-4-5'
})
const HIGGSFIELD_ASPECT_TARGETS = Object.freeze({
  '1:1': 'higgsfield-aspect-square', '16:9': 'higgsfield-aspect-landscape', '9:16': 'higgsfield-aspect-portrait'
})
const HIGGSFIELD_OBSERVATION_TTL_MS = 60_000
function redactedHiggsfieldResultUrl(value) {
  try {
    const url = new URL(String(value || ''))
    url.search = ''
    url.hash = ''
    return url.toString()
  } catch { return '' }
}
function observedHiggsfieldState(value, context) {
  if (!isRecord(value) || value.guestWebContentsId !== context.guestId || value.url !== context.url ||
    !HIGGSFIELD_MODELS.includes(value.selectedModel) || !HIGGSFIELD_ASPECTS.includes(value.selectedAspect) ||
    value.unlimited !== true || !HIGGSFIELD_GENERATION_STATUSES.includes(value.generationStatus) || !Array.isArray(value.results)) {
    throw new Error('Higgsfield observation did not satisfy the browser-control contract')
  }
  const results = value.results.map(result => isRecord(result) && typeof result.url === 'string' &&
    typeof result.providerJobId === 'string' && result.url ? { url: result.url, providerJobId: result.providerJobId } : null)
  if (results.some(result => !result) || results.length > 1) throw new Error('Higgsfield observation contains an invalid or ambiguous result')
  return { ...value, results }
}
async function observeHiggsfield(panelId, context, requireLinkableResult = true) {
  const observed = observedHiggsfieldState(await higgsfieldControl(panelId, { op: 'observeHiggsfield' }, context), context)
  if (!requireLinkableResult) return { observed, receipt: '' }
  if (observed.generationStatus !== 'complete' || observed.results.length !== 1) {
    throw new Error('A completed unambiguous Higgsfield result is required before linking')
  }
  const receipt = createId('hfo-')
  higgsfieldObservationReceipts.set(receipt, {
    panelId, targetId: context.targetId, guestId: context.guestId, sourceUrl: context.url,
    result: observed.results[0], selectedModel: observed.selectedModel, selectedAspect: observed.selectedAspect,
    generationStatus: observed.generationStatus, expiresAt: Date.now() + HIGGSFIELD_OBSERVATION_TTL_MS
  })
  return { observed, receipt }
}
function consumeHiggsfieldObservation(panelId, context, receipt) {
  const observation = higgsfieldObservationReceipts.get(receipt)
  higgsfieldObservationReceipts.delete(receipt)
  if (!observation || observation.expiresAt < Date.now() || observation.panelId !== panelId ||
    observation.targetId !== context.targetId || observation.guestId !== context.guestId ||
    observation.sourceUrl !== context.url) throw new Error('A fresh matching Higgsfield observation receipt is required')
  return observation
}
function isHiggsfieldPage(rawUrl) {
  try {
    const hostname = new URL(rawUrl).hostname.toLowerCase()
    return hostname === 'higgsfield.ai' || hostname.endsWith('.higgsfield.ai')
  } catch { return false }
}
function currentHiggsfieldContext(panelId) {
  const browserApi = window.hermesDesktop?.browser
  const webview = browserWebviews.get(panelId)
  const panel = state.browserPanels[panelId]
  const guestId = webview?.getWebContentsId?.()
  const url = String(webview?.getURL?.() || '')
  if (!browserApi?.control || !panel || !Number.isInteger(guestId) || !isHiggsfieldPage(url) || panel.url !== url) {
    throw new Error('Open the current Higgsfield page in the Browser pane')
  }
  return { browserApi, webview, panel, guestId, targetId: panel.targetId, url }
}
function sameHiggsfieldContext(panelId, context) {
  const panel = state.browserPanels[panelId]
  return Boolean(panel && panel.targetId === context.targetId && panel.url === context.url &&
    browserWebviews.get(panelId)?.getWebContentsId?.() === context.guestId)
}
async function higgsfieldControl(panelId, request, context = currentHiggsfieldContext(panelId)) {
  if (!sameHiggsfieldContext(panelId, context)) throw new Error('Higgsfield panel target or URL changed')
  const result = await context.browserApi.control(context.guestId, {
    provider: 'higgsfield', recipe: HIGGSFIELD_SELECTOR_REGISTRY.version, expectedUrl: context.url, ...request
  })
  if (!sameHiggsfieldContext(panelId, context)) throw new Error('Higgsfield panel target or URL changed')
  return result
}
function higgsfieldNode(snapshot, id, role, required = true) {
  const matches = Array.isArray(snapshot?.nodes) ? snapshot.nodes.filter(node => node?.id === id && (!role || node.role === role)) : []
  if (matches.length !== 1) {
    if (!required && matches.length === 0) return null
    throw new Error(`Higgsfield target ${id} is ambiguous or unavailable`)
  }
  return matches[0]
}
async function runHiggsfieldControl(panelId, payload) {
  if (payload.action === 'capabilities') return { summary: 'Higgsfield Web — Unlimited control capabilities', detail: { state: 'READY', evidence: { selectorRegistry: HIGGSFIELD_SELECTOR_REGISTRY.version, models: HIGGSFIELD_MODELS, billableGenerate: true } } }
  if (payload.action === 'navigate') {
    setBrowserPanel(panelId, { url: payload.url, qcProfileHint: 'higgsfield-image' })
    host.panes?.setOpen?.(BROWSER_PANE_ID, true)
    return { summary: `Navigated ${panelId} to Higgsfield`, detail: { state: 'NAVIGATING', evidence: { panelId, requestedUrl: payload.url } } }
  }
  if (payload.action === 'repair') {
    const context = state.reviewContext
    const providerEvidence = context?.providerEvidence
    if (!reviewContextMatches(state, 'higgsfield-image') || context?.panelId !== panelId ||
      providerEvidence?.source !== 'higgsfield-web' || !providerEvidence.jobId || providerEvidence.status !== 'complete') {
      throw new Error('Link a fresh completed Higgsfield Web result in this panel before approving repair')
    }
    const candidateId = state.selectedCandidate
    const candidate = state.candidates[candidateId]
    if (candidate?.disposition !== 'REPAIR' || !candidate.repairPrompt?.trim()) {
      throw new Error('The selected QC candidate must have a reviewed REPAIR disposition and stored repair prompt')
    }
    return { summary: 'Higgsfield repair draft handoff approved', detail: { state: 'DRAFT_HANDOFF', evidence: { provider: 'higgsfield-web', candidateId, prompt: candidate.repairPrompt.trim(), generation: 'not-invoked' } } }
  }
  const context = currentHiggsfieldContext(panelId)
  if (payload.action === 'state') {
    const { observed } = await observeHiggsfield(panelId, context, false)
    return { summary: 'Higgsfield typed browser state', detail: { state: 'OBSERVED', evidence: observed } }
  }
  if (payload.action === 'results' || payload.action === 'observe') {
    const { observed, receipt } = await observeHiggsfield(panelId, context)
    return { summary: 'Higgsfield typed browser observation', detail: { state: 'OBSERVED', evidence: observed, observationReceipt: receipt } }
  }
  if (payload.action === 'link') {
    const observation = consumeHiggsfieldObservation(panelId, context, payload.observationReceipt)
    const resultUrl = redactedHiggsfieldResultUrl(observation.result.url)
    if (!resultUrl) throw new Error('Observed Higgsfield result URL is invalid')
    const providerEvidence = restoredProviderEvidence({
      source: 'higgsfield-web', jobId: observation.result.providerJobId, status: observation.generationStatus,
      model: observation.selectedModel, aspectRatio: observation.selectedAspect, resultUrl
    })
    setState(linkPanelState(updatePanelState(state, panelId, {
      url: resultUrl, providerEvidence, qcProfileHint: 'higgsfield-image'
    }), panelId, { profileId: 'higgsfield-image' }, createId))
    return { summary: 'Observed Higgsfield result linked to Quality Control', detail: { state: 'LINKED', evidence: { providerEvidence } } }
  }
  if (payload.action === 'draft') {
    await higgsfieldControl(panelId, { op: 'focusText', targetId: 'higgsfield-composer', text: payload.prompt.trim(), replace: true }, context)
    await higgsfieldControl(panelId, { op: 'activate', targetId: HIGGSFIELD_ASPECT_TARGETS[payload.aspect] }, context)
    await higgsfieldControl(panelId, { op: 'activate', targetId: HIGGSFIELD_MODEL_TARGETS[payload.model] }, context)
    higgsfieldDrafts.set(panelId, { targetId: context.targetId, url: context.url, prompt: payload.prompt.trim(), aspect: payload.aspect, model: payload.model })
    return { summary: 'Higgsfield draft set', detail: { state: 'DRAFT', evidence: { panelId, targetId: context.targetId, url: context.url, prompt: payload.prompt.trim(), aspect: payload.aspect, model: payload.model } } }
  }
  if (payload.action === 'validate') {
    const draft = higgsfieldDrafts.get(panelId)
    if (!draft || draft.targetId !== context.targetId || draft.url !== context.url) throw new Error('Set a fresh Higgsfield draft before validation')
    const snapshot = await higgsfieldControl(panelId, { op: 'snapshot' }, context)
    const prompt = higgsfieldNode(snapshot, 'higgsfield-composer', 'textbox').value
    const selected = node => ['true', 'on', 'selected'].includes(String(node?.attrs?.['aria-selected'] || node?.attrs?.['aria-pressed'] || node?.attrs?.['data-selected'] || node?.attrs?.['data-active'] || node?.attrs?.['data-state'] || '').toLowerCase())
    if (prompt !== draft.prompt ||
      !selected(higgsfieldNode(snapshot, HIGGSFIELD_ASPECT_TARGETS[draft.aspect], 'button')) ||
      !selected(higgsfieldNode(snapshot, HIGGSFIELD_MODEL_TARGETS[draft.model], 'button'))) {
      throw new Error('Higgsfield prompt, aspect, or model changed after draft')
    }
    const receipt = createId('hfv-')
    const batchFingerprint = await midjourneyPromptHash(`${prompt}\n${draft.aspect}\n${draft.model}`)
    const expiresAtMs = Date.now() + 60_000
    const expiresAt = new Date(expiresAtMs).toISOString()
    higgsfieldValidations.set(receipt, { panelId, targetId: context.targetId, url: context.url, prompt, aspect: draft.aspect, model: draft.model, batchFingerprint, expiresAt: expiresAtMs })
    return { summary: 'Higgsfield draft is generate-ready', receiptContext: { receiptHash: await midjourneyPromptHash(receipt), batchContextId: batchFingerprint, expiresAt, batchFingerprint }, detail: { state: 'READY', evidence: { prompt, aspect: draft.aspect, model: draft.model, receipt, expiresAt } } }
  }
  if (payload.action === 'generate') {
    const validation = higgsfieldValidations.get(payload.validateReceipt)
    if (!validation || validation.expiresAt < Date.now() || validation.panelId !== panelId || validation.targetId !== context.targetId || validation.url !== context.url || validation.batchFingerprint !== payload.batchFingerprint) throw new Error('A fresh matching Higgsfield validate receipt is required')
    if (payload.billableConfirmed !== true) throw new Error('Higgsfield Generate is billable and requires billableConfirmed=true')
    higgsfieldValidations.delete(payload.validateReceipt)
    const snapshot = await higgsfieldControl(panelId, { op: 'snapshot' }, context)
    const prompt = higgsfieldNode(snapshot, 'higgsfield-composer', 'textbox').value
    const selected = node => ['true', 'on', 'selected'].includes(String(node?.attrs?.['aria-selected'] || node?.attrs?.['aria-pressed'] || node?.attrs?.['data-selected'] || node?.attrs?.['data-active'] || node?.attrs?.['data-state'] || '').toLowerCase())
    if (prompt !== validation.prompt ||
      !selected(higgsfieldNode(snapshot, HIGGSFIELD_ASPECT_TARGETS[validation.aspect], 'button')) ||
      !selected(higgsfieldNode(snapshot, HIGGSFIELD_MODEL_TARGETS[validation.model], 'button'))) {
      throw new Error('Higgsfield prompt, aspect, or model changed after validation')
    }
    await higgsfieldControl(panelId, { op: 'generate', targetId: 'higgsfield-generate', billable: true }, context)
    return { summary: 'Higgsfield generation submitted (billable external action)', detail: { state: 'SUBMITTED', evidence: { panelId, targetId: context.targetId, receipt: payload.validateReceipt } } }
  }
  return { summary: 'Higgsfield QC state', detail: { state: 'QC_RUNNING', evidence: { panelId, qc: agentStatusSnapshot(state) } } }
}
const MIDJOURNEY_CAPABILITIES = Object.freeze({
  selectorRegistry: MIDJOURNEY_SELECTOR_REGISTRY.version,
  transport: 'window.hermesDesktop.browser.control',
  supported: Object.freeze(['capabilities', 'state', 'navigate', 'probe', 'results', 'settings', 'draft', 'attach', 'detach', 'validate', 'submit', 'wait', 'link', 'grid', 'action', 'download', 'capture', 'qc']),
  approvalGated: Object.freeze(['submit', 'upscale', 'vary', 'reroll', 'pan', 'zoom']),
  implemented: Object.freeze(['settings', 'attach', 'detach', 'draft', 'link', 'grid', 'select', 'upscale', 'vary', 'reroll', 'pan', 'zoom', 'download'])
})
const midjourneyDrafts = new Map()
const midjourneyAttachments = new Map()
const midjourneyValidations = new Map()
const midjourneyLinks = new Map()
const MIDJOURNEY_LEDGER_MAX = 32
const MIDJOURNEY_VALIDATION_TTL_MS = 60_000
const MIDJOURNEY_WAIT_MAX_MS = 30_000

function isMidjourneyPage(rawUrl) {
  try {
    const hostname = new URL(rawUrl).hostname.toLowerCase()
    return hostname === 'midjourney.com' || hostname.endsWith('.midjourney.com')
  } catch { return false }
}
function midjourneyError(error) {
  return String(error instanceof Error ? error.message : error).replace(/[\r\n\t]+/g, ' ').replace(/[^\x20-\x7e]/g, '').slice(0, 300)
}
function boundedMidjourneyLedger(ledger, key, value) {
  ledger.set(key, value)
  while (ledger.size > MIDJOURNEY_LEDGER_MAX) ledger.delete(ledger.keys().next().value)
}
function midjourneyOperation(stateName, evidence = {}, error = '') {
  return { operationId: createId('mj-'), state: stateName, evidence, error: midjourneyError(error) }
}
function currentMidjourneyContext(panelId) {
  const browserApi = window.hermesDesktop?.browser
  const webview = browserWebviews.get(panelId)
  const panel = state.browserPanels[panelId]
  const guestId = webview?.getWebContentsId?.()
  const url = String(webview?.getURL?.() || '')
  if (!browserApi?.control || !panel || !Number.isInteger(guestId) || !isMidjourneyPage(url) || panel.url !== url) {
    throw new Error('Open the current Midjourney page in the Browser pane')
  }
  return { browserApi, webview, panel, guestId, targetId: panel.targetId, url }
}
function sameMidjourneyContext(panelId, context) {
  const panel = state.browserPanels[panelId]
  return Boolean(panel && panel.targetId === context.targetId && panel.url === context.url &&
    browserWebviews.get(panelId)?.getWebContentsId?.() === context.guestId &&
    String(browserWebviews.get(panelId)?.getURL?.() || '') === context.url)
}
async function midjourneyControl(panelId, request, context = currentMidjourneyContext(panelId)) {
  if (!sameMidjourneyContext(panelId, context)) throw new Error('Midjourney panel target or URL changed')
  const result = await context.browserApi.control(context.guestId, {
    recipe: MIDJOURNEY_SELECTOR_REGISTRY.version, expectedUrl: context.url, ...request
  })
  if (!sameMidjourneyContext(panelId, context)) throw new Error('Midjourney panel target or URL changed')
  return result
}
function midjourneyNodes(snapshot) {
  if (!snapshot || typeof snapshot.url !== 'string' || !Array.isArray(snapshot.nodes)) throw new Error('Midjourney snapshot is incomplete')
  return snapshot.nodes.slice(0, 48)
}
function midjourneyNode(snapshot, id, role, required = true) {
  const matches = midjourneyNodes(snapshot).filter(node => node?.id === id && (!role || node.role === role))
  if (matches.length !== 1) {
    if (!required && matches.length === 0) return null
    throw new Error(`Midjourney target ${id} is ambiguous or unavailable`)
  }
  return matches[0]
}
function midjourneyRoleSelected(node) {
  const attrs = node?.attrs || {}
  return attrs['aria-pressed'] === 'true' || attrs['aria-selected'] === 'true' ||
    ['active', 'checked', 'on', 'selected', 'true'].includes(String(attrs['data-state'] || '').toLowerCase()) ||
    String(attrs.class || '').split(/\s+/).includes('text-splash')
}
function normalizedMidjourneyPrompt(value) {
  return String(value || '').trim().replace(/\s+/g, ' ')
}
function normalizedMidjourneyPromptBody(value) {
  return normalizedMidjourneyPrompt(value).replace(/\s--[a-z][\s\S]*$/i, '').trim()
}
async function midjourneyPromptHash(value) {
  const bytes = new TextEncoder().encode(normalizedMidjourneyPrompt(value))
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('')
}
function midjourneyJobId(rawUrl) {
  return midjourneyJobLocation(rawUrl).jobId
}
function selectedMidjourneyRoles(snapshot) {
  return ['start-frame', 'image-prompt', 'style-reference', 'omni']
    .filter(id => {
      const node = midjourneyNode(snapshot, id, 'button', false)
      return Boolean(node?.visible && midjourneyRoleSelected(node))
    })
}
async function midjourneySnapshot(panelId, context = currentMidjourneyContext(panelId)) {
  const snapshot = await midjourneyControl(panelId, { op: 'snapshot' }, context)
  if (snapshot.url !== context.url) throw new Error('Midjourney snapshot URL changed')
  return { context, snapshot, nodes: midjourneyNodes(snapshot) }
}
async function midjourneySettingsSnapshot(panelId, context, snapshot) {
  const openMarker = midjourneyNode(snapshot, 'aspect-portrait', 'button', false)
  if (openMarker?.visible) return snapshot
  const toggle = midjourneyNode(snapshot, 'settings-toggle', 'button')
  if (!toggle.visible || !toggle.enabled) throw new Error('Midjourney settings control is unavailable')
  await midjourneyControl(panelId, { op: 'activate', targetId: 'settings-toggle' }, context)
  await midjourneyControl(panelId, { op: 'waitFor', targetId: 'aspect-portrait', predicate: 'visible', timeoutMs: 5000 }, context)
  return (await midjourneySnapshot(panelId, context)).snapshot
}
function midjourneySettingsEvidence(snapshot) {
  const selected = (ids) => ids.map(id => midjourneyNode(snapshot, id, 'button', false)).find(node => node?.visible && midjourneyRoleSelected(node))?.id || ''
  const personalization = midjourneyNode(snapshot, 'personalization-toggle', 'button', false)
  return {
    aspect: selected(['aspect-portrait', 'aspect-square', 'aspect-landscape']).replace('aspect-', ''),
    model: selected(['model-standard', 'model-hd']).replace('model-', ''),
    raw: selected(['raw-standard', 'raw-on']).replace('raw-on', 'raw').replace('raw-', ''),
    speed: selected(['speed-relax', 'speed-fast']).replace('speed-', ''),
    videoResolution: selected(['video-sd', 'video-hd']).replace('video-', ''),
    personalization: Boolean(personalization?.visible && /\bPersonalize\b/.test(personalization.text))
  }
}
function midjourneyGrid(snapshot) {
  const image = midjourneyNodes(snapshot).find(node => node.id === 'result-image' && node.role === 'image' && node.visible)
  return { candidateCount: 0, candidates: [], compositeVisible: Boolean(image) }
}
async function probeMidjourneyPanel(panelId) {
  const { context, snapshot, nodes } = await midjourneySnapshot(panelId)
  const grid = midjourneyGrid(snapshot)
  const jobStatus = grid.candidateCount ? 'GRID_READY' : nodes.some(node => node.id === 'submit' && node.visible) ? 'READY' : 'BROWSING'
  const semanticTrace = Array.isArray(snapshot.semanticTrace) ? snapshot.semanticTrace.slice(0, 120) : []
  const evidence = { panelId, targetId: context.targetId, url: context.url, nodes, semanticTrace, checkedAt: new Date().toISOString() }
  return { snapshot: { registryVersion: MIDJOURNEY_SELECTOR_REGISTRY.version, url: context.url, targets: nodes, semanticTrace, jobStatus, grid }, summary: `Midjourney typed snapshot · ${nodes.length} targets`, evidence }
}
function formatMidjourneyDraft(prompt, parameters = {}) {
  const specs = { ar: value => /^\d{1,3}:\d{1,3}$/.test(String(value)), chaos: value => Number.isFinite(Number(value)) && Number(value) >= 0 && Number(value) <= 100, quality: value => ['.25', '.5', '1', '2'].includes(String(value)), seed: value => /^\d{1,10}$/.test(String(value)), stylize: value => Number.isFinite(Number(value)) && Number(value) >= 0 && Number(value) <= 1000, weird: value => Number.isFinite(Number(value)) && Number(value) >= 0 && Number(value) <= 3000, version: value => /^[\w.-]{1,16}$/.test(String(value)), profile: value => /^[\w.-]{1,64}$/.test(String(value)), raw: value => value === true, tile: value => value === true, no: value => typeof value === 'string' && value.trim().length > 0 && value.length <= 500 }
  const flags = []
  for (const [key, value] of Object.entries(parameters)) {
    if (!Object.hasOwn(specs, key) || !specs[key](value)) throw new Error(`Unsupported or invalid Midjourney parameter: ${key}`)
    flags.push(value === true ? `--${key}` : `--${key} ${String(value).trim()}`)
  }
  return `${prompt.trim()}${flags.length ? ` ${flags.join(' ')}` : ''}`
}
async function validationFor(panelId, context, snapshot) {
  const draft = midjourneyDrafts.get(panelId)
  const attachments = midjourneyAttachments.get(panelId) || []
  const composer = midjourneyNode(snapshot, 'composer', 'textbox')
  const settings = ['start-frame', 'image-prompt', 'style-reference', 'omni'].map(id => midjourneyNode(snapshot, id, 'button', false)).filter(Boolean)
  const exactPrompt = Boolean(draft && draft.text === composer.value && draft.targetId === context.targetId && draft.url === context.url)
  const roles = attachments.map(item => item.role)
  const receipt = createId('mjv-')
  const createdAt = Date.now()
  const selectedSettings = settings.filter(midjourneyRoleSelected)
  const evidence = { panelId, targetId: context.targetId, url: context.url, composer: composer.value, exactPrompt, attachmentRoles: roles, settings: settings.map(node => ({ id: node.id, visible: node.visible, enabled: node.enabled, selected: midjourneyRoleSelected(node) })), timestamp: new Date(createdAt).toISOString(), expiresAt: new Date(createdAt + MIDJOURNEY_VALIDATION_TTL_MS).toISOString() }
  const approved = exactPrompt && midjourneyNode(snapshot, 'submit', null).visible && roles.every(role => selectedSettings.some(node => node.id === role && node.visible)) && selectedSettings.every(node => roles.includes(node.id))
  const batchFingerprint = await midjourneyPromptHash(JSON.stringify({ panelId, targetId: context.targetId, composer: composer.value, attachmentRoles: roles, settings: selectedSettings.map(node => node.id) }))
  const validation = { receipt, batchFingerprint, approved, createdAt, expiresAt: createdAt + MIDJOURNEY_VALIDATION_TTL_MS, evidence }
  boundedMidjourneyLedger(midjourneyValidations, receipt, validation)
  return validation
}
function requireMidjourneyValidation(receipt, batchFingerprint, panelId, context, snapshot) {
  const validation = midjourneyValidations.get(receipt)
  const composer = midjourneyNode(snapshot, 'composer', 'textbox')
  if (!validation || !validation.approved || validation.expiresAt < Date.now() || validation.batchFingerprint !== batchFingerprint ||
      validation.evidence.panelId !== panelId || validation.evidence.targetId !== context.targetId ||
      validation.evidence.url !== context.url || validation.evidence.composer !== composer.value) {
    throw new Error('A fresh matching Midjourney validate receipt is required and batch identity must match')
  }
  return validation
}
async function runMidjourneyControl(panelId, payload) {
  let envelope = midjourneyOperation('FAILED')
  try {
    if (payload.action === 'capabilities') return { summary: 'Midjourney control capabilities', detail: { ...envelope, state: 'READY', evidence: MIDJOURNEY_CAPABILITIES } }
    if (payload.action === 'navigate') {
      const panel = state.browserPanels[panelId]
      const currentUrl = panel?.url || ''
      const link = midjourneyLinks.get(panelId)
      const panelEvidence = restoredProviderEvidence(panel?.providerEvidence)
      const candidateJobId = link?.jobId || (panelEvidence?.source === 'midjourney' ? panelEvidence.jobId : '')
      const preserveMidjourneyCandidate = sameMidjourneyCandidateSwitch(currentUrl, payload.url, candidateJobId)
      if (!preserveMidjourneyCandidate) midjourneyLinks.delete(panelId)
      setBrowserPanel(panelId, preserveMidjourneyCandidate
        ? { url: payload.url }
        : { url: payload.url, qcProfileHint: 'midjourney' }, {
          preserveMidjourneyCandidate,
          preserveProviderEvidence: preserveMidjourneyCandidate,
          preserveQcProfileHint: preserveMidjourneyCandidate
        })
      host.panes?.setOpen?.(BROWSER_PANE_ID, true)
      return { summary: `Navigated ${panelId} to ${payload.url}`, detail: { ...envelope, state: 'NAVIGATING', evidence: { panelId, requestedUrl: payload.url } } }
    }
    const { context, snapshot } = await midjourneySnapshot(panelId)
    if (payload.action === 'probe' || payload.action === 'state') {
      const probed = await probeMidjourneyPanel(panelId)
      return { summary: probed.summary, detail: { ...envelope, state: probed.snapshot.jobStatus, evidence: probed.evidence, snapshot: probed.snapshot } }
    }
    if (payload.action === 'results') {
      const resultState = await midjourneyControl(panelId, { op: 'results' }, context)
      return { summary: 'Midjourney bounded result evidence', detail: { ...envelope, state: 'OBSERVED', evidence: resultState } }
    }
    if (payload.action === 'settings') {
      if (payload.name === 'personalization') {
        let personalizationSnapshot = snapshot
        const openSettings = midjourneyNode(personalizationSnapshot, 'aspect-portrait', 'button', false)
        if (openSettings?.visible) {
          await midjourneyControl(panelId, { op: 'activate', targetId: 'settings-toggle' }, context)
          await midjourneyControl(panelId, { op: 'waitFor', targetId: 'personalization-toggle', predicate: 'enabled', timeoutMs: 5000 }, context)
          personalizationSnapshot = (await midjourneySnapshot(panelId, context)).snapshot
        }
        const before = midjourneyNode(personalizationSnapshot, 'personalization-toggle', 'button')
        if (!before.visible || !before.enabled) throw new Error('Midjourney personalization control is unavailable')
        const enabled = /\bPersonalize\b/.test(before.text)
        if (enabled !== payload.value) {
          if (payload.value) {
            await midjourneyControl(panelId, { op: 'activate', targetId: 'personalization-toggle' }, context)
          } else {
            await midjourneyControl(panelId, { op: 'activate', targetId: 'personalization-menu' }, context)
            await midjourneyControl(panelId, { op: 'waitFor', targetId: 'personalization-off', predicate: 'enabled', timeoutMs: 5000 }, context)
            await midjourneyControl(panelId, { op: 'activate', targetId: 'personalization-off' }, context)
          }
        }
        let after = (await midjourneySnapshot(panelId, context)).snapshot
        const readback = midjourneyNode(after, 'personalization-toggle', 'button')
        if (/\bPersonalize\b/.test(readback.text) !== payload.value) throw new Error('Midjourney personalization readback failed')
        if (midjourneyNode(after, 'personalization-off', 'button', false)?.visible) {
          await midjourneyControl(panelId, { op: 'activate', targetId: 'personalization-menu' }, context)
          after = (await midjourneySnapshot(panelId, context)).snapshot
          if (midjourneyNode(after, 'personalization-off', 'button', false)?.visible) throw new Error('Midjourney personalization menu did not close')
        }
        return { summary: `Midjourney personalization ${payload.value ? 'on' : 'off'}`, detail: { ...envelope, state: 'SETTINGS', evidence: { panelId, targetId: context.targetId, url: context.url, personalization: payload.value } } }
      }
      let current = await midjourneySettingsSnapshot(panelId, context, snapshot)
      if (!Object.hasOwn(payload, 'name')) {
        return { summary: 'Midjourney settings readback', detail: { ...envelope, state: 'SETTINGS', evidence: { panelId, targetId: context.targetId, url: context.url, settings: midjourneySettingsEvidence(current) } } }
      }
      const optionTargets = {
        aspect: { portrait: 'aspect-portrait', square: 'aspect-square', landscape: 'aspect-landscape' },
        model: { standard: 'model-standard', hd: 'model-hd' }, raw: { standard: 'raw-standard', raw: 'raw-on' },
        speed: { relax: 'speed-relax', fast: 'speed-fast' }, videoResolution: { sd: 'video-sd', hd: 'video-hd' }
      }
      const targetId = optionTargets[payload.name]?.[payload.value]
      if (!targetId) throw new Error('Midjourney setting target is unsupported')
      const option = midjourneyNode(current, targetId, 'button')
      if (!option.visible || !option.enabled) throw new Error(`Midjourney setting ${payload.name} is unavailable`)
      if (!midjourneyRoleSelected(option)) await midjourneyControl(panelId, { op: 'activate', targetId }, context)
      current = (await midjourneySnapshot(panelId, context)).snapshot
      const settings = midjourneySettingsEvidence(current)
      const actual = settings[payload.name]
      if (actual !== payload.value) throw new Error(`Midjourney setting ${payload.name} readback failed`)
      return { summary: `Midjourney setting ${payload.name}=${payload.value}`, detail: { ...envelope, state: 'SETTINGS', evidence: { panelId, targetId: context.targetId, url: context.url, settings } } }
    }
    if (payload.action === 'grid') {
      const link = midjourneyLinks.get(panelId)
      const jobId = midjourneyJobId(context.url)
      if (!link || !jobId || link.jobId !== jobId) throw new Error('Midjourney grid requires the exact linked current job')
      const resultState = await midjourneyControl(panelId, { op: 'results' }, context)
      const currentJob = resultState.currentJob
      const quadrants = currentJob?.jobId === jobId && Array.isArray(currentJob.compositeGrid?.quadrants)
        ? currentJob.compositeGrid.quadrants : []
      const labels = quadrants.map(item => item?.label)
      if (quadrants.length !== 4 || labels.join('') !== 'ABCD' || quadrants.some(item => !item?.bounds || item.bounds.width <= 0 || item.bounds.height <= 0)) {
        throw new Error('Midjourney current job does not expose a verified complete A-D grid')
      }
      const candidates = quadrants.map((item, index) => ({ candidateId: item.label, ordinal: index + 1, quadrant: item.bounds, sourceKind: 'composite', jobId }))
      return { summary: 'Midjourney A-D grid verified', detail: { ...envelope, state: 'GRID_READY', evidence: { panelId, targetId: context.targetId, url: context.url, jobId, operationId: link.operationId, promptHash: link.promptHash, candidates } } }
    }
    if (payload.action === 'draft') {
      const text = formatMidjourneyDraft(payload.prompt, payload.parameters || {})
      await midjourneyControl(panelId, { op: 'focusText', targetId: 'composer', text, replace: true }, context)
      const after = (await midjourneySnapshot(panelId, context)).snapshot
      if (midjourneyNode(after, 'composer', 'textbox').value !== text) throw new Error('Midjourney composer readback did not match the requested draft')
      boundedMidjourneyLedger(midjourneyDrafts, panelId, { targetId: context.targetId, url: context.url, text, setAt: new Date().toISOString() })
      return { summary: `Draft set (${text.length} characters)`, detail: { ...envelope, state: 'DRAFT', evidence: { panelId, targetId: context.targetId, url: context.url, composer: text } } }
    }
    if (payload.action === 'attach') {
      const role = payload.role === 'omni-reference' ? 'omni' : payload.role
      let current = snapshot
      const modeSwitch = role === 'start-frame' ? 'switch-to-video' : 'switch-to-image'
      const existingInput = midjourneyNode(current, 'image-file-input', null, false)
      if (!existingInput) {
        const opener = {
          'image-prompt': 'add-images',
          'start-frame': 'add-start-frame',
          'style-reference': 'add-style-reference',
          omni: 'add-omni-reference'
        }[role]
        const add = midjourneyNode(current, opener, 'button')
        if (!add.visible || !add.enabled) throw new Error(`Midjourney ${role} attachment control is unavailable`)
        await midjourneyControl(panelId, { op: 'activate', targetId: opener }, context)
        await midjourneyControl(panelId, { op: 'waitFor', targetId: 'image-file-input', predicate: 'enabled', timeoutMs: 5000 }, context)
        current = (await midjourneySnapshot(panelId, context)).snapshot
      }
      const requestedMode = role === 'start-frame' ? 'video' : 'image'
      if (current.composerMode !== requestedMode) {
        const switchNode = midjourneyNode(current, modeSwitch, 'button', false)
        if (!switchNode?.visible || !switchNode.enabled) throw new Error(`Midjourney ${requestedMode} composer mode is not positively available`)
        await midjourneyControl(panelId, { op: 'activate', targetId: modeSwitch }, context)
        current = (await midjourneySnapshot(panelId, context)).snapshot
      }
      if (current.composerMode !== requestedMode) throw new Error(`Midjourney ${requestedMode} composer mode readback failed`)
      const beforeRoles = selectedMidjourneyRoles(current)
      if (beforeRoles.length) throw new Error(`Midjourney attachment precondition is not empty: ${beforeRoles.join(', ')}`)
      const input = midjourneyNode(current, 'image-file-input', null)
      if (!input.enabled) throw new Error('Midjourney image file input is unavailable')
      await midjourneyControl(panelId, { op: 'setFileInput', targetId: 'image-file-input', filePath: payload.path }, context)
      const roleDeadline = Date.now() + 10000
      do {
        current = (await midjourneySnapshot(panelId, context)).snapshot
        const requestedRole = midjourneyNode(current, role, 'button', false)
        if (requestedRole && midjourneyRoleSelected(requestedRole)) break
        await new Promise(resolve => setTimeout(resolve, 250))
      } while (Date.now() <= roleDeadline)
      await midjourneyControl(panelId, { op: 'waitFor', targetId: role, predicate: 'visible', timeoutMs: 10000 }, context)
      current = (await midjourneySnapshot(panelId, context)).snapshot
      const selectedRoles = selectedMidjourneyRoles(current)
      if (selectedRoles.length !== 1 || selectedRoles[0] !== role) throw new Error(`Midjourney attachment roles did not read back exactly: ${selectedRoles.join(', ') || 'none'}`)
      const roleNode = midjourneyNode(current, role, 'button')
      if (!roleNode.visible || !roleNode.enabled || !midjourneyRoleSelected(roleNode)) throw new Error(`Midjourney attachment role ${role} was not verified`)
      const readback = { roleControl: roleNode.text, confirmed: midjourneyRoleSelected(roleNode) }
      if (!readback.confirmed) throw new Error(`Midjourney attachment role ${role} readback did not confirm selection`)
      const attachments = [...(midjourneyAttachments.get(panelId) || []).filter(item => item.role !== role), { role, targetId: context.targetId, url: context.url, attachedAt: new Date().toISOString() }].slice(-4)
      boundedMidjourneyLedger(midjourneyAttachments, panelId, attachments)
      return { summary: `Attached image as ${role}`, detail: { ...envelope, state: 'READY', evidence: { panelId, targetId: context.targetId, url: context.url, attachmentRoles: attachments.map(item => item.role), roleReadback: readback } } }
    }
    if (payload.action === 'detach') {
      const role = payload.role === 'omni-reference' ? 'omni' : payload.role
      const selectedRoles = selectedMidjourneyRoles(snapshot)
      if (selectedRoles.length !== 1 || selectedRoles[0] !== role) throw new Error(`Midjourney ${role} is not the sole selected attachment role`)
      const clear = midjourneyNode(snapshot, role, 'button')
      if (!clear.visible || !clear.enabled || !/^Clear\b/.test(clear.text)) throw new Error(`Midjourney ${role} has no exact typed clear action`)
      await midjourneyControl(panelId, { op: 'activate', targetId: role }, context)
      const deadline = Date.now() + 5000
      let after = snapshot
      do {
        after = (await midjourneySnapshot(panelId, context)).snapshot
        if (!selectedMidjourneyRoles(after).length) break
        await new Promise(resolve => setTimeout(resolve, 250))
      } while (Date.now() <= deadline)
      if (selectedMidjourneyRoles(after).length) throw new Error(`Midjourney ${role} cleanup readback failed`)
      boundedMidjourneyLedger(midjourneyAttachments, panelId, (midjourneyAttachments.get(panelId) || []).filter(item => item.role !== role))
      return { summary: `Detached ${role}`, detail: { ...envelope, state: 'READY', evidence: { panelId, targetId: context.targetId, url: context.url, attachmentRoles: [] } } }
    }
    if (payload.action === 'validate') {
      const validation = await validationFor(panelId, context, snapshot)
      return { summary: validation.approved ? 'Midjourney draft is submit-ready' : 'Midjourney draft is not submit-ready', receiptContext: { receiptHash: await midjourneyPromptHash(validation.receipt), batchContextId: validation.batchFingerprint, expiresAt: validation.evidence.expiresAt, batchFingerprint: validation.batchFingerprint }, detail: { ...envelope, state: validation.approved ? 'READY' : 'FAILED', evidence: validation.evidence, validation } }
    }
    if (payload.action === 'link') {
      const resultState = await midjourneyControl(panelId, { op: 'results' }, context)
      const requestedPrompt = normalizedMidjourneyPrompt(payload.prompt)
      const requestedJobId = String(payload.jobId).toLowerCase()
      const submittedAt = Date.parse(payload.ledgerCreatedAt)
      const latestAt = submittedAt + 30 * 60_000
      const matches = (Array.isArray(resultState.results) ? resultState.results : []).filter(result => {
        const createdAt = Date.parse(result?.createdAt || '')
        return /^[0-9a-f-]{36}$/i.test(String(result?.jobId || '')) &&
          String(result.jobId).toLowerCase() === requestedJobId &&
          (!result?.prompt || normalizedMidjourneyPromptBody(result.prompt) === normalizedMidjourneyPromptBody(requestedPrompt)) &&
          (!result?.createdAt || Number.isFinite(createdAt) && createdAt >= submittedAt - 5000 && createdAt <= latestAt)
      })
      if (matches.length !== 1) throw new Error(`Midjourney acknowledged submit linkage is ${matches.length ? 'ambiguous' : 'unavailable'}`)
      const linked = matches[0]
      const promptHash = await midjourneyPromptHash(requestedPrompt)
      const record = { jobId: requestedJobId, operationId: payload.operationId, promptHash, submittedAt: payload.ledgerCreatedAt, providerCreatedAt: linked.createdAt, linkedAt: new Date().toISOString() }
      boundedMidjourneyLedger(midjourneyLinks, panelId, record)
      const requestedUrl = `https://www.midjourney.com/jobs/${record.jobId}`
      setBrowserPanel(panelId, {
        url: requestedUrl, qcProfileHint: 'midjourney',
        providerEvidence: { source: 'midjourney', jobId: record.jobId, operationId: record.operationId, resultUrl: requestedUrl }
      })
      host.panes?.setOpen?.(BROWSER_PANE_ID, true)
      return { summary: `Linked Midjourney job ${record.jobId}`, detail: { ...envelope, state: 'NAVIGATING', evidence: { panelId, sourceTargetId: context.targetId, sourceUrl: context.url, requestedUrl, ...record } } }
    }
    if (payload.action === 'submit' || payload.action === 'action') {
      const name = payload.action === 'submit' ? 'submit' : payload.name
      if (name !== 'select' && payload.approved !== true) throw new Error(`${name} requires approved=true`)
      if (payload.action === 'submit') requireMidjourneyValidation(payload.validateReceipt, payload.batchFingerprint, panelId, context, snapshot)
      if (payload.action === 'action') {
        const link = midjourneyLinks.get(panelId)
        const currentJobId = midjourneyJobId(context.url)
        if (!link || !currentJobId || link.jobId !== currentJobId || payload.jobId.toLowerCase() !== currentJobId) throw new Error('Midjourney result action requires the exact linked current job')
      }
      const target = name
      const node = midjourneyNode(snapshot, target, target === 'submit' ? null : 'button')
      if (!node.visible || !node.enabled) throw new Error(`Midjourney ${target} control is unavailable`)
      const activation = { op: 'activate', targetId: target }
      if (payload.action === 'action' && payload.candidate) activation.candidate = payload.candidate
      await midjourneyControl(panelId, activation, context)
      return { summary: `${name} activated once`, detail: { ...envelope, state: name === 'submit' ? 'SUBMITTED' : 'MUTATED', evidence: { panelId, targetId: context.targetId, url: context.url, jobId: payload.jobId || '', candidate: payload.candidate || '', action: name, idempotencyKey: payload.idempotencyKey } } }
    }
    if (payload.action === 'wait') {
      const timeoutMs = Math.min(payload.timeoutMs || 5000, MIDJOURNEY_WAIT_MAX_MS)
      const link = midjourneyLinks.get(panelId)
      const jobId = midjourneyJobId(context.url)
      if (!link || !jobId || link.jobId !== jobId) throw new Error('Midjourney wait requires the exact linked current job')
      const result = await midjourneyControl(panelId, { op: 'waitFor', targetId: 'result-image', predicate: 'visible', timeoutMs }, context)
      return { summary: 'Midjourney result state observed', detail: { ...envelope, state: 'RESULT_READY', evidence: { panelId, targetId: context.targetId, url: context.url, jobId, timeoutMs, result: result.node || null } } }
    }
    if (payload.action === 'download') {
      const jobId = payload.jobId
      const filename = payload.filename
      const currentJobId = midjourneyJobId(context.url)
      const link = midjourneyLinks.get(panelId)
      if (!currentJobId || currentJobId !== jobId.toLowerCase() || link?.jobId !== currentJobId) throw new Error('Midjourney download job does not match the exact linked current page')
      const safe = `midjourney/${jobId}/${filename}`
      if (!/^midjourney\/[A-Za-z0-9_-]{1,80}\/[A-Za-z0-9._-]{1,120}\.(?:png|jpe?g|webp|gif|avif|bmp)$/i.test(safe)) throw new Error('Midjourney download artifact path is unsafe')
      const result = await midjourneyControl(panelId, { op: 'download', targetId: 'result-image', artifactRelativePath: safe }, context)
      if (!/^image\//i.test(result.mime || '') || !Number.isFinite(result.bytes) || result.bytes <= 0 || !Number.isFinite(result.width) || result.width <= 0 || !Number.isFinite(result.height) || result.height <= 0) throw new Error('Midjourney download did not return verified image provenance')
      return { summary: `Downloaded ${filename}`, detail: { ...envelope, state: 'DOWNLOADED', evidence: { panelId, targetId: context.targetId, url: context.url, jobId, artifactRelativePath: safe, artifact: result } } }
    }
    if (payload.action === 'capture') {
      const captured = await captureBrowserPanel(panelId)
      return { summary: `Captured ${captured.width}×${captured.height}`, detail: { ...envelope, state: 'CAPTURED', evidence: { panelId, targetId: context.targetId, url: context.url, capture: captured } } }
    }
    if (payload.action === 'qc') return { summary: 'Midjourney QC state', detail: { ...envelope, state: 'QC_RUNNING', evidence: { panelId, targetId: context.targetId, url: context.url, qc: agentStatusSnapshot(state) } } }
    throw new Error(`Unsupported Midjourney control action: ${payload.action}`)
  } catch (error) {
    envelope = { ...envelope, error: midjourneyError(error) }
    throw new Error(envelope.error)
  }
}

async function runDesignPageChecks(panelId) {
  if (!reviewContextMatches(state, 'design')) {
    throw new Error('Link the target in the Browser pane before running page checks')
  }
  const browserApi = window.hermesDesktop?.browser
  const webview = browserWebviews.get(panelId)
  const guestId = webview?.getWebContentsId?.()
  const startContextId = state.reviewContext?.contextId
  const startTargetId = state.browserPanels[panelId]?.targetId
  if (!browserApi?.audit || !Number.isInteger(guestId)) {
    throw new Error('Open the linked page in the Browser pane before running page checks')
  }
  const audit = await browserApi.audit(guestId)
  if (!isRecord(audit) || !Number.isFinite(audit.viewportWidth) || !Number.isFinite(audit.viewportHeight) ||
      !Number.isFinite(audit.documentWidth) || typeof audit.horizontalOverflow !== 'boolean') {
    throw new Error('Page checks returned incomplete CDP audit data')
  }
  const panel = state.browserPanels[panelId]
  const context = state.reviewContext
  const sourceUrl = String(audit.url || webview?.getURL?.() || panel?.url || '')
  if (!panel || !context || context.contextId !== startContextId || panel.targetId !== startTargetId ||
      startTargetId !== context.targetId || sourceUrl !== context.url) {
    throw new Error('Target changed during page checks; results were not attached')
  }
  const summary = `Page ${audit.viewportWidth || 0}×${audit.viewportHeight || 0} · overflow ${audit.horizontalOverflow ? 1 : 0} · broken images ${audit.brokenImages || 0} · missing labels ${(audit.missingAlt || 0) + (audit.unlabeledControls || 0)}`
  const design = { ...(state.evaluations.design || {}) }
  design.responsive = { status: audit.horizontalOverflow ? 'fail' : 'pass', note: `Current viewport ${audit.viewportWidth || 0}×${audit.viewportHeight || 0}; document width ${audit.documentWidth || 0}.` }
  design.clipping = { status: audit.horizontalOverflow || audit.brokenImages ? 'fail' : 'pending', note: audit.horizontalOverflow || audit.brokenImages ? `Horizontal overflow ${audit.horizontalOverflow ? 'detected' : 'not detected'}; broken images ${audit.brokenImages || 0}.` : 'No global horizontal overflow or broken images detected. Local clipping and bounds still require visual review.' }
  design.contrast = { status: 'pending', note: `Automated accessibility preflight: missing image alt ${audit.missingAlt || 0}, unlabeled controls ${audit.unlabeledControls || 0}. Contrast still requires visual review.` }
  setState({
    evaluations: { ...state.evaluations, design },
    browserPanels: { ...state.browserPanels, [panelId]: { ...panel, inspection: { url: sourceUrl, summary, checkedAt: new Date().toISOString() } } }
  })
  return summary
}

function linkBrowserPanelToQc(panelId, input = {}) {
  const panel = state.browserPanels[panelId] || DEFAULT_BROWSER_PANELS[panelId]
  if (!panel.url) {
    host.notify({ kind: 'warning', message: `Open a ${panelId} target before linking it to Quality Control` })
    return false
  }
  const profileId = QC_PROFILE_IDS.includes(input.profileId)
    ? input.profileId
    : QC_PROFILE_IDS.includes(panel.qcProfileHint) ? panel.qcProfileHint : qcProfileFor({ ...input, src: panel.url, providerEvidence: panel.providerEvidence })
  setState(linkPanelState(state, panelId, { ...input, profileId }, createId))
  host.panes?.setOpen?.(BROWSER_PANE_ID, true)
  host.panes?.setOpen?.(QC_PANE_ID, true)
  return true
}
async function dispatchAgentCommand(ctx, received, seenIds) {
  const commandId = typeof received?.id === 'string' ? received.id : ''
  const op = typeof received?.op === 'string' ? received.op : 'invalid'
  let ok = false
  let summary = ''
  let error = ''
  let detail = null
  let receiptContext = null
  try {
    if (!commandId || seenIds.has(commandId)) throw new Error(commandId ? 'Duplicate command id' : 'Command id is required')
    seenIds.add(commandId)
    if (seenIds.size > 200) seenIds.delete(seenIds.values().next().value)
    const validated = validateAgentCommand(received)
    if (!validated.ok) throw new Error(validated.error)
    const command = validated.command
    if (['capture', 'inspect', 'page-checks'].includes(command.op)) {
      const result = command.op === 'capture'
        ? await captureBrowserPanel(command.panelId)
        : command.op === 'inspect'
          ? await inspectBrowserPanel(command.panelId)
          : await runDesignPageChecks(command.panelId)
      summary = typeof result === 'string' ? result : command.op === 'capture' ? `Captured ${command.panelId}` : command.op
    } else if (command.op === 'midjourney-probe') {
      const result = await probeMidjourneyPanel(command.panelId)
      summary = result.summary
      detail = { ...midjourneyOperation(result.snapshot.jobStatus, result.evidence), snapshot: result.snapshot }
    } else if (command.op === 'midjourney-control') {
      const result = await runMidjourneyControl(command.panelId, command.payload)
      summary = result.summary
      detail = result.detail
      receiptContext = result.receiptContext || null
    } else if (command.op === 'higgsfield-control') {
      const result = await runHiggsfieldControl(command.panelId, command.payload)
      summary = result.summary
      detail = result.detail
      receiptContext = result.receiptContext || null
    } else if (command.op === 'import-qc') {
      if (!reviewContextMatches(state, state.qcProfile)) throw new Error('Link the target in the Browser pane before editing QC')
      const provider = providerForProfile(state.qcProfile)
      if (!provider?.qcDocument) throw new Error('Structured QC import is unavailable for this profile')
      const document = provider.qcDocument.validate(command.payload.json)
      const formatted = JSON.stringify(document, null, 2)
      setState({
        job: document.job, candidates: Object.fromEntries(document.candidates.map(candidate => [candidate.id, candidate])),
        selectedCandidate: document.selectedCandidate, qcJson: formatted, qcProfile: state.qcProfile
      })
      summary = `Imported QC for ${document.job.id}`
    } else {
      const applied = applyAgentCommand(state, command, createId)
      if (applied.error) throw new Error(applied.error)
      if (applied.state !== state) setState(applied.state)
      summary = applied.summary
    }
    ok = true
  } catch (caught) {
    error = midjourneyError(caught)
    if (op === 'midjourney-control' || op === 'midjourney-probe') detail = midjourneyOperation('FAILED', {}, error)
  }
  const message = ok ? summary : error
  setState({ agentActivity: { op, at: new Date().toISOString(), ok, summary: message } })
  host.notify({ kind: ok ? 'success' : 'warning', message: `Agent QC · ${op} — ${message}` })
  const ack = { id: commandId, ok, error: ok ? '' : error, summary: message, ...(detail ? { detail } : {}), ...(receiptContext ? { receiptContext } : {}), state: agentStatusSnapshot(state) }
  try {
    await ctx.rest('/result', { method: 'POST', body: ack })
  } catch (postError) {
    host.notify({ kind: 'warning', message: `Agent QC · ${op} — result acknowledgement failed: ${postError instanceof Error ? postError.message : String(postError)}` })
  }
}

function AgentActivity({ activity }) {
  if (!activity) return null
  return jsxs('div', {
    style: { alignItems: 'center', color: 'var(--ui-text-quaternary)', display: 'flex', fontSize: 10, gap: 6, padding: '0 12px 8px' },
    children: [
      jsx(Badge, { variant: 'muted', children: 'AGENT' }),
      jsx('span', { children: `${activity.op} · ${new Date(activity.at).toLocaleTimeString()}` })
    ]
  })
}
function swapBrowserPanels() {
  setState(swapPanelsState(state, createId))
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

function BrowserSurface({ panelId, url, viewport }) {
  const kind = mediaKind(url)
  const hasPrivilegedBrowser = Boolean(window.hermesDesktop?.browser?.capture)
  const webviewRef = useRef(null)

  useEffect(() => {
    const element = webviewRef.current
    const cdp = window.hermesDesktop?.browser?.cdp
    if (!element || !cdp || kind !== 'page') return
    let active = true

    const applyViewport = async () => {
      const guestId = element.getWebContentsId?.()
      if (!Number.isInteger(guestId)) return
      if (viewport.responsive) {
        await cdp(guestId, 'Emulation.clearDeviceMetricsOverride')
      } else {
        await cdp(guestId, 'Emulation.setDeviceMetricsOverride', {
          width: viewport.width,
          height: viewport.height,
          deviceScaleFactor: 1,
          mobile: false,
          screenWidth: viewport.width,
          screenHeight: viewport.height
        })
      }
    }

    const scheduleViewport = () => {
      const previous = browserViewportTasks.get(panelId) || Promise.resolve()
      const next = previous.catch(() => {}).then(applyViewport)
      browserViewportTasks.set(panelId, next)
      void next.catch(error => {
        const message = error instanceof Error ? error.message : String(error)
        if (message.includes('must be attached to the DOM')) return
        if (active && browserWebviews.get(panelId) === element) {
          host.notify({ kind: 'warning', message: `Viewport sync failed: ${message}` })
        }
      }).finally(() => {
        if (browserViewportTasks.get(panelId) === next) browserViewportTasks.delete(panelId)
      })
    }

    element.addEventListener('dom-ready', scheduleViewport)
    scheduleViewport()
    return () => {
      active = false
      element.removeEventListener('dom-ready', scheduleViewport)
    }
  }, [kind, url, viewport.height, viewport.responsive, viewport.width])

  if (!url) {
    return jsx(EmptyState, { title: 'No target', description: 'Paste a URL or open a file from the Files pane.' })
  }

  if (kind === 'image') {
    return jsx('img', {
      alt: 'QC target',
      ref: element => {
        if (element) browserMediaElements.set(panelId, element)
        else browserMediaElements.delete(panelId)
      },
      src: url,
      style: { display: 'block', height: '100%', objectFit: 'contain', width: '100%' }
    })
  }

  if (kind === 'video') {
    return jsx('video', {
      controls: true,
      ref: element => {
        if (element) browserMediaElements.set(panelId, element)
        else browserMediaElements.delete(panelId)
      },
      src: url,
      style: { display: 'block', height: '100%', objectFit: 'contain', width: '100%' }
    })
  }

  if (hasPrivilegedBrowser) {
    return jsx('webview', {
      allowpopups: 'false',
      partition: 'persist:hermes-browser',
      ref: element => {
        webviewRef.current = element
        if (!element) {
          browserWebviews.delete(panelId)
          return
        }
        browserWebviews.set(panelId, element)
        if (!browserWebviewSyncInstalled.has(element)) {
          const syncUrl = event => {
            const nextUrl = String(event?.url || element.getURL?.() || '')
            const currentUrl = state.browserPanels[panelId]?.url || ''
            if (nextUrl && nextUrl !== currentUrl) {
              const link = midjourneyLinks.get(panelId)
              const preserveMidjourneyCandidate = sameMidjourneyCandidateSwitch(currentUrl, nextUrl, link?.jobId)
              const preserveProvenance = preserveMidjourneyCandidate || comparableUrl(nextUrl) === comparableUrl(currentUrl)
              setBrowserPanel(panelId, { url: nextUrl }, {
                preserveMidjourneyCandidate,
                preserveProviderEvidence: preserveProvenance,
                preserveQcProfileHint: preserveProvenance
              })
            }
          }
          const syncLoadFailure = event => {
            if (event?.isMainFrame === false || event?.errorCode === -3) return
            const next = markPanelLoadFailedState(state, panelId)
            if (next === state) return
            setState(next)
            host.notify({ kind: 'warning', message: `Browser failed to load ${event?.validatedURL || state.browserPanels[panelId]?.url || 'the linked target'}; QC context marked stale` })
          }
          element.addEventListener('did-navigate', syncUrl)
          element.addEventListener('did-navigate-in-page', syncUrl)
          element.addEventListener('did-fail-load', syncLoadFailure)
          browserWebviewSyncInstalled.add(element)
        }
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
    title: 'Renderline Browser'
  })
}

function ViewportStage({ panel, panelId }) {
  const containerRef = useRef(null)
  const [bounds, setBounds] = useState({ width: 0, height: 0 })
  const viewport = viewportFor(panel)
  const actualSize = panel.displayMode === 'actual'

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
      children: jsx(BrowserSurface, { panelId, url: panel.url, viewport })
    })
  }

  const scale = Math.min(bounds.width / viewport.width || 1, bounds.height / viewport.height || 1, 1)

  return jsx('div', {
    ref: containerRef,
    style: {
      background: 'var(--ui-surface-secondary)',
      height: '100%',
      minHeight: 0,
      overflow: actualSize ? 'auto' : 'hidden',
      position: 'relative',
      width: '100%'
    },
    children: jsx('div', {
      style: {
        background: 'var(--ui-surface-primary)',
        boxShadow: 'inset 0 0 0 1px var(--ui-stroke-secondary)',
        height: viewport.height,
        left: actualSize ? 0 : '50%',
        overflow: 'hidden',
        position: 'absolute',
        top: actualSize ? 0 : '50%',
        transform: actualSize ? 'none' : `translate(-50%, -50%) scale(${scale})`,
        transformOrigin: 'center center',
        width: viewport.width
      },
      children: jsx(BrowserSurface, { panelId, url: panel.url, viewport })
    })
  })
}

function BrowserPanel({ panelId, title }) {
  const workbench = useWorkbench()
  const panel = workbench.browserPanels[panelId] || DEFAULT_BROWSER_PANELS[panelId]
  const [draft, setDraft] = useState(panel.url)
  const [captureStatus, setCaptureStatus] = useState('')
  const [metricStatus, setMetricStatus] = useState('')
  const viewport = viewportFor(panel)

  useEffect(() => setDraft(panel.url), [panel.url])

  const navigate = () => setBrowserPanel(panelId, { url: normalizeUrl(draft) })
  const setPreset = preset => {
    const dimensions = VIEWPORT_PRESETS[preset] || {}
    setBrowserPanel(panelId, { preset, width: dimensions.width || panel.width, height: dimensions.height || panel.height })
  }
  const capturePng = async () => {
    setCaptureStatus('Capturing…')
    try {
      const capture = await captureBrowserPanel(panelId, { save: true })
      setCaptureStatus(capture.canceled ? `Captured ${capture.width}×${capture.height} · save cancelled` : `Saved ${capture.width}×${capture.height}`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setCaptureStatus(message)
      host.notify({ kind: 'error', message: `Browser capture failed: ${message}` })
    }
  }

  const inspectViewport = async () => {
    try {
      setMetricStatus(await inspectBrowserPanel(panelId))
    } catch (error) {
      setMetricStatus(error instanceof Error ? error.message : String(error))
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
          }),
          jsx(Button, {
            onClick: () => setBrowserPanel(panelId, { displayMode: panel.displayMode === 'actual' ? 'fit' : 'actual' }),
            size: 'xs',
            variant: panel.displayMode === 'actual' ? 'default' : 'outline',
            children: panel.displayMode === 'actual' ? '100% · Actual' : 'Fit'
          }),
          jsx(Button, {
            disabled: !panel.url || mediaKind(panel.url) !== 'page' || !window.hermesDesktop?.browser?.cdp,
            onClick: inspectViewport,
            size: 'xs',
            variant: 'outline',
            children: 'Inspect CDP'
          }),
          jsx(Button, {
            disabled: !panel.url,
            onClick: () => linkBrowserPanelToQc(panelId),
            size: 'xs',
            variant: panelLinkedToQc(workbench, panelId) ? 'default' : 'outline',
            children: panelLinkedToQc(workbench, panelId) ? 'QC Linked' : 'Review in QC'
          })
        ]
      }),
      captureStatus
        ? jsx('div', { style: { color: 'var(--ui-text-tertiary)', fontSize: 10, padding: '0 10px 6px' }, children: captureStatus })
        : null,
      metricStatus
        ? jsx('div', { style: { color: 'var(--ui-text-tertiary)', fontSize: 10, padding: '0 10px 6px' }, children: metricStatus })
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
            onClick: swapBrowserPanels,
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
    onChange: event => {
      const profileId = event.target.value
      const panelId = state.qcTargetPanelId || 'result'
      if (state.browserPanels[panelId]?.url) linkBrowserPanelToQc(panelId, { profileId })
      else setState({ qcProfile: profileId })
    },
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

function QcTargetCard({ workbench }) {
  const panelId = workbench.qcTargetPanelId || 'result'
  const panel = workbench.browserPanels[panelId] || DEFAULT_BROWSER_PANELS[panelId]
  const viewport = viewportFor(panel)
  const hasTarget = Boolean(panel.url)
  const linkedCapture = workbench.capture?.panelId === panelId && workbench.capture?.targetId === panel.targetId &&
    workbench.capture?.url === panel.url &&
    JSON.stringify(workbench.capture?.viewport) === JSON.stringify(viewportFor(panel))
    ? workbench.capture
    : null
  const [status, setStatus] = useState('')
  useEffect(() => setStatus(''), [panelId, panel.url])

  const captureEvidence = async () => {
    setStatus('Capturing evidence…')
    try {
      const capture = await captureBrowserPanel(panelId)
      setStatus(`Evidence captured ${capture.width}×${capture.height}`)
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error))
    }
  }
  const inspectTarget = async () => {
    setStatus('Inspecting target…')
    try {
      setStatus(await inspectBrowserPanel(panelId))
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error))
    }
  }

  return jsxs('div', {
    style: {
      background: 'var(--ui-surface-secondary)',
      border: '1px solid var(--ui-stroke-secondary)',
      borderRadius: 7,
      margin: '0 12px 10px',
      padding: 9
    },
    children: [
      jsxs('div', {
        style: { alignItems: 'center', display: 'flex', gap: 6 },
        children: [
          jsx('strong', { style: { fontSize: 11 }, children: 'QC target' }),
          jsx(Badge, {
            variant: workbench.reviewContext?.stale && workbench.reviewContext.panelId === panelId ? 'warn' : reviewContextMatches(workbench, workbench.qcProfile) ? 'default' : 'warn',
            children: workbench.reviewContext?.stale && workbench.reviewContext.panelId === panelId
              ? 'STALE · TARGET CHANGED'
              : reviewContextMatches(workbench, workbench.qcProfile) ? `${panelId.toUpperCase()} LINKED`
              : hasTarget ? 'OPEN · NOT LINKED' : 'NO TARGET'
          }),
          linkedCapture ? jsx(Badge, { variant: 'muted', children: 'CAPTURE READY' }) : null
        ]
      }),
      jsx('div', {
        style: {
          color: hasTarget ? 'var(--ui-text-secondary)' : 'var(--ui-text-quaternary)',
          fontFamily: 'var(--ui-font-mono)',
          fontSize: 9,
          lineHeight: 1.4,
          marginTop: 6,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap'
        },
        title: panel.url,
        children: hasTarget ? panel.url : 'Link a Result or Reference from the Browser pane.'
      }),
      hasTarget
        ? jsx('div', {
            style: { color: 'var(--ui-text-quaternary)', fontSize: 9, marginTop: 4 },
            children: `${mediaKind(panel.url).toUpperCase()} · ${viewport.responsive ? 'responsive' : `${viewport.width}×${viewport.height}`} · ${panel.displayMode === 'actual' ? '100% actual' : 'fit'}`
          })
        : null,
      linkedCapture
        ? jsx('div', {
            style: { color: 'var(--ui-text-tertiary)', fontSize: 9, marginTop: 4 },
            children: `Evidence ${linkedCapture.width}×${linkedCapture.height}${linkedCapture.path ? ` · ${linkedCapture.path}` : ' · in-memory'}`
          })
        : null,
      jsxs('div', {
        style: { display: 'flex', flexWrap: 'wrap', gap: 5, marginTop: 8 },
        children: [
          ...['result', 'reference'].map(id => jsx(Button, {
            disabled: !workbench.browserPanels[id]?.url,
            onClick: () => linkBrowserPanelToQc(id),
            size: 'xs',
            variant: panelId === id ? 'default' : 'outline',
            children: id === 'result' ? 'Use Result' : 'Use Reference'
          }, id)),
          jsx(Button, {
            onClick: () => host.panes?.setOpen?.(BROWSER_PANE_ID, true),
            size: 'xs',
            variant: 'outline',
            children: 'Show Browser'
          }),
          jsx(Button, {
            disabled: !hasTarget || (mediaKind(panel.url) === 'page' && !window.hermesDesktop?.browser?.capture),
            onClick: captureEvidence,
            size: 'xs',
            variant: 'outline',
            children: linkedCapture ? 'Refresh evidence' : 'Capture evidence'
          }),
          jsx(Button, {
            disabled: !hasTarget || mediaKind(panel.url) !== 'page' || !window.hermesDesktop?.browser?.cdp,
            onClick: inspectTarget,
            size: 'xs',
            variant: 'outline',
            children: 'Inspect target'
          })
        ]
      }),
      status
        ? jsx('div', { role: 'status', style: { color: 'var(--ui-text-tertiary)', fontSize: 9, marginTop: 6 }, children: status })
        : null
    ]
  })
}

function CheckRow({ checkId, label, profileId }) {
  const workbench = useWorkbench()
  const hasReviewContext = reviewContextMatches(workbench, profileId)
  const evaluation = hasReviewContext
    ? workbench.evaluations[profileId]?.[checkId] || { status: 'pending', note: '' }
    : { status: 'pending', note: '' }

  const update = patch => {
    if (!reviewContextMatches(state, profileId)) {
      host.notify({ kind: 'warning', message: 'Link the target in the Browser pane before editing QC' })
      return
    }
    const profile = { ...(state.evaluations[profileId] || {}) }
    profile[checkId] = { ...evaluation, ...patch }
    setState({ evaluations: { ...state.evaluations, [profileId]: profile } })
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

function candidateHasReview(candidate) {
  if (!candidate) return false
  return Boolean(
    candidate.summary || candidate.evidence?.length || candidate.repairPrompt || candidate.score > 0 ||
    Object.values(candidate.dimensions || {}).some(dimension => dimension?.score > 0 || dimension?.evidence)
  )
}

function ReadinessRow({ label, value, variant = 'muted', detail = '' }) {
  return jsxs('div', {
    style: { alignItems: 'center', borderBottom: '1px solid var(--ui-stroke-tertiary)', display: 'grid', gap: 8, gridTemplateColumns: '96px minmax(0, 1fr)', padding: '7px 0' },
    children: [
      jsx('span', { style: { color: 'var(--ui-text-tertiary)', fontSize: 10 }, children: label }),
      jsxs('div', { style: { minWidth: 0 }, children: [
        jsx(Badge, { variant, children: value }),
        detail ? jsx('div', { style: { color: 'var(--ui-text-quaternary)', fontSize: 10, lineHeight: 1.35, marginTop: 4, overflowWrap: 'anywhere' }, children: detail }) : null
      ] })
    ]
  })
}

function QcReadinessCard({ workbench, profileId, provider }) {
  const panelId = workbench.qcTargetPanelId || 'result'
  const panel = workbench.browserPanels[panelId] || DEFAULT_BROWSER_PANELS[panelId]
  const hasTarget = Boolean(panel.url)
  const hasCapture = Boolean(workbench.capture?.panelId === panelId && workbench.capture?.targetId === panel.targetId &&
    workbench.capture?.url === panel.url &&
    JSON.stringify(workbench.capture?.viewport) === JSON.stringify(viewportFor(panel)))
  const hasInspection = Boolean(panel.inspection?.checkedAt && comparableUrl(panel.inspection.url) === comparableUrl(panel.url))
  const hasReviewContext = reviewContextMatches(workbench, profileId)
  const providerEvidence = hasReviewContext ? workbench.reviewContext.providerEvidence : null
  const manualValues = hasReviewContext ? Object.values(workbench.evaluations[profileId] || {}) : []
  const manualReviewed = manualValues.filter(value => ['pass', 'fail', 'na'].includes(value.status)).length
  const manualTotal = QC_PROFILES[profileId]?.checks?.length || 0
  const expectedCandidates = profileId === 'higgsfield-image'
    ? Math.min(providerEvidence?.count || 1, CANDIDATE_IDS.length)
    : CANDIDATE_IDS.length
  const candidateReviewed = hasReviewContext
    ? CANDIDATE_IDS.slice(0, expectedCandidates).filter(id => candidateHasReview(workbench.candidates[id])).length
    : 0
  const isStructured = Boolean(provider?.structuredReview)
  const isHiggsfield = profileId.startsWith('higgsfield-')
  const status = String(providerEvidence?.status || '').toLowerCase()
  const statusVariantForMcp = ['completed', 'succeeded'].includes(status)
    ? 'default'
    : ['failed', 'cancelled'].includes(status) ? 'destructive' : 'warn'
  const metadata = providerEvidence
    ? [
        providerEvidence.mediaType?.toUpperCase(),
        providerEvidence.width && providerEvidence.height ? `${providerEvidence.width}×${providerEvidence.height}` : '',
        providerEvidence.aspectRatio,
        providerEvidence.resolution,
        providerEvidence.duration ? `${providerEvidence.duration}s` : '',
        `${providerEvidence.referenceCount} ref`
      ].filter(Boolean).join(' · ')
    : ''

  return jsxs('div', {
    style: { borderTop: '1px solid var(--ui-stroke-secondary)', padding: '8px 12px 10px' },
    children: [
      jsxs('div', { style: { alignItems: 'center', display: 'flex', justifyContent: 'space-between' }, children: [
        jsx('strong', { style: { fontSize: 11 }, children: 'Inspection status' }),
        jsx('span', { style: { color: 'var(--ui-text-quaternary)', fontSize: 9 }, children: panelId.toUpperCase() })
      ] }),
      jsx(ReadinessRow, {
        label: 'Target', value: hasReviewContext ? 'LINKED' : hasTarget ? 'OPEN' : 'MISSING', variant: hasReviewContext ? 'default' : 'warn',
        detail: hasReviewContext ? `${mediaKind(panel.url).toUpperCase()} · ${panel.url}` : hasTarget ? 'Relink from the Browser pane to bind this target to QC.' : 'Open a Result or Reference target.'
      }),
      jsx(ReadinessRow, {
        label: 'Evidence', value: hasCapture ? 'CAPTURE READY' : 'NOT CAPTURED', variant: hasCapture ? 'default' : 'warn',
        detail: hasCapture ? `${workbench.capture.width}×${workbench.capture.height}${workbench.capture.path ? ' · saved' : ' · in-memory'}` : 'Capture the exact linked target before judging pixels.'
      }),
      mediaKind(panel.url) === 'page' ? jsx(ReadinessRow, {
        label: 'Target check', value: hasInspection ? 'CHECKED' : 'NOT CHECKED', variant: hasInspection ? 'default' : 'warn',
        detail: hasInspection ? panel.inspection.summary : 'Inspect the live Browser guest and viewport.'
      }) : null,
      isHiggsfield ? jsx(ReadinessRow, {
        label: 'Provider metadata', value: providerEvidence ? 'LINKED' : 'NOT LINKED', variant: providerEvidence ? 'default' : 'warn',
        detail: providerEvidence
          ? [providerEvidence.jobId || 'job id unavailable', providerEvidence.model || 'model unavailable', providerEvidence.soulId ? `Soul ${providerEvidence.soulId}` : ''].filter(Boolean).join(' · ')
          : 'Bind provenance from the Higgsfield CLI bridge or a Higgsfield tool result to attach job, model, prompt, and output settings.'
      }) : null,
      providerEvidence ? jsxs('div', { style: { padding: '8px 0 2px' }, children: [
        jsxs('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 5 }, children: [
          jsx(Badge, { variant: statusVariantForMcp, children: String(providerEvidence.status || 'UNKNOWN').toUpperCase() }),
          jsx(Badge, { variant: 'muted', children: providerEvidence.model || 'MODEL UNKNOWN' })
        ] }),
        metadata ? jsx('div', { style: { color: 'var(--ui-text-tertiary)', fontSize: 10, marginTop: 5 }, children: metadata }) : null,
        providerEvidence.prompt ? jsx('div', { style: { color: 'var(--ui-text-quaternary)', fontSize: 10, lineHeight: 1.4, marginTop: 5 }, children: providerEvidence.prompt.slice(0, 240) }) : null
      ] }) : null,
      jsx(ReadinessRow, {
        label: 'Review', value: isStructured ? `${candidateReviewed}/${expectedCandidates} REVIEWED` : `${manualReviewed}/${manualTotal} CHECKED`,
        variant: (isStructured ? candidateReviewed === expectedCandidates : manualReviewed === manualTotal) ? 'default' : 'warn',
        detail: isStructured
          ? `${hasReviewContext && workbench.selectedCandidate ? `Selected ${workbench.selectedCandidate}` : 'No candidate selected'} · ${workbench.job.state}`
          : `${manualValues.filter(value => value.status === 'fail').length} fail · ${manualValues.filter(value => value.status === 'pass').length} pass`
      }),
      profileId === 'midjourney' ? jsx(ReadinessRow, {
        label: 'Execution', value: 'READ ONLY', variant: 'muted',
        detail: 'Hermes internal Browser · persist:hermes-browser · no submit, variation, or upscale action.'
      }) : null,
      profileId === 'design' && mediaKind(panel.url) === 'page' ? jsx(Button, {
        onClick: () => {
          void runDesignPageChecks(panelId)
            .then(summary => host.notify({ kind: 'success', message: summary }))
            .catch(error => host.notify({ kind: 'warning', message: error instanceof Error ? error.message : String(error) }))
        },
        size: 'xs', style: { marginTop: 8, width: '100%' }, variant: 'outline', children: 'Run page checks'
      }) : null
    ]
  })
}

function dispositionVariant(disposition) {
  if (disposition === 'PASS') return 'default'
  if (disposition === 'REJECT') return 'destructive'
  return 'warn'
}

function JobEditor({ provider, workbench }) {
  const providerName = provider.label.replace(/ QC$/, '')
  const updateJob = patch => {
    if (!reviewContextMatches(state, provider.profileId)) {
      host.notify({ kind: 'warning', message: 'Link the target in the Browser pane before editing QC' })
      return
    }
    const now = new Date().toISOString()
    setState({ job: { ...state.job, ...patch, createdAt: state.job.createdAt || now, updatedAt: now } })
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
          jsx('span', { style: { color: 'var(--ui-text-quaternary)', fontSize: 10 }, children: `Status only · does not trigger ${providerName} actions` })
        ]
      }),
      jsx(Input, {
        'aria-label': `${providerName} job ID`,
        onChange: event => updateJob({ id: event.target.value }),
        placeholder: 'job-id',
        style: { marginTop: 8 },
        value: workbench.job.id
      }),
      jsx(Textarea, {
        'aria-label': `${providerName} job brief`,
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
  const reviewed = candidateHasReview(candidate)
  const update = patch => {
    if (!reviewContextMatches(state, provider.profileId)) {
      host.notify({ kind: 'warning', message: 'Link the target in the Browser pane before editing QC' })
      return
    }
    setState({ candidates: { ...state.candidates, [candidate.id]: { ...candidate, ...patch } } })
  }
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
          jsx(Badge, {
            variant: reviewed ? dispositionVariant(candidate.disposition) : 'muted',
            children: reviewed ? candidate.disposition : 'UNREVIEWED'
          }),
          jsx(Badge, { variant: 'muted', children: `${candidate.score}/100` }),
          jsx(Button, {
            onClick: () => {
              if (!reviewContextMatches(state, provider.profileId)) {
                host.notify({ kind: 'warning', message: 'Link the target in the Browser pane before editing QC' })
                return
              }
              setState({ selectedCandidate: candidate.id })
            },
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
  const wire = provider.qcDocument
  const panel = workbench.browserPanels[workbench.qcTargetPanelId || 'result'] || DEFAULT_BROWSER_PANELS.result
  const hasReviewContext = reviewContextMatches(workbench, provider.profileId)
  useEffect(() => setDraft(hasReviewContext ? workbench.qcJson || '' : ''), [hasReviewContext, workbench.qcJson])
  const visibleCandidateIds = provider.profileId === 'higgsfield-image'
    ? provider.candidateIds.slice(0, Math.min((hasReviewContext ? workbench.reviewContext.providerEvidence?.count : 1) || 1, provider.candidateIds.length))
    : provider.candidateIds

  const importQc = () => {
    if (!reviewContextMatches(state, provider.profileId)) {
      setImportError('Link the target in the Browser pane before editing QC')
      return
    }
    try {
      const document = wire.validate(draft)
      const formatted = JSON.stringify(document, null, 2)
      setState({
        job: document.job, candidates: Object.fromEntries(document.candidates.map(candidate => [candidate.id, candidate])),
        selectedCandidate: document.selectedCandidate, qcJson: formatted, qcProfile: provider.profileId
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
      if (!hasReviewContext) throw new Error('No review belongs to the currently linked target')
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
      jsx(AgentActivity, { activity: workbench.agentActivity }),
      jsx('div', { style: { padding: '0 12px 8px' }, children: jsx(ProfileSelect, { value: workbench.qcProfile }) }),
      jsx(QcTargetCard, { workbench }),
      jsx(QcReadinessCard, { workbench, profileId: provider.profileId, provider }),
      jsx(Separator, {}),
      jsx(ScrollArea, {
        style: { flex: 1, minHeight: 0 },
        children: jsxs('div', {
          children: [
            wire ? jsx(JobEditor, { provider, workbench: hasReviewContext ? workbench : { ...workbench, job: blankJob() } }) : null,
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
            ...visibleCandidateIds.map(id => jsx(CandidateCard, {
              candidate: hasReviewContext ? workbench.candidates[id] : blankCandidate(id),
              provider,
              selected: hasReviewContext && workbench.selectedCandidate === id
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
  const values = reviewContextMatches(workbench, workbench.qcProfile)
    ? Object.values(workbench.evaluations[workbench.qcProfile] || {})
    : []
  const failed = values.filter(value => value.status === 'fail').length
  const passed = values.filter(value => value.status === 'pass').length
  const targetPanelId = workbench.qcTargetPanelId || 'result'
  const targetPanel = workbench.browserPanels[targetPanelId] || DEFAULT_BROWSER_PANELS.result
  const hasResult = Boolean(targetPanel.url)
  const hasReference = Boolean(workbench.browserPanels.reference.url)
  const hasCapture = workbench.capture?.panelId === targetPanelId && workbench.capture?.targetId === targetPanel.targetId &&
    workbench.capture?.url === targetPanel.url &&
    JSON.stringify(workbench.capture?.viewport) === JSON.stringify(viewportFor(targetPanel))

  return jsxs('div', {
    style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 },
    children: [
      jsx(PanelIntro, { title: profile.label, description: profile.description }),
      jsx(AgentActivity, { activity: workbench.agentActivity }),
      jsx('div', { style: { padding: '0 12px 8px' }, children: jsx(ProfileSelect, { value: workbench.qcProfile }) }),
      jsx(QcTargetCard, { workbench }),
      jsx(QcReadinessCard, { workbench, profileId: workbench.qcProfile, provider }),
      jsxs('div', {
        style: { display: 'flex', gap: 6, padding: '0 12px 10px' },
        children: [
          jsx(Badge, { variant: failed ? 'destructive' : 'muted', children: `${failed} FAIL` }),
          jsx(Badge, { variant: passed ? 'default' : 'muted', children: `${passed} PASS` }),
          jsx('span', {
            style: { color: 'var(--ui-text-quaternary)', fontSize: 10, marginLeft: 'auto' },
            children: hasCapture ? 'CAPTURE READY' : hasResult && hasReference ? 'TARGET + REFERENCE' : reviewContextMatches(workbench, workbench.qcProfile) ? 'TARGET LINKED' : hasResult ? 'TARGET OPEN' : 'NO TARGET'
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
  name: 'Renderline',
  version: PLUGIN_VERSION,
  register(ctx) {
    pluginContext = ctx
    const savedV7 = ctx.storage.get('workbench.v7', null)
    const savedV6 = ctx.storage.get('workbench.v6', null)
    const savedV5 = ctx.storage.get('workbench.v5', null)
    const savedV4 = ctx.storage.get('workbench.v4', null)
    const savedV3 = ctx.storage.get('workbench.v3', null)
    const savedV2 = ctx.storage.get('workbench.v2', null)
    const savedV1 = ctx.storage.get('workbench.v1', DEFAULT_STATE)
    state = restoredState(savedV7 || savedV6 || savedV5 || savedV4 || savedV3 || savedV2 || savedV1)
    ctx.storage.set('workbench.v7', persistedState())
    const seenAgentCommandIds = new Set()
    ctx.socket('/commands', received => { void dispatchAgentCommand(ctx, received, seenAgentCommandIds) })
    const relayTimer = setInterval(() => { void relayPendingSelection(ctx) }, 1500)
    ctx.onDispose?.(() => clearInterval(relayTimer))

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
            setBrowserPanel('result', {
              url: input.src,
              qcProfileHint: qcProfileFor(input),
              providerEvidence: providerEvidenceFor(input)
            })
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
            setBrowserPanel('reference', {
              url: input.src,
              qcProfileHint: qcProfileFor(input),
              providerEvidence: providerEvidenceFor(input)
            })
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
            const profileId = qcProfileFor(input)
            setBrowserPanel('result', {
              url: input.src,
              qcProfileHint: profileId,
              providerEvidence: providerEvidenceFor(input)
            })
            linkBrowserPanelToQc('result', input)
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
