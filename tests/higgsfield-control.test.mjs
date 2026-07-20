import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import {
  READ_ONLY_COMMANDS,
  BLOCKED_COMMANDS,
  resolveReadOnlyArgv,
  assertHiggsfieldBinary,
  extractJobs,
  selectJobByUrl,
  selectJobById,
  evidenceForJob
} from '../scripts/higgsfield-control.mjs'

const script = fileURLToPath(new URL('../scripts/higgsfield-control.mjs', import.meta.url))
const SIGNED = 'https://cdn.higgsfield.ai/generations/abc.png?token=secret-token&sig=secret-sig&Expires=123&Key-Pair-Id=secret-key'

function job(overrides = {}) {
  return {
    id: '7483fa69-b1e8-42b1-b830-b3ae443ec3d1',
    status: 'completed',
    display_name: 'Higgsfield Soul V2',
    job_set_type: 'text2image_soul_v2',
    result_url: SIGNED,
    created_at: 1784570752.16,
    params: { prompt: 'a cinematic test prompt', width: 1152, height: 2048, batch_size: 1, seed: 81272, aspect_ratio: '9:16', custom_reference_id: 'soul-123' },
    ...overrides
  }
}

function invoke(args, env = {}) {
  return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env: { ...process.env, ...env } })
}

test('read-only allowlist maps only observation subcommands', () => {
  assert.deepEqual(resolveReadOnlyArgv('account'), ['account', 'status', '--json'])
  assert.deepEqual(resolveReadOnlyArgv('generations'), ['generate', 'list', '--json'])
  assert.deepEqual(resolveReadOnlyArgv('souls'), ['soul-id', 'list', '--json'])
  assert.deepEqual(resolveReadOnlyArgv('models'), ['model', 'list', '--json'])
  assert.deepEqual(resolveReadOnlyArgv('job', { jobId: '7483fa69-b1e8-42b1-b830-b3ae443ec3d1' }), [
    'generate', 'get', '7483fa69-b1e8-42b1-b830-b3ae443ec3d1', '--json'
  ])
  assert.ok(!Object.keys(READ_ONLY_COMMANDS).includes('create'))
})

test('read-only firewall refuses every mutating or credential command', () => {
  for (const command of BLOCKED_COMMANDS) {
    assert.throws(() => resolveReadOnlyArgv(command), /strictly read-only/)
  }
  assert.throws(() => resolveReadOnlyArgv('unknown-op'), /Unknown read-only command/)
  assert.throws(() => resolveReadOnlyArgv('job', { jobId: 'bad id' }), /valid --job-id/)
})

test('refuses the hf binary that collides with the HuggingFace CLI', () => {
  assert.throws(() => assertHiggsfieldBinary('hf'), /HuggingFace/)
  assert.throws(() => assertHiggsfieldBinary('/opt/homebrew/bin/hf'), /HuggingFace/)
  assert.equal(assertHiggsfieldBinary('higgsfield'), 'higgsfield')
  assert.equal(assertHiggsfieldBinary('/Users/x/.npm-global/bin/higgsfield'), '/Users/x/.npm-global/bin/higgsfield')
})

test('normalizes a CLI job into workbench provider evidence and redacts the signed url', () => {
  const evidence = evidenceForJob(job())
  assert.equal(evidence.source, 'higgsfield-mcp')
  assert.equal(evidence.jobId, '7483fa69-b1e8-42b1-b830-b3ae443ec3d1')
  assert.equal(evidence.model, 'text2image_soul_v2')
  assert.equal(evidence.mediaType, 'image')
  assert.match(evidence.prompt, /cinematic test prompt/)
  assert.equal(evidence.width, 1152)
  assert.equal(evidence.height, 2048)
  assert.equal(evidence.soulId, 'soul-123')
  assert.ok(evidence.resultUrl.startsWith('https://cdn.higgsfield.ai/generations/abc.png'))
  for (const secret of ['secret-token', 'secret-sig', 'secret-key']) {
    assert.ok(!evidence.resultUrl.includes(secret), `resultUrl leaked ${secret}`)
  }
})

test('selects exactly one job and rejects ambiguity', () => {
  assert.equal(selectJobByUrl([job()], SIGNED)?.id, '7483fa69-b1e8-42b1-b830-b3ae443ec3d1')
  assert.equal(selectJobByUrl([job(), job()], SIGNED), null)
  assert.equal(selectJobByUrl([], SIGNED), null)
  assert.equal(selectJobById([job()], '7483fa69-b1e8-42b1-b830-b3ae443ec3d1')?.status, 'completed')
  assert.equal(selectJobById([job(), job()], '7483fa69-b1e8-42b1-b830-b3ae443ec3d1'), null)
})

test('extractJobs reads common list envelopes', () => {
  assert.equal(extractJobs([job()]).length, 1)
  assert.equal(extractJobs({ items: [job()] }).length, 1)
  assert.equal(extractJobs({ jobs: [job(), job()] }).length, 2)
  assert.equal(extractJobs({ nothing: true }).length, 0)
})

test('--print-argv prints the resolved read-only argv without executing', () => {
  const account = invoke(['--print-argv', 'account'])
  assert.equal(account.status, 0, account.stderr)
  assert.deepEqual(JSON.parse(account.stdout), ['account', 'status', '--json'])
})

test('--print-argv fails closed for a mutating command', () => {
  const create = invoke(['--print-argv', 'create'])
  assert.notEqual(create.status, 0)
  assert.match(create.stderr, /read-only/)
})

test('evidence subcommand normalizes an offline generations file', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'hf-control-'))
  t.after(() => rm(directory, { force: true, recursive: true }))
  const file = join(directory, 'generations.json')
  await writeFile(file, JSON.stringify({ items: [job()] }))

  const result = invoke(['evidence', '--input', file, '--url', SIGNED])
  assert.equal(result.status, 0, result.stderr)
  const evidence = JSON.parse(result.stdout)
  assert.equal(evidence.jobId, '7483fa69-b1e8-42b1-b830-b3ae443ec3d1')
  assert.equal(evidence.model, 'text2image_soul_v2')
  for (const secret of ['secret-token', 'secret-sig', 'secret-key']) {
    assert.ok(!JSON.stringify(evidence).includes(secret), `evidence leaked ${secret}`)
  }

  const ambiguous = invoke(['evidence', '--input', file, '--url', 'https://cdn.higgsfield.ai/missing.png'])
  assert.notEqual(ambiguous.status, 0)
  assert.match(ambiguous.stderr, /No single exact/)
})
