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
  PERSISTED_SCHEMA_VERSION,
  PROVIDER_IDS,
  PROVIDERS,
  providerEvidenceFor,
  providerForProfile,
  QC_DIMENSIONS,
  qcDocumentFromState,
  qcProfileFor,
  reviewContextMatches,
  restoredProviderEvidence,
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
    schemaVersion: PERSISTED_SCHEMA_VERSION,
    browserSplit: false,
    browserPanels: {
      result: { url: '', preset: 'desktop', width: 1440, height: 900, displayMode: 'fit', qcProfileHint: '' },
      reference: { url: '', preset: 'mobile', width: 390, height: 844, displayMode: 'fit', qcProfileHint: '' }
    },
    qcTargetPanelId: 'result', qcProfile: 'design', evaluations: {}, job: blankJob(), candidates: blankCandidates(), selectedCandidate: null
  }
  const legacy = { browserUrl: 'https://example.test', qcProfile: 'higgsfield-image', evaluations: { design: { composition: { status: 'pass', note: 'kept' } } } }
  const migrated = migratePersistedState(legacy, defaults)
  assert.equal(migrated.schemaVersion, PERSISTED_SCHEMA_VERSION)
  assert.equal(migrated.qcTargetPanelId, 'result')
  assert.equal(migrated.browserPanels.result.url, 'https://example.test')
  assert.equal(migrated.browserPanels.result.displayMode, 'fit')
  assert.equal(migrated.browserPanels.reference.displayMode, 'fit')
  assert.equal(migrated.evaluations.design.composition.note, 'kept')
  assert.deepEqual(Object.keys(migrated.candidates), CANDIDATE_IDS)
})

test('repairs malformed persisted candidate fields and deep-merges partial dimensions', () => {
  const defaults = {
    schemaVersion: PERSISTED_SCHEMA_VERSION,
    browserSplit: false,
    browserPanels: {
      result: { url: '', preset: 'desktop', width: 1440, height: 900, displayMode: 'fit', qcProfileHint: '' },
      reference: { url: '', preset: 'mobile', width: 390, height: 844, displayMode: 'fit', qcProfileHint: '' }
    },
    qcTargetPanelId: 'result', reviewContext: null, qcProfile: 'design', evaluations: {}, job: blankJob(), candidates: blankCandidates(), selectedCandidate: null,
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

function v5Defaults() {
  return {
    schemaVersion: PERSISTED_SCHEMA_VERSION,
    browserSplit: false,
    browserPanels: {
      result: { url: '', preset: 'desktop', width: 1440, height: 900, displayMode: 'fit', qcProfileHint: '', providerEvidence: null, inspection: null },
      reference: { url: '', preset: 'mobile', width: 390, height: 844, displayMode: 'fit', qcProfileHint: '', providerEvidence: null, inspection: null }
    },
    qcTargetPanelId: 'result', reviewContext: null, qcProfile: 'design', evaluations: {}, job: blankJob(), candidates: blankCandidates(), selectedCandidate: null,
    qcJson: '', capture: null
  }
}

test('migrates a fully-populated v2 snapshot to connected v5 target evidence', () => {
  const snapshot = {
    schemaVersion: 2,
    browserSplit: true,
    browserPanels: {
      result: { url: 'https://www.midjourney.com/imagine', preset: 'desktop', width: 1440, height: 900, displayMode: 'actual' },
      reference: { url: 'file:///tmp/reference.png', preset: 'custom', width: 512, height: 512, displayMode: 'fit' }
    },
    qcProfile: 'midjourney',
    evaluations: {
      design: { composition: { status: 'pass', note: 'kept' } },
      'higgsfield-image': { prompt: { status: 'fail', note: 'off-brief' } }
    },
    job: { id: 'job-42', state: 'QC_RUNNING', brief: 'Poster grid', createdAt: NOW, updatedAt: NOW },
    candidates: Object.fromEntries(CANDIDATE_IDS.map((id, index) => [id, {
      id,
      summary: `Candidate ${id}`,
      score: 88 - index,
      disposition: index === 0 ? 'PASS' : index === 1 ? 'REPAIR' : 'REJECT',
      evidence: [`Evidence ${id}`],
      repairPrompt: index === 1 ? 'Fix hands.' : '',
      dimensions: Object.fromEntries(QC_DIMENSIONS.map(key => [key, { score: 88 - index, evidence: `${key} ok` }]))
    }])),
    selectedCandidate: 'A',
    qcJson: '{"schemaVersion":1}',
    capture: { panelId: 'result', width: 1440, height: 900, createdAt: NOW, path: '/tmp/capture.png' }
  }
  const restored = migratePersistedState(structuredClone(snapshot), v5Defaults())
  assert.equal(restored.schemaVersion, PERSISTED_SCHEMA_VERSION)
  assert.equal(restored.qcTargetPanelId, 'result')
  assert.equal(restored.capture.url, '')
  assert.deepEqual(restored.browserPanels, {
    result: { ...snapshot.browserPanels.result, qcProfileHint: '', providerEvidence: null, inspection: null },
    reference: { ...snapshot.browserPanels.reference, qcProfileHint: '', providerEvidence: null, inspection: null }
  })
  assert.deepEqual(restored.candidates, snapshot.candidates)
})

test('restores valid actual display mode and repairs malformed values to fit', () => {
  const restored = migratePersistedState({
    browserPanels: {
      result: { displayMode: 'actual' },
      reference: { displayMode: 'zoomed' }
    }
  }, v5Defaults())

  assert.equal(restored.browserPanels.result.displayMode, 'actual')
  assert.equal(restored.browserPanels.reference.displayMode, 'fit')
  assert.equal(
    migratePersistedState({ browserPanels: { result: { displayMode: 100 } } }, v5Defaults()).browserPanels.result.displayMode,
    'fit'
  )
})

test('restores only durable target evidence and preserves provider provenance', () => {
  const saved = {
    qcTargetPanelId: 'reference',
    browserPanels: { reference: {
      qcProfileHint: 'higgsfield-image',
      providerEvidence: {
        source: 'higgsfield-mcp', jobId: 'job-1', status: 'completed', model: 'seedream_v5_pro',
        mediaType: 'image', resultUrl: 'https://example.test/reference', width: 768, height: 1024
      },
      inspection: { url: 'https://example.test/reference', summary: 'CDP CSS 768×1024', checkedAt: NOW }
    } },
    capture: {
      panelId: 'reference',
      url: 'https://example.test/reference',
      width: 768,
      height: 1024,
      createdAt: 1_752_710_400_000,
      path: '/tmp/reference-capture.png'
    }
  }
  const restored = migratePersistedState(saved, v5Defaults())
  assert.equal(restored.qcTargetPanelId, 'reference')
  assert.equal(restored.browserPanels.reference.qcProfileHint, 'higgsfield-image')
  assert.equal(restored.browserPanels.reference.providerEvidence.jobId, 'job-1')
  assert.equal(restored.browserPanels.reference.inspection.summary, 'CDP CSS 768×1024')
  assert.deepEqual(restored.capture, saved.capture)
  assert.equal(migratePersistedState({ capture: { ...saved.capture, path: '' } }, v5Defaults()).capture, null)
  assert.equal(migratePersistedState({ qcTargetPanelId: 'bogus' }, v5Defaults()).qcTargetPanelId, 'result')
})

test('routes Midjourney URLs and tool provenance to the matching QC profile', () => {
  assert.equal(qcProfileFor({ src: 'https://www.midjourney.com/explore?tab=top_month' }), 'midjourney')
  assert.equal(qcProfileFor({ src: 'https://cdn.example.test/grid.png', toolName: 'midjourney_web_create' }), 'midjourney')
  assert.equal(qcProfileFor({ src: 'https://cdn.example.test/clip.mp4' }), 'higgsfield-video')
  assert.equal(qcProfileFor({ src: 'https://example.test/page' }), 'design')
})

test('extracts bounded Higgsfield MCP metadata for the exact displayed result', () => {
  const src = 'https://cdn.example.test/result.png?token=display'
  const evidence = providerEvidenceFor({
    src,
    toolName: 'mcp__higgsfield__show_generations',
    toolResult: {
      structuredContent: {
        items: [{
          id: 'job-1', type: 'image', status: 'completed', model: 'seedream_v5_pro',
          params: {
            aspect_ratio: '3:4', batch_size: 2, height: 1168, medias: [{ role: 'image' }],
            prompt: 'Product fidelity prompt', resolution: '1k', width: 880
          },
          results: { rawUrl: 'https://cdn.example.test/result.png?token=raw' },
          createdAt: 123
        }]
      }
    }
  })

  assert.equal(evidence.source, 'higgsfield-mcp')
  assert.equal(evidence.jobId, 'job-1')
  assert.equal(evidence.status, 'completed')
  assert.equal(evidence.model, 'seedream_v5_pro')
  assert.equal(evidence.mediaType, 'image')
  assert.equal(evidence.width, 880)
  assert.equal(evidence.height, 1168)
  assert.equal(evidence.aspectRatio, '3:4')
  assert.equal(evidence.count, 2)
  assert.equal(evidence.referenceCount, 1)
  assert.equal(evidence.resultUrl, 'https://cdn.example.test/result.png?token=raw')
  assert.ok(evidence.checkedAt)
})

test('rejects unrelated or malformed provider metadata and bounds restored values', () => {
  assert.equal(providerEvidenceFor({ src: 'https://cdn.example.test/result.png', toolName: 'midjourney' }), null)
  assert.equal(providerEvidenceFor({ src: 'https://cdn.example.test/result.png', toolName: 'mcp__higgsfield__show_generations', toolResult: {} }), null)
  assert.equal(providerEvidenceFor({
    src: 'https://cdn.example.test/current.png',
    toolName: 'mcp__higgsfield__show_generations',
    toolResult: { structuredContent: { items: [{ id: 'old', results: { rawUrl: 'https://cdn.example.test/old.png' } }] } }
  }), null)
  assert.equal(restoredProviderEvidence({ source: 'unknown' }), null)
  const restored = restoredProviderEvidence({
    source: 'higgsfield-mcp', count: 999, height: -1, jobId: 'j'.repeat(200), mediaType: 'bogus',
    prompt: 'p'.repeat(5000), referenceCount: 999, width: 880
  })
  assert.equal(restored.count, 20)
  assert.equal(restored.referenceCount, 20)
  assert.equal(restored.jobId.length, 128)
  assert.equal(restored.prompt.length, 4000)
  assert.equal(restored.mediaType, '')
  assert.equal(restored.height, 0)
})

test('binds persisted review state to the exact profile, panel, and target URL', () => {
  const defaults = v5Defaults()
  const saved = {
    ...defaults,
    browserPanels: {
      ...defaults.browserPanels,
      result: { ...defaults.browserPanels.result, url: 'https://example.test/result.png' }
    },
    qcProfile: 'higgsfield-image',
    reviewContext: { profileId: 'higgsfield-image', panelId: 'result', url: 'https://example.test/result.png' }
  }
  const restored = migratePersistedState(saved, defaults)
  assert.equal(reviewContextMatches(restored, 'higgsfield-image'), true)
  assert.equal(reviewContextMatches({ ...restored, qcTargetPanelId: 'reference' }, 'higgsfield-image'), false)
  assert.equal(reviewContextMatches({
    ...restored,
    browserPanels: { ...restored.browserPanels, result: { ...restored.browserPanels.result, url: 'https://example.test/other.png' } }
  }, 'higgsfield-image'), false)
  assert.equal(reviewContextMatches(restored, 'midjourney'), false)
  assert.equal(migratePersistedState({ reviewContext: { profileId: 'bad', panelId: 'result', url: 'x' } }, defaults).reviewContext, null)
})

test('rejects a top-level provider field as an unknown field (schema v1 frozen)', () => {
  const document = validDocument()
  document.provider = 'midjourney'
  assert.throws(() => validateQcDocument(document), /unknown fields provider/)
})

test('round-trips a valid document byte-for-byte through import and export', () => {
  const formatted = JSON.stringify(validateQcDocument(JSON.stringify(validDocument())), null, 2)
  assert.equal(JSON.stringify(validateQcDocument(formatted), null, 2), formatted)

  const document = validateQcDocument(validDocument())
  const state = {
    job: document.job,
    selectedCandidate: document.selectedCandidate,
    candidates: Object.fromEntries(document.candidates.map(item => [item.id, item]))
  }
  assert.equal(JSON.stringify(qcDocumentFromState(state, document.generatedAt), null, 2), formatted)
})

test('accepts exactly 64 KiB of JSON and rejects one byte more', () => {
  const text = JSON.stringify(validDocument())
  const padded = target => text + ' '.repeat(target - Buffer.byteLength(text, 'utf8'))
  assert.equal(validateQcDocument(padded(MAX_QC_JSON_BYTES)).schemaVersion, 1)
  assert.throws(() => validateQcDocument(padded(MAX_QC_JSON_BYTES + 1)), /exceeds 65536 bytes/)
})

test('exposes a provider registry with midjourney as the schema-v1 adapter', () => {
  assert.deepEqual([...PROVIDER_IDS], ['midjourney', 'higgsfield-image'])

  const midjourney = providerForProfile('midjourney')
  assert.equal(midjourney, PROVIDERS.midjourney)
  assert.equal(midjourney.qcDocument.validate, validateQcDocument)
  assert.equal(midjourney.qcDocument.schemaVersion, 1)
  assert.equal(midjourney.qcDocument.maxBytes, MAX_QC_JSON_BYTES)
  assert.deepEqual([...midjourney.dimensions], [...QC_DIMENSIONS])
  assert.deepEqual([...midjourney.candidateIds], [...CANDIDATE_IDS])

  assert.equal(providerForProfile('design'), null)
  assert.equal(providerForProfile('higgsfield-video'), null)
  assert.equal(providerForProfile('unknown-profile'), null)

  const higgsfield = providerForProfile('higgsfield-image')
  assert.equal(higgsfield.structuredReview, true)
  assert.equal(higgsfield.qcDocument, null)
  assert.notDeepEqual([...higgsfield.dimensions], [...QC_DIMENSIONS])
  for (const provider of PROVIDER_IDS.map(id => PROVIDERS[id])) {
    for (const key of provider.dimensions) {
      assert.ok(QC_DIMENSIONS.includes(key), `${provider.id} dimension ${key} must stay storable in schema v2`)
      assert.equal(typeof provider.dimensionLabels[key], 'string')
    }
  }
  assert.equal(higgsfield.dimensionLabels.promptFidelity, 'Prompt adherence')
  assert.ok(Object.isFrozen(PROVIDERS))
  assert.ok(Object.isFrozen(midjourney))
  assert.ok(Object.isFrozen(higgsfield.dimensions))
})

test('pins midjourney automation to the internal Hermes browser pane with hard-stop semantics', () => {
  const automation = PROVIDERS.midjourney.automation
  assert.deepEqual({ ...automation }, {
    target: 'hermes-internal-browser-pane',
    appScope: 'Hermes',
    partition: 'persist:hermes-browser',
    externalBrowserFallback: 'forbidden',
    unavailableState: 'internal_pane_unavailable'
  })
  assert.ok(Object.isFrozen(automation))
  assert.equal(providerForProfile('higgsfield-image').automation, null)
})

test('restores higgsfield-image structured review state across restart and repairs invalid input', () => {
  const higgsfield = providerForProfile('higgsfield-image')
  const scored = Object.fromEntries(higgsfield.dimensions.map((key, index) => [key, { score: 60 + index, evidence: `${key} noted` }]))
  const saved = {
    schemaVersion: 2,
    qcProfile: 'higgsfield-image',
    evaluations: { 'higgsfield-image': { prompt: { status: 'fail', note: 'off-brief' } } },
    candidates: {
      A: { summary: 'HF review', score: 71, disposition: 'REPAIR', evidence: ['soft focus'], repairPrompt: 'sharpen the product edge', dimensions: scored },
      B: { dimensions: { promptFidelity: { score: 999, evidence: 42 } } }
    }
  }
  const restored = migratePersistedState(saved, v5Defaults())

  assert.equal(restored.qcProfile, 'higgsfield-image')
  for (const key of higgsfield.dimensions) {
    assert.deepEqual(restored.candidates.A.dimensions[key], scored[key])
  }
  assert.equal(restored.candidates.A.disposition, 'REPAIR')
  assert.equal(restored.evaluations['higgsfield-image'].prompt.note, 'off-brief')
  assert.deepEqual(restored.candidates.B.dimensions.promptFidelity, { score: 0, evidence: '' })
  assert.deepEqual(migratePersistedState(structuredClone(restored), v5Defaults()), restored)
})
