import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

import { validateQcDocument } from '../scripts/qc-core.mjs'
import { verifyHandoffReceipt } from '../scripts/handoff-receipt.mjs'

const root = resolve(import.meta.dirname, '..')
const runner = join(root, 'scripts', 'fixture-e2e.mjs')
const NOW = '2026-07-17T01:02:03.000Z'

test('creates a complete non-billable fixture artifact job under HERMES_HOME', async t => {
  const hermesHome = await mkdtemp(join(tmpdir(), 'hermes-midjourney-fixture-'))
  t.after(() => rm(hermesHome, { force: true, recursive: true }))
  const result = spawnSync(process.execPath, [runner, '--hermes-home', hermesHome, '--job-id', 'fixture-test', '--now', NOW], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  const output = JSON.parse(result.stdout)
  const jobDir = join(hermesHome, 'artifacts', 'midjourney', 'fixture-test')
  assert.equal(output.jobDir, jobDir)
  await stat(join(jobDir, 'capture.svg'))
  const request = JSON.parse(await readFile(join(jobDir, 'request.json'), 'utf8'))
  assert.equal(request.creditApproval, false)
  const provenance = JSON.parse(await readFile(join(jobDir, 'provenance.json'), 'utf8'))
  assert.deepEqual(provenance.billableActionsExecuted, [])
  assert.equal(provenance.cookieDataAccessed, false)
  assert.equal(provenance.credentialsEntered, false)
  const receipt = JSON.parse(await readFile(output.receipt, 'utf8'))
  assert.equal(receipt.provider, 'midjourney')
  assert.equal(receipt.assetKind, 'grid')
  assert.equal(receipt.capture.path, join(jobDir, 'capture.svg'))
  assert.deepEqual(verifyHandoffReceipt(receipt), {
    ok: true,
    state: 'DELIVERABLE',
    selectedCandidate: 'A'
  })
  const qc = validateQcDocument(await readFile(join(jobDir, 'qc.json'), 'utf8'))
  assert.equal(qc.selectedCandidate, 'A')
})

test('refuses accidental duplicate artifact jobs unless forced', async t => {
  const hermesHome = await mkdtemp(join(tmpdir(), 'hermes-midjourney-fixture-'))
  t.after(() => rm(hermesHome, { force: true, recursive: true }))
  const args = [runner, '--hermes-home', hermesHome, '--job-id', 'duplicate', '--now', NOW]
  assert.equal(spawnSync(process.execPath, args, { encoding: 'utf8' }).status, 0)
  const duplicate = spawnSync(process.execPath, args, { encoding: 'utf8' })
  assert.notEqual(duplicate.status, 0)
  assert.match(duplicate.stderr, /already exists/)
  assert.equal(spawnSync(process.execPath, [...args, '--force'], { encoding: 'utf8' }).status, 0)
})
