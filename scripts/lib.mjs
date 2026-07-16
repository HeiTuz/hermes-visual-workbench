import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url))
export const MARKER_NAME = '.hermes-visual-workbench-install.json'

export function parseArgs(argv) {
  const args = [...argv]
  while (args[0] === '--') args.shift()

  const options = { force: false, help: false, hermesHome: '', target: '', uninstall: false }

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--force') options.force = true
    else if (arg === '--help' || arg === '-h') options.help = true
    else if (arg === '--uninstall') options.uninstall = true
    else if (arg === '--target' || arg === '--hermes-home') {
      const value = args[index + 1]
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a path`)
      index += 1
      if (arg === '--target') options.target = value
      else options.hermesHome = value
    } else {
      throw new Error(`Unknown option: ${arg}`)
    }
  }

  return options
}

export function targetDirectory(options, env = process.env) {
  if (options.target) return resolve(options.target)
  const hermesHome = options.hermesHome || env.HERMES_HOME || join(homedir(), '.hermes')
  return join(resolve(hermesHome), 'desktop-plugins', 'visual-workbench')
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

export async function atomicWrite(path, value, mode = 0o644) {
  await mkdir(dirname(path), { recursive: true })
  const temporary = join(dirname(path), `.${basename(path)}.tmp-${process.pid}-${Date.now()}`)
  await writeFile(temporary, value, { mode })

  try {
    await rename(temporary, path)
  } catch (error) {
    if (!['EEXIST', 'EPERM'].includes(error?.code)) throw error
    await rm(path, { force: true })
    await rename(temporary, path)
  }
}

export async function backupFile(path, backupDirectory) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const destination = join(backupDirectory, `plugin-${stamp}.js`)
  await mkdir(backupDirectory, { recursive: true })
  await copyFile(path, destination)
  return destination
}

export async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}
