#!/usr/bin/env node

import { access, mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'

import {
  atomicWrite,
  backupFile,
  MARKER_NAME,
  PACKAGE_ROOT,
  parseArgs,
  readJson,
  sha256,
  targetDirectory
} from './lib.mjs'

const usage = `Hermes Visual Workbench installer

Usage:
  hermes-visual-workbench [--hermes-home PATH]
  hermes-visual-workbench --target PLUGIN_DIRECTORY
  hermes-visual-workbench --uninstall [--force]

Options:
  --hermes-home PATH  Hermes home (default: HERMES_HOME or ~/.hermes)
  --target PATH       Exact plugin installation directory
  --uninstall         Remove the managed plugin
  --force             Uninstall even when plugin.js was modified
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

async function uninstall(target, options) {
  const pluginPath = join(target, 'plugin.js')
  const markerPath = join(target, MARKER_NAME)

  if (!(await exists(pluginPath))) {
    console.log(`Visual Workbench is not installed at ${target}`)
    return
  }

  let marker = null
  if (await exists(markerPath)) {
    try {
      marker = await readJson(markerPath)
    } catch {
      marker = null
    }
  }

  const currentHash = sha256(await readFile(pluginPath))
  if (!options.force && (!marker?.sha256 || marker.sha256 !== currentHash)) {
    throw new Error('Refusing to remove a modified or unmanaged plugin.js. Re-run with --force to remove it.')
  }

  await rm(pluginPath, { force: true })
  await rm(markerPath, { force: true })
  console.log(`Removed Visual Workbench from ${target}`)
}

async function install(target) {
  const sourcePath = join(PACKAGE_ROOT, 'plugin.js')
  const packageJson = await readJson(join(PACKAGE_ROOT, 'package.json'))
  const source = await readFile(sourcePath)
  const sourceHash = sha256(source)
  const pluginPath = join(target, 'plugin.js')
  const markerPath = join(target, MARKER_NAME)

  await mkdir(target, { recursive: true })

  if (await exists(pluginPath)) {
    const currentHash = sha256(await readFile(pluginPath))
    if (currentHash === sourceHash) {
      await atomicWrite(
        markerPath,
        `${JSON.stringify({ installedAt: new Date().toISOString(), package: packageJson.name, sha256: sourceHash, version: packageJson.version }, null, 2)}\n`
      )
      console.log(`Visual Workbench ${packageJson.version} is already current at ${target}`)
      return
    }

    const backup = await backupFile(pluginPath, join(target, 'backups'))
    console.log(`Backed up existing plugin to ${backup}`)
  }

  await atomicWrite(pluginPath, source)
  await atomicWrite(
    markerPath,
    `${JSON.stringify({ installedAt: new Date().toISOString(), package: packageJson.name, sha256: sourceHash, version: packageJson.version }, null, 2)}\n`
  )
  console.log(`Installed Visual Workbench ${packageJson.version} to ${target}`)
}

try {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    process.stdout.write(usage)
  } else {
    const target = targetDirectory(options)
    if (options.uninstall) await uninstall(target, options)
    else await install(target)
  }
} catch (error) {
  console.error(`hermes-visual-workbench: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
