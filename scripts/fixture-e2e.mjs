#!/usr/bin/env node

import { access, copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, extname, join, resolve } from 'node:path'

import { blankCandidate, CANDIDATE_IDS, QC_DIMENSIONS, validateQcDocument } from './qc-core.mjs'

const PACKAGE_ROOT = resolve(import.meta.dirname, '..')

function parseArgs(argv) {
  const options = { brief: 'Deterministic non-billable Midjourney grid fixture', capture: '', force: false, hermesHome: '', jobId: '', now: '' }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--force') options.force = true
    else if (['--brief', '--capture', '--hermes-home', '--job-id', '--now'].includes(arg)) {
      const value = argv[index + 1]
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`)
      options[{ '--brief': 'brief', '--capture': 'capture', '--hermes-home': 'hermesHome', '--job-id': 'jobId', '--now': 'now' }[arg]] = value
      index += 1
    } else throw new Error(`Unknown option: ${arg}`)
  }
  return options
}

async function exists(path) {
  try { await access(path); return true } catch { return false }
}

function candidate(id, score, disposition, summary) {
  const value = blankCandidate(id)
  value.score = score
  value.disposition = disposition
  value.summary = summary
  value.evidence = [`Fixture candidate ${id} is intentionally labeled for deterministic workflow verification.`]
  value.repairPrompt = disposition === 'REPAIR' ? `Repair candidate ${id}: improve composition and production readiness while preserving the brief.` : ''
  value.dimensions = Object.fromEntries(QC_DIMENSIONS.map((key, index) => [key, {
    score: Math.max(0, Math.min(100, score - (index % 3))),
    evidence: `Fixture ${key} evidence for candidate ${id}.`
  }]))
  return value
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const now = options.now || new Date().toISOString()
  if (!Number.isFinite(Date.parse(now))) throw new Error('--now must be an ISO timestamp')
  const compact = now.replace(/[-:.TZ]/g, '').slice(0, 14)
  const jobId = options.jobId || `fixture-v1-${compact}`
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(jobId)) throw new Error('job id must be filesystem-safe and at most 128 characters')

  const hermesHome = resolve(options.hermesHome || process.env.HERMES_HOME || join(homedir(), '.hermes'))
  const artifactRoot = join(hermesHome, 'artifacts', 'midjourney')
  const jobDir = join(artifactRoot, jobId)
  if (!jobDir.startsWith(`${artifactRoot}/`)) throw new Error('job path escaped the Midjourney artifact root')
  if (await exists(jobDir)) {
    if (!options.force) throw new Error(`artifact job already exists: ${jobId}`)
    await rm(jobDir, { force: true, recursive: true })
  }
  await mkdir(jobDir, { recursive: true })

  const captureSource = resolve(options.capture || join(PACKAGE_ROOT, 'fixtures', 'midjourney-grid.svg'))
  const extension = extname(captureSource).toLowerCase() || '.bin'
  const captureName = `capture${extension}`
  await copyFile(captureSource, join(jobDir, captureName))

  const job = { id: jobId, state: 'GRID_READY', brief: options.brief, createdAt: now, updatedAt: now }
  const candidates = [
    candidate('A', 92, 'PASS', 'Strongest balanced fixture candidate.'),
    candidate('B', 78, 'REPAIR', 'Usable after a bounded composition repair.'),
    candidate('C', 54, 'REJECT', 'Fails production-readiness threshold.'),
    candidate('D', 68, 'REPAIR', 'Secondary repair candidate with weaker fidelity.')
  ]
  const qc = validateQcDocument({ schemaVersion: 1, job, selectedCandidate: 'A', candidates, generatedAt: now })
  const request = { schemaVersion: 1, jobId, brief: options.brief, mode: 'fixture', requestedAt: now, creditApproval: false }
  const provenance = {
    schemaVersion: 1,
    source: 'deterministic-fixture',
    capture: captureName,
    sourceCaptureName: basename(captureSource),
    createdAt: now,
    billableActionsExecuted: [],
    cookieDataAccessed: false,
    credentialsEntered: false
  }

  await Promise.all([
    writeFile(join(jobDir, 'request.json'), `${JSON.stringify(request, null, 2)}\n`),
    writeFile(join(jobDir, 'provenance.json'), `${JSON.stringify(provenance, null, 2)}\n`),
    writeFile(join(jobDir, 'qc.json'), `${JSON.stringify(qc, null, 2)}\n`)
  ])

  const readback = validateQcDocument(await readFile(join(jobDir, 'qc.json'), 'utf8'))
  if (readback.selectedCandidate !== 'A' || readback.candidates.map(item => item.id).join('') !== CANDIDATE_IDS.join('')) {
    throw new Error('fixture QC readback failed')
  }
  console.log(JSON.stringify({ ok: true, jobId, jobDir, capture: join(jobDir, captureName), qc: join(jobDir, 'qc.json') }))
}

main().catch(error => {
  console.error(`midjourney-fixture-e2e: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
