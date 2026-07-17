export const PERSISTED_SCHEMA_VERSION = 5
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
  const nested = ['structuredContent', 'result', 'data', 'items', 'generations', 'jobs']
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
  if (!isRecord(value) || value.source !== 'higgsfield-mcp') return null
  const width = Number.isFinite(value.width) && value.width > 0 ? Math.round(value.width) : 0
  const height = Number.isFinite(value.height) && value.height > 0 ? Math.round(value.height) : 0
  const duration = Number.isFinite(value.duration) && value.duration > 0 ? value.duration : 0
  const count = Number.isInteger(value.count) && value.count > 0 ? Math.min(value.count, 20) : 1
  const referenceCount = Number.isInteger(value.referenceCount) && value.referenceCount >= 0 ? Math.min(value.referenceCount, 20) : 0
  return {
    source: 'higgsfield-mcp',
    jobId: boundedMetadataString(value.jobId, 128),
    status: boundedMetadataString(value.status, 64),
    model: boundedMetadataString(value.model, 128),
    mediaType: ['image', 'video', 'audio', '3d'].includes(value.mediaType) ? value.mediaType : '',
    prompt: boundedMetadataString(value.prompt),
    width,
    height,
    duration,
    aspectRatio: boundedMetadataString(value.aspectRatio, 32),
    resolution: boundedMetadataString(value.resolution, 32),
    count,
    referenceCount,
    resultUrl: boundedMetadataString(value.resultUrl, 4096),
    createdAt: typeof value.createdAt === 'string' || Number.isFinite(value.createdAt) ? value.createdAt : '',
    checkedAt: boundedMetadataString(value.checkedAt, 64)
  }
}

export function providerEvidenceFor(input = {}) {
  const toolName = String(input.toolName || '').toLowerCase()
  if (!toolName.includes('higgsfield')) return null
  const records = providerRecords(input.toolResult)
  const src = String(input.src || '')
  const matching = records.filter(record => resultUrls(record).some(url => comparableUrl(url) === comparableUrl(src)))
  const recordsWithUrls = records.filter(record => resultUrls(record).length > 0)
  const record = matching[0] || (recordsWithUrls.length === 0 && records.length === 1 ? records[0] : null)
  if (!record) return null
  const params = isRecord(record.params) ? record.params : {}
  const urls = resultUrls(record)
  const mediaType = ['image', 'video', 'audio', '3d'].includes(record.type)
    ? record.type
    : /\.(mp4|mov|webm|mkv|avi)(?:[?#]|$)/i.test(src) ? 'video' : 'image'
  return restoredProviderEvidence({
    source: 'higgsfield-mcp',
    jobId: record.id || record.jobId || record.job_id || '',
    status: record.status || '',
    model: record.model || params.model || '',
    mediaType,
    prompt: params.prompt || record.prompt || '',
    width: params.width || record.width || 0,
    height: params.height || record.height || 0,
    duration: params.duration || record.duration || 0,
    aspectRatio: params.aspect_ratio || record.aspect_ratio || '',
    resolution: params.resolution || record.resolution || '',
    count: params.batch_size || params.count || record.count || 1,
    referenceCount: Array.isArray(params.medias) ? params.medias.length : 0,
    resultUrl: urls.find(url => comparableUrl(url) === comparableUrl(src)) || urls[0] || src,
    createdAt: record.createdAt || record.created_at || '',
    checkedAt: new Date().toISOString()
  })
}

function restoredInspection(value) {
  if (!isRecord(value)) return null
  return {
    url: boundedMetadataString(value.url, 4096),
    summary: boundedMetadataString(value.summary, 1000),
    checkedAt: boundedMetadataString(value.checkedAt, 64)
  }
}

function restoredReviewContext(value) {
  if (!isRecord(value) || !QC_PROFILE_IDS.includes(value.profileId) || !['result', 'reference'].includes(value.panelId)) return null
  const url = boundedMetadataString(value.url, 4096)
  return url ? { profileId: value.profileId, panelId: value.panelId, url } : null
}

export function reviewContextMatches(current, profileId) {
  const panelId = current.qcTargetPanelId || 'result'
  const panel = current.browserPanels[panelId]
  return Boolean(
    panel?.url && current.reviewContext?.profileId === profileId && current.reviewContext?.panelId === panelId &&
    current.reviewContext?.url === panel.url
  )
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
  if (!isRecord(value) || !['result', 'reference'].includes(value.panelId)) return null
  if (!Number.isInteger(value.width) || value.width <= 0 || !Number.isInteger(value.height) || value.height <= 0) return null
  if (typeof value.path !== 'string' || !value.path) return null
  return {
    panelId: value.panelId,
    url: typeof value.url === 'string' ? value.url : '',
    width: value.width,
    height: value.height,
    createdAt: Number.isFinite(value.createdAt) ? value.createdAt : typeof value.createdAt === 'string' ? value.createdAt : '',
    path: typeof value.path === 'string' ? value.path : ''
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
  return {
    ...defaults,
    schemaVersion: PERSISTED_SCHEMA_VERSION,
    browserSplit: source.browserSplit === true,
    browserPanels: {
      result: restoredPanel(source.browserPanels?.result, defaults.browserPanels.result, legacyUrl),
      reference: restoredPanel(source.browserPanels?.reference, defaults.browserPanels.reference)
    },
    qcTargetPanelId: ['result', 'reference'].includes(source.qcTargetPanelId) ? source.qcTargetPanelId : 'result',
    reviewContext: restoredReviewContext(source.reviewContext),
    qcProfile: QC_PROFILE_IDS.includes(source.qcProfile) ? source.qcProfile : defaults.qcProfile,
    evaluations: restoredEvaluations(source.evaluations),
    job: restoredJob(source.job),
    candidates: Object.fromEntries(CANDIDATE_IDS.map(id => [id, restoredCandidate(candidates[id], id)])),
    selectedCandidate: CANDIDATE_IDS.includes(source.selectedCandidate) ? source.selectedCandidate : null,
    qcJson: typeof source.qcJson === 'string' ? source.qcJson : '',
    capture: restoredCapture(source.capture)
  }
}

// Provider descriptor registry. Midjourney is the first adapter: its QC wire
// format is the frozen schema-v1 document contract (`validateQcDocument`).
// Descriptor dimensions MUST be drawn from the persisted schema-v5 candidate
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
      if (!QC_DIMENSIONS.includes(key)) throw new Error(`Provider ${providerId}: dimension ${key} is not storable in persisted schema v2`)
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
