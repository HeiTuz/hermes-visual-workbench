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
  linkPanelState,
  markPanelLoadFailedState,
  providerEvidenceIdentity,
  restoredProviderEvidence,
  swapPanelsState,
  updatePanelState,
  QC_PROFILE_IDS,
  qcProfileFor,
  validateAgentCommand,
  validateHiggsfieldControlPayload,
  HIGGSFIELD_GENERATION_STATUSES,
  applyAgentCommand,
  agentStatusSnapshot,
  validateQcDocument
} from '../scripts/qc-core.mjs'

const NOW = '2026-07-17T00:00:00.000Z'
const root = resolve(import.meta.dirname, '..')
const pluginSource = await readFile(resolve(root, 'plugin.js'), 'utf8')
const midjourneyCliSource = await readFile(resolve(root, 'scripts', 'midjourney-control.mjs'), 'utf8')

function validDocument() {
  return {
    schemaVersion: 1,
    job: { id: 'runtime-parity', state: 'SELECTED', brief: 'Runtime parity', createdAt: NOW, updatedAt: NOW },
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
  return Function(`${source}\nreturn { DEFAULT_STATE, persistedState, restoredState, restoredProviderEvidence, validateQcDocument, validateAgentCommand, validateHiggsfieldControlPayload, HIGGSFIELD_MODELS, HIGGSFIELD_ASPECTS, HIGGSFIELD_GENERATION_STATUSES, applyAgentCommand, agentStatusSnapshot, PROVIDERS, PROVIDER_IDS, providerEvidenceFor, providerForProfile, qcProfileFor, reviewContextMatches, panelLinkedToQc, updatePanelState, linkPanelState, swapPanelsState, markPanelLoadFailedState, providerEvidenceIdentity, midjourneyJobLocation, midjourneyProviderEvidenceForUrl, sameMidjourneyCandidateSwitch, setRuntimeState(value) { state = { ...DEFAULT_STATE, ...value } } }`)()
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
test('runtime submit commands require the validation batch identity', () => {
  const runtime = loadRuntimeCore()
  const command = {
    id: 'mj-submit',
    op: 'midjourney-control',
    panelId: 'result',
    payload: { action: 'submit', approved: true, idempotencyKey: 'abcdefgh', validateReceipt: 'mjv-receipt', batchFingerprint: 'a'.repeat(64) }
  }
  assert.equal(runtime.validateAgentCommand(command).ok, true)
  delete command.payload.batchFingerprint
  assert.equal(runtime.validateAgentCommand(command).ok, false)
  assert.equal(validateAgentCommand(command).ok, false)
})
test('Higgsfield Web exposes exact models and one-shot billable validation', async () => {
  const runtime = loadRuntimeCore()
  assert.deepEqual(runtime.HIGGSFIELD_MODELS, ['Seedream 5.0 Lite', 'Nano Banana 2', 'Seedream 4.5'])
  assert.equal(runtime.PROVIDERS['higgsfield-web'].label, 'Higgsfield Web — Unlimited')
  const draft = { action: 'draft', prompt: 'studio product image', aspect: '16:9', model: 'Nano Banana 2' }
  assert.equal(runtime.validateHiggsfieldControlPayload(draft), true)
  const generate = { action: 'generate', billableConfirmed: true, idempotencyKey: 'hf-generate-fixture-1', validateReceipt: 'hfv-receipt', batchFingerprint: 'a'.repeat(64) }
  assert.equal(runtime.validateAgentCommand({ id: 'hf-generate', op: 'higgsfield-control', panelId: 'result', payload: generate }).ok, true)
  assert.equal(validateAgentCommand({ id: 'hf-generate', op: 'higgsfield-control', panelId: 'result', payload: generate }).ok, true)
  generate.billableConfirmed = false
  assert.equal(runtime.validateAgentCommand({ id: 'hf-generate', op: 'higgsfield-control', panelId: 'result', payload: generate }).ok, false)
  assert.equal(validateAgentCommand({ id: 'hf-generate', op: 'higgsfield-control', panelId: 'result', payload: generate }).ok, false)
  const source = await readFile(resolve('plugin.js'), 'utf8')
  assert.match(source, /higgsfieldValidations\.delete\(payload\.validateReceipt\)/)
  assert.match(source, /Higgsfield prompt, aspect, or model changed after validation/)
})

test('Higgsfield Web rejects caller-asserted QC provenance', () => {
  const runtime = loadRuntimeCore()
  const command = {
    id: 'hf-link',
    op: 'higgsfield-control',
    panelId: 'result',
    payload: { action: 'link', providerJobId: 'hf-job-123', resultUrl: 'https://cdn.higgsfield.ai/generations/result.png' }
  }
  assert.equal(runtime.validateAgentCommand(command).ok, false)
  assert.equal(validateAgentCommand(command).ok, false)
})
test('runtime rejects caller-asserted Higgsfield provider evidence', () => {
  const runtime = loadRuntimeCore()
  const command = {
    id: 'hf-set-target',
    op: 'set-target',
    panelId: 'result',
    payload: {
      url: 'https://cdn.higgsfield.ai/generations/result.png',
      providerEvidence: { source: 'higgsfield-web', jobId: 'caller-job', resultUrl: 'https://cdn.higgsfield.ai/generations/result.png' }
    }
  }
  assert.equal(runtime.validateAgentCommand(command).ok, false)
})
test('Higgsfield observation receipt implementation is exact, one-shot, and redacts result URLs', () => {
  assert.match(pluginSource, /op: 'observeHiggsfield'/)
  assert.match(pluginSource, /guestWebContentsId !== context\.guestId/)
  assert.match(pluginSource, /value\.unlimited !== true/)
  assert.match(pluginSource, /results\.length > 1/)
  assert.match(pluginSource, /higgsfieldObservationReceipts\.delete\(receipt\)/)
  assert.match(pluginSource, /observation\.expiresAt < Date\.now\(\)/)
  assert.match(pluginSource, /observation\.targetId !== context\.targetId/)
  assert.match(pluginSource, /observation\.guestId !== context\.guestId/)
  assert.match(pluginSource, /observation\.sourceUrl !== context\.url/)
  assert.match(pluginSource, /url\.search = ''/)
  assert.match(pluginSource, /url\.hash = ''/)
  assert.match(pluginSource, /observed\.generationStatus !== 'complete'/)
})
test('Higgsfield link provenance and repair handoff reject caller evidence and never generate', () => {
  const runtime = loadRuntimeCore()
  assert.equal(runtime.validateHiggsfieldControlPayload({ action: 'link', observationReceipt: 'hfo-receipt' }), true)
  assert.equal(runtime.validateHiggsfieldControlPayload({ action: 'link', observationReceipt: 'hfo-receipt', providerJobId: 'caller' }), false)
  assert.equal(runtime.validateHiggsfieldControlPayload({ action: 'repair', approved: true }), true)
  assert.equal(runtime.validateHiggsfieldControlPayload({ action: 'repair', approved: false }), false)
  assert.deepEqual(runtime.HIGGSFIELD_GENERATION_STATUSES, HIGGSFIELD_GENERATION_STATUSES)
  assert.deepEqual(runtime.HIGGSFIELD_ASPECTS, ['1:1', '9:16', '16:9'])
  const observationAndLink = pluginSource.slice(pluginSource.indexOf('async function observeHiggsfield'), pluginSource.indexOf("if (payload.action === 'draft')"))
  assert.doesNotMatch(observationAndLink, /op: 'generate'/)
  const repairStart = pluginSource.indexOf("if (payload.action === 'repair')", pluginSource.indexOf('async function runHiggsfieldControl'))
  const repair = pluginSource.slice(repairStart, pluginSource.indexOf('const context = currentHiggsfieldContext(panelId)', repairStart))
  assert.match(repair, /reviewContextMatches\(state, 'higgsfield-image'\)/)
  assert.match(repair, /candidate\?\.disposition !== 'REPAIR'/)
  assert.doesNotMatch(repair, /higgsfieldControl|op: 'generate'/)
  assert.match(pluginSource, /receiptContext: \{ receiptHash: await midjourneyPromptHash\(receipt\), batchContextId: batchFingerprint, expiresAt, batchFingerprint \}/)
})

test('runtime persisted-state restore repairs malformed and partial candidate data', () => {
  const runtime = loadRuntimeCore()
  const saved = {
    qcTargetPanelId: 'bogus',
    qcProfile: 'unknown-profile',
    job: { id: 42, state: 'UNKNOWN', brief: null },
    browserPanels: {
      result: { targetId: 'truntime-result', displayMode: 'actual' },
      reference: { targetId: 'truntime-reference', displayMode: 'unknown' }
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
    targetId: 'truntime-capture',
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
    browserPanels: { result: { url: 'https://example.test/result', targetId: 'truntime-capture', qcProfileHint: 'higgsfield-image' } },
    capture: durable
  })
  assert.equal(restored.browserPanels.result.qcProfileHint, 'higgsfield-image')
  assert.deepEqual(restored.capture, durable)
})

test('runtime panel identity reducers stay behaviorally aligned with the standalone QC core', () => {
  const runtime = loadRuntimeCore()
  const state = structuredClone(runtime.DEFAULT_STATE)
  state.browserPanels.result = {
    ...state.browserPanels.result,
    url: 'https://example.test/old',
    targetId: 'tseed-0000',
    inspection: { url: 'https://example.test/old', summary: 'old', checkedAt: NOW }
  }
  const makeId = prefix => `${prefix}next-0000`
  const evidence = {
    source: 'higgsfield-mcp', jobId: 'job-parity', status: 'completed', model: 'seedream_v5_pro', soulId: '',
    mediaType: 'image', prompt: 'p', width: 1024, height: 1024, duration: 0, aspectRatio: '1:1',
    resolution: '1k', count: 2, referenceCount: 0, resultUrl: 'https://cdn.example.test/parity.png', createdAt: NOW, checkedAt: NOW
  }
  const scenarios = [
    ['url change', s => [s, 'result', { url: 'https://example.test/new' }, {}],
      s => updatePanelState(s, 'result', { url: 'https://example.test/new' }, {}, makeId),
      (r, s) => r.updatePanelState(s, 'result', { url: 'https://example.test/new' }, {}, makeId)],
    ['page viewport change', s => null,
      s => updatePanelState(s, 'result', { preset: 'mobile', width: 390, height: 844 }, {}, makeId),
      (r, s) => r.updatePanelState(s, 'result', { preset: 'mobile', width: 390, height: 844 }, {}, makeId)],
    ['provenance rotation', s => null,
      s => updatePanelState(s, 'result', { providerEvidence: structuredClone(evidence) }, {}, makeId),
      (r, s) => r.updatePanelState(s, 'result', { providerEvidence: structuredClone(evidence) }, {}, makeId)]
  ]
  for (const [, , standalone, viaRuntime] of scenarios) {
    assert.deepEqual(viaRuntime(runtime, structuredClone(state)), standalone(structuredClone(state)))
  }
  const changed = updatePanelState(state, 'result', { url: 'https://example.test/new' }, {}, makeId)
  const linked = linkPanelState(changed, 'result', { profileId: 'midjourney', contextId: 'cnext-0000', linkedAt: NOW }, makeId)
  assert.deepEqual(runtime.linkPanelState(changed, 'result', { profileId: 'midjourney', contextId: 'cnext-0000', linkedAt: NOW }, makeId), linked)
  assert.deepEqual(
    runtime.linkPanelState(linked, 'result', { profileId: 'design', contextId: 'coverride-0000', linkedAt: NOW }, makeId),
    linkPanelState(linked, 'result', { profileId: 'design', contextId: 'coverride-0000', linkedAt: NOW }, makeId)
  )
  assert.deepEqual(runtime.swapPanelsState(linked, makeId), swapPanelsState(linked, makeId))
  assert.deepEqual(runtime.markPanelLoadFailedState(linked, 'result'), markPanelLoadFailedState(linked, 'result'))
  assert.equal(runtime.markPanelLoadFailedState(linked, 'reference'), linked, 'load failure on an unlinked panel stays a no-op in the runtime core')
  assert.equal(runtime.providerEvidenceIdentity(null), providerEvidenceIdentity(null))
  assert.equal(runtime.providerEvidenceIdentity(evidence), providerEvidenceIdentity(evidence))

  const mediaState = structuredClone(runtime.DEFAULT_STATE)
  mediaState.browserPanels.reference = { ...mediaState.browserPanels.reference, url: 'https://cdn.example.test/shot.png', targetId: 'tmedia-0000' }
  assert.deepEqual(
    runtime.updatePanelState(structuredClone(mediaState), 'reference', { preset: 'desktop', width: 1440, height: 900 }, {}, makeId),
    updatePanelState(structuredClone(mediaState), 'reference', { preset: 'desktop', width: 1440, height: 900 }, {}, makeId)
  )

  const tampered = {
    schemaVersion: 6,
    browserPanels: { result: { url: 'https://example.test/page', targetId: 'bad' } },
    reviewContext: {
      contextId: 'bad', panelId: 'result', targetId: 'bad', profileId: 'design', url: 'https://example.test/page',
      mediaKind: 'weird', viewport: { width: 10 }, stale: 'yes', staleReason: 'unknown', linkedAt: NOW
    },
    evaluations: { design: { layout: { status: 'pass', note: 'must-clear' } } }
  }
  const runtimeHealed = runtime.restoredState(structuredClone(tampered))
  const coreHealed = migratePersistedState(structuredClone(tampered), runtime.DEFAULT_STATE)
  assert.equal(runtimeHealed.reviewContext, null)
  assert.deepEqual(runtimeHealed.evaluations, coreHealed.evaluations)
  assert.deepEqual({ ...runtimeHealed, browserPanels: null }, { ...coreHealed, browserPanels: null },
    'tampered v6 healing stays aligned (panels excluded: fresh ids are non-deterministic)')

  const smuggledLegacy = {
    schemaVersion: 6,
    browserPanels: { result: { url: 'https://example.test/page', targetId: 'tsmuggle-0000' } },
    reviewContext: { profileId: 'design', panelId: 'result', url: 'https://example.test/page' },
    evaluations: { design: { layout: { status: 'pass', note: 'must-clear' } } }
  }
  assert.equal(runtime.restoredState(structuredClone(smuggledLegacy)).reviewContext, null)
  assert.equal(migratePersistedState(structuredClone(smuggledLegacy), runtime.DEFAULT_STATE).reviewContext, null)
  assert.deepEqual(runtime.restoredState(structuredClone(smuggledLegacy)).evaluations, {})

  const provenanceBase = structuredClone(runtime.DEFAULT_STATE)
  provenanceBase.browserPanels.reference = {
    ...provenanceBase.browserPanels.reference,
    url: 'https://cdn.example.test/shot.png',
    targetId: 'tprov-0000',
    providerEvidence: structuredClone(evidence)
  }
  const provenanceLinked = {
    ...linkPanelState(provenanceBase, 'reference', { profileId: 'higgsfield-image', contextId: 'cprov-0000', linkedAt: NOW }, makeId),
    schemaVersion: 6,
    evaluations: { 'higgsfield-image': { c1: { status: 'pass', note: 'live' } } }
  }
  const substituted = structuredClone(provenanceLinked)
  substituted.browserPanels.reference.providerEvidence.jobId = 'job-substituted'
  const runtimeDropped = runtime.restoredState(structuredClone(substituted))
  const coreDropped = migratePersistedState(structuredClone(substituted), runtime.DEFAULT_STATE)
  assert.equal(runtimeDropped.reviewContext, null)
  assert.deepEqual(runtimeDropped, coreDropped, 'provenance-mismatch restore stays aligned between runtime and core')
  assert.deepEqual(runtimeDropped.evaluations, {})

  const staleHistory = structuredClone(substituted)
  staleHistory.reviewContext.stale = true
  staleHistory.reviewContext.staleReason = 'provenance-changed'
  const runtimeStale = runtime.restoredState(structuredClone(staleHistory))
  const coreStale = migratePersistedState(structuredClone(staleHistory), runtime.DEFAULT_STATE)
  assert.equal(runtimeStale.reviewContext?.providerEvidence?.jobId, 'job-parity')
  assert.deepEqual(runtimeStale, coreStale, 'stale historical provenance restore stays aligned between runtime and core')
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
  assert.match(pluginSource, /panelLinkedToQc\(workbench, panelId\)/)
  assert.match(pluginSource, /children: linkedCapture \? 'Refresh evidence' : 'Capture evidence'/)
  assert.match(pluginSource, /pluginContext\?\.storage\.set\('workbench\.v7'/)
  assert.match(pluginSource, /element\.addEventListener\('did-navigate', syncUrl\)/)
  assert.match(pluginSource, /browserSplit: panelId === 'reference' \? true : current\.browserSplit/)
  assert.match(pluginSource, /children: 'Inspection status'/)
  assert.match(pluginSource, /label: 'Provider metadata'/)
  assert.match(pluginSource, /children: 'Run page checks'/)
  assert.match(pluginSource, /value: 'READ ONLY'/)
  assert.match(pluginSource, /providerEvidence: providerEvidenceFor\(input\)/)
  assert.match(pluginSource, /children: reviewed \? candidate\.disposition : 'UNREVIEWED'/)
  assert.match(pluginSource, /reviewContextMatches\(workbench, profileId\)/)
  assert.match(pluginSource, /Page checks returned incomplete CDP audit data/)
  assert.match(pluginSource, /browserApi\.audit\(guestId\)/)
  assert.match(pluginSource, /const browserMediaElements = new Map\(\)/)
  assert.match(pluginSource, /element\?\.complete && element\?\.naturalWidth > 0/)
  assert.match(pluginSource, /element\?\.readyState >= 2 && element\?\.videoWidth > 0/)
  assert.match(pluginSource, /comparableUrl\(currentSrc\) !== comparableUrl\(panel\.url\)/)
  assert.match(pluginSource, /mediaKind\(panel\.url\) === 'page' && !window\.hermesDesktop\?\.browser\?\.capture/)
  assert.doesNotMatch(pluginSource, /Runtime\.evaluate/)
  assert.match(pluginSource, /staleReason = urlChanged \? 'url-changed' : viewportChanged \? 'viewport-changed' : 'provenance-changed'/)
  assert.match(pluginSource, /Link the target in the Browser pane before editing QC/)
  assert.match(pluginSource, /element\.addEventListener\('did-fail-load', syncLoadFailure\)/)
  assert.doesNotMatch(pluginSource, /currentReviewContext/)
})
test('runtime agent command exports stay aligned with the standalone QC core', () => {
  const runtime = loadRuntimeCore()
  const command = { id: 'target', op: 'set-target', panelId: 'result', payload: { url: 'https://example.test/agent' } }
  const makeId = prefix => `${prefix}agent-0000`
  assert.deepEqual(runtime.validateAgentCommand(command), validateAgentCommand(command))
  assert.deepEqual(runtime.applyAgentCommand(structuredClone(runtime.DEFAULT_STATE), command, makeId), applyAgentCommand(structuredClone(runtime.DEFAULT_STATE), command, makeId))
  const applied = applyAgentCommand(structuredClone(runtime.DEFAULT_STATE), command, makeId)
  assert.deepEqual(runtime.agentStatusSnapshot(applied.state), agentStatusSnapshot(applied.state))
})

test('runtime dispatcher subscribes to the command socket', () => {
  assert.match(pluginSource, /ctx\.socket\('\/commands', received => \{ void dispatchAgentCommand\(ctx, received, seenAgentCommandIds\) \}\)/)
})

test('runtime Midjourney QC links infer strict URL provenance without a control ledger', () => {
  const runtime = loadRuntimeCore()
  const jobId = '123e4567-e89b-42d3-a456-426614174000'
  const url = `https://www.midjourney.com/jobs/${jobId}?index=0`
  const state = structuredClone(runtime.DEFAULT_STATE)
  state.browserPanels.result = { ...state.browserPanels.result, url, targetId: 'tmj-0000', providerEvidence: null }
  const linked = runtime.linkPanelState(state, 'result', { profileId: 'midjourney', contextId: 'cmj-0000', linkedAt: NOW }, prefix => `${prefix}next-0000`)
  assert.deepEqual(linked.reviewContext.providerEvidence, {
    source: 'midjourney', jobId, operationId: '', resultUrl: url
  })
  assert.deepEqual(linked.browserPanels.result.providerEvidence, linked.reviewContext.providerEvidence)
  for (const invalidUrl of [
    `https://midjourney.com/jobs/${jobId}/`,
    `https://midjourney.com/jobs/${jobId}?index=0&extra=1`,
    `https://midjourney.example/jobs/${jobId}`,
    `https://midjourney.com/jobs/not-a-uuid`
  ]) assert.equal(runtime.midjourneyProviderEvidenceForUrl(invalidUrl), null, invalidUrl)
})

test('Midjourney candidate navigation preserves only the linked job while capture and stale guards remain strict', () => {
  const runtime = loadRuntimeCore()
  const jobId = '123e4567-e89b-42d3-a456-426614174000'
  const url = `https://www.midjourney.com/jobs/${jobId}`
  const evidence = { source: 'midjourney', jobId, operationId: 'op-1', resultUrl: url }
  const base = structuredClone(runtime.DEFAULT_STATE)
  base.browserPanels.result = {
    ...base.browserPanels.result, url, targetId: 'tmj-0000', qcProfileHint: 'midjourney', providerEvidence: evidence
  }
  const linked = runtime.linkPanelState(base, 'result', { profileId: 'midjourney', contextId: 'cmj-0000', linkedAt: NOW }, prefix => `${prefix}next-0000`)
  linked.capture = {
    panelId: 'result', targetId: 'tmj-0000', url, width: 1440, height: 900,
    viewport: { preset: 'desktop', width: 1440, height: 900, responsive: false }, createdAt: 1, path: ''
  }

  assert.equal(runtime.agentStatusSnapshot(linked).capture.url, url)
  assert.deepEqual(runtime.agentStatusSnapshot(linked).capture.viewport, linked.capture.viewport)
  const candidateUrl = `https://www.midjourney.com/jobs/${jobId}?index=0`
  assert.equal(runtime.sameMidjourneyCandidateSwitch(url, candidateUrl, jobId), true)
  const navigateStart = pluginSource.indexOf("if (payload.action === 'navigate') {")
  const navigateEnd = pluginSource.indexOf("const { context, snapshot } = await midjourneySnapshot(panelId)", navigateStart)
  const navigateSource = pluginSource.slice(navigateStart, navigateEnd)
  assert.match(navigateSource, /const panelEvidence = restoredProviderEvidence\(panel\?\.providerEvidence\)/)
  assert.match(navigateSource, /const candidateJobId = link\?\.jobId \|\| \(panelEvidence\?\.source === 'midjourney' \? panelEvidence\.jobId : ''\)/)
  assert.match(navigateSource, /sameMidjourneyCandidateSwitch\(currentUrl, payload\.url, candidateJobId\)/)
  assert.match(navigateSource, /if \(!preserveMidjourneyCandidate\) midjourneyLinks\.delete\(panelId\)/)
  assert.match(navigateSource, /preserveProviderEvidence: preserveMidjourneyCandidate/)
  assert.match(navigateSource, /preserveQcProfileHint: preserveMidjourneyCandidate/)
  assert.doesNotMatch(navigateSource, /preserveMidjourneyCandidate: true/)
  const candidate = runtime.updatePanelState(linked, 'result', { url: candidateUrl }, {
    preserveMidjourneyCandidate: runtime.sameMidjourneyCandidateSwitch(url, candidateUrl, jobId),
    preserveProviderEvidence: true, preserveQcProfileHint: true
  }, prefix => `${prefix}unexpected-0000`)
  assert.equal(candidate.browserPanels.result.targetId, 'tmj-0000')
  assert.equal(candidate.reviewContext.stale, false)
  assert.equal(candidate.reviewContext.url, candidateUrl)
  assert.equal(candidate.reviewContext.providerEvidence.jobId, jobId)
  assert.equal(runtime.agentStatusSnapshot(candidate).reviewContext.providerJobId, jobId)
  assert.equal(candidate.capture, null)
  assert.deepEqual(runtime.restoredProviderEvidence({ source: 'midjourney', jobId: jobId.toUpperCase(), operationId: 'op-1', resultUrl: url }), evidence)
  assert.equal(runtime.restoredProviderEvidence({ source: 'midjourney', jobId: 'not-a-uuid' }), null)
  const nextCandidateUrl = `https://www.midjourney.com/jobs/${jobId}?index=3`
  const nextCandidate = runtime.updatePanelState(candidate, 'result', { url: nextCandidateUrl }, {
    preserveMidjourneyCandidate: runtime.sameMidjourneyCandidateSwitch(candidateUrl, nextCandidateUrl, jobId),
    preserveProviderEvidence: true, preserveQcProfileHint: true
  }, prefix => `${prefix}next-candidate-0000`)
  assert.equal(nextCandidate.reviewContext.stale, false)
  assert.equal(nextCandidate.browserPanels.result.targetId, 'tmj-0000')
  assert.equal(runtime.sameMidjourneyCandidateSwitch(candidateUrl, candidateUrl, jobId), false)
  assert.equal(runtime.sameMidjourneyCandidateSwitch(url, url, jobId), false)
  assert.equal(runtime.sameMidjourneyCandidateSwitch(url, `${url}?index=4`, jobId), false)
  assert.equal(runtime.sameMidjourneyCandidateSwitch(candidateUrl, `${url}?index=0&extra=1`, jobId), false)
  assert.equal(runtime.sameMidjourneyCandidateSwitch(candidateUrl, `${url}?index=0&index=1`, jobId), false)
  assert.equal(runtime.sameMidjourneyCandidateSwitch(candidateUrl, `${url}?index=x`, jobId), false)

  const otherUrl = 'https://www.midjourney.com/jobs/223e4567-e89b-42d3-a456-426614174000?index=0'
  const other = runtime.updatePanelState(candidate, 'result', { url: otherUrl }, {
    preserveMidjourneyCandidate: runtime.sameMidjourneyCandidateSwitch(candidateUrl, otherUrl, jobId)
  }, prefix => `${prefix}other-0000`)
  assert.equal(other.reviewContext.stale, true)
  assert.equal(other.reviewContext.staleReason, 'url-changed')
  assert.equal(other.capture, null)

  const viewport = runtime.updatePanelState(linked, 'result', { preset: 'mobile', width: 390, height: 844 }, {}, prefix => `${prefix}viewport-0000`)
  assert.equal(viewport.reviewContext.staleReason, 'viewport-changed')
  assert.equal(viewport.capture, null)
  const failed = runtime.markPanelLoadFailedState(linked, 'result')
  assert.equal(failed.reviewContext.staleReason, 'load-failed')
  assert.equal(failed.capture, null)
})

test('Midjourney schema-v1 A-D import document validates and A selection is SELECTED', () => {
  const runtime = loadRuntimeCore()
  const document = validDocument()
  assert.deepEqual(runtime.validateQcDocument(JSON.stringify(document)), document)
  const selected = runtime.applyAgentCommand({
    ...structuredClone(runtime.DEFAULT_STATE),
    browserPanels: {
      ...runtime.DEFAULT_STATE.browserPanels,
      result: { ...runtime.DEFAULT_STATE.browserPanels.result, url: 'https://www.midjourney.com/jobs/123e4567-e89b-42d3-a456-426614174000?index=0', targetId: 'tmj-select' }
    },
    qcTargetPanelId: 'result',
    qcProfile: 'midjourney',
    reviewContext: {
      contextId: 'cmj-select', panelId: 'result', targetId: 'tmj-select', profileId: 'midjourney',
      url: 'https://www.midjourney.com/jobs/123e4567-e89b-42d3-a456-426614174000?index=0',
      mediaKind: 'page', viewport: { preset: 'desktop', width: 1440, height: 900, responsive: false },
      providerEvidence: null, linkedAt: NOW, stale: false, staleReason: ''
    }
  }, { op: 'select-candidate', payload: { candidateId: 'A' } })
  assert.equal(document.job.state, 'SELECTED')
  assert.equal(selected.state.selectedCandidate, 'A')
})
test('Midjourney control surface uses the typed Hermes seam and excludes forbidden browser APIs', () => {
  const midjourneySource = pluginSource.slice(pluginSource.indexOf('const MIDJOURNEY_SELECTOR_REGISTRY'), pluginSource.indexOf('async function runDesignPageChecks'))
  assert.match(midjourneySource, /mj-web-2026-07-19\.v3/)
  assert.match(midjourneySource, /browserApi\.control\(context\.guestId/)
  assert.match(midjourneySource, /op: 'focusText', targetId: 'composer', text, replace: true/)
  assert.match(midjourneySource, /op: 'setFileInput', targetId: 'image-file-input'/)
  assert.match(midjourneySource, /payload\.action === 'settings'/)
  assert.match(midjourneySource, /Midjourney personalization readback failed/)
  assert.match(midjourneySource, /current\.composerMode !== requestedMode/)
  assert.match(midjourneySource, /selectedRoles\.length !== 1 \|\| selectedRoles\[0\] !== role/)
  assert.match(midjourneySource, /op: 'results'/)
  assert.match(midjourneySource, /payload\.action === 'results'/)
  assert.match(midjourneySource, /Midjourney acknowledged submit linkage is/)
  assert.match(midjourneySource, /normalizedMidjourneyPromptBody/)
  assert.match(midjourneySource, /String\(result\.jobId\)\.toLowerCase\(\) === requestedJobId/)
  assert.match(midjourneySource, /Midjourney grid requires the exact linked current job/)
  assert.doesNotMatch(midjourneySource, /nearestStartFrameRight|wrong-slot Start Frame/)
  assert.match(midjourneySource, /artifactRelativePath: safe/)
  assert.match(midjourneySource, /A fresh matching Midjourney validate receipt is required/)
  assert.match(midjourneySource, /Midjourney panel target or URL changed/)
  assert.match(midjourneySource, /operationId/)
  assert.doesNotMatch(midjourneySource, /Runtime\.evaluate|DOM\.querySelector|Input\.|Network\.|document\.cookie|localStorage|sessionStorage/)
  assert.match(midjourneyCliSource, /existing === true && queued\?\.queued === false/)
  assert.match(midjourneyCliSource, /operationId: queued\.operationId/)
  assert.match(midjourneyCliSource, /openapi\.json/)
  assert.match(midjourneyCliSource, /body\?\.info\?\.title !== 'Hermes Agent'/)
  assert.match(midjourneyCliSource, /renderline\/control\/result\?cursor=0/)
  assert.match(midjourneyCliSource, /if \(authorized\.ok\) return/)
  assert.match(midjourneyCliSource, /control token must have mode 0600/)
  assert.doesNotMatch(midjourneyCliSource, /console\.(?:log|error)\([^\n]*token/)
})
