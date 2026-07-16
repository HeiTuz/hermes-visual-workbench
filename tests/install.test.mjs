import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const root = resolve(import.meta.dirname, '..')
const installer = join(root, 'scripts', 'install.mjs')
const sourcePlugin = await readFile(join(root, 'plugin.js'), 'utf8')

function run(args) {
  return spawnSync(process.execPath, [installer, ...args], { cwd: root, encoding: 'utf8' })
}

async function workspace() {
  return mkdtemp(join(tmpdir(), 'hermes-visual-workbench-'))
}

test('installs, updates with backup, and uninstalls a managed plugin', async t => {
  const target = await workspace()
  t.after(() => rm(target, { force: true, recursive: true }))

  const installed = run(['--target', target])
  assert.equal(installed.status, 0, installed.stderr)
  assert.equal(await readFile(join(target, 'plugin.js'), 'utf8'), sourcePlugin)

  await writeFile(join(target, 'plugin.js'), '// locally modified\n')
  const updated = run(['--target', target])
  assert.equal(updated.status, 0, updated.stderr)
  assert.match(updated.stdout, /Backed up existing plugin/)
  assert.equal(await readFile(join(target, 'plugin.js'), 'utf8'), sourcePlugin)
  assert.equal((await readdir(join(target, 'backups'))).length, 1)

  const removed = run(['--target', target, '--uninstall'])
  assert.equal(removed.status, 0, removed.stderr)
  await assert.rejects(readFile(join(target, 'plugin.js')), /ENOENT/)
})

test('accepts package-runner forwarded arguments after --', async t => {
  const target = await workspace()
  t.after(() => rm(target, { force: true, recursive: true }))

  const result = run(['--', '--target', target])
  assert.equal(result.status, 0, result.stderr)
  assert.equal(await readFile(join(target, 'plugin.js'), 'utf8'), sourcePlugin)
})

test('refuses to uninstall a modified plugin unless forced', async t => {
  const target = await workspace()
  t.after(() => rm(target, { force: true, recursive: true }))

  assert.equal(run(['--target', target]).status, 0)
  await writeFile(join(target, 'plugin.js'), '// modified after install\n')

  const refused = run(['--target', target, '--uninstall'])
  assert.notEqual(refused.status, 0)
  assert.match(refused.stderr, /Refusing to remove/)

  const forced = run(['--target', target, '--uninstall', '--force'])
  assert.equal(forced.status, 0, forced.stderr)
})

test('keeps package, manifest, and plugin versions aligned', async () => {
  const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'))
  const pluginVersion = sourcePlugin.match(/const PLUGIN_VERSION = '([^']+)'/)?.[1]

  assert.equal(manifest.version, packageJson.version)
  assert.equal(pluginVersion, packageJson.version)
})
