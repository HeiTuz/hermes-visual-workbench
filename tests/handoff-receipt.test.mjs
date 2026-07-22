import test from 'node:test'
import assert from 'node:assert/strict'

import { verifyHandoffReceipt } from '../scripts/handoff-receipt.mjs'

function validReceipt(overrides = {}) {
  return {
    schemaVersion: 1,
    provider: 'higgsfield',
    assetKind: 'image',
    link: { contextId: 'renderline-context-1', targetId: 't-result-1' },
    capture: { path: '/tmp/renderline/capture.png', targetId: 't-result-1' },
    qc: {
      candidates: [
        { id: 'A', score: 91, disposition: 'PASS' },
        { id: 'B', score: 72, disposition: 'REPAIR' }
      ]
    },
    select: { candidateId: 'A' },
    ...overrides
  }
}

test('accepts complete Higgsfield and Midjourney handoff receipts', () => {
  assert.deepEqual(verifyHandoffReceipt(validReceipt()), {
    ok: true,
    state: 'DELIVERABLE',
    selectedCandidate: 'A'
  })
  assert.deepEqual(verifyHandoffReceipt(validReceipt({ provider: 'midjourney', assetKind: 'grid' })), {
    ok: true,
    state: 'DELIVERABLE',
    selectedCandidate: 'A'
  })
})

test('fails closed with a structured state when each mandatory receipt stage is absent', () => {
  const cases = [
    ['link', { link: undefined }],
    ['capture', { capture: undefined }],
    ['qc', { qc: undefined }],
    ['select', { select: undefined }]
  ]

  for (const [stage, override] of cases) {
    const result = verifyHandoffReceipt(validReceipt(override))
    assert.equal(result.ok, false, stage)
    assert.equal(result.state, 'DELIVERY_BLOCKED', stage)
    assert.ok(result.missing.includes(stage), stage)
  }
})

test('requires every QC candidate to have a bounded integer score and disposition', () => {
  for (const candidate of [
    { id: 'A', score: 101, disposition: 'PASS' },
    { id: 'A', score: 90.5, disposition: 'PASS' },
    { id: 'A', score: 90, disposition: 'UNKNOWN' },
    { id: '', score: 90, disposition: 'PASS' }
  ]) {
    const result = verifyHandoffReceipt(validReceipt({ qc: { candidates: [candidate] }, select: { candidateId: 'A' } }))
    assert.equal(result.ok, false)
    assert.equal(result.state, 'DELIVERY_BLOCKED')
    assert.ok(result.missing.includes('qc'))
  }
})

test('requires selection to name a candidate present in the QC receipt', () => {
  assert.deepEqual(verifyHandoffReceipt(validReceipt({ select: { candidateId: 'C' } })), {
    ok: false,
    state: 'DELIVERY_BLOCKED',
    missing: ['select']
  })
})

test('requires exact schema-v1 keys, unique bounded candidates, correlation, and a selected PASS candidate', () => {
  const cases = [
    ['extra receipt field', { agentModel: 'GPT-5.6' }, 'receipt'],
    ['extra candidate field', { qc: { candidates: [{ id: 'A', score: 91, disposition: 'PASS', note: 'extra' }] } }, 'qc'],
    ['duplicate candidate', { qc: { candidates: [{ id: 'A', score: 91, disposition: 'PASS' }, { id: 'A', score: 80, disposition: 'REPAIR' }] } }, 'qc'],
    ['too many candidates', { qc: { candidates: ['A', 'B', 'C', 'D', 'E'].map(id => ({ id, score: 80, disposition: id === 'A' ? 'PASS' : 'REPAIR' })) } }, 'qc'],
    ['capture target mismatch', { capture: { path: '/tmp/renderline/capture.png', targetId: 'other' } }, 'capture'],
    ['selected non-pass', { select: { candidateId: 'B' } }, 'select'],
    ['unsupported 3D', { assetKind: '3d' }, 'assetKind']
  ]
  for (const [name, override, stage] of cases) {
    const result = verifyHandoffReceipt(validReceipt(override))
    assert.equal(result.ok, false, name)
    assert.equal(result.state, 'DELIVERY_BLOCKED', name)
    assert.ok(result.missing.includes(stage), name)
  }
})
