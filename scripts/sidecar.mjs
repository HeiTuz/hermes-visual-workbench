#!/usr/bin/env node

import { createHash, randomBytes } from 'node:crypto'
import { access, chmod, copyFile, lstat, mkdir, readFile, readlink, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url))
const PACKAGE = JSON.parse(await readFile(join(PACKAGE_ROOT, 'package.json'), 'utf8'))
const HOME = resolve(process.env.RENDERLINE_HOME || join(homedir(), 'Library', 'Application Support', 'Renderline'))
const HERMES_HOME = resolve(process.env.HERMES_HOME || join(homedir(), '.hermes'))
const RELEASES = join(HOME, 'releases')
const RELEASE = join(RELEASES, PACKAGE.version)
const CURRENT = join(HOME, 'current')
const PREVIOUS = join(HOME, 'previous')
const VENV = join(HOME, 'venv')
const TOKEN = join(HOME, 'control.token')
const MARKER = join(HOME, '.renderline-sidecar-install.json')
const LABEL = 'com.eusin.renderline.sidecar'
const PLIST = join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`)
const UID = process.getuid?.() ?? 501
const DOMAIN = `gui/${UID}`
const action = process.argv[2] || 'install'

const files = ['__init__.py', 'app.py', 'requirements.txt', 'schema.json']
const sha = value => createHash('sha256').update(value).digest('hex')
async function exists(path) { try { await access(path); return true } catch { return false } }
function run(command, args, options = {}) {
  const cleanEnvironment = { ...process.env }
  delete cleanEnvironment.PYTHONPATH
  delete cleanEnvironment.PYTHONHOME
  delete cleanEnvironment.VIRTUAL_ENV
  const result = spawnSync(command, args, { encoding: 'utf8', env: cleanEnvironment, ...options })
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed: ${(result.stderr || result.stdout).trim()}`)
  return result.stdout.trim()
}
async function atomic(path, content, mode = 0o644) {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`
  await writeFile(temporary, content, { mode })
  await rename(temporary, path)
}
async function safeLink(path) {
  try {
    const info = await lstat(path)
    if (!info.isSymbolicLink()) throw new Error(`${path} must be a symlink`)
    return resolve(dirname(path), await readlink(path))
  } catch (error) {
    if (error?.code === 'ENOENT') return ''
    throw error
  }
}
async function replaceLink(path, target) {
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`
  await rm(temporary, { force: true })
  await symlink(target, temporary)
  await rename(temporary, path)
}
function plist(release) {
  const python = join(VENV, 'bin', 'python')
  const out = join(HOME, 'logs', 'sidecar.log')
  const err = join(HOME, 'logs', 'sidecar.error.log')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${LABEL}</string>
<key>ProgramArguments</key><array><string>${python}</string><string>-m</string><string>uvicorn</string><string>sidecar.app:app</string><string>--host</string><string>127.0.0.1</string><string>--port</string><string>47821</string></array>
<key>WorkingDirectory</key><string>${release}</string>
<key>EnvironmentVariables</key><dict><key>RENDERLINE_HOME</key><string>${HOME}</string><key>HERMES_HOME</key><string>${HERMES_HOME}</string><key>PYTHONPATH</key><string>${release}</string></dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ProcessType</key><string>Background</string>
<key>StandardOutPath</key><string>${out}</string><key>StandardErrorPath</key><string>${err}</string>
</dict></plist>\n`
}
async function restart(release) {
  await mkdir(dirname(PLIST), { recursive: true })
  await mkdir(join(HOME, 'logs'), { recursive: true })
  await atomic(PLIST, plist(release))
  spawnSync('launchctl', ['bootout', DOMAIN, PLIST], { encoding: 'utf8' })
  run('launchctl', ['bootstrap', DOMAIN, PLIST])
  run('launchctl', ['enable', `${DOMAIN}/${LABEL}`])
  run('launchctl', ['kickstart', '-k', `${DOMAIN}/${LABEL}`])
}
async function install() {
  if (process.platform !== 'darwin') throw new Error('Renderline sidecar launchd install currently requires macOS')
  await mkdir(RELEASE, { recursive: true })
  const marked = []
  for (const name of files) {
    const source = await readFile(join(PACKAGE_ROOT, 'sidecar', name))
    await atomic(join(RELEASE, 'sidecar', name), source)
    marked.push({ path: `sidecar/${name}`, sha256: sha(source) })
  }
  if (!(await exists(TOKEN))) await atomic(TOKEN, `${randomBytes(48).toString('base64url')}\n`, 0o600)
  await chmod(TOKEN, 0o600)
  if (await exists(join(VENV, 'bin', 'python'))) {
    const probe = spawnSync(join(VENV, 'bin', 'python'), ['-I', '-c', 'import fastapi, uvicorn'], { env: {} })
    if (probe.status !== 0) await rm(VENV, { recursive: true, force: true })
  }
  if (!(await exists(join(VENV, 'bin', 'python')))) run('/usr/bin/python3', ['-m', 'venv', VENV])
  run(join(VENV, 'bin', 'python'), ['-m', 'pip', 'install', '--disable-pip-version-check', '--quiet', '--requirement', join(RELEASE, 'sidecar', 'requirements.txt')])
  const current = await safeLink(CURRENT)
  if (current && current !== RELEASE) await replaceLink(PREVIOUS, current)
  await replaceLink(CURRENT, RELEASE)
  await atomic(MARKER, `${JSON.stringify({ schemaVersion: 1, version: PACKAGE.version, release: RELEASE, files: marked }, null, 2)}\n`, 0o600)
  await restart(RELEASE)
  console.log(`Installed independent Renderline sidecar ${PACKAGE.version} at ${HOME}`)
}
async function verify() {
  const marker = JSON.parse(await readFile(MARKER, 'utf8'))
  if (marker.version !== PACKAGE.version || marker.release !== RELEASE) throw new Error('sidecar marker version drift')
  if (await safeLink(CURRENT) !== RELEASE) throw new Error('sidecar current release drift')
  for (const entry of marker.files) {
    const value = await readFile(join(RELEASE, entry.path))
    if (sha(value) !== entry.sha256) throw new Error(`sidecar hash drift: ${entry.path}`)
  }
  let response
  let health
  let lastError
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      response = await fetch('http://127.0.0.1:47821/health')
      health = await response.json()
      if (response.ok && health.ok === true && health.version === PACKAGE.version && health.schemaVersion === 1) break
      lastError = new Error('sidecar live health mismatch')
    } catch (error) {
      lastError = error
    }
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  if (!response?.ok || health?.ok !== true || health?.version !== PACKAGE.version || health?.schemaVersion !== 1) {
    throw lastError || new Error('sidecar live health mismatch')
  }
  console.log(`Verified independent Renderline sidecar ${PACKAGE.version} pid-managed by launchd`)
}
async function rollback() {
  const previous = await safeLink(PREVIOUS)
  if (!previous || !(await exists(previous))) throw new Error('no previous sidecar release')
  const current = await safeLink(CURRENT)
  await replaceLink(CURRENT, previous)
  if (current) await replaceLink(PREVIOUS, current)
  await restart(previous)
  console.log(`Rolled back Renderline sidecar to ${previous}`)
}
async function uninstall() {
  spawnSync('launchctl', ['bootout', DOMAIN, PLIST], { encoding: 'utf8' })
  await rm(PLIST, { force: true })
  console.log(`Stopped Renderline sidecar; durable state retained at ${HOME}`)
}

try {
  if (action === 'install' || action === 'update') await install()
  else if (action === 'verify') await verify()
  else if (action === 'rollback') await rollback()
  else if (action === 'uninstall') await uninstall()
  else throw new Error(`unknown sidecar action: ${action}`)
} catch (error) {
  console.error(`renderline-sidecar: ${error.message}`)
  process.exitCode = 1
}
