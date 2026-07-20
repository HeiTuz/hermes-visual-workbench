import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('../scripts/midjourney-control.mjs', import.meta.url))
const receipt = 'validation-receipt-from-one-validate-result'
const fingerprint = 'a'.repeat(64)

function invoke(...args) {
  return spawnSync(process.execPath, [script, '--serialize', ...args], { encoding: 'utf8' })
}

test('submit serialization preserves the validation receipt and batch fingerprint together', () => {
  const result = invoke(
    'submit',
    '--approve-billable',
    '--idempotency-key',
    'idempotency-key',
    '--validate-receipt',
    receipt,
    '--batch-fingerprint',
    fingerprint
  )

  assert.equal(result.status, 0, result.stderr)
  const command = JSON.parse(result.stdout)
  assert.deepEqual(command.payload, {
    action: 'submit',
    approved: true,
    idempotencyKey: 'idempotency-key',
    validateReceipt: receipt,
    batchFingerprint: fingerprint
  })
})

test('submit without a valid lowercase 64-hex batch fingerprint fails closed', () => {
  for (const args of [
    ['submit', '--approve-billable', '--idempotency-key', 'idempotency-key', '--validate-receipt', receipt],
    ['submit', '--approve-billable', '--idempotency-key', 'idempotency-key', '--validate-receipt', receipt, '--batch-fingerprint', 'A'.repeat(64)]
  ]) {
    const result = invoke(...args)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /batch fingerprint/i)
    assert.equal(result.stdout, '')
  }
})
