import assert from 'node:assert/strict'
import test from 'node:test'

import { sanitizeUrl, providerEvidenceFor } from '../scripts/qc-core.mjs'

const raw = 'https://cdn.example.test/asset.png?token=synthetic-token&sig=synthetic-sig&signature=synthetic-signature&expires=synthetic-expires&key=synthetic-key&auth=synthetic-auth&keep=ok'
const secrets = ['synthetic-token', 'synthetic-sig', 'synthetic-signature', 'synthetic-expires', 'synthetic-key', 'synthetic-auth']

test('red-team: persisted and observed JS URL sinks remove every signed query secret', () => {
  const clean = sanitizeUrl(raw)
  for (const secret of secrets) assert.doesNotMatch(clean, new RegExp(secret))
  assert.match(clean, /keep=ok/)
  const evidence = providerEvidenceFor({
    toolName: 'mcp__higgsfield__show_generations',
    src: raw,
    toolResult: { structuredContent: { items: [{
      id: 'job-clean', status: 'completed', type: 'image', model: 'seedream_v5_pro',
      results: { rawUrl: raw }
    }] } }
  })
  assert.ok(evidence)
  for (const secret of secrets) assert.doesNotMatch(JSON.stringify(evidence), new RegExp(secret))
})

test('red-team: Higgsfield requires an exact URL match and rejects duplicate exact matches', () => {
  const exact = 'https://cdn.example.test/shared.png?sig=first'
  const evidence = providerEvidenceFor({
    src: exact,
    toolName: 'mcp__higgsfield__show_generations',
    toolResult: { structuredContent: { items: [
      { id: 'one', status: 'completed', type: 'image', results: { rawUrl: exact } },
      { id: 'two', status: 'completed', type: 'image', results: { rawUrl: 'https://cdn.example.test/shared.png?sig=second' } }
    ] } }
  })
  assert.equal(evidence?.jobId, 'one', 'the exact signed URL must win over a redaction collision')
  const collision = providerEvidenceFor({
    src: exact,
    toolName: 'mcp__higgsfield__show_generations',
    toolResult: { structuredContent: { items: [
      { id: 'one', status: 'completed', type: 'image', results: { rawUrl: exact } },
      { id: 'two', status: 'completed', type: 'image', results: { rawUrl: exact } }
    ] } }
  })
  assert.equal(collision, null, 'duplicate exact matches must fail closed')
})
