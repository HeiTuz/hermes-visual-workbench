#!/usr/bin/env node

import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import os from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const COMMANDS = new Set(['capabilities', 'state', 'navigate', 'probe', 'results', 'settings', 'draft', 'attach', 'detach', 'validate', 'submit', 'wait', 'link', 'grid', 'action', 'download', 'capture', 'qc'])

function usage() {
  console.error(`Usage: midjourney-control.mjs [--base-url http://127.0.0.1:PORT] [--serialize] <command> [options]
Commands: capabilities, state, navigate --url URL, probe, results, settings [--name NAME --value VALUE], draft --prompt TEXT [--parameters JSON],
          attach --path FILE --role ROLE, detach --role ROLE, validate,
          submit --approve-billable --idempotency-key KEY --validate-receipt RECEIPT --batch-fingerprint 64LOWERHEX,
          wait [--timeout-ms N], link --operation-id HASH --job-id ID --prompt TEXT --acknowledged --ledger-created-at ISO,
          grid, action --name NAME --job-id ID [--candidate A-D] [--approve-billable --idempotency-key KEY],
          download --job-id ID --filename NAME, capture, qc
--serialize prints the command envelope without contacting Hermes (for local verification).`)
  process.exit(2)
}

function parseArgs(argv) {
  const options = { baseUrl: '', panelId: 'result', command: '', payload: {}, timeout: 20_000, serialize: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--base-url') options.baseUrl = argv[++index] || ''
    else if (arg === '--serialize') options.serialize = true
    else if (arg === '--panel-id') options.panelId = argv[++index] || ''
    else if (arg === '--url') options.payload.url = argv[++index] || ''
    else if (arg === '--prompt') options.payload.prompt = argv[++index] || ''
    else if (arg === '--parameters') {
      try { options.payload.parameters = JSON.parse(argv[++index] || '') } catch { usage() }
    } else if (arg === '--path') options.payload.path = argv[++index] || ''
    else if (arg === '--role') options.payload.role = argv[++index] || ''
    else if (arg === '--name') options.payload.name = argv[++index] || ''
    else if (arg === '--value') {
      const value = argv[++index] || ''
      options.payload.value = value === 'true' ? true : value === 'false' ? false : /^-?\d+(?:\.\d+)?$/.test(value) ? Number(value) : value
    }
    else if (arg === '--candidate') options.payload.candidate = argv[++index] || ''
    else if (arg === '--idempotency-key') options.payload.idempotencyKey = argv[++index] || ''
    else if (arg === '--validate-receipt') options.payload.validateReceipt = argv[++index] || ''
    else if (arg === '--batch-fingerprint') options.payload.batchFingerprint = argv[++index] || ''
    else if (arg === '--operation-id') options.payload.operationId = argv[++index] || ''
    else if (arg === '--acknowledged') options.payload.acknowledged = true
    else if (arg === '--ledger-created-at') options.payload.ledgerCreatedAt = argv[++index] || ''
    else if (arg === '--job-id') options.payload.jobId = argv[++index] || ''
    else if (arg === '--filename') options.payload.filename = argv[++index] || ''
    else if (arg === '--approve-billable') options.payload.approved = true
    else if (arg === '--timeout-ms') {
      const value = Number(argv[++index])
      if (!Number.isInteger(value)) usage()
      options.payload.timeoutMs = value
      options.timeout = Math.max(options.timeout, value + 5_000)
    } else if (!options.command) options.command = arg
    else usage()
  }
  if (!COMMANDS.has(options.command)) usage()
  if (options.baseUrl && !/^http:\/\/127\.0\.0\.1:\d+$/.test(options.baseUrl)) usage()
  if (!['result', 'reference'].includes(options.panelId)) usage()
  options.payload.action = options.command
  if (options.command === 'submit') {
    if (!options.payload.validateReceipt) throw new Error('submit requires a validate receipt')
    if (!/^[0-9a-f]{64}$/.test(options.payload.batchFingerprint || '')) throw new Error('submit requires a valid lowercase 64-hex batch fingerprint')
  }
  return options
}

async function discoverBaseUrl(token) {
  const { stdout } = await execFileAsync('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN'], { maxBuffer: 1024 * 1024 })
  const ports = [...new Set([...stdout.matchAll(/127\.0\.0\.1:(\d+) \(LISTEN\)/g)].map(match => Number(match[1])))]
  for (const port of ports) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/openapi.json`, { signal: AbortSignal.timeout(500) })
      const body = await response.json()
      if (!response.ok || body?.info?.title !== 'Hermes Agent') continue
      const authorized = await fetch(`http://127.0.0.1:${port}/api/plugins/visual-workbench/control/result?cursor=0`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(500)
      })
      if (authorized.ok) return `http://127.0.0.1:${port}`
    } catch {}
  }
  throw new Error('Hermes Agent loopback API was not found')
}

async function request(baseUrl, token, path, init = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...(init.headers || {})
    }
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(`${response.status} ${body.detail || body.error || 'request failed'}`)
  return body
}
function commandEnvelope(options, id) {
  return {
    id,
    op: options.command === 'probe' ? 'midjourney-probe' : 'midjourney-control',
    panelId: options.panelId,
    payload: options.command === 'probe' ? {} : options.payload
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const id = `mj-${options.command}-${randomUUID()}`.slice(0, 64)
  if (options.serialize) {
    process.stdout.write(`${JSON.stringify(commandEnvelope(options, id), null, 2)}\n`)
    return
  }
  const hermesHome = process.env.HERMES_HOME || join(os.homedir(), '.hermes')
  const tokenPath = join(hermesHome, 'plugins', 'visual-workbench', 'control.token')
  const tokenStat = await stat(tokenPath)
  if ((tokenStat.mode & 0o777) !== 0o600) throw new Error('Visual Workbench control token must have mode 0600')
  const token = (await readFile(tokenPath, 'utf8')).trim()
  if (token.length < 43) throw new Error('Visual Workbench control token is missing or invalid')
  options.baseUrl ||= await discoverBaseUrl(token)

  const queued = await request(options.baseUrl, token, '/api/plugins/visual-workbench/command', {
    method: 'POST',
    body: JSON.stringify(commandEnvelope(options, id))
  })
  if (queued?.existing === true && queued?.queued === false) {
    process.stdout.write(`${JSON.stringify({ id, ok: true, duplicate: true, existing: true, queued: false, operationId: queued.operationId, status: queued.status }, null, 2)}\n`)
    return
  }

  const deadline = Date.now() + options.timeout
  let cursor = 0
  while (Date.now() < deadline) {
    const receiptPage = await request(
      options.baseUrl,
      token,
      `/api/plugins/visual-workbench/control/result?cursor=${cursor}`
    )
    const result = Array.isArray(receiptPage?.results)
      ? receiptPage.results.find(receipt => receipt?.id === id)
      : null
    if (result) {
      const output = queued?.operationId ? { ...result, reservationOperationId: queued.operationId } : result
      process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)
      if (!result.ok) process.exitCode = 1
      return
    }
    if (Number.isInteger(receiptPage?.nextCursor) && receiptPage.nextCursor >= cursor) cursor = receiptPage.nextCursor
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error(`Timed out waiting for Visual Workbench ${options.command} result`)
}

main().catch(error => {
  console.error(`midjourney-control: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
