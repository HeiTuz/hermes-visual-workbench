#!/usr/bin/env node

import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { realpathSync } from 'node:fs'
import { promisify } from 'node:util'

import { providerEvidenceFor } from './qc-core.mjs'

const execFileAsync = promisify(execFile)

// Structural read-only allowlist. Every permitted command maps to an observation-only
// `higgsfield` subcommand. There is no argv passthrough, so paid or mutating subcommands
// (generate create, soul-id train, upload, delete, publish, auth token, ...) are unreachable.
export const READ_ONLY_COMMANDS = Object.freeze({
  account: () => ['account', 'status', '--json'],
  generations: () => ['generate', 'list', '--json'],
  souls: () => ['soul-id', 'list', '--json'],
  models: () => ['model', 'list', '--json'],
  job: options => ['generate', 'get', requireJobId(options.jobId), '--json']
})

// Defensive second layer with explicit denial messages for anything mutating or credential-bearing.
export const BLOCKED_COMMANDS = Object.freeze([
  'create', 'generate-create', 'train', 'soul-train', 'delete', 'remove', 'update',
  'upload', 'publish', 'deploy', 'buy', 'purchase', 'voice-change', 'token', 'login', 'logout'
])

const HIGGSFIELD_BIN = process.env.HIGGSFIELD_BIN || 'higgsfield'

function usage() {
  process.stderr.write(`Usage: higgsfield-control <account|generations|souls|models|job|evidence> [flags]

Read-only Higgsfield CLI bridge for Visual Workbench QC provenance.

Commands:
  account            Print signed-in account status (higgsfield account status)
  generations        List existing generation jobs (higgsfield generate list)
  souls              List Soul references (higgsfield soul-id list)
  models             List available models (higgsfield model list)
  job --job-id ID    Inspect one existing job (higgsfield generate get ID)
  evidence           Print normalized Visual Workbench provider evidence for one job

Flags:
  --job-id ID        Target job id (job / evidence)
  --url URL          Result URL to match one exact job (evidence)
  --input PATH       Read a generations JSON file instead of calling the CLI (offline)
  --print-argv       Print the resolved read-only higgsfield argv and exit (no execution)
  --json             Reserved; CLI output is already JSON

Never invokes paid, mutating, or credential-printing subcommands. Never uses the 'hf'
alias, which collides with the HuggingFace CLI.
`)
  process.exitCode = 1
}

function requireJobId(jobId) {
  if (!/^[0-9a-fA-F][0-9a-fA-F-]{7,63}$/.test(String(jobId || ''))) {
    throw new Error('job requires a valid --job-id')
  }
  return String(jobId)
}

export function assertHiggsfieldBinary(binary) {
  const name = String(binary || '').split('/').pop()
  if (name === 'hf') {
    throw new Error("Refusing 'hf': it resolves to the HuggingFace CLI on this host. Use 'higgsfield'.")
  }
  return binary
}

export function resolveReadOnlyArgv(command, options = {}) {
  if (BLOCKED_COMMANDS.includes(command)) {
    throw new Error(`Higgsfield command '${command}' is not permitted: this bridge is strictly read-only`)
  }
  const build = READ_ONLY_COMMANDS[command]
  if (!build) throw new Error(`Unknown read-only command: '${command}'`)
  return build(options)
}

export function extractJobs(payload) {
  if (Array.isArray(payload)) return payload
  if (!payload || typeof payload !== 'object') return []
  for (const key of ['items', 'jobs', 'data', 'generations', 'results']) {
    if (Array.isArray(payload[key])) return payload[key]
  }
  return []
}

function jobResultUrls(job) {
  const urls = []
  for (const value of [job?.result_url, job?.resultUrl, job?.url, job?.min_result_url]) {
    if (typeof value === 'string' && value) urls.push(value)
  }
  const results = job && typeof job.results === 'object' && job.results ? job.results : {}
  for (const value of [results.rawUrl, results.minUrl, results.url]) {
    if (typeof value === 'string' && value) urls.push(value)
  }
  return [...new Set(urls)]
}

export function selectJobByUrl(jobs, url) {
  if (typeof url !== 'string' || !url) return null
  const matches = extractJobs(jobs).filter(job => jobResultUrls(job).includes(url))
  return matches.length === 1 ? matches[0] : null
}

export function selectJobById(jobs, jobId) {
  if (typeof jobId !== 'string' || !jobId) return null
  const matches = extractJobs(jobs).filter(job => (job?.id || job?.job_id || job?.jobId) === jobId)
  return matches.length === 1 ? matches[0] : null
}

export function evidenceForJob(job, srcOverride) {
  if (!job || typeof job !== 'object') return null
  const src = typeof srcOverride === 'string' && srcOverride ? srcOverride : jobResultUrls(job)[0]
  if (typeof src !== 'string' || !src) return null
  // Reuse the exact provenance normalization the Visual Workbench already trusts for
  // Higgsfield results. The synthetic tool name keeps the existing extractor path while
  // the result URL is sanitized (signed query params removed) inside restoredProviderEvidence.
  return providerEvidenceFor({ toolName: 'higgsfield-cli', src, toolResult: { items: [job] } })
}

function parseArgs(argv) {
  const options = { command: '', jobId: '', url: '', input: '', printArgv: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--job-id') options.jobId = argv[++index] || ''
    else if (arg === '--url') options.url = argv[++index] || ''
    else if (arg === '--input') options.input = argv[++index] || ''
    else if (arg === '--print-argv') options.printArgv = true
    else if (arg === '--json') continue
    else if (arg === '--help' || arg === '-h') { usage(); return null }
    else if (!options.command) options.command = arg
    else { usage(); return null }
  }
  if (!options.command) { usage(); return null }
  return options
}

async function runHiggsfield(args) {
  assertHiggsfieldBinary(HIGGSFIELD_BIN)
  const { stdout } = await execFileAsync(HIGGSFIELD_BIN, args, { maxBuffer: 16 * 1024 * 1024 })
  return stdout
}

async function loadJobs(options) {
  if (options.input) return extractJobs(JSON.parse(await readFile(options.input, 'utf8')))
  return extractJobs(JSON.parse(await runHiggsfield(['generate', 'list', '--json'])))
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (!options) return

  if (options.command === 'evidence') {
    const jobs = await loadJobs(options)
    const job = options.url ? selectJobByUrl(jobs, options.url) : selectJobById(jobs, options.jobId)
    const evidence = evidenceForJob(job, options.url)
    if (!evidence) {
      process.stderr.write('No single exact Higgsfield job matched the requested url or job id\n')
      process.exitCode = 1
      return
    }
    process.stdout.write(`${JSON.stringify(evidence)}\n`)
    return
  }

  const argv = resolveReadOnlyArgv(options.command, options)
  if (options.printArgv) {
    process.stdout.write(`${JSON.stringify(argv)}\n`)
    return
  }
  if (options.input && options.command === 'generations') {
    process.stdout.write(`${JSON.stringify(extractJobs(JSON.parse(await readFile(options.input, 'utf8'))))}\n`)
    return
  }
  process.stdout.write(await runHiggsfield(argv))
}

function isDirectRun() {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (isDirectRun()) {
  main().catch(error => {
    process.stderr.write(`higgsfield-control: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
