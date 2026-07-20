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
  sanitizeUrl,
  invokeHiggsfieldReadOnly,
  providerForProfile,
  QC_DIMENSIONS,
  qcDocumentFromState,
  panelLinkedToQc,
  qcProfileFor,
  reviewContextMatches,
  restoredProviderEvidence,
  sameMidjourneyCandidateSwitch,
  midjourneyProviderEvidenceForUrl,
  transitionJob,
  linkPanelState,
  markPanelLoadFailedState,
  swapPanelsState,
  updatePanelState,
  validateAgentCommand,
  applyAgentCommand,
  agentStatusSnapshot,
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
      result: { url: '', targetId: 'tfixture-result', preset: 'desktop', width: 1440, height: 900, displayMode: 'fit', qcProfileHint: '', providerEvidence: null, inspection: null },
      reference: { url: '', targetId: 'tfixture-reference', preset: 'mobile', width: 390, height: 844, displayMode: 'fit', qcProfileHint: '', providerEvidence: null, inspection: null }
    },
    qcTargetPanelId: 'result', reviewContext: null, qcProfile: 'design', evaluations: {}, job: blankJob(), candidates: blankCandidates(), selectedCandidate: null,
    qcJson: '', capture: null
  }
}

test('migrates a fully-populated v2 snapshot and drops URL-less capture evidence', () => {
  const snapshot = {
    schemaVersion: 2,
    browserSplit: true,
    browserPanels: {
      result: { url: 'https://www.midjourney.com/imagine', targetId: 'tv2-result', preset: 'desktop', width: 1440, height: 900, displayMode: 'actual' },
      reference: { url: 'file:///tmp/reference.png', targetId: 'tv2-reference', preset: 'custom', width: 512, height: 512, displayMode: 'fit' }
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
    capture: { panelId: 'result', targetId: 'tv2-result', width: 1440, height: 900, createdAt: NOW, path: '/tmp/capture.png' }
  }
  const restored = migratePersistedState(structuredClone(snapshot), v5Defaults())
  assert.equal(restored.schemaVersion, PERSISTED_SCHEMA_VERSION)
  assert.equal(restored.qcTargetPanelId, 'result')
  assert.equal(restored.capture, null)
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
      url: 'https://example.test/reference', targetId: 'tsaved-reference', qcProfileHint: 'higgsfield-image',
      providerEvidence: {
        source: 'higgsfield-mcp', jobId: 'job-1', status: 'completed', model: 'seedream_v5_pro',
        mediaType: 'image', resultUrl: 'https://example.test/reference', width: 768, height: 1024
      },
      inspection: { url: 'https://example.test/reference', summary: 'CDP CSS 768×1024', checkedAt: NOW }
    } },
    capture: {
      panelId: 'reference', targetId: 'tsaved-reference',
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

test('binds Higgsfield metadata only to one exact raw receipt and redacts URL secrets', () => {
  const src = 'https://cdn.example.test/result.png?token=display&keep=ok'
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
          results: { rawUrl: src },
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
  assert.equal(evidence.resultUrl, 'https://cdn.example.test/result.png?keep=ok')
  assert.ok(evidence.checkedAt)

  const collision = {
    src,
    toolName: 'mcp__higgsfield__show_generations',
    toolResult: { structuredContent: { items: [
      { id: 'one', results: { rawUrl: 'https://cdn.example.test/result.png?token=other' } },
      { id: 'two', results: { rawUrl: 'https://cdn.example.test/result.png?sig=other' } }
    ] } }
  }
  assert.equal(providerEvidenceFor(collision), null)
  collision.toolResult.structuredContent.items.push({ id: 'exact', results: { rawUrl: src } })
  assert.equal(providerEvidenceFor(collision).jobId, 'exact')
  collision.toolResult.structuredContent.items.push({ id: 'duplicate', results: { rawUrl: src } })
  assert.equal(providerEvidenceFor(collision), null)
  assert.equal(sanitizeUrl('https://cdn.example.test/a?token=x&sig=y&signature=z&expires=1&key=k&auth=a&keep=yes#secret'), 'https://cdn.example.test/a?keep=yes')
})

test('Higgsfield invocation firewall allows inspections only and blocks mutations before invocation', async () => {
  const calls = []
  const invoke = async name => { calls.push(name); return { ok: true } }
  await invokeHiggsfieldReadOnly('mcp__higgsfield__show_generations', invoke)
  await invokeHiggsfieldReadOnly('mcp__higgsfield__job_status', invoke)
  await assert.rejects(invokeHiggsfieldReadOnly('mcp__higgsfield__generate_image', invoke), /read-only/)
  await assert.rejects(invokeHiggsfieldReadOnly('mcp__higgsfield__upscale', invoke), /read-only/)
  assert.deepEqual(calls, ['mcp__higgsfield__show_generations', 'mcp__higgsfield__job_status'])
})

test('extracts Soul V2 metadata from the Higgsfield job_status raw_data envelope', () => {
  const src = 'https://cdn.example.test/soul.png'
  const evidence = providerEvidenceFor({
    src,
    toolName: 'mcp__higgsfield__job_status',
    toolResult: { structuredContent: { raw_data: {
      id: 'job-soul', job_set_type: 'text2image_soul_v2', result_url: src, status: 'completed',
      params: { custom_reference_id: 'soul-1', height: 2048, prompt: 'Portrait', width: 1536 }
    } } }
  })

  assert.equal(evidence.jobId, 'job-soul')
  assert.equal(evidence.model, 'text2image_soul_v2')
  assert.equal(evidence.soulId, 'soul-1')
  assert.equal(evidence.resultUrl, src)
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

test('binds persisted review state to the exact profile, panel, and target identity', () => {
  const defaults = v5Defaults()
  const saved = {
    ...defaults,
    schemaVersion: 5,
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
    browserPanels: { ...restored.browserPanels, result: { ...restored.browserPanels.result, targetId: 'tother-target' } }
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
  assert.deepEqual([...PROVIDER_IDS], ['midjourney', 'higgsfield-image', 'higgsfield-web'])

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
test('enforces v6 review identities and migrates matching v5 evidence', () => {
  const defaults = v5Defaults()
  const saved = {
    schemaVersion: 5,
    qcTargetPanelId: 'result',
    qcProfile: 'design',
    browserPanels: {
      result: { ...defaults.browserPanels.result, url: 'https://example.test/page' },
      reference: defaults.browserPanels.reference
    },
    reviewContext: { profileId: 'design', panelId: 'result', url: 'https://example.test/page' },
    capture: { panelId: 'result', url: 'https://example.test/page', width: 800, height: 600, createdAt: NOW, path: '/tmp/page.png' }
  }
  const restored = migratePersistedState(saved, defaults)
  assert.equal(reviewContextMatches(restored, 'design'), true)
  assert.equal(panelLinkedToQc(restored, 'result'), true)
  assert.equal(restored.capture.targetId, restored.browserPanels.result.targetId)
  assert.equal(reviewContextMatches({ ...restored, reviewContext: { ...restored.reviewContext, stale: true } }, 'design'), false)
  assert.equal(panelLinkedToQc({
    ...restored,
    browserPanels: { ...restored.browserPanels, result: { ...restored.browserPanels.result, targetId: 'tnew-target' } }
  }, 'result'), false)

  const dropped = migratePersistedState({
    ...saved,
    reviewContext: { ...saved.reviewContext, url: 'https://example.test/other' },
    evaluations: { design: { composition: { status: 'pass', note: 'orphan' } } }
  }, defaults)
  assert.equal(dropped.reviewContext, null)
  assert.deepEqual(dropped.evaluations, {})
})

function sequentialIds() {
  let counter = 0
  return prefix => `${prefix}gen${String(++counter).padStart(2, '0')}-abcd`
}

function v6State() {
  const defaults = v5Defaults()
  return {
    ...defaults,
    browserPanels: {
      result: { ...defaults.browserPanels.result, url: 'https://example.test/page', targetId: 'tresult-0001' },
      reference: { ...defaults.browserPanels.reference, url: 'https://cdn.example.test/shot.png', targetId: 'treference-0001' }
    }
  }
}

function resultCapture() {
  return { panelId: 'result', targetId: 'tresult-0001', url: 'https://example.test/page', width: 800, height: 600, viewport: { preset: 'desktop', width: 1440, height: 900, responsive: false }, createdAt: NOW, path: '/tmp/x.png' }
}

test('link creates one atomic review context and resets review families', () => {
  const makeId = sequentialIds()
  const base = { ...v6State(), capture: resultCapture(), evaluations: { design: { composition: { status: 'pass', note: 'old' } } } }
  const linked = linkPanelState(base, 'result', { profileId: 'design', contextId: 'clink-0001', linkedAt: NOW }, makeId)
  assert.deepEqual(linked.reviewContext, {
    contextId: 'clink-0001', panelId: 'result', targetId: 'tresult-0001', profileId: 'design',
    url: 'https://example.test/page', mediaKind: 'page',
    viewport: { preset: 'desktop', width: 1440, height: 900, responsive: false },
    providerEvidence: null, linkedAt: NOW, stale: false, staleReason: ''
  })
  assert.deepEqual(linked.evaluations, {})
  assert.deepEqual(linked.job, blankJob())
  assert.equal(linked.selectedCandidate, null)
  assert.equal(linked.qcJson, '')
  assert.deepEqual(linked.capture, resultCapture(), 'capture bound to the same target survives linking')
  assert.equal(reviewContextMatches(linked, 'design'), true)
  assert.equal(panelLinkedToQc(linked, 'result'), true)
})

test('Midjourney QC links infer only strict verified job URL provenance', () => {
  const jobId = '123e4567-e89b-42d3-a456-426614174000'
  const validUrls = [
    `https://midjourney.com/jobs/${jobId}`,
    `https://www.midjourney.com/jobs/${jobId}?index=3`
  ]
  for (const url of validUrls) {
    const inferred = midjourneyProviderEvidenceForUrl(url)
    assert.deepEqual(inferred, { source: 'midjourney', jobId, operationId: '', resultUrl: url })
    const state = v6State()
    state.browserPanels.result = { ...state.browserPanels.result, url, targetId: 'tmj-0000', providerEvidence: null }
    const linked = linkPanelState(state, 'result', { profileId: 'midjourney', contextId: 'cmj-0000', linkedAt: NOW }, sequentialIds())
    assert.deepEqual(linked.browserPanels.result.providerEvidence, inferred)
    assert.deepEqual(linked.reviewContext.providerEvidence, inferred)
  }

  const invalidUrls = [
    `http://midjourney.com/jobs/${jobId}`,
    `https://evil.midjourney.com/jobs/${jobId}`,
    `https://midjourney.com/jobs/${jobId}/`,
    `https://midjourney.com/imagine/${jobId}`,
    'https://midjourney.com/jobs/not-a-uuid',
    `https://midjourney.com/jobs/${jobId}?index=4`,
    `https://midjourney.com/jobs/${jobId}?index=0&extra=1`,
    `https://midjourney.com/jobs/${jobId}?foo=bar`,
    `https://midjourney.com/jobs/${jobId}#fragment`
  ]
  for (const url of invalidUrls) {
    assert.equal(midjourneyProviderEvidenceForUrl(url), null, url)
    const state = v6State()
    state.browserPanels.result = {
      ...state.browserPanels.result, url, targetId: 'tmj-invalid', providerEvidence: {
        source: 'midjourney', jobId, operationId: 'transient', resultUrl: `https://midjourney.com/jobs/${jobId}`
      }
    }
    const linked = linkPanelState(state, 'result', { profileId: 'midjourney', contextId: 'cmj-invalid', linkedAt: NOW }, sequentialIds())
    assert.equal(linked.reviewContext.providerEvidence, null, url)
    assert.equal(linked.browserPanels.result.providerEvidence, null, url)
  }
})

test('URL change rotates target identity, clears evidence, and stales the context', () => {
  const makeId = sequentialIds()
  const linked = linkPanelState({ ...v6State(), capture: resultCapture() }, 'result', { profileId: 'design', contextId: 'clink-0001', linkedAt: NOW }, makeId)
  const next = updatePanelState(linked, 'result', { url: 'https://example.test/other' }, {}, makeId)
  assert.notEqual(next.browserPanels.result.targetId, 'tresult-0001')
  assert.match(next.browserPanels.result.targetId, /^t[0-9a-z]+-[0-9a-z]{4,}$/)
  assert.equal(next.browserPanels.result.inspection, null)
  assert.equal(next.capture, null)
  assert.equal(next.reviewContext.stale, true)
  assert.equal(next.reviewContext.staleReason, 'url-changed')
  assert.equal(reviewContextMatches(next, 'design'), false)
  assert.equal(panelLinkedToQc(next, 'result'), false)
})

test('viewport change rotates page targets but never media targets', () => {
  const makeId = sequentialIds()
  const linkedPage = linkPanelState({ ...v6State(), capture: resultCapture() }, 'result', { profileId: 'design', contextId: 'clink-0001', linkedAt: NOW }, makeId)
  const pageNext = updatePanelState(linkedPage, 'result', { preset: 'mobile', width: 390, height: 844 }, {}, makeId)
  assert.notEqual(pageNext.browserPanels.result.targetId, 'tresult-0001')
  assert.equal(pageNext.browserPanels.result.url, 'https://example.test/page')
  assert.equal(pageNext.capture, null)
  assert.equal(pageNext.reviewContext.staleReason, 'viewport-changed')

  const linkedMedia = linkPanelState(v6State(), 'reference', { profileId: 'higgsfield-image', contextId: 'clink-0002', linkedAt: NOW }, makeId)
  const mediaNext = updatePanelState(linkedMedia, 'reference', { preset: 'desktop', width: 1440, height: 900 }, {}, makeId)
  assert.equal(mediaNext.browserPanels.reference.targetId, 'treference-0001')
  assert.equal(mediaNext.reviewContext.stale, false)
  assert.equal(reviewContextMatches(mediaNext, 'higgsfield-image'), true)
})

test('provider provenance identity participates in target identity', () => {
  const makeId = sequentialIds()
  const evidence = {
    source: 'higgsfield-mcp', jobId: 'job-1', status: 'completed', model: 'seedream_v5_pro', soulId: '',
    mediaType: 'image', prompt: 'p', width: 1024, height: 1024, duration: 0, aspectRatio: '1:1',
    resolution: '1k', count: 1, referenceCount: 0, resultUrl: 'https://cdn.example.test/shot.png', createdAt: NOW, checkedAt: NOW
  }
  const linked = linkPanelState(v6State(), 'reference', { profileId: 'higgsfield-image', contextId: 'clink-0001', linkedAt: NOW }, makeId)
  const rotated = updatePanelState(linked, 'reference', { providerEvidence: evidence }, {}, makeId)
  assert.notEqual(rotated.browserPanels.reference.targetId, 'treference-0001')
  assert.equal(rotated.reviewContext.staleReason, 'provenance-changed')

  const refreshed = updatePanelState(rotated, 'reference', { providerEvidence: { ...evidence, checkedAt: '2026-07-18T00:00:00.000Z' } }, {}, makeId)
  assert.equal(refreshed.browserPanels.reference.targetId, rotated.browserPanels.reference.targetId, 'same provenance identity must not rotate the target')
  assert.equal(refreshed.reviewContext.staleReason, rotated.reviewContext.staleReason)
})

test('panel swap rotates both target identities and stales the active context', () => {
  const makeId = sequentialIds()
  const linked = linkPanelState({ ...v6State(), capture: resultCapture() }, 'result', { profileId: 'design', contextId: 'clink-0001', linkedAt: NOW }, makeId)
  const swapped = swapPanelsState(linked, makeId)
  assert.equal(swapped.browserPanels.result.url, 'https://cdn.example.test/shot.png')
  assert.equal(swapped.browserPanels.reference.url, 'https://example.test/page')
  assert.notEqual(swapped.browserPanels.result.targetId, 'treference-0001')
  assert.notEqual(swapped.browserPanels.reference.targetId, 'tresult-0001')
  assert.equal(swapped.browserPanels.result.inspection, null)
  assert.equal(swapped.capture, null)
  assert.equal(swapped.reviewContext.stale, true)
  assert.equal(swapped.reviewContext.staleReason, 'panels-swapped')
  assert.equal(panelLinkedToQc(swapped, 'result'), false)
  assert.equal(panelLinkedToQc(swapped, 'reference'), false)
})

test('relinking the same tuple is idempotent while overrides create a fresh context', () => {
  const makeId = sequentialIds()
  const linked = linkPanelState(v6State(), 'result', { profileId: 'design', contextId: 'clink-0001', linkedAt: NOW }, makeId)
  const reviewed = { ...linked, evaluations: { design: { composition: { status: 'pass', note: 'kept' } } } }
  const relinked = linkPanelState(reviewed, 'result', { profileId: 'design', contextId: 'cignored-0002', linkedAt: NOW }, makeId)
  assert.equal(relinked.reviewContext.contextId, 'clink-0001')
  assert.deepEqual(relinked.evaluations, reviewed.evaluations)

  const overridden = linkPanelState(reviewed, 'result', { profileId: 'midjourney', contextId: 'cnew-0003', linkedAt: NOW }, makeId)
  assert.equal(overridden.reviewContext.contextId, 'cnew-0003')
  assert.equal(overridden.reviewContext.profileId, 'midjourney')
  assert.equal(overridden.qcProfile, 'midjourney')
  assert.deepEqual(overridden.evaluations, {})
})

test('restore drops identity-inconsistent live contexts and captures, healing tampered blobs', () => {
  const defaults = v5Defaults()
  const makeId = sequentialIds()
  const linked = linkPanelState(v6State(), 'result', { profileId: 'design', contextId: 'clink-0001', linkedAt: NOW }, makeId)
  const persisted = { ...linked, capture: resultCapture(), evaluations: { design: { composition: { status: 'pass', note: 'live' } } } }

  const roundTrip = migratePersistedState(structuredClone(persisted), defaults)
  assert.deepEqual(roundTrip.reviewContext, linked.reviewContext, 'consistent v6 tuples restore exactly')
  assert.deepEqual(roundTrip.capture, resultCapture())

  const urlMismatch = migratePersistedState({ ...structuredClone(persisted), reviewContext: { ...linked.reviewContext, url: 'https://example.test/other' } }, defaults)
  assert.equal(urlMismatch.reviewContext, null)
  assert.deepEqual(urlMismatch.evaluations, {}, 'orphaned review families are blanked')

  const kindMismatch = migratePersistedState({ ...structuredClone(persisted), reviewContext: { ...linked.reviewContext, mediaKind: 'image' } }, defaults)
  assert.equal(kindMismatch.reviewContext, null)

  const viewportMismatch = migratePersistedState({ ...structuredClone(persisted), reviewContext: { ...linked.reviewContext, viewport: { preset: 'mobile', width: 390, height: 844, responsive: false } } }, defaults)
  assert.equal(viewportMismatch.reviewContext, null)

  const staleSnapshot = migratePersistedState({ ...structuredClone(persisted), reviewContext: { ...linked.reviewContext, stale: true, staleReason: 'url-changed', targetId: 'tolder-target' } }, defaults)
  assert.equal(staleSnapshot.reviewContext?.stale, true)
  assert.equal(staleSnapshot.reviewContext?.targetId, 'tolder-target', 'stale snapshots keep their historical identity')

  const captureMismatch = migratePersistedState({ ...structuredClone(persisted), capture: { ...resultCapture(), url: 'https://example.test/other' } }, defaults)
  assert.equal(captureMismatch.capture, null)

  const tampered = migratePersistedState({
    schemaVersion: 6,
    browserPanels: { result: { url: 'https://example.test/page', targetId: 'bad' } },
    reviewContext: {
      contextId: 'bad', panelId: 'result', targetId: 'bad', profileId: 'design', url: 'https://example.test/page',
      mediaKind: 'weird', viewport: { width: 10 }, stale: 'yes', staleReason: 'unknown', linkedAt: NOW
    },
    evaluations: { design: { layout: { status: 'pass', note: 'must-clear' } } },
    candidates: { A: { summary: 'must-clear' } }
  }, defaults)
  assert.match(tampered.browserPanels.result.targetId, /^t[0-9a-z]+-[0-9a-z]{4,}$/)
  assert.equal(tampered.reviewContext, null)
  assert.deepEqual(tampered.evaluations, {})
  assert.equal(tampered.candidates.A.summary, '')
})

test('schema-v6 blobs cannot smuggle legacy-shaped contexts past full-tuple validation', () => {
  const defaults = v5Defaults()
  const makeId = sequentialIds()
  const linked = linkPanelState(v6State(), 'result', { profileId: 'design', contextId: 'clink-0001', linkedAt: NOW }, makeId)
  const smuggled = migratePersistedState({
    ...structuredClone(linked),
    schemaVersion: PERSISTED_SCHEMA_VERSION,
    reviewContext: { profileId: 'design', panelId: 'result', url: 'https://example.test/page' },
    evaluations: { design: { composition: { status: 'pass', note: 'orphan' } } }
  }, defaults)
  assert.equal(smuggled.reviewContext, null, 'v6 blobs must not upgrade legacy-shaped contexts')
  assert.deepEqual(smuggled.evaluations, {})

  const legacy = migratePersistedState({
    schemaVersion: 5,
    browserPanels: { result: { url: 'https://example.test/page', targetId: 'tlegacy-result' } },
    reviewContext: { profileId: 'design', panelId: 'result', url: 'https://example.test/page' }
  }, defaults)
  assert.equal(legacy.reviewContext?.targetId, 'tlegacy-result', 'pre-v6 blobs still migrate URL-matching contexts')
})

test('restore rejects live contexts whose provenance identity differs from the panel', () => {
  const defaults = v5Defaults()
  const makeId = sequentialIds()
  const evidence = {
    source: 'higgsfield-mcp', jobId: 'job-a', status: 'completed', model: 'seedream_v5_pro', soulId: '',
    mediaType: 'image', prompt: 'p', width: 1024, height: 1024, duration: 0, aspectRatio: '1:1',
    resolution: '1k', count: 1, referenceCount: 0, resultUrl: 'https://cdn.example.test/shot.png', createdAt: NOW, checkedAt: NOW
  }
  const base = v6State()
  base.browserPanels.reference.providerEvidence = structuredClone(evidence)
  const linked = linkPanelState(base, 'reference', { profileId: 'higgsfield-image', contextId: 'clink-0001', linkedAt: NOW }, makeId)
  const roundTrip = migratePersistedState(structuredClone(linked), defaults)
  assert.equal(roundTrip.reviewContext?.providerEvidence?.jobId, 'job-a')

  const substituted = structuredClone(linked)
  substituted.browserPanels.reference.providerEvidence.jobId = 'job-b'
  substituted.evaluations = { 'higgsfield-image': { c1: { status: 'pass', note: 'orphan' } } }
  const dropped = migratePersistedState(substituted, defaults)
  assert.equal(dropped.reviewContext, null, 'live context provenance must match panel provenance')
  assert.deepEqual(dropped.evaluations, {})

  const staleHistorical = structuredClone(substituted)
  staleHistorical.reviewContext.stale = true
  staleHistorical.reviewContext.staleReason = 'provenance-changed'
  const preserved = migratePersistedState(staleHistorical, defaults)
  assert.equal(preserved.reviewContext?.providerEvidence?.jobId, 'job-a', 'stale snapshots keep historical provenance')
})

test('failed loads explicitly stale the linked context without touching other state', () => {
  const makeId = sequentialIds()
  const linked = linkPanelState({ ...v6State(), capture: resultCapture() }, 'result', { profileId: 'design', contextId: 'clink-0001', linkedAt: NOW }, makeId)
  const failed = markPanelLoadFailedState(linked, 'result')
  assert.equal(failed.reviewContext.stale, true)
  assert.equal(failed.reviewContext.staleReason, 'load-failed')
  assert.equal(failed.capture, null, 'failed navigation clears target capture')
  assert.equal(failed.browserPanels.result.targetId, 'tresult-0001', 'target identity does not rotate on load failure')
  assert.equal(reviewContextMatches(failed, 'design'), false)
  assert.equal(panelLinkedToQc(failed, 'result'), false)

  assert.equal(markPanelLoadFailedState(failed, 'result'), failed, 'already-stale context is a no-op')
  assert.equal(markPanelLoadFailedState(linked, 'reference'), linked, 'failure on an unlinked panel is a no-op')
  const rotated = { ...linked, browserPanels: { ...linked.browserPanels, result: { ...linked.browserPanels.result, targetId: 'tother-0001' } } }
  assert.equal(markPanelLoadFailedState(rotated, 'result'), rotated, 'target mismatch is a no-op')

  const defaults = v5Defaults()
  const restored = migratePersistedState(structuredClone({ ...failed, schemaVersion: 6 }), defaults)
  assert.equal(restored.reviewContext?.stale, true)
  assert.equal(restored.reviewContext?.staleReason, 'load-failed', 'load-failed stale snapshots survive restart')
})
test('validates every agent command and rejects malformed command payloads', () => {
  const commands = [
    { id: 'status', op: 'status', payload: {} },
    { id: 'target', op: 'set-target', panelId: 'result', payload: { url: 'https://example.test' } },
    { id: 'link', op: 'link', panelId: 'result', payload: {} },
    { id: 'capture', op: 'capture', panelId: 'result', payload: {} },
    { id: 'inspect', op: 'inspect', panelId: 'result', payload: {} },
    { id: 'checks', op: 'page-checks', panelId: 'result', payload: {} },
    { id: 'mj-state', op: 'midjourney-control', panelId: 'result', payload: { action: 'state' } },
    { id: 'mj-nav', op: 'midjourney-control', panelId: 'result', payload: { action: 'navigate', url: 'https://www.midjourney.com/' } },
    { id: 'mj-draft', op: 'midjourney-control', panelId: 'result', payload: { action: 'draft', prompt: 'non-billable smoke', parameters: { ar: '3:4' } } },
    { id: 'mj-download', op: 'midjourney-control', panelId: 'result', payload: { action: 'download', jobId: 'job_123', filename: 'result.webp' } },
    { id: 'mj-select', op: 'midjourney-control', panelId: 'result', payload: { action: 'action', name: 'select', candidate: 'A', jobId: '123e4567-e89b-42d3-a456-426614174000' } },
    { id: 'mj-submit', op: 'midjourney-control', panelId: 'result', payload: { action: 'submit', approved: true, idempotencyKey: 'abcdefgh', validateReceipt: 'mjv-receipt', batchFingerprint: 'a'.repeat(64) } },
    { id: 'check', op: 'set-check', payload: { profileId: 'design', checkId: 'contrast', status: 'pass' } },
    { id: 'score', op: 'score-candidate', payload: { candidateId: 'A', score: 90 } },
    { id: 'select', op: 'select-candidate', payload: { candidateId: 'A' } },
    { id: 'import', op: 'import-qc', payload: { json: JSON.stringify(validDocument()) } }
  ]
  for (const command of commands) assert.equal(validateAgentCommand(command).ok, true, command.op)
  assert.equal(validateAgentCommand({ id: '', op: 'status', payload: {} }).ok, false)
  assert.equal(validateAgentCommand({ id: 'bad', op: 'unknown', payload: {} }).ok, false)
  assert.equal(validateAgentCommand({ id: 'bad', op: 'set-target', panelId: 'result', payload: { url: 'https://example.test', extra: true } }).ok, false)
  assert.equal(validateAgentCommand({ id: 'bad-mj', op: 'midjourney-control', panelId: 'result', payload: { action: 'navigate', url: 'https://example.test' } }).ok, false)
  assert.equal(validateAgentCommand({ id: 'bad-submit', op: 'midjourney-control', panelId: 'result', payload: { action: 'submit', approved: false, idempotencyKey: 'abcdefgh' } }).ok, false)
  assert.equal(validateAgentCommand({ id: 'bad-download', op: 'midjourney-control', panelId: 'result', payload: { action: 'download', jobId: '../bad', filename: 'result.png' } }).ok, false)
  assert.equal(validateAgentCommand({ id: 'bad-stale-validation', op: 'midjourney-control', panelId: 'result', payload: { action: 'submit', approved: true, idempotencyKey: 'abcdefgh' } }).ok, false)
  assert.equal(validateAgentCommand({ id: 'missing-batch-identity', op: 'midjourney-control', panelId: 'result', payload: { action: 'submit', approved: true, idempotencyKey: 'abcdefgh', validateReceipt: 'mjv-receipt' } }).ok, false)
  assert.equal(validateAgentCommand({ id: 'bad-billable-action', op: 'midjourney-control', panelId: 'result', payload: { action: 'action', name: 'upscale', jobId: '123e4567-e89b-42d3-a456-426614174000', idempotencyKey: 'abcdefgh' } }).ok, false)
})
test('Midjourney candidate freshness accepts only the linked base and index transitions', () => {
  const jobId = '123e4567-e89b-42d3-a456-426614174000'
  const base = `https://www.midjourney.com/jobs/${jobId}`
  const first = `${base}?index=0`
  const second = `${base}?index=3`
  assert.equal(sameMidjourneyCandidateSwitch(base, first, jobId), true)
  assert.equal(sameMidjourneyCandidateSwitch(first, second, jobId), true)
  assert.equal(sameMidjourneyCandidateSwitch(first, first, jobId), false)
  assert.equal(sameMidjourneyCandidateSwitch(base, base, jobId), false)
  assert.equal(sameMidjourneyCandidateSwitch(first, `${base}?index=0&x=1`, jobId), false)
  assert.equal(sameMidjourneyCandidateSwitch(first, `${base}?index=0&index=1`, jobId), false)
  assert.equal(sameMidjourneyCandidateSwitch(first, `${base}?index=4`, jobId), false)
  assert.equal(sameMidjourneyCandidateSwitch(first, 'https://www.midjourney.com/jobs/223e4567-e89b-42d3-a456-426614174000?index=1', jobId), false)
})
test('standalone Midjourney evidence and status retain strict job and capture provenance', () => {
  const jobId = '123e4567-e89b-42d3-a456-426614174000'
  const jobUrl = `https://www.midjourney.com/jobs/${jobId}`
  const evidence = restoredProviderEvidence({ source: 'midjourney', jobId: jobId.toUpperCase(), operationId: 'op-1', resultUrl: jobUrl })
  assert.deepEqual(evidence, { source: 'midjourney', jobId, operationId: 'op-1', resultUrl: jobUrl })
  assert.equal(restoredProviderEvidence({ source: 'midjourney', jobId: 'not-a-uuid' }), null)
  const state = { ...v6State(), capture: { ...resultCapture(), url: jobUrl } }
  state.browserPanels.result = { ...state.browserPanels.result, url: jobUrl, providerEvidence: evidence }
  const linked = linkPanelState(state, 'result', { profileId: 'midjourney', contextId: 'cmj-0001', linkedAt: NOW })
  assert.deepEqual(linked.reviewContext.providerEvidence, { source: 'midjourney', jobId, operationId: '', resultUrl: jobUrl })
  const status = agentStatusSnapshot(linked)
  assert.equal(status.reviewContext.providerJobId, jobId)
  assert.equal(status.capture.url, linked.capture.url)
  assert.deepEqual(status.capture.viewport, linked.capture.viewport)
})

test('applies linked agent QC commands and emits the complete status snapshot contract', () => {
  let state = migratePersistedState({}, v5Defaults())
  const makeId = prefix => `${prefix}agent-0000`
  assert.equal(applyAgentCommand(state, { op: 'set-check', payload: { profileId: 'design', checkId: 'contrast', status: 'pass' } }, makeId).error, 'Link the target in the Browser pane before editing QC')
  state = applyAgentCommand(state, { op: 'set-target', panelId: 'result', payload: { url: 'https://example.test' } }, makeId).state
  state = applyAgentCommand(state, { op: 'link', panelId: 'result', payload: {} }, makeId).state
  const scored = applyAgentCommand(state, { op: 'score-candidate', payload: { candidateId: 'A', score: 91, disposition: 'PASS' } }, makeId)
  assert.equal(scored.state.candidates.A.score, 91)
  assert.equal(applyAgentCommand({ ...scored.state, reviewContext: { ...scored.state.reviewContext, stale: true } }, { op: 'score-candidate', payload: { candidateId: 'A', score: 1 } }, makeId).error, 'Link the target in the Browser pane before editing QC')
  assert.deepEqual(Object.keys(agentStatusSnapshot(scored.state)).sort(), ['candidates', 'capture', 'evaluations', 'jobState', 'panels', 'qcProfile', 'qcTargetPanelId', 'reviewContext', 'selectedCandidate'].sort())
  assert.deepEqual(Object.keys(agentStatusSnapshot(scored.state).reviewContext).sort(), ['contextId', 'mediaKind', 'panelId', 'profileId', 'providerJobId', 'stale', 'staleReason', 'targetId', 'url'].sort())
  assert.deepEqual(Object.keys(agentStatusSnapshot(scored.state).panels).sort(), ['reference', 'result'])
})

test('set-target binds sanitized Higgsfield CLI provenance and links it into QC', () => {
  const url = 'https://cdn.higgsfield.test/generations/job.png'
  const signed = `${url}?token=secret-token&sig=secret-sig`
  const providerEvidence = {
    source: 'higgsfield-mcp', jobId: 'cli-job-1', status: 'completed', model: 'text2image_soul_v2',
    soulId: 'soul-9', mediaType: 'image', prompt: 'a portrait', width: 1152, height: 2048,
    resultUrl: signed, createdAt: 1784570752
  }
  const makeId = prefix => `${prefix}cli-0000`
  let state = migratePersistedState({}, v5Defaults())

  // Provenance whose result URL path does not match the target URL is rejected.
  assert.equal(
    validateAgentCommand({ id: 'mismatch', op: 'set-target', panelId: 'result', payload: { url, providerEvidence: { ...providerEvidence, resultUrl: 'https://cdn.higgsfield.test/other.png' } } }).ok,
    false
  )
  // Unrecognized provenance source is rejected.
  assert.equal(
    validateAgentCommand({ id: 'bad-source', op: 'set-target', panelId: 'result', payload: { url, providerEvidence: { source: 'unknown', jobId: 'x', resultUrl: url } } }).ok,
    false
  )
  // Matching provenance is accepted.
  assert.equal(
    validateAgentCommand({ id: 'ok', op: 'set-target', panelId: 'result', payload: { url, providerEvidence } }).ok,
    true
  )

  state = applyAgentCommand(state, { op: 'set-target', panelId: 'result', payload: { url, providerEvidence } }, makeId).state
  const panel = state.browserPanels.result
  assert.equal(panel.url, url)
  assert.equal(panel.providerEvidence.jobId, 'cli-job-1')
  assert.equal(panel.providerEvidence.model, 'text2image_soul_v2')
  // Signed query is stripped from the bound provenance.
  assert.ok(!JSON.stringify(panel.providerEvidence).includes('secret-token'))
  assert.ok(!JSON.stringify(panel.providerEvidence).includes('secret-sig'))

  state = applyAgentCommand(state, { op: 'link', panelId: 'result', payload: { profileId: 'higgsfield-image' } }, makeId).state
  assert.equal(state.reviewContext.profileId, 'higgsfield-image')
  assert.equal(state.reviewContext.providerEvidence.jobId, 'cli-job-1')
  assert.equal(agentStatusSnapshot(state).reviewContext.providerJobId, 'cli-job-1')
})
