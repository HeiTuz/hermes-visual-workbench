export const PERSISTED_SCHEMA_VERSION = 7
export const QC_DOCUMENT_SCHEMA_VERSION = 1
export const MAX_QC_JSON_BYTES = 64 * 1024
export const CANDIDATE_IDS = Object.freeze(['A', 'B', 'C', 'D'])
export const DISPOSITIONS = Object.freeze(['PASS', 'REPAIR', 'REJECT'])
export const QC_PROFILE_IDS = Object.freeze(['design', 'higgsfield-image', 'higgsfield-video', 'midjourney'])
export const JOB_STATES = Object.freeze([
  'DRAFT',
  'READY',
  'SUBMITTED',
  'GENERATING',
  'GRID_READY',
  'QC_RUNNING',
  'SELECTED',
  'UPSCALING',
  'DOWNLOADED',
  'ATTACHED',
  'FAILED',
  'CANCELLED'
])
export const QC_DIMENSIONS = Object.freeze([
  'promptFidelity',
  'composition',
  'identityReferenceFidelity',
  'anatomyGeometry',
  'artifacts',
  'typography',
  'colorMaterialFidelity',
  'productionReadiness'
])

export const JOB_TRANSITIONS = Object.freeze({
  DRAFT: ['READY', 'FAILED', 'CANCELLED'],
  READY: ['SUBMITTED', 'FAILED', 'CANCELLED'],
  SUBMITTED: ['GENERATING', 'FAILED', 'CANCELLED'],
  GENERATING: ['GRID_READY', 'FAILED', 'CANCELLED'],
  GRID_READY: ['QC_RUNNING', 'FAILED', 'CANCELLED'],
  QC_RUNNING: ['SELECTED', 'FAILED', 'CANCELLED'],
  SELECTED: ['UPSCALING', 'DOWNLOADED', 'FAILED', 'CANCELLED'],
  UPSCALING: ['DOWNLOADED', 'FAILED', 'CANCELLED'],
  DOWNLOADED: ['ATTACHED', 'FAILED', 'CANCELLED'],
  ATTACHED: [],
  FAILED: [],
  CANCELLED: []
})

export function blankCandidate(id) {
  return {
    id,
    summary: '',
    score: 0,
    disposition: 'REJECT',
    evidence: [],
    repairPrompt: '',
    dimensions: Object.fromEntries(QC_DIMENSIONS.map(key => [key, { score: 0, evidence: '' }]))
  }
}

export function blankCandidates() {
  return Object.fromEntries(CANDIDATE_IDS.map(id => [id, blankCandidate(id)]))
}

export function blankJob() {
  return { id: '', state: 'DRAFT', brief: '', createdAt: '', updatedAt: '' }
}

function fail(path, message) {
  throw new Error(`${path}: ${message}`)
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
}

function boundedMetadataString(value, max = 4000) {
  return typeof value === 'string' ? value.slice(0, max) : ''
}
const URL_SECRET_PARAM = /(?:^|[_-])(?:token|sig(?:nature)?|expires?|key|auth(?:entication|orization)?|secret|credential|session)(?:$|[_-])/i

export function sanitizeUrl(value) {
  const raw = boundedMetadataString(value, 4096)
  if (!raw) return ''
  try {
    const url = new URL(raw)
    for (const key of [...url.searchParams.keys()]) {
      if (URL_SECRET_PARAM.test(key)) url.searchParams.delete(key)
    }
    const base = raw.split(/[?#]/, 1)[0]
    return url.searchParams.size ? `${base}?${url.searchParams}` : base
  } catch {
    return raw
  }
}

// Mandatory gate for any future Higgsfield provider invocation.
export async function invokeHiggsfieldReadOnly(toolName, invoke, ...args) {
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

export function restoredProviderEvidence(value) {
  if (!isRecord(value)) return null
  if (value.source === 'midjourney') {
    const jobId = boundedMetadataString(value.jobId, 128).toLowerCase()
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(jobId)) return null
    return {
      source: 'midjourney', jobId, operationId: boundedMetadataString(value.operationId, 128),
      resultUrl: sanitizeUrl(value.resultUrl)
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
export function providerEvidenceIdentity(evidence) {
  return evidence ? `${evidence.jobId}|${evidence.resultUrl}|${evidence.model}` : ''
}
export function midjourneyJobLocation(rawUrl) {
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
export function midjourneyProviderEvidenceForUrl(rawUrl) {
  const location = midjourneyJobLocation(rawUrl)
  return location.jobId && location.candidateIndex !== null
    ? restoredProviderEvidence({ source: 'midjourney', jobId: location.jobId, resultUrl: String(rawUrl) })
    : null
}

export function sameMidjourneyCandidateSwitch(previousUrl, nextUrl, linkedJobId) {
  const previous = midjourneyJobLocation(previousUrl)
  const next = midjourneyJobLocation(nextUrl)
  return Boolean(linkedJobId && previous.jobId === String(linkedJobId).toLowerCase() &&
    next.jobId === previous.jobId && previous.candidateIndex !== null &&
    Number.isInteger(next.candidateIndex) && next.candidateIndex >= 0 && previous.candidateIndex !== next.candidateIndex)
}

export function providerEvidenceFor(input = {}) {
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
      !QC_PROFILE_IDS.includes(value.profileId) || !['image', 'video', 'page'].includes(value.mediaKind) ||
      !isRecord(value.viewport) || typeof value.stale !== 'boolean' ||
      !['', 'url-changed', 'viewport-changed', 'panels-swapped', 'provenance-changed', 'load-failed'].includes(value.staleReason) ||
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

export function reviewContextMatches(current, profileId) {
  const panelId = current.qcTargetPanelId || 'result'
  const panel = current.browserPanels[panelId]
  const context = current.reviewContext
  return Boolean(panel?.url && context && !context.stale && context.profileId === profileId &&
    context.panelId === panelId && context.targetId === panel.targetId)
}

export function panelLinkedToQc(current, panelId) {
  const panel = current.browserPanels[panelId]
  const context = current.reviewContext
  return Boolean(panel?.url && context && !context.stale && current.qcTargetPanelId === panelId &&
    context.panelId === panelId && context.targetId === panel.targetId && context.profileId === current.qcProfile)
}
export function updatePanelState(state, panelId, patch, options = {}, makeId = createId) {
  const panel = state.browserPanels[panelId]
  if (!panel) return state
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
  const context = state.reviewContext
  const reviewContext = candidateSwitch && context?.panelId === panelId && context.targetId === panel.targetId && !context.stale
    ? { ...context, url: nextUrl, mediaKind: mediaKind(nextUrl), viewport: viewportFor(nextPanel), linkedAt: new Date().toISOString() }
    : targetChanged && context?.panelId === panelId && context.targetId === panel.targetId
      ? { ...context, stale: true, staleReason }
      : context
  return {
    ...state,
    browserPanels: { ...state.browserPanels, [panelId]: nextPanel },
    reviewContext,
    ...((targetChanged || candidateSwitch) && state.capture?.panelId === panelId ? { capture: null } : {})
  }
}

export function linkPanelState(state, panelId, input = {}, makeId = createId) {
  const panel = state.browserPanels[panelId]
  if (!panel?.url) return state
  const profileId = QC_PROFILE_IDS.includes(input.profileId)
    ? input.profileId
    : QC_PROFILE_IDS.includes(panel.qcProfileHint) ? panel.qcProfileHint : 'design'
  const inferredProviderEvidence = profileId === 'midjourney' ? midjourneyProviderEvidenceForUrl(panel.url) : null
  const providerEvidence = profileId === 'midjourney' ? inferredProviderEvidence : restoredProviderEvidence(panel.providerEvidence)
  const nextPanel = profileId === 'midjourney' && providerEvidenceIdentity(providerEvidence) !== providerEvidenceIdentity(panel.providerEvidence)
    ? { ...panel, providerEvidence }
    : panel
  const previous = state.reviewContext
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
    ...state,
    browserPanels: nextPanel === panel ? state.browserPanels : { ...state.browserPanels, [panelId]: nextPanel },
    browserSplit: panelId === 'reference' ? true : state.browserSplit,
    qcProfile: profileId, qcTargetPanelId: panelId, reviewContext,
    ...(same ? {} : {
      evaluations: {}, job: blankJob(), candidates: blankCandidates(), selectedCandidate: null, qcJson: '',
      ...(state.capture?.targetId !== panel.targetId ? { capture: null } : {})
    })
  }
}

export function swapPanelsState(state, makeId = createId) {
  const result = state.browserPanels.result
  const reference = state.browserPanels.reference
  if (!result || !reference) return state
  const context = state.reviewContext
  return {
    ...state,
    browserPanels: {
      ...state.browserPanels,
      result: { ...reference, targetId: makeId('t'), inspection: null },
      reference: { ...result, targetId: makeId('t'), inspection: null }
    },
    reviewContext: context && !context.stale && ['result', 'reference'].includes(context.panelId)
      ? { ...context, stale: true, staleReason: 'panels-swapped' }
      : context,
    capture: null
  }
}

export function markPanelLoadFailedState(state, panelId) {
  const panel = state.browserPanels[panelId]
  const context = state.reviewContext
  if (!panel || !context || context.stale || context.panelId !== panelId || context.targetId !== panel.targetId) return state
  return {
    ...state,
    reviewContext: { ...context, stale: true, staleReason: 'load-failed' },
    ...(state.capture?.panelId === panelId ? { capture: null } : {})
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
  if (!isRecord(value)) fail(path, 'must be an object')
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    const unknown = actual.filter(key => !wanted.includes(key))
    const missing = wanted.filter(key => !actual.includes(key))
    fail(path, [unknown.length ? `unknown fields ${unknown.join(', ')}` : '', missing.length ? `missing fields ${missing.join(', ')}` : ''].filter(Boolean).join('; '))
  }
}

function boundedString(value, path, max, { allowEmpty = true } = {}) {
  if (typeof value !== 'string') fail(path, 'must be a string')
  if (!allowEmpty && !value.trim()) fail(path, 'must not be empty')
  if (value.length > max) fail(path, `must be at most ${max} characters`)
  return value
}

function boundedScore(value, path) {
  if (!Number.isInteger(value) || value < 0 || value > 100) fail(path, 'must be an integer from 0 to 100')
  return value
}

function isoTimestamp(value, path, { allowEmpty = false } = {}) {
  boundedString(value, path, 64, { allowEmpty })
  if (!value && allowEmpty) return value
  if (!Number.isFinite(Date.parse(value))) fail(path, 'must be an ISO timestamp')
  return value
}

function validateDimension(value, path) {
  exactKeys(value, ['score', 'evidence'], path)
  return {
    score: boundedScore(value.score, `${path}.score`),
    evidence: boundedString(value.evidence, `${path}.evidence`, 2000)
  }
}

function validateCandidate(value, path, expectedId) {
  exactKeys(value, ['id', 'summary', 'score', 'disposition', 'evidence', 'repairPrompt', 'dimensions'], path)
  if (value.id !== expectedId) fail(`${path}.id`, `must be ${expectedId}`)
  if (!DISPOSITIONS.includes(value.disposition)) fail(`${path}.disposition`, `must be one of ${DISPOSITIONS.join(', ')}`)
  if (!Array.isArray(value.evidence) || value.evidence.length > 20) fail(`${path}.evidence`, 'must be an array with at most 20 items')
  const evidence = value.evidence.map((item, index) => boundedString(item, `${path}.evidence[${index}]`, 1000, { allowEmpty: false }))
  exactKeys(value.dimensions, QC_DIMENSIONS, `${path}.dimensions`)
  const dimensions = Object.fromEntries(
    QC_DIMENSIONS.map(key => [key, validateDimension(value.dimensions[key], `${path}.dimensions.${key}`)])
  )
  return {
    id: expectedId,
    summary: boundedString(value.summary, `${path}.summary`, 2000),
    score: boundedScore(value.score, `${path}.score`),
    disposition: value.disposition,
    evidence,
    repairPrompt: boundedString(value.repairPrompt, `${path}.repairPrompt`, 4000),
    dimensions
  }
}

export function validateQcDocument(input) {
  const text = typeof input === 'string' ? input : JSON.stringify(input)
  if (new TextEncoder().encode(text).byteLength > MAX_QC_JSON_BYTES) fail('$', `JSON exceeds ${MAX_QC_JSON_BYTES} bytes`)

  let value
  try {
    value = typeof input === 'string' ? JSON.parse(input) : input
  } catch (error) {
    fail('$', `malformed JSON (${error instanceof Error ? error.message : String(error)})`)
  }

  exactKeys(value, ['schemaVersion', 'job', 'selectedCandidate', 'candidates', 'generatedAt'], '$')
  if (value.schemaVersion !== QC_DOCUMENT_SCHEMA_VERSION) fail('$.schemaVersion', `must be ${QC_DOCUMENT_SCHEMA_VERSION}`)
  exactKeys(value.job, ['id', 'state', 'brief', 'createdAt', 'updatedAt'], '$.job')
  if (!JOB_STATES.includes(value.job.state)) fail('$.job.state', `must be one of ${JOB_STATES.join(', ')}`)
  const job = {
    id: boundedString(value.job.id, '$.job.id', 128, { allowEmpty: false }),
    state: value.job.state,
    brief: boundedString(value.job.brief, '$.job.brief', 8000),
    createdAt: isoTimestamp(value.job.createdAt, '$.job.createdAt'),
    updatedAt: isoTimestamp(value.job.updatedAt, '$.job.updatedAt')
  }
  if (value.selectedCandidate !== null && !CANDIDATE_IDS.includes(value.selectedCandidate)) {
    fail('$.selectedCandidate', 'must be null or A, B, C, D')
  }
  if (!Array.isArray(value.candidates) || value.candidates.length !== 4) fail('$.candidates', 'must contain exactly four candidates')
  const candidates = value.candidates.map((candidate, index) => validateCandidate(candidate, `$.candidates[${index}]`, CANDIDATE_IDS[index]))
  return {
    schemaVersion: QC_DOCUMENT_SCHEMA_VERSION,
    job,
    selectedCandidate: value.selectedCandidate,
    candidates,
    generatedAt: isoTimestamp(value.generatedAt, '$.generatedAt')
  }
}

export function nextJobStates(state) {
  if (!JOB_STATES.includes(state)) throw new Error(`Unknown job state: ${state}`)
  return [...JOB_TRANSITIONS[state]]
}

export function transitionJob(job, nextState, now = new Date().toISOString()) {
  if (!nextJobStates(job.state).includes(nextState)) throw new Error(`Invalid job transition: ${job.state} → ${nextState}`)
  return { ...job, state: nextState, updatedAt: now }
}

export function qcDocumentFromState(state, generatedAt = new Date().toISOString()) {
  const value = {
    schemaVersion: QC_DOCUMENT_SCHEMA_VERSION,
    job: state.job,
    selectedCandidate: state.selectedCandidate ?? null,
    candidates: CANDIDATE_IDS.map(id => state.candidates[id]),
    generatedAt
  }
  return validateQcDocument(value)
}

export function migratePersistedState(saved, defaults) {
  const source = isRecord(saved) ? saved : {}
  const legacyUrl = typeof source.browserUrl === 'string' ? source.browserUrl : ''
  const candidates = isRecord(source.candidates) ? source.candidates : {}
  const browserPanels = {
    result: restoredPanel(source.browserPanels?.result, defaults.browserPanels.result, legacyUrl),
    reference: restoredPanel(source.browserPanels?.reference, defaults.browserPanels.reference)
  }
  const reviewContext = restoredReviewContext(source.reviewContext, browserPanels, Number(source.schemaVersion) < 6)
  const restored = {
    ...defaults,
    schemaVersion: PERSISTED_SCHEMA_VERSION,
    browserSplit: source.browserSplit === true,
    browserPanels,
    qcTargetPanelId: ['result', 'reference'].includes(source.qcTargetPanelId) ? source.qcTargetPanelId : 'result',
    reviewContext,
    qcProfile: QC_PROFILE_IDS.includes(source.qcProfile) ? source.qcProfile : defaults.qcProfile,
    evaluations: restoredEvaluations(source.evaluations),
    job: restoredJob(source.job),
    candidates: Object.fromEntries(CANDIDATE_IDS.map(id => [id, restoredCandidate(candidates[id], id)])),
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

// Provider descriptor registry. Midjourney is the first adapter: its QC wire
// format is the frozen schema-v1 document contract (`validateQcDocument`).
// Descriptor dimensions MUST be drawn from the persisted schema-v7 candidate
// dimension vocabulary (`QC_DIMENSIONS`) so structured review state stays
// storable without a persisted-schema bump; `assertProviderRegistry` enforces
// this at module init.
export const PROVIDERS = Object.freeze({
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

export const PROVIDER_IDS = Object.freeze(Object.keys(PROVIDERS))

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

export function providerForProfile(profileId) {
  for (const providerId of PROVIDER_IDS) {
    if (PROVIDERS[providerId].profileId === profileId) return PROVIDERS[providerId]
  }
  return null
}

export function qcProfileFor(input = {}) {
  const src = String(input.src || '')
  const toolName = String(input.toolName || '').toLowerCase()
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
const HIGGSFIELD_ASPECTS = ['1:1', '16:9', '9:16']
const HIGGSFIELD_CONTROL_ACTIONS = ['capabilities', 'state', 'navigate', 'draft', 'validate', 'generate', 'results', 'qc']

function agentCommandError(message) {
  return { ok: false, error: message }
}

function hasOnlyKeys(value, keys) {
  return Object.keys(value).every(key => keys.includes(key))
}

function validAgentString(value, max) {
  return typeof value === 'string' && value.length <= max
}
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
export function validateHiggsfieldControlPayload(payload) {
  if (!isRecord(payload) || !HIGGSFIELD_CONTROL_ACTIONS.includes(payload.action)) return false
  if (['capabilities', 'state', 'validate', 'results', 'qc'].includes(payload.action)) return hasOnlyKeys(payload, ['action'])
  if (payload.action === 'navigate') return hasOnlyKeys(payload, ['action', 'url']) && validAgentString(payload.url, 4096) && /^https:\/\/(?:www\.)?higgsfield\.ai(?:\/|$)/i.test(payload.url)
  if (payload.action === 'draft') return hasOnlyKeys(payload, ['action', 'prompt', 'aspect', 'model']) && validAgentString(payload.prompt, 6000) && payload.prompt.trim().length > 0 && HIGGSFIELD_ASPECTS.includes(payload.aspect) && HIGGSFIELD_MODELS.includes(payload.model)
  if (payload.action === 'generate') return hasOnlyKeys(payload, ['action', 'billableConfirmed', 'idempotencyKey', 'validateReceipt', 'batchFingerprint']) && payload.billableConfirmed === true && validAgentString(payload.idempotencyKey, 128) && payload.idempotencyKey.length >= 8 && validAgentString(payload.validateReceipt, 80) && /^[a-f0-9]{64}$/.test(String(payload.batchFingerprint || ''))
  return false
}

export function validateAgentCommand(value) {
  if (!isRecord(value) || !hasOnlyKeys(value, ['id', 'op', 'panelId', 'payload'])) return agentCommandError('Command must be an object with only id, op, panelId, and payload')
  if (!validAgentString(value.id, 64) || !value.id) return agentCommandError('id must be a non-empty string of at most 64 characters')
  if (!AGENT_COMMAND_OPS.includes(value.op)) return agentCommandError('op is unknown')
  if (!isRecord(value.payload)) return agentCommandError('payload must be an object')

  const needsPanel = ['set-target', 'link', 'capture', 'inspect', 'page-checks', 'midjourney-probe', 'midjourney-control', 'higgsfield-control'].includes(value.op)
  if (needsPanel ? !AGENT_PANEL_IDS.includes(value.panelId) : Object.hasOwn(value, 'panelId')) {
    return agentCommandError(needsPanel ? 'panelId must be result or reference' : 'panelId is not allowed for this op')
  }

  const payload = value.payload
  if (value.op === 'status' && hasOnlyKeys(payload, [])) return { ok: true, command: value }
  if (value.op === 'set-target' && hasOnlyKeys(payload, ['url', 'preset', 'width', 'height', 'providerEvidence']) &&
      validAgentString(payload.url, 4096) && /^(https?|file|data):/i.test(payload.url) &&
      (!Object.hasOwn(payload, 'preset') || validAgentString(payload.preset, 64)) &&
      (!Object.hasOwn(payload, 'width') || Number.isInteger(payload.width) && payload.width >= 240) &&
      (!Object.hasOwn(payload, 'height') || Number.isInteger(payload.height) && payload.height >= 240) &&
      (!Object.hasOwn(payload, 'providerEvidence') || (restoredProviderEvidence(payload.providerEvidence) !== null && comparableUrl(restoredProviderEvidence(payload.providerEvidence).resultUrl) === comparableUrl(payload.url)))) return { ok: true, command: value }
  if (value.op === 'link' && hasOnlyKeys(payload, ['profileId']) &&
      (!Object.hasOwn(payload, 'profileId') || QC_PROFILE_IDS.includes(payload.profileId))) return { ok: true, command: value }
  if (['capture', 'inspect', 'page-checks', 'midjourney-probe'].includes(value.op) && hasOnlyKeys(payload, [])) return { ok: true, command: value }
  if (value.op === 'midjourney-control' && validateMidjourneyControlPayload(payload)) return { ok: true, command: value }
  if (value.op === 'higgsfield-control' && validateHiggsfieldControlPayload(payload)) return { ok: true, command: value }
  if (value.op === 'set-check' && hasOnlyKeys(payload, ['profileId', 'checkId', 'status', 'note']) &&
      QC_PROFILE_IDS.includes(payload.profileId) && validAgentString(payload.checkId, 64) && payload.checkId &&
      AGENT_CHECK_STATUSES.includes(payload.status) &&
      (!Object.hasOwn(payload, 'note') || validAgentString(payload.note, 2000))) return { ok: true, command: value }
  if (value.op === 'score-candidate' && hasOnlyKeys(payload, ['candidateId', 'summary', 'score', 'disposition', 'repairPrompt', 'dimensions']) &&
      CANDIDATE_IDS.includes(payload.candidateId) &&
      (!Object.hasOwn(payload, 'summary') || validAgentString(payload.summary, 2000)) &&
      (!Object.hasOwn(payload, 'score') || Number.isInteger(payload.score) && payload.score >= 0 && payload.score <= 100) &&
      (!Object.hasOwn(payload, 'disposition') || DISPOSITIONS.includes(payload.disposition)) &&
      (!Object.hasOwn(payload, 'repairPrompt') || validAgentString(payload.repairPrompt, 4000)) &&
      (!Object.hasOwn(payload, 'dimensions') || isRecord(payload.dimensions) && Object.entries(payload.dimensions).every(([key, dimension]) =>
        QC_DIMENSIONS.includes(key) && isRecord(dimension) && hasOnlyKeys(dimension, ['score', 'evidence']) &&
        Number.isInteger(dimension.score) && dimension.score >= 0 && dimension.score <= 100 &&
        validAgentString(dimension.evidence, 2000)))) return { ok: true, command: value }
  if (value.op === 'select-candidate' && hasOnlyKeys(payload, ['candidateId']) && CANDIDATE_IDS.includes(payload.candidateId)) return { ok: true, command: value }
  if (value.op === 'import-qc' && hasOnlyKeys(payload, ['json']) && validAgentString(payload.json, MAX_QC_JSON_BYTES)) return { ok: true, command: value }
  return agentCommandError(`Invalid payload for ${value.op}`)
}

function agentCandidateReviewed(candidate) {
  return Boolean(candidate?.summary || candidate?.evidence?.length || candidate?.repairPrompt || candidate?.score > 0 ||
    Object.values(candidate?.dimensions || {}).some(dimension => dimension?.score > 0 || dimension?.evidence))
}

export function agentStatusSnapshot(state) {
  const context = state.reviewContext
  return {
    qcProfile: state.qcProfile,
    qcTargetPanelId: state.qcTargetPanelId,
    reviewContext: context ? {
      contextId: context.contextId, panelId: context.panelId, targetId: context.targetId, profileId: context.profileId,
      url: sanitizeUrl(context.url), mediaKind: context.mediaKind, stale: context.stale, staleReason: context.staleReason,
      providerJobId: context.providerEvidence?.jobId || ''
    } : null,
    panels: Object.fromEntries(AGENT_PANEL_IDS.map(panelId => {
      const panel = state.browserPanels[panelId] || {}
      return [panelId, { url: sanitizeUrl(panel.url), targetId: panel.targetId || '', mediaKind: mediaKind(panel.url) }]
    })),
    capture: state.capture ? {
      panelId: state.capture.panelId, targetId: state.capture.targetId, url: sanitizeUrl(state.capture.url),
      ...(state.capture.viewport ? { viewport: state.capture.viewport } : {}),
      width: state.capture.width, height: state.capture.height, path: state.capture.path
    } : null,
    evaluations: Object.fromEntries(Object.entries(state.evaluations || {}).map(([profileId, checks]) => [
      profileId, Object.fromEntries(Object.entries(checks || {}).map(([checkId, evaluation]) => [checkId, { status: evaluation.status }]))
    ])),
    candidates: Object.fromEntries(CANDIDATE_IDS.map(id => {
      const candidate = state.candidates?.[id] || blankCandidate(id)
      return [id, { score: candidate.score, disposition: candidate.disposition, reviewed: agentCandidateReviewed(candidate) }]
    })),
    selectedCandidate: state.selectedCandidate,
    jobState: state.job?.state || 'DRAFT'
  }
}

export function applyAgentCommand(state, command, makeId = createId) {
  const guardError = 'Link the target in the Browser pane before editing QC'
  const { op, payload } = command
  if (op === 'status') return { state, summary: 'Status snapshot' }
  if (op === 'set-target') {
    const patch = Object.fromEntries(Object.entries(payload).filter(([key]) => ['url', 'preset', 'width', 'height', 'providerEvidence'].includes(key)))
    return { state: updatePanelState(state, command.panelId, patch, {}, makeId), summary: `Set ${command.panelId} target` }
  }
  if (op === 'link') {
    const panel = state.browserPanels[command.panelId]
    const profileId = payload.profileId || (QC_PROFILE_IDS.includes(panel?.qcProfileHint) ? panel.qcProfileHint : qcProfileFor({ src: panel?.url }))
    if (!panel?.url) return { error: `Open a ${command.panelId} target before linking it to Quality Control` }
    return { state: linkPanelState(state, command.panelId, { profileId }, makeId), summary: `Linked ${command.panelId} to ${profileId}` }
  }
  if (op === 'set-check') {
    if (!reviewContextMatches(state, payload.profileId)) return { error: guardError }
    const profile = { ...(state.evaluations[payload.profileId] || {}) }
    profile[payload.checkId] = { ...profile[payload.checkId], status: payload.status, ...(Object.hasOwn(payload, 'note') ? { note: payload.note } : {}) }
    return { state: { ...state, evaluations: { ...state.evaluations, [payload.profileId]: profile } }, summary: `Set ${payload.checkId} to ${payload.status}` }
  }
  if (op === 'score-candidate') {
    if (!reviewContextMatches(state, state.qcProfile)) return { error: guardError }
    const candidate = state.candidates[payload.candidateId]
    const patch = Object.fromEntries(Object.entries(payload).filter(([key]) => ['summary', 'score', 'disposition', 'repairPrompt'].includes(key)))
    if (payload.dimensions) patch.dimensions = { ...candidate.dimensions, ...payload.dimensions }
    return { state: { ...state, candidates: { ...state.candidates, [payload.candidateId]: { ...candidate, ...patch } } }, summary: `Scored candidate ${payload.candidateId}` }
  }
  if (op === 'select-candidate') {
    if (!reviewContextMatches(state, state.qcProfile)) return { error: guardError }
    return { state: { ...state, selectedCandidate: payload.candidateId }, summary: `Selected candidate ${payload.candidateId}` }
  }
  return { error: `${op} is not a pure agent command` }
}
