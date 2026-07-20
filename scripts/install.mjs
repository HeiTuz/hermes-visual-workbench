#!/usr/bin/env node

import { access, copyFile, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

import {
  atomicWrite,
  assertSafeDestination,
  dashboardDirectory,
  hermesHomeDirectory,
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
  hermes-visual-workbench --install|--update [--dry-run]
  hermes-visual-workbench --verify
  hermes-visual-workbench --rollback [--dry-run]
  hermes-visual-workbench --uninstall [--force]

Options:
  --hermes-home PATH  Hermes home (default: HERMES_HOME or ~/.hermes)
  --target PATH       Exact plugin installation directory
  --skill-target PATH Exact workflow skill installation directory
  --uninstall         Remove all managed files
  --install           Install or idempotently repair managed files (default)
  --update            Update managed files through the same transaction
  --verify            Verify marker and source/install hashes without writing
  --rollback          Restore the exact newest update transaction
  --dry-run           Print the transaction without writing
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
  const backendTarget = dirname(dashboardTarget)
  return [
    { id: 'plugin', path: join(target, 'plugin.js') },
    { id: 'skill', path: join(skillTarget, 'SKILL.md') },
    { id: 'backend-manifest', path: join(backendTarget, 'plugin.yaml') },
    { id: 'backend-init', path: join(backendTarget, '__init__.py') },
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

async function install(target, skillTarget, dashboardTarget, dryRun = false) {
  const packageJson = await readJson(join(PACKAGE_ROOT, 'package.json'))
  const markerPath = join(target, MARKER_NAME)
  const sourcePaths = {
    plugin: join(PACKAGE_ROOT, 'plugin.js'), skill: join(PACKAGE_ROOT, 'skill', 'SKILL.md'),
    'backend-manifest': join(PACKAGE_ROOT, 'backend', 'plugin.yaml'), 'backend-init': join(PACKAGE_ROOT, 'backend', '__init__.py'),
    'dashboard-manifest': join(PACKAGE_ROOT, 'dashboard', 'manifest.json'), 'dashboard-api': join(PACKAGE_ROOT, 'dashboard', 'plugin_api.py')
  }
  const plans = await Promise.all(expectedManagedFiles(target, skillTarget, dashboardTarget).map(async file => {
    const [source, current] = await Promise.all([readFile(sourcePaths[file.id]), readManagedFile(file.path)])
    return { ...file, source, current, sourceHash: sha256(source), changed: !current || !current.equals(source) }
  }))
  const files = plans.map(file => ({ id: file.id, path: file.path, sha256: file.sourceHash }))
  const markerBefore = await readManagedFile(markerPath)
  let marker
  try { marker = markerBefore && JSON.parse(markerBefore.toString('utf8')) } catch {}
  const markerChanged = plans.some(file => file.changed) || marker?.schemaVersion !== 2 || marker?.package !== packageJson.name ||
    marker?.version !== packageJson.version || JSON.stringify(marker?.files) !== JSON.stringify(files)

  if (dryRun) {
    console.log(`Dry run install/update: ${plans.filter(file => file.changed).length} managed file(s) would change`)
    for (const file of plans) console.log(`${file.changed ? 'write' : 'keep'} ${file.id}`)
    return
  }

  const stamp = `${process.pid}-${Date.now()}`
  const operations = []
  const missingDirectories = new Set()
  async function addMissingDirectories(path) {
    for (let current = path; !(await exists(current)); current = dirname(current)) missingDirectories.add(current)
  }
  for (const file of plans.filter(file => file.changed)) await addMissingDirectories(dirname(file.path))
  if (markerChanged) await addMissingDirectories(dirname(markerPath))
  for (const file of plans.filter(file => file.changed && file.current)) await addMissingDirectories(join(target, 'backups', file.id))
  if (markerChanged && markerBefore) await addMissingDirectories(join(target, 'backups', 'marker'))
  for (const path of [...missingDirectories].sort((a, b) => a.split('/').length - b.split('/').length)) operations.push({ type: 'mkdir', path })

  for (const file of plans.filter(file => file.changed)) {
    const temp = `${file.path}.tmp-${stamp}`
    if (file.current) operations.push({ type: 'backup', path: file.path, backup: join(target, 'backups', file.id, `${basename(file.path)}-${stamp}.bak`) })
    operations.push({ type: 'temp', path: temp, value: file.source })
    operations.push({ type: 'replace', path: file.path, temp, before: file.current })
  }
  if (markerChanged) {
    const temp = `${markerPath}.tmp-${stamp}`
    if (markerBefore) operations.push({ type: 'backup', path: markerPath, backup: join(target, 'backups', 'marker', `${MARKER_NAME}-${stamp}.bak`) })
    operations.push({ type: 'temp', path: temp, value: Buffer.from(`${JSON.stringify({ schemaVersion: 2, installedAt: new Date().toISOString(), package: packageJson.name, version: packageJson.version, files }, null, 2)}\n`) })
    operations.push({ type: 'replace', path: markerPath, temp, before: markerBefore })
  }

  let journalDirectory = dirname(target)
  while (!(await exists(journalDirectory))) journalDirectory = dirname(journalDirectory)
  const journalPath = join(journalDirectory, `.${basename(target)}.install-journal-${stamp}.json`)
  await writeFile(journalPath, JSON.stringify(operations.map(operation => ({
    ...operation, value: operation.value?.toString('base64'), before: operation.before?.toString('base64')
  }))) + '\n', { mode: 0o600 })
  const injectedFailure = process.env.HERMES_VW_TEST_FAIL_OPERATION
  const operationCounts = new Map()
  try {
    for (const operation of operations) {
      const count = (operationCounts.get(operation.type) || 0) + 1
      operationCounts.set(operation.type, count)
      if (injectedFailure === operation.type || injectedFailure === `${operation.type}:${count}`) throw new Error(`Injected ${operation.type} failure`)
      if (operation.type === 'mkdir') await mkdir(operation.path)
      else if (operation.type === 'backup') await copyFile(operation.path, operation.backup)
      else if (operation.type === 'temp') await writeFile(operation.path, operation.value, { mode: 0o644 })
      else if (operation.type === 'replace') await rename(operation.temp, operation.path)
    }
  } catch (error) {
    const rollbackErrors = []
    for (const operation of [...operations].reverse()) {
      try {
        if (operation.type === 'replace') operation.before ? await writeFile(operation.path, operation.before, { mode: 0o644 }) : await rm(operation.path, { force: true })
        else if (operation.type === 'temp') await rm(operation.path, { force: true })
        else if (operation.type === 'backup') await rm(operation.backup, { force: true })
        else if (operation.type === 'mkdir') await rm(operation.path, { force: true })
      } catch (rollbackError) { rollbackErrors.push(`${operation.path}: ${rollbackError.message}`) }
    }
    await rm(journalPath, { force: true }).catch(rollbackError => rollbackErrors.push(`${journalPath}: ${rollbackError.message}`))
    throw new Error(`Installation failed: ${error instanceof Error ? error.message : String(error)}.${rollbackErrors.length ? ` Rollback also failed: ${rollbackErrors.join('; ')}` : ' Previous managed files were restored.'}`)
  }
  await rm(journalPath, { force: true })
  for (const operation of operations.filter(operation => operation.type === 'backup')) {
    console.log(`Backed up existing ${operation.path === markerPath ? 'marker' : plans.find(file => file.path === operation.path)?.id} to ${operation.backup}`)
  }
  console.log(`${plans.some(file => file.changed) ? 'Installed' : 'Verified'} Visual Workbench ${packageJson.version} at ${target}`)
  console.log(`Installed Midjourney workflow skill to ${skillTarget}`)
  console.log('Run: hermes plugins enable visual-workbench (backend restart required)')
}

async function verify(target, skillTarget, dashboardTarget) {
  const markerPath = join(target, MARKER_NAME)
  const markerBytes = await readManagedFile(markerPath)
  if (!markerBytes) throw new Error(`No managed installation marker at ${markerPath}`)
  let marker
  try { marker = JSON.parse(markerBytes.toString('utf8')) } catch { throw new Error('Installation marker is not valid JSON') }
  const expected = expectedManagedFiles(target, skillTarget, dashboardTarget)
  const marked = validatedMarkerFiles(marker, expected)
  const sourcePaths = {
    plugin: join(PACKAGE_ROOT, 'plugin.js'), skill: join(PACKAGE_ROOT, 'skill', 'SKILL.md'),
    'backend-manifest': join(PACKAGE_ROOT, 'backend', 'plugin.yaml'), 'backend-init': join(PACKAGE_ROOT, 'backend', '__init__.py'),
    'dashboard-manifest': join(PACKAGE_ROOT, 'dashboard', 'manifest.json'), 'dashboard-api': join(PACKAGE_ROOT, 'dashboard', 'plugin_api.py')
  }
  for (const file of expected) {
    const [source, current] = await Promise.all([readFile(sourcePaths[file.id]), readManagedFile(file.path)])
    const sourceHash = sha256(source)
    const markedHash = marked.find(entry => entry.id === file.id)?.sha256
    if (!current || sha256(current) !== sourceHash || markedHash !== sourceHash) {
      throw new Error(`Compatibility error: managed file differs from source: ${file.id}. Run hermes-visual-workbench --update`)
    }
  }
  console.log(`Verified Visual Workbench ${marker.version || 'unknown'} at ${target}`)
}

async function rollback(target, skillTarget, dashboardTarget, dryRun = false) {
  const managed = expectedManagedFiles(target, skillTarget, dashboardTarget)
  const markerPath = join(target, MARKER_NAME)
  const markerDirectory = join(target, 'backups', 'marker')
  let markerBackupNames
  try { markerBackupNames = await readdir(markerDirectory) } catch (error) {
    if (error?.code === 'ENOENT') throw new Error('No rollback transaction backup')
    throw error
  }
  const markerPrefix = `${MARKER_NAME}-`
  const candidates = await Promise.all(markerBackupNames
    .filter(name => name.startsWith(markerPrefix) && name.endsWith('.bak'))
    .map(async name => ({ name, modified: (await lstat(join(markerDirectory, name))).mtimeMs })))
  candidates.sort((a, b) => a.modified - b.modified || a.name.localeCompare(b.name))
  const latestMarker = candidates.at(-1)?.name
  if (!latestMarker) throw new Error('No rollback transaction backup')
  const stamp = latestMarker.slice(markerPrefix.length, -'.bak'.length)
  const markerBackupPath = join(markerDirectory, latestMarker)
  const markerBackup = await readManagedFile(markerBackupPath)
  if (!markerBackup) throw new Error('Rollback transaction marker backup is unavailable')

  let previousMarker
  try { previousMarker = JSON.parse(markerBackup.toString('utf8')) } catch {
    throw new Error('Rollback transaction marker backup is not valid JSON')
  }
  const previousEntries = new Map()
  for (const entry of Array.isArray(previousMarker?.files) ? previousMarker.files : []) {
    if (!entry || typeof entry.id !== 'string' || previousEntries.has(entry.id)) {
      throw new Error('Rollback transaction marker has invalid managed file entries')
    }
    previousEntries.set(entry.id, entry)
  }

  const actions = []
  for (const file of managed) {
    const current = await readManagedFile(file.path)
    const backupPath = join(target, 'backups', file.id, `${basename(file.path)}-${stamp}.bak`)
    const backup = await readManagedFile(backupPath)
    if (backup) {
      actions.push({ ...file, type: 'restore', backup, current })
      continue
    }

    const previous = previousEntries.get(file.id)
    if (!previous) {
      actions.push({ ...file, type: 'remove', current })
      continue
    }
    if (previous.path !== file.path || !/^[a-f0-9]{64}$/.test(previous.sha256)) {
      throw new Error(`Rollback transaction marker has invalid metadata for ${file.id}`)
    }
    if (!current || sha256(current) !== previous.sha256) {
      throw new Error(`Rollback transaction is missing the exact backup for changed file: ${file.id}`)
    }
    actions.push({ ...file, type: 'keep', current })
  }

  if (dryRun) {
    const restored = actions.filter(file => file.type === 'restore').length
    const kept = actions.filter(file => file.type === 'keep').length
    const removed = actions.filter(file => file.type === 'remove').length
    console.log(`Dry run rollback: ${restored} managed file(s) would be restored, ${kept} kept, ${removed} removed`)
    for (const file of actions) console.log(`${file.type} ${file.id}`)
    return
  }

  const markerBefore = await readManagedFile(markerPath)
  const applied = []
  try {
    for (const file of actions) {
      if (file.type === 'restore') await atomicWrite(file.path, file.backup)
      else if (file.type === 'remove') await rm(file.path, { force: true })
      else continue
      applied.push(file)
    }
    await atomicWrite(markerPath, markerBackup)
  } catch (error) {
    for (const file of [...applied].reverse()) {
      if (file.current) await atomicWrite(file.path, file.current)
      else await rm(file.path, { force: true })
    }
    if (markerBefore) await atomicWrite(markerPath, markerBefore)
    else await rm(markerPath, { force: true })
    throw error
  }
  console.log(`Rolled back Visual Workbench at ${target}`)
}

try {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    process.stdout.write(usage)
  } else {
    const target = targetDirectory(options)
    const skillTarget = skillDirectory(options)
    const dashboardTarget = dashboardDirectory(options)
    const hermesHome = hermesHomeDirectory(options)
    const destinations = [
      target, skillTarget, dashboardTarget,
      join(target, MARKER_NAME), join(target, 'backups'),
      ...expectedManagedFiles(target, skillTarget, dashboardTarget).map(file => file.path)
    ]
    for (const destination of destinations) await assertSafeDestination(hermesHome, destination)
    if (options.uninstall) await uninstall(target, skillTarget, dashboardTarget, options)
    else if (options.verify) await verify(target, skillTarget, dashboardTarget)
    else if (options.rollback) await rollback(target, skillTarget, dashboardTarget, options.dryRun)
    else await install(target, skillTarget, dashboardTarget, options.dryRun)
  }
} catch (error) {
  console.error(`hermes-visual-workbench: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
