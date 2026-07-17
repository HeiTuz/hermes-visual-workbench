import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'

import {
  blankCandidate,
  CANDIDATE_IDS,
  migratePersistedState,
  PROVIDER_IDS,
  PROVIDERS,
  providerForProfile,
  QC_DIMENSIONS,
  QC_PROFILE_IDS,
  validateQcDocument
} from '../scripts/qc-core.mjs'

const NOW = '2026-07-17T00:00:00.000Z'
const root = resolve(import.meta.dirname, '..')
const pluginSource = await readFile(resolve(root, 'plugin.js'), 'utf8')

function validDocument() {
  return {
    schemaVersion: 1,
    job: { id: 'runtime-parity', state: 'GRID_READY', brief: 'Runtime parity', createdAt: NOW, updatedAt: NOW },
    selectedCandidate: 'A',
    candidates: CANDIDATE_IDS.map((id, index) => {
      const candidate = blankCandidate(id)
      candidate.summary = `Candidate ${id}`
      candidate.score = 90 - index * 10
      candidate.disposition = index === 0 ? 'PASS' : index === 1 ? 'REPAIR' : 'REJECT'
      candidate.evidence = [`Evidence ${id}`]
      candidate.dimensions = Object.fromEntries(
        QC_DIMENSIONS.map(key => [key, { score: candidate.score, evidence: `${key} evidence` }])
      )
      return candidate
    }),
    generatedAt: NOW
  }
}

function loadRuntimeCore() {
  const begin = '// WORKBENCH_CORE_BEGIN'
  const end = '// WORKBENCH_CORE_END'
  const start = pluginSource.indexOf(begin)
  const finish = pluginSource.indexOf(end)
  assert.notEqual(start, -1, 'plugin core begin marker is missing')
  assert.notEqual(finish, -1, 'plugin core end marker is missing')
  assert.ok(finish > start, 'plugin core markers are out of order')
  const source = pluginSource.slice(start + begin.length, finish)
  return Function(`${source}\nreturn { DEFAULT_STATE, restoredState, validateQcDocument, PROVIDERS, PROVIDER_IDS, providerForProfile }`)()
}

function serializableProvider(provider) {
  return {
    id: provider.id,
    label: provider.label,
    profileId: provider.profileId,
    candidateIds: [...provider.candidateIds],
    structuredReview: provider.structuredReview,
    dimensions: [...provider.dimensions],
    dimensionLabels: { ...provider.dimensionLabels },
    chatImageToolNames: [...provider.chatImageToolNames],
    qcDocument: provider.qcDocument
      ? { schemaVersion: provider.qcDocument.schemaVersion, maxBytes: provider.qcDocument.maxBytes }
      : null,
    automation: provider.automation ? { ...provider.automation } : null
  }
}

test('runtime plugin validator stays behaviorally aligned with the standalone QC core', () => {
  const runtime = loadRuntimeCore()
  const document = validDocument()
  assert.deepEqual(runtime.validateQcDocument(document), validateQcDocument(document))

  for (const mutate of [
    value => { value.extra = true },
    value => { value.candidates[0].score = 101 },
    value => { value.candidates[1].dimensions.composition.extra = true }
  ]) {
    const value = structuredClone(document)
    mutate(value)
    assert.throws(() => runtime.validateQcDocument(value))
    assert.throws(() => validateQcDocument(value))
  }
})

test('runtime persisted-state restore repairs malformed and partial candidate data', () => {
  const runtime = loadRuntimeCore()
  const saved = {
    qcProfile: 'unknown-profile',
    job: { id: 42, state: 'UNKNOWN', brief: null },
    candidates: {
      A: {
        evidence: 'not-an-array',
        dimensions: { composition: { score: 88, evidence: 'kept' } }
      }
    }
  }
  const restored = runtime.restoredState(saved)

  assert.deepEqual(restored, migratePersistedState(saved, runtime.DEFAULT_STATE))
  assert.equal(restored.qcProfile, 'design')
  assert.equal(restored.job.id, '')
  assert.equal(restored.job.state, 'DRAFT')
  assert.deepEqual(restored.candidates.A.evidence, [])
  assert.equal(restored.candidates.A.dimensions.composition.score, 88)
  assert.equal(restored.candidates.A.dimensions.promptFidelity.score, 0)
})

test('runtime provider registry stays behaviorally aligned with the standalone QC core', () => {
  const runtime = loadRuntimeCore()
  assert.deepEqual([...runtime.PROVIDER_IDS], [...PROVIDER_IDS])
  for (const providerId of PROVIDER_IDS) {
    assert.deepEqual(serializableProvider(runtime.PROVIDERS[providerId]), serializableProvider(PROVIDERS[providerId]))
  }
  for (const profileId of [...QC_PROFILE_IDS, 'unknown-profile']) {
    assert.equal(runtime.providerForProfile(profileId)?.id ?? null, providerForProfile(profileId)?.id ?? null)
  }

  const document = validDocument()
  assert.deepEqual(runtime.PROVIDERS.midjourney.qcDocument.validate(document), PROVIDERS.midjourney.qcDocument.validate(document))
  assert.equal(PROVIDERS.midjourney.qcDocument.validate, validateQcDocument, 'standalone adapter must reuse the schema-v1 validator')
  assert.equal(runtime.PROVIDERS.midjourney.qcDocument.validate, runtime.validateQcDocument, 'runtime adapter must reuse the schema-v1 validator')
})
