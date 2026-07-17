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
  providerEvidenceFor,
  providerForProfile,
  QC_DIMENSIONS,
  QC_PROFILE_IDS,
  qcProfileFor,
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
  return Function(`${source}\nreturn { DEFAULT_STATE, persistedState, restoredState, validateQcDocument, PROVIDERS, PROVIDER_IDS, providerEvidenceFor, providerForProfile, qcProfileFor, setRuntimeState(value) { state = { ...DEFAULT_STATE, ...value } } }`)()
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
    qcTargetPanelId: 'bogus',
    qcProfile: 'unknown-profile',
    job: { id: 42, state: 'UNKNOWN', brief: null },
    browserPanels: {
      result: { displayMode: 'actual' },
      reference: { displayMode: 'unknown' }
    },
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
  assert.equal(restored.qcTargetPanelId, 'result')
  assert.equal(restored.job.id, '')
  assert.equal(restored.job.state, 'DRAFT')
  assert.equal(restored.browserPanels.result.displayMode, 'actual')
  assert.equal(restored.browserPanels.reference.displayMode, 'fit')
  assert.deepEqual(restored.candidates.A.evidence, [])
  assert.equal(restored.candidates.A.dimensions.composition.score, 88)
  assert.equal(restored.candidates.A.dimensions.promptFidelity.score, 0)
})

test('runtime persistence drops ephemeral captures and preserves durable provenance', () => {
  const runtime = loadRuntimeCore()
  const capture = {
    panelId: 'result',
    url: 'https://example.test/result',
    width: 768,
    height: 1024,
    createdAt: 1_752_710_400_000,
    path: ''
  }
  runtime.setRuntimeState({ capture })
  assert.equal(runtime.persistedState().capture, null)

  const durable = { ...capture, path: '/tmp/result.png' }
  runtime.setRuntimeState({ capture: durable })
  assert.deepEqual(runtime.persistedState().capture, durable)

  const restored = runtime.restoredState({
    browserPanels: { result: { qcProfileHint: 'higgsfield-image' } },
    capture: durable
  })
  assert.equal(restored.browserPanels.result.qcProfileHint, 'higgsfield-image')
  assert.equal(restored.capture.createdAt, durable.createdAt)
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

test('runtime Higgsfield MCP provenance extraction stays aligned with the standalone QC core', () => {
  const runtime = loadRuntimeCore()
  const input = {
    src: 'https://cdn.example.test/result.mp4',
    toolName: 'mcp__higgsfield__show_generations',
    toolResult: {
      structuredContent: {
        items: [{
          id: 'video-job', model: 'seedance_2_0', status: 'completed', type: 'video',
          params: { aspect_ratio: '9:16', duration: 5, resolution: '720p' },
          results: { rawUrl: 'https://cdn.example.test/result.mp4' }
        }]
      }
    }
  }

  const actual = runtime.providerEvidenceFor(input)
  const expected = providerEvidenceFor(input)
  assert.deepEqual({ ...actual, checkedAt: '' }, { ...expected, checkedAt: '' })
})

test('runtime QC target routing and Browser-to-QC controls stay connected', () => {
  const runtime = loadRuntimeCore()
  for (const input of [
    { src: 'https://www.midjourney.com/explore' },
    { src: 'https://cdn.example.test/grid.png', toolName: 'midjourney' },
    { src: 'https://cdn.example.test/clip.mp4' },
    { src: 'https://example.test/page' }
  ]) {
    assert.equal(runtime.qcProfileFor(input), qcProfileFor(input))
  }
  assert.match(pluginSource, /children: workbench\.qcTargetPanelId === panelId \? 'QC Linked' : 'Review in QC'/)
  assert.match(pluginSource, /children: linkedCapture \? 'Refresh evidence' : 'Capture evidence'/)
  assert.match(pluginSource, /pluginContext\?\.storage\.set\('workbench\.v5'/)
  assert.match(pluginSource, /element\.addEventListener\('did-navigate', syncUrl\)/)
  assert.match(pluginSource, /browserSplit: panelId === 'reference' \? true : state\.browserSplit/)
  assert.match(pluginSource, /children: 'Inspection status'/)
  assert.match(pluginSource, /label: 'MCP metadata'/)
  assert.match(pluginSource, /children: 'Run page checks'/)
  assert.match(pluginSource, /value: 'READ ONLY'/)
  assert.match(pluginSource, /providerEvidence: providerEvidenceFor\(input\)/)
  assert.match(pluginSource, /children: reviewed \? candidate\.disposition : 'UNREVIEWED'/)
  assert.match(pluginSource, /reviewContextMatches\(workbench, profileId\)/)
  assert.match(pluginSource, /Page checks returned incomplete CDP audit data/)
  assert.match(pluginSource, /browserApi\.audit\(guestId\)/)
  assert.doesNotMatch(pluginSource, /Runtime\.evaluate/)
  assert.match(pluginSource, /preserveProviderEvidence: preserveProvenance/)
  assert.match(pluginSource, /reviewContextMatches\(state, 'design'\) \? \{ \.\.\.\(state\.evaluations\.design \|\| \{\}\) \} : \{\}/)
  assert.match(pluginSource, /hasReviewContext \? \{\} : \{ candidates: blankCandidates\(\), selectedCandidate: null, qcJson: '' \}/)
})
