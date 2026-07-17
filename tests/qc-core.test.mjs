import assert from 'node:assert/strict'
import test from 'node:test'

import {
  blankCandidate,
  blankCandidates,
  blankJob,
  CANDIDATE_IDS,
  MAX_QC_JSON_BYTES,
  migratePersistedState,
  nextJobStates,
  QC_DIMENSIONS,
  qcDocumentFromState,
  transitionJob,
  validateQcDocument
} from '../scripts/qc-core.mjs'

const NOW = '2026-07-17T00:00:00.000Z'

function validDocument() {
  const job = { ...blankJob(), id: 'fixture-1', state: 'GRID_READY', brief: 'Four candidate grid', createdAt: NOW, updatedAt: NOW }
  const candidates = CANDIDATE_IDS.map((id, index) => {
    const value = blankCandidate(id)
    value.score = 90 - index * 10
    value.disposition = index === 0 ? 'PASS' : index === 1 ? 'REPAIR' : 'REJECT'
    value.summary = `Candidate ${id}`
    value.evidence = [`Evidence ${id}`]
    value.repairPrompt = index === 1 ? 'Repair candidate B.' : ''
    value.dimensions = Object.fromEntries(QC_DIMENSIONS.map(key => [key, { score: value.score, evidence: `${key} evidence` }]))
    return value
  })
  return { schemaVersion: 1, job, selectedCandidate: 'A', candidates, generatedAt: NOW }
}

test('accepts and normalizes a strict four-candidate QC document', () => {
  const document = validateQcDocument(JSON.stringify(validDocument()))
  assert.equal(document.selectedCandidate, 'A')
  assert.deepEqual(document.candidates.map(item => item.id), CANDIDATE_IDS)
  assert.deepEqual(Object.keys(document.candidates[0].dimensions), QC_DIMENSIONS)
})

test('rejects malformed, oversized, unknown-field, missing-field, and invalid-range inputs', () => {
  assert.throws(() => validateQcDocument('{'), /malformed JSON/)
  assert.throws(() => validateQcDocument(' '.repeat(MAX_QC_JSON_BYTES + 1)), /exceeds/)

  const unknown = validDocument()
  unknown.secret = 'nope'
  assert.throws(() => validateQcDocument(unknown), /unknown fields secret/)

  const missing = validDocument()
  delete missing.job.brief
  assert.throws(() => validateQcDocument(missing), /missing fields brief/)

  const invalid = validDocument()
  invalid.candidates[0].score = 101
  assert.throws(() => validateQcDocument(invalid), /0 to 100/)
})

test('does not mutate prior good state when an import fails', () => {
  const good = validateQcDocument(validDocument())
  const snapshot = structuredClone(good)
  assert.throws(() => validateQcDocument('{"schemaVersion":1}'), /missing fields/)
  assert.deepEqual(good, snapshot)
})

test('enforces bounded job transitions', () => {
  const ready = transitionJob({ ...blankJob(), id: 'job', state: 'DRAFT' }, 'READY', NOW)
  assert.equal(ready.state, 'READY')
  assert.deepEqual(nextJobStates('READY'), ['SUBMITTED', 'FAILED', 'CANCELLED'])
  assert.throws(() => transitionJob(ready, 'GRID_READY', NOW), /Invalid job transition/)
  assert.deepEqual(nextJobStates('ATTACHED'), [])
})

test('migrates v0.1 persisted state without losing browser and evaluation data', () => {
  const defaults = {
    schemaVersion: 2,
    browserSplit: false,
    browserPanels: {
      result: { url: '', preset: 'desktop', width: 1440, height: 900 },
      reference: { url: '', preset: 'mobile', width: 390, height: 844 }
    },
    qcProfile: 'design', evaluations: {}, job: blankJob(), candidates: blankCandidates(), selectedCandidate: null
  }
  const legacy = { browserUrl: 'https://example.test', qcProfile: 'higgsfield-image', evaluations: { design: { composition: { status: 'pass', note: 'kept' } } } }
  const migrated = migratePersistedState(legacy, defaults)
  assert.equal(migrated.schemaVersion, 2)
  assert.equal(migrated.browserPanels.result.url, 'https://example.test')
  assert.equal(migrated.evaluations.design.composition.note, 'kept')
  assert.deepEqual(Object.keys(migrated.candidates), CANDIDATE_IDS)
})

test('repairs malformed persisted candidate fields and deep-merges partial dimensions', () => {
  const defaults = {
    schemaVersion: 2,
    browserSplit: false,
    browserPanels: {
      result: { url: '', preset: 'desktop', width: 1440, height: 900 },
      reference: { url: '', preset: 'mobile', width: 390, height: 844 }
    },
    qcProfile: 'design', evaluations: {}, job: blankJob(), candidates: blankCandidates(), selectedCandidate: null,
    qcJson: '', capture: null
  }
  const migrated = migratePersistedState({
    qcProfile: 'bogus',
    job: { id: 7, state: 'BROKEN', brief: null },
    candidates: {
      A: {
        score: 999,
        evidence: 'not-an-array',
        dimensions: { composition: { score: 88, evidence: 'kept' } }
      }
    }
  }, defaults)

  assert.equal(migrated.qcProfile, 'design')
  assert.deepEqual(migrated.job, blankJob())
  assert.equal(migrated.candidates.A.score, 0)
  assert.deepEqual(migrated.candidates.A.evidence, [])
  assert.equal(migrated.candidates.A.dimensions.composition.score, 88)
  assert.equal(migrated.candidates.A.dimensions.promptFidelity.score, 0)
})

test('exports current state through the same strict validator', () => {
  const source = validDocument()
  const state = {
    job: source.job,
    selectedCandidate: source.selectedCandidate,
    candidates: Object.fromEntries(source.candidates.map(item => [item.id, item]))
  }
  assert.deepEqual(qcDocumentFromState(state, NOW), source)
})
