import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const root = resolve(import.meta.dirname, '..')
const installer = join(root, 'scripts', 'install.mjs')
const sourcePlugin = await readFile(join(root, 'plugin.js'), 'utf8')
const sourceSkill = await readFile(join(root, 'skill', 'SKILL.md'), 'utf8')
const sourceDashboardManifest = await readFile(join(root, 'dashboard', 'manifest.json'), 'utf8')
const sourceDashboardApi = await readFile(join(root, 'dashboard', 'plugin_api.py'), 'utf8')

function run(args) {
  const forwarded = [...args]
  const targetIndex = forwarded.indexOf('--target')
  if (targetIndex >= 0 && !forwarded.includes('--skill-target')) {
    forwarded.push('--skill-target', join(forwarded[targetIndex + 1], 'skill'))
  }
  if (targetIndex >= 0 && !forwarded.includes('--hermes-home')) forwarded.push('--hermes-home', forwarded[targetIndex + 1])
  return spawnSync(process.execPath, [installer, ...forwarded], { cwd: root, encoding: 'utf8' })
}

async function workspace() {
  return mkdtemp(join(tmpdir(), 'hermes-visual-workbench-'))
}

test('installs, updates with backup, and uninstalls managed plugin, skill, and dashboard files', async t => {
  const target = await workspace()
  const dashboardTarget = join(target, 'plugins', 'visual-workbench', 'dashboard')
  t.after(() => rm(target, { force: true, recursive: true }))

  const installed = run(['--target', target])
  assert.equal(installed.status, 0, installed.stderr)
  assert.match(installed.stdout, /Run: hermes plugins enable visual-workbench \(backend restart required\)/)
  assert.equal(await readFile(join(target, 'plugin.js'), 'utf8'), sourcePlugin)
  assert.equal(await readFile(join(target, 'skill', 'SKILL.md'), 'utf8'), sourceSkill)
  assert.equal(await readFile(join(dashboardTarget, 'manifest.json'), 'utf8'), sourceDashboardManifest)
  assert.equal(await readFile(join(dashboardTarget, 'plugin_api.py'), 'utf8'), sourceDashboardApi)
  const marker = JSON.parse(await readFile(join(target, '.hermes-visual-workbench-install.json'), 'utf8'))
  assert.deepEqual(marker.files.map(file => file.id), ['plugin', 'skill', 'dashboard-manifest', 'dashboard-api'])

  await writeFile(join(target, 'plugin.js'), '// locally modified\n')
  await writeFile(join(dashboardTarget, 'plugin_api.py'), '# locally modified\n')
  await writeFile(join(dashboardTarget, 'manifest.json'), '{"locally":"modified"}\n')
  const updated = run(['--target', target])
  assert.equal(updated.status, 0, updated.stderr)
  assert.match(updated.stdout, /Backed up existing plugin/)
  assert.match(updated.stdout, /Backed up existing dashboard-api/)
  assert.match(updated.stdout, /Backed up existing dashboard-manifest/)
  assert.equal(await readFile(join(target, 'plugin.js'), 'utf8'), sourcePlugin)
  assert.equal(await readFile(join(dashboardTarget, 'plugin_api.py'), 'utf8'), sourceDashboardApi)
  assert.equal(await readFile(join(dashboardTarget, 'manifest.json'), 'utf8'), sourceDashboardManifest)
  assert.equal((await readdir(join(target, 'backups', 'plugin'))).length, 1)
  assert.equal((await readdir(join(target, 'backups', 'dashboard-api'))).length, 1)
  assert.equal((await readdir(join(target, 'backups', 'dashboard-manifest'))).length, 1)

  const removed = run(['--target', target, '--uninstall'])
  assert.equal(removed.status, 0, removed.stderr)
  await assert.rejects(readFile(join(target, 'plugin.js')), /ENOENT/)
  await assert.rejects(readFile(join(target, 'skill', 'SKILL.md')), /ENOENT/)
  await assert.rejects(readFile(join(dashboardTarget, 'manifest.json')), /ENOENT/)
  await assert.rejects(readFile(join(dashboardTarget, 'plugin_api.py')), /ENOENT/)
})

test('accepts package-runner forwarded arguments after --', async t => {
  const target = await workspace()
  t.after(() => rm(target, { force: true, recursive: true }))

  const result = run(['--', '--target', target])
  assert.equal(result.status, 0, result.stderr)
  assert.equal(await readFile(join(target, 'plugin.js'), 'utf8'), sourcePlugin)
})

test('requires custom plugin and skill targets to be supplied together', async t => {
  const target = await workspace()
  t.after(() => rm(target, { force: true, recursive: true }))

  const pluginOnly = spawnSync(process.execPath, [installer, '--target', target], { cwd: root, encoding: 'utf8' })
  assert.notEqual(pluginOnly.status, 0)
  assert.match(pluginOnly.stderr, /--target and --skill-target must be supplied together/)

  const skillOnly = spawnSync(process.execPath, [installer, '--skill-target', target], { cwd: root, encoding: 'utf8' })
  assert.notEqual(skillOnly.status, 0)
  assert.match(skillOnly.stderr, /--target and --skill-target must be supplied together/)
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

test('refuses to uninstall a modified workflow skill unless forced', async t => {
  const target = await workspace()
  t.after(() => rm(target, { force: true, recursive: true }))

  assert.equal(run(['--target', target]).status, 0)
  await writeFile(join(target, 'skill', 'SKILL.md'), '# locally modified\n')
  const refused = run(['--target', target, '--uninstall'])
  assert.notEqual(refused.status, 0)
  assert.match(refused.stderr, /locally modified managed file/)
  assert.equal(run(['--target', target, '--uninstall', '--force']).status, 0)
})

test('never trusts marker paths as uninstall deletion targets', async t => {
  const target = await workspace()
  const sentinel = join(target, 'must-survive.txt')
  const markerPath = join(target, '.hermes-visual-workbench-install.json')
  t.after(() => rm(target, { force: true, recursive: true }))

  assert.equal(run(['--target', target]).status, 0)
  await writeFile(sentinel, 'keep me\n')
  const marker = JSON.parse(await readFile(markerPath, 'utf8'))
  marker.files[0].path = sentinel
  await writeFile(markerPath, `${JSON.stringify(marker, null, 2)}\n`)

  const refused = run(['--target', target, '--uninstall'])
  assert.notEqual(refused.status, 0)
  assert.match(refused.stderr, /invalid managed path/)
  assert.equal(await readFile(sentinel, 'utf8'), 'keep me\n')

  const forced = run(['--target', target, '--uninstall', '--force'])
  assert.equal(forced.status, 0, forced.stderr)
  assert.equal(await readFile(sentinel, 'utf8'), 'keep me\n')
})

test('forced uninstall removes both fixed targets even with a legacy plugin-only marker', async t => {
  const target = await workspace()
  const markerPath = join(target, '.hermes-visual-workbench-install.json')
  t.after(() => rm(target, { force: true, recursive: true }))

  assert.equal(run(['--target', target]).status, 0)
  const marker = JSON.parse(await readFile(markerPath, 'utf8'))
  await writeFile(markerPath, `${JSON.stringify({ sha256: marker.files.find(file => file.id === 'plugin').sha256 })}\n`)

  const forced = run(['--target', target, '--uninstall', '--force'])
  assert.equal(forced.status, 0, forced.stderr)
  await assert.rejects(readFile(join(target, 'plugin.js')), /ENOENT/)
  await assert.rejects(readFile(join(target, 'skill', 'SKILL.md')), /ENOENT/)
})

test('rejects symlinked managed files without touching their targets', async t => {
  const target = await workspace()
  const sentinel = join(target, 'sentinel.txt')
  t.after(() => rm(target, { force: true, recursive: true }))

  await writeFile(sentinel, 'outside content\n')
  await symlink(sentinel, join(target, 'plugin.js'))
  const result = run(['--target', target])
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /must be a regular file/)
  assert.equal(await readFile(sentinel, 'utf8'), 'outside content\n')
})

test('rolls back an earlier managed write when a later write fails', async t => {
  const target = await workspace()
  const skillTarget = join(target, 'skill')
  const pluginPath = join(target, 'plugin.js')
  const markerPath = join(target, '.hermes-visual-workbench-install.json')
  t.after(async () => {
    await chmod(skillTarget, 0o700).catch(() => {})
    await rm(target, { force: true, recursive: true })
  })

  assert.equal(run(['--target', target]).status, 0)
  const markerBefore = await readFile(markerPath, 'utf8')
  await writeFile(pluginPath, '// preserve on rollback\n')
  await chmod(skillTarget, 0o500)

  const failed = run(['--target', target])
  assert.notEqual(failed.status, 0)
  assert.match(failed.stderr, /Installation failed/)
  assert.equal(await readFile(pluginPath, 'utf8'), '// preserve on rollback\n')
  assert.equal(await readFile(markerPath, 'utf8'), markerBefore)
})

test('keeps package, manifest, and plugin versions aligned', async () => {
  const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'))
  const pluginVersion = sourcePlugin.match(/const PLUGIN_VERSION = '([^']+)'/)?.[1]
  const skillVersion = sourceSkill.match(/^version: ([^\n]+)$/m)?.[1]

  assert.equal(manifest.version, packageJson.version)
  assert.equal(pluginVersion, packageJson.version)
  assert.equal(skillVersion, packageJson.version)
})

test('pins Midjourney automation to the Hermes internal Browser pane', () => {
  assert.match(sourceSkill, /persist:hermes-browser/)
  assert.match(sourceSkill, /app="Hermes"/)
  assert.match(sourceSkill, /Never use `browser_navigate`, any `browser_\*` tool/)
  assert.match(sourceSkill, /Chrome, Safari, Arc, Brave, or Edge/)
  assert.match(sourceSkill, /internal_pane_unavailable/)
  assert.doesNotMatch(sourceSkill, /internal_browser_unavailable/)
  assert.match(sourceSkill, /Never fall back to an external browser/)
})
