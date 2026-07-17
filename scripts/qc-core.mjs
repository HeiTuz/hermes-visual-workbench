export const PERSISTED_SCHEMA_VERSION = 2
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
    qcProfile: QC_PROFILE_IDS.includes(source.qcProfile) ? source.qcProfile : defaults.qcProfile,
    evaluations: restoredEvaluations(source.evaluations),
    job: restoredJob(source.job),
    candidates: Object.fromEntries(CANDIDATE_IDS.map(id => [id, restoredCandidate(candidates[id], id)])),
    selectedCandidate: CANDIDATE_IDS.includes(source.selectedCandidate) ? source.selectedCandidate : null,
    qcJson: typeof source.qcJson === 'string' ? source.qcJson : '',
    capture: restoredCapture(source.capture)
  }
}
