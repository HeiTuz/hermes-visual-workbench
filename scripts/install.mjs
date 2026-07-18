#!/usr/bin/env node

import { access, lstat, mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'

import {
  atomicWrite,
  backupFile,
  dashboardDirectory,
  MARKER_NAME,
  PACKAGE_ROOT,
  parseArgs,
  readJson,
  sha256,
  skillDirectory,
  targetDirectory
} from './lib.mjs'

const usage = `Hermes Visual Workbench installer

Usage:
  hermes-visual-workbench [--hermes-home PATH]
  hermes-visual-workbench --target PLUGIN_DIRECTORY --skill-target SKILL_DIRECTORY
  hermes-visual-workbench --uninstall [--force]

Options:
  --hermes-home PATH  Hermes home (default: HERMES_HOME or ~/.hermes)
  --target PATH       Exact plugin installation directory
  --skill-target PATH Exact workflow skill installation directory
  --uninstall         Remove all managed files
  --force             Uninstall even when a managed file was modified
  --help              Show this help
`

async function exists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function readManagedFile(path) {
  try {
    const info = await lstat(path)
    if (!info.isFile()) throw new Error(`Managed path must be a regular file: ${path}`)
    return await readFile(path)
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

function expectedManagedFiles(target, skillTarget, dashboardTarget) {
  return [
    { id: 'plugin', path: join(target, 'plugin.js') },
    { id: 'skill', path: join(skillTarget, 'SKILL.md') },
    { id: 'dashboard-manifest', path: join(dashboardTarget, 'manifest.json') },
    { id: 'dashboard-api', path: join(dashboardTarget, 'plugin_api.py') }
  ]
}

function validatedMarkerFiles(marker, expected) {
  if (marker?.sha256 && !marker?.files) {
    if (!/^[a-f0-9]{64}$/.test(marker.sha256)) throw new Error('Installation marker has an invalid plugin hash')
    return [{ ...expected[0], sha256: marker.sha256 }]
  }
  if (!Array.isArray(marker?.files) || marker.files.length !== expected.length) {
    throw new Error('Installation marker has an incomplete managed file list')
  }

  return expected.map(file => {
    const matches = marker.files.filter(candidate => candidate?.id === file.id)
    if (matches.length !== 1) throw new Error(`Installation marker is missing or duplicates managed file: ${file.id}`)
    const [entry] = matches
    if (entry.path !== file.path) throw new Error(`Installation marker has an invalid managed path for ${file.id}`)
    if (!/^[a-f0-9]{64}$/.test(entry.sha256)) throw new Error(`Installation marker has an invalid hash for ${file.id}`)
    return { ...file, sha256: entry.sha256 }
  })
}

async function uninstall(target, skillTarget, dashboardTarget, options) {
  const markerPath = join(target, MARKER_NAME)
  const expected = expectedManagedFiles(target, skillTarget, dashboardTarget)

  if (!(await Promise.all([...expected.map(file => exists(file.path)), exists(markerPath)])).some(Boolean)) {
    console.log(`Visual Workbench is not installed at ${target}`)
    return
  }

  let marker = null
  if (await exists(markerPath)) {
    try {
      marker = JSON.parse((await readManagedFile(markerPath)).toString('utf8'))
    } catch {
      marker = null
    }
  }

  if (!options.force && !marker) {
    throw new Error(`No managed installation marker at ${markerPath}. Re-run with --force to remove it.`)
  }
  let files
  if (options.force) {
    files = expected
  } else {
    files = validatedMarkerFiles(marker, expected)
  }
  if (!options.force) {
    for (const file of files) {
      const current = await readManagedFile(file.path)
      if (!current) continue
      const currentHash = sha256(current)
      if (currentHash !== file.sha256) {
        throw new Error(`Refusing to remove locally modified managed file: ${file.path}. Re-run with --force if intentional.`)
      }
    }
  }
  for (const file of files) await rm(file.path, { force: true })
  await rm(markerPath, { force: true })
  await rm(skillTarget, { force: true, recursive: false }).catch(() => {})
  console.log(`Removed Visual Workbench from ${target}`)
}

async function install(target, skillTarget, dashboardTarget) {
  const packageJson = await readJson(join(PACKAGE_ROOT, 'package.json'))
  const markerPath = join(target, MARKER_NAME)
  const sourcePaths = {
    plugin: join(PACKAGE_ROOT, 'plugin.js'),
    skill: join(PACKAGE_ROOT, 'skill', 'SKILL.md'),
    'dashboard-manifest': join(PACKAGE_ROOT, 'dashboard', 'manifest.json'),
    'dashboard-api': join(PACKAGE_ROOT, 'dashboard', 'plugin_api.py')
  }
  const managed = expectedManagedFiles(target, skillTarget, dashboardTarget).map(file => ({
    ...file,
    sourcePath: sourcePaths[file.id]
  }))

  await Promise.all([mkdir(target, { recursive: true }), mkdir(skillTarget, { recursive: true }), mkdir(dashboardTarget, { recursive: true })])
  const markerBefore = await readManagedFile(markerPath)
  const plans = []
  for (const file of managed) {
    const [source, current] = await Promise.all([readFile(file.sourcePath), readManagedFile(file.path)])
    plans.push({ ...file, source, sourceHash: sha256(source), current })
  }

  const files = []
  let changed = false
  for (const file of plans) {
    if (file.current) {
      const currentHash = sha256(file.current)
      if (currentHash !== file.sourceHash) {
        const backup = await backupFile(file.path, join(target, 'backups', file.id))
        console.log(`Backed up existing ${file.id} to ${backup}`)
        changed = true
      }
    } else {
      changed = true
    }
    files.push({ id: file.id, path: file.path, sha256: file.sourceHash })
  }

  const applied = []
  try {
    for (const file of plans) {
      await atomicWrite(file.path, file.source)
      applied.push(file)
    }
    await atomicWrite(
      markerPath,
      `${JSON.stringify({ schemaVersion: 2, installedAt: new Date().toISOString(), package: packageJson.name, version: packageJson.version, files }, null, 2)}\n`
    )
  } catch (installError) {
    const rollbackErrors = []
    for (const file of [...applied].reverse()) {
      try {
        if (file.current) await atomicWrite(file.path, file.current)
        else await rm(file.path, { force: true })
      } catch (rollbackError) {
        rollbackErrors.push(`${file.path}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`)
      }
    }
    try {
      if (markerBefore) await atomicWrite(markerPath, markerBefore)
      else await rm(markerPath, { force: true })
    } catch (rollbackError) {
      rollbackErrors.push(`${markerPath}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`)
    }
    const suffix = rollbackErrors.length
      ? ` Rollback also failed: ${rollbackErrors.join('; ')}`
      : ' Previous managed files were restored.'
    throw new Error(`Installation failed: ${installError instanceof Error ? installError.message : String(installError)}.${suffix}`)
  }
  console.log(`${changed ? 'Installed' : 'Verified'} Visual Workbench ${packageJson.version} at ${target}`)
  console.log(`Installed Midjourney workflow skill to ${skillTarget}`)
  console.log('Run: hermes plugins enable visual-workbench (backend restart required)')
}

try {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    process.stdout.write(usage)
  } else {
    const target = targetDirectory(options)
    const skillTarget = skillDirectory(options)
    const dashboardTarget = dashboardDirectory(options)
    if (options.uninstall) await uninstall(target, skillTarget, dashboardTarget, options)
    else await install(target, skillTarget, dashboardTarget)
  }
} catch (error) {
  console.error(`hermes-visual-workbench: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
