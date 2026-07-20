import { createHash } from 'node:crypto'
import { copyFile, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url))
export const MARKER_NAME = '.hermes-visual-workbench-install.json'
export const SKILL_NAME = 'midjourney-visual-workbench'

export function parseArgs(argv) {
  const args = [...argv]
  while (args[0] === '--') args.shift()

  const options = { dryRun: false, force: false, help: false, hermesHome: '', rollback: false, skillTarget: '', target: '', uninstall: false, update: false, verify: false }

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--force') options.force = true
    else if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--install') {}
    else if (arg === '--update') options.update = true
    else if (arg === '--verify') options.verify = true
    else if (arg === '--rollback') options.rollback = true
    else if (arg === '--help' || arg === '-h') options.help = true
    else if (arg === '--uninstall') options.uninstall = true
    else if (arg === '--target' || arg === '--skill-target' || arg === '--hermes-home') {
      const value = args[index + 1]
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a path`)
      index += 1
      if (arg === '--target') options.target = value
      else if (arg === '--skill-target') options.skillTarget = value
      else options.hermesHome = value
    } else {
      throw new Error(`Unknown option: ${arg}`)
    }
  }

  if (Boolean(options.target) !== Boolean(options.skillTarget)) {
    throw new Error('--target and --skill-target must be supplied together')
  }
  if (options.force && !options.uninstall) {
    throw new Error('--force is only valid with --uninstall')
  }
  if ([options.uninstall, options.verify, options.rollback].filter(Boolean).length > 1) {
    throw new Error('--uninstall, --verify, and --rollback are mutually exclusive')
  }
  if (options.dryRun && (options.uninstall || options.verify)) {
    throw new Error('--dry-run is valid only with install, update, or rollback')
  }

  return options
}

export function targetDirectory(options, env = process.env) {
  if (options.target) return resolve(options.target)
  const hermesHome = options.hermesHome || env.HERMES_HOME || join(homedir(), '.hermes')
  return join(resolve(hermesHome), 'desktop-plugins', 'visual-workbench')
}

export function hermesHomeDirectory(options, env = process.env) {
  return resolve(options.hermesHome || env.HERMES_HOME || join(homedir(), '.hermes'))
}

export function skillDirectory(options, env = process.env) {
  if (options.skillTarget) return resolve(options.skillTarget)
  return join(hermesHomeDirectory(options, env), 'skills', SKILL_NAME)
}
export function dashboardDirectory(options, env = process.env) {
  return join(hermesHomeDirectory(options, env), 'plugins', 'visual-workbench', 'dashboard')
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}
export function isContainedPath(root, destination) {
  const canonicalRoot = resolve(root)
  const canonicalDestination = resolve(destination)
  const path = relative(canonicalRoot, canonicalDestination)
  return path === '' || (!path.startsWith('..') && !path.includes(`..${process.platform === 'win32' ? '\\' : '/'}`) && !path.startsWith('/'))
}

export async function assertSafeDestination(root, destination) {
  if (!isContainedPath(root, destination)) {
    throw new Error(`Installation destination escapes Hermes home: ${destination}`)
  }

  const configuredRoot = resolve(root)
  const configuredDestination = resolve(destination)
  const trustedParent = dirname(configuredRoot)
  for (let current = configuredDestination; ; current = dirname(current)) {
    try {
      const info = await lstat(current)
      if (info.isSymbolicLink()) throw new Error(`Installation destination has a symlinked parent: ${current}`)
      if (!info.isDirectory() && current !== configuredDestination) {
        throw new Error(`Installation destination has a non-directory parent: ${current}`)
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    if (current === trustedParent) break
    if (current === dirname(current)) break
  }

  const canonicalTrustedParent = await realpath(trustedParent)
  const canonicalRoot = join(canonicalTrustedParent, basename(configuredRoot))
  const canonicalDestination = join(canonicalTrustedParent, relative(trustedParent, configuredDestination))
  if (!isContainedPath(canonicalTrustedParent, canonicalRoot) || !isContainedPath(canonicalRoot, canonicalDestination)) {
    throw new Error(`Installation destination escapes Hermes home: ${destination}`)
  }
}

export async function atomicWrite(path, value, mode = 0o644) {
  await mkdir(dirname(path), { recursive: true })
  const temporary = join(dirname(path), `.${basename(path)}.tmp-${process.pid}-${Date.now()}`)
  await writeFile(temporary, value, { mode })

  try {
    try {
      await rename(temporary, path)
    } catch (error) {
      if (!['EEXIST', 'EPERM'].includes(error?.code)) throw error
      await rm(path, { force: true })
      await rename(temporary, path)
    }
  } finally {
    await rm(temporary, { force: true }).catch(() => {})
  }
}

export async function backupFile(path, backupDirectory) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const destination = join(backupDirectory, `${basename(path)}-${stamp}.bak`)
  await mkdir(backupDirectory, { recursive: true })
  await copyFile(path, destination)
  return destination
}

export async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}
