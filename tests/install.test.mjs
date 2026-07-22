import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

const root = resolve(import.meta.dirname, '..')
const installer = join(root, 'scripts', 'install.mjs')
const sourcePlugin = await readFile(join(root, 'plugin.js'), 'utf8')
const sourceSkill = await readFile(join(root, 'skill', 'SKILL.md'), 'utf8')
const sourceBackendManifest = await readFile(join(root, 'backend', 'plugin.yaml'), 'utf8')
const sourceBackendInit = await readFile(join(root, 'backend', '__init__.py'), 'utf8')
const sourceDashboardManifest = await readFile(join(root, 'dashboard', 'manifest.json'), 'utf8')
const sourceDashboardApi = await readFile(join(root, 'dashboard', 'plugin_api.py'), 'utf8')
const sourceSidecarApi = await readFile(join(root, 'sidecar', 'app.py'), 'utf8')
const sourceReceipt = await readFile(join(root, 'scripts', 'handoff-receipt.mjs'), 'utf8')
const sourceControlCli = await readFile(join(root, 'scripts', 'midjourney-control.mjs'), 'utf8')

function run(args, env = {}) {
  const forwarded = [...args]
  const targetIndex = forwarded.indexOf('--target')
  if (targetIndex >= 0 && !forwarded.includes('--skill-target')) {
    forwarded.push('--skill-target', join(forwarded[targetIndex + 1], 'skill'))
  }
  if (targetIndex >= 0 && !forwarded.includes('--hermes-home')) forwarded.push('--hermes-home', forwarded[targetIndex + 1])
  return spawnSync(process.execPath, [installer, ...forwarded], { cwd: root, encoding: 'utf8', env: { ...process.env, ...env } })
}

async function workspace() {
  return mkdtemp(join(tmpdir(), 'renderline-'))
}
function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

test('installs, updates with backup, and uninstalls managed plugin, skill, and dashboard files', async t => {
  const target = await workspace()
  const dashboardTarget = join(target, 'plugins', 'renderline', 'dashboard')
  t.after(() => rm(target, { force: true, recursive: true }))

  const installed = run(['--target', target])
  assert.equal(installed.status, 0, installed.stderr)
  assert.match(installed.stdout, /Run: hermes plugins enable renderline \(backend restart required\)/)
  assert.equal(await readFile(join(target, 'plugin.js'), 'utf8'), sourcePlugin)
  assert.equal(await readFile(join(target, 'skill', 'SKILL.md'), 'utf8'), sourceSkill)
  assert.equal(await readFile(join(target, 'plugins', 'renderline', 'plugin.yaml'), 'utf8'), sourceBackendManifest)
  assert.equal(await readFile(join(target, 'plugins', 'renderline', '__init__.py'), 'utf8'), sourceBackendInit)
  assert.equal(await readFile(join(dashboardTarget, 'manifest.json'), 'utf8'), sourceDashboardManifest)
  assert.equal(await readFile(join(dashboardTarget, 'plugin_api.py'), 'utf8'), sourceDashboardApi)
  assert.equal(await readFile(join(target, 'scripts', 'handoff-receipt.mjs'), 'utf8'), sourceReceipt)
  const marker = JSON.parse(await readFile(join(target, '.renderline-install.json'), 'utf8'))
  assert.equal(marker.schemaVersion, 3)
  assert.deepEqual(marker.files.map(file => file.id), [
    'plugin',
    'skill',
    'backend-manifest',
    'backend-init',
    'dashboard-manifest',
    'dashboard-api',
    'handoff-receipt'
  ])

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
  await assert.rejects(readFile(join(target, 'plugins', 'renderline', 'plugin.yaml')), /ENOENT/)
  await assert.rejects(readFile(join(target, 'plugins', 'renderline', '__init__.py')), /ENOENT/)
  await assert.rejects(readFile(join(dashboardTarget, 'manifest.json')), /ENOENT/)
  await assert.rejects(readFile(join(dashboardTarget, 'plugin_api.py')), /ENOENT/)
  await assert.rejects(readFile(join(target, 'scripts', 'handoff-receipt.mjs')), /ENOENT/)
})

test('accepts package-runner forwarded arguments after --', async t => {
  const target = await workspace()
  t.after(() => rm(target, { force: true, recursive: true }))

  const result = run(['--', '--target', target])
  assert.equal(result.status, 0, result.stderr)
  assert.equal(await readFile(join(target, 'plugin.js'), 'utf8'), sourcePlugin)
})

test('supports dry-run, verify, update, and compatibility errors', async t => {
  const target = await workspace()
  t.after(() => rm(target, { force: true, recursive: true }))
  const dry = run(['--target', target, '--dry-run'])
  assert.equal(dry.status, 0, dry.stderr)
  assert.match(dry.stdout, /Dry run install\/update: 7 managed file\(s\) would change/)
  await assert.rejects(readFile(join(target, 'plugin.js')), /ENOENT/)
  assert.equal(run(['--target', target, '--install']).status, 0)
  assert.equal(run(['--target', target, '--verify']).status, 0)
  await writeFile(join(target, 'plugin.js'), '// drift\n')
  const incompatible = run(['--target', target, '--verify'])
  assert.notEqual(incompatible.status, 0)
  assert.match(incompatible.stderr, /Compatibility error.*--update/)
  assert.equal(run(['--target', target, '--update']).status, 0)
  assert.equal(run(['--target', target, '--verify']).status, 0)
})
test('rejects explicit install with verify-installed before mutating the filesystem', async t => {
  for (const args of [
    ['--install', '--verify-installed'],
    ['--verify-installed', '--install']
  ]) {
    const target = await workspace()
    t.after(() => rm(target, { force: true, recursive: true }))

    const result = run(['--target', target, ...args])
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /--install, --uninstall, --verify, --verify-installed, and --rollback are mutually exclusive/)
    assert.deepEqual(await readdir(target), [])
  }
})

test('rolls back every managed file from its newest backup', async t => {
  const target = await workspace()
  t.after(() => rm(target, { force: true, recursive: true }))
  assert.equal(run(['--target', target]).status, 0)
  const prior = [
    ['plugin.js', '// prior plugin\n'], ['skill/SKILL.md', '# prior skill\n'],
    ['plugins/renderline/plugin.yaml', 'prior manifest\n'],
    ['plugins/renderline/__init__.py', '# prior backend\n'],
    ['plugins/renderline/dashboard/manifest.json', '{}\n'],
    ['plugins/renderline/dashboard/plugin_api.py', '# prior api\n']
  ]
  for (const [relative, value] of prior) await writeFile(join(target, relative), value)
  const markerPath = join(target, '.renderline-install.json')
  const priorMarker = JSON.parse(await readFile(markerPath, 'utf8'))
  const ids = [
    'plugin', 'skill', 'backend-manifest', 'backend-init', 'dashboard-manifest', 'dashboard-api'
  ]
  for (const [index, [, value]] of prior.entries()) priorMarker.files.find(file => file.id === ids[index]).sha256 = sha256(value)
  await writeFile(markerPath, `${JSON.stringify(priorMarker, null, 2)}\n`)
  assert.equal(run(['--target', target, '--update']).status, 0)
  const dry = run(['--target', target, '--rollback', '--dry-run'])
  assert.equal(dry.status, 0, dry.stderr)
  assert.match(dry.stdout, /Dry run rollback: 6 managed file\(s\) would be restored/)
  assert.equal(run(['--target', target, '--rollback']).status, 0)
  assert.equal(await readFile(join(target, 'plugin.js'), 'utf8'), '// prior plugin\n')
  const incompatible = run(['--target', target, '--verify'])
  assert.notEqual(incompatible.status, 0)
  assert.match(incompatible.stderr, /Compatibility error/)
})

test('rollback restores one coherent partial-update transaction', async t => {
  const target = await workspace()
  t.after(() => rm(target, { force: true, recursive: true }))
  assert.equal(run(['--target', target]).status, 0)
  const skillBefore = await readFile(join(target, 'skill', 'SKILL.md'), 'utf8')

  await writeFile(join(target, 'plugin.js'), '// prior partial plugin\n')
  const marker = JSON.parse(await readFile(join(target, '.renderline-install.json'), 'utf8'))
  marker.files.find(file => file.id === 'plugin').sha256 = sha256('// prior partial plugin\n')
  await writeFile(join(target, '.renderline-install.json'), `${JSON.stringify(marker, null, 2)}\n`)
  const markerBefore = await readFile(join(target, '.renderline-install.json'), 'utf8')
  assert.equal(run(['--target', target, '--update']).status, 0)

  const dry = run(['--target', target, '--rollback', '--dry-run'])
  assert.equal(dry.status, 0, dry.stderr)
  assert.match(dry.stdout, /restore plugin/)
  assert.match(dry.stdout, /keep skill/)
  assert.equal(run(['--target', target, '--rollback']).status, 0)
  assert.equal(await readFile(join(target, 'plugin.js'), 'utf8'), '// prior partial plugin\n')
  assert.equal(await readFile(join(target, 'skill', 'SKILL.md'), 'utf8'), skillBefore)
  assert.equal(await readFile(join(target, '.renderline-install.json'), 'utf8'), markerBefore)
})
test('rejects corrupted or swapped rollback backups before restoring any files', async t => {
  for (const mutation of ['corrupt', 'swap']) {
    const target = await workspace()
    t.after(() => rm(target, { force: true, recursive: true }))
    const markerPath = join(target, '.renderline-install.json')
    const pluginPrior = '// authenticated prior plugin\n'
    const skillPrior = '# authenticated prior skill\n'

    assert.equal(run(['--target', target]).status, 0)
    await writeFile(join(target, 'plugin.js'), pluginPrior)
    await writeFile(join(target, 'skill', 'SKILL.md'), skillPrior)
    const priorMarker = JSON.parse(await readFile(markerPath, 'utf8'))
    priorMarker.files.find(file => file.id === 'plugin').sha256 = sha256(pluginPrior)
    priorMarker.files.find(file => file.id === 'skill').sha256 = sha256(skillPrior)
    await writeFile(markerPath, `${JSON.stringify(priorMarker, null, 2)}\n`)
    assert.equal(run(['--target', target, '--update']).status, 0)

    const pluginBackupPath = join(target, 'backups', 'plugin', (await readdir(join(target, 'backups', 'plugin')))[0])
    const skillBackupPath = join(target, 'backups', 'skill', (await readdir(join(target, 'backups', 'skill')))[0])
    if (mutation === 'corrupt') await writeFile(skillBackupPath, '# corrupted backup\n')
    else await writeFile(skillBackupPath, await readFile(pluginBackupPath))

    const markerBefore = await readFile(markerPath)
    const rejected = run(['--target', target, '--rollback'])
    assert.notEqual(rejected.status, 0)
    assert.match(rejected.stderr, /backup does not match the prior marker hash/)
    assert.equal(await readFile(join(target, 'plugin.js'), 'utf8'), sourcePlugin)
    assert.equal(await readFile(join(target, 'skill', 'SKILL.md'), 'utf8'), sourceSkill)
    assert.deepEqual(await readFile(markerPath), markerBefore)
  }
})
test('migrates exact v2 markers, verifies installed bytes, and rejects malformed marker entries', async t => {
  const target = await workspace()
  const markerPath = join(target, '.renderline-install.json')
  const receiptPath = join(target, 'scripts', 'handoff-receipt.mjs')
  t.after(() => rm(target, { force: true, recursive: true }))

  assert.equal(run(['--target', target]).status, 0)
  const current = JSON.parse(await readFile(markerPath, 'utf8'))
  const v2 = `${JSON.stringify({ ...current, schemaVersion: 2, files: current.files.filter(file => file.id !== 'handoff-receipt') }, null, 2)}\n`
  await writeFile(markerPath, v2)
  await rm(receiptPath)
  assert.equal(run(['--target', target, '--verify-installed']).status, 0)
  assert.equal(run(['--target', target, '--update']).status, 0)
  assert.equal(run(['--target', target, '--rollback']).status, 0)
  assert.equal(await readFile(markerPath, 'utf8'), v2)
  await assert.rejects(readFile(receiptPath), /ENOENT/)
  assert.equal(run(['--target', target, '--verify-installed']).status, 0)
  assert.equal(await readFile(join(target, 'plugin.js'), 'utf8'), sourcePlugin)
  assert.equal(await readFile(join(target, 'skill', 'SKILL.md'), 'utf8'), sourceSkill)
  assert.equal(await readFile(join(target, 'plugins', 'renderline', 'plugin.yaml'), 'utf8'), sourceBackendManifest)
  assert.equal(await readFile(join(target, 'plugins', 'renderline', '__init__.py'), 'utf8'), sourceBackendInit)
  assert.equal(await readFile(join(target, 'plugins', 'renderline', 'dashboard', 'manifest.json'), 'utf8'), sourceDashboardManifest)
  assert.equal(await readFile(join(target, 'plugins', 'renderline', 'dashboard', 'plugin_api.py'), 'utf8'), sourceDashboardApi)

  for (const mutate of [
    marker => { marker.files.pop() },
    marker => { marker.files.push({ ...marker.files[0] }) },
    marker => { marker.files.push({ id: 'extra', path: join(target, 'extra'), sha256: 'a'.repeat(64) }) },
    marker => { marker.files[0].path = join(target, 'wrong') },
    marker => { marker.files[0].sha256 = 'A'.repeat(64) }
  ]) {
    const marker = JSON.parse(v2)
    mutate(marker)
    await writeFile(markerPath, `${JSON.stringify(marker)}\n`)
    assert.notEqual(run(['--target', target, '--verify-installed']).status, 0)
  }
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
  const markerPath = join(target, '.renderline-install.json')
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
  const markerPath = join(target, '.renderline-install.json')
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
  assert.match(result.stderr, /(must be a regular file|symlinked parent)/)
  assert.equal(await readFile(sentinel, 'utf8'), 'outside content\n')
})
test('rejects destination roots that escape Hermes home or traverse symlinked parents', async t => {
  const home = await workspace()
  const outside = await workspace()
  const linked = join(home, 'linked')
  t.after(async () => {
    await rm(home, { force: true, recursive: true })
    await rm(outside, { force: true, recursive: true })
  })
  await symlink(outside, linked)
  const escaped = spawnSync(process.execPath, [installer, '--hermes-home', home, '--target', outside, '--skill-target', join(outside, 'skill')], { cwd: root, encoding: 'utf8' })
  assert.notEqual(escaped.status, 0)
  assert.match(escaped.stderr, /escapes Hermes home/)
  const symlinked = spawnSync(process.execPath, [installer, '--hermes-home', home, '--target', linked, '--skill-target', join(linked, 'skill')], { cwd: root, encoding: 'utf8' })
  assert.notEqual(symlinked.status, 0)
  assert.match(symlinked.stderr, /symlink/)
})
test('rejects a nonexistent Hermes home below a symlinked profile parent', async t => {
  const profile = await workspace()
  const outside = await workspace()
  const linkedProfile = join(profile, 'linked-profile')
  t.after(async () => {
    await rm(profile, { force: true, recursive: true })
    await rm(outside, { force: true, recursive: true })
  })
  await symlink(outside, linkedProfile)
  const home = join(linkedProfile, '.hermes')
  const result = spawnSync(process.execPath, [installer, '--hermes-home', home], { cwd: root, encoding: 'utf8' })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /symlink/)
  await assert.rejects(readFile(join(outside, '.hermes', 'desktop-plugins', 'renderline', 'plugin.js')), /ENOENT/)
})

test('rolls back an earlier managed write when a later write fails', async t => {
  const target = await workspace()
  const skillTarget = join(target, 'skill')
  const pluginPath = join(target, 'plugin.js')
  const markerPath = join(target, '.renderline-install.json')
  t.after(async () => {
    await chmod(skillTarget, 0o700).catch(() => {})
    await rm(target, { force: true, recursive: true })
  })

  assert.equal(run(['--target', target]).status, 0)
  const markerBefore = await readFile(markerPath, 'utf8')
  await writeFile(pluginPath, '// preserve on rollback\n')
  await chmod(skillTarget, 0o500)

  const failed = run(['--target', target], { HERMES_VW_TEST_FAIL_OPERATION: 'temp:2' })
  assert.notEqual(failed.status, 0)
  assert.match(failed.stderr, /Installation failed/)
  assert.equal(await readFile(pluginPath, 'utf8'), '// preserve on rollback\n')
  assert.equal(await readFile(markerPath, 'utf8'), markerBefore)
})

test('is mutation-idempotent when managed bytes and marker are current', async t => {
  const target = await workspace()
  t.after(() => rm(target, { force: true, recursive: true }))
  assert.equal(run(['--target', target]).status, 0)
  const markerPath = join(target, '.renderline-install.json')
  const markerBefore = await readFile(markerPath)
  const pluginBefore = await readFile(join(target, 'plugin.js'))
  const repeated = run(['--target', target])
  assert.equal(repeated.status, 0, repeated.stderr)
  assert.match(repeated.stdout, /Verified Renderline/)
  assert.deepEqual(await readFile(markerPath), markerBefore)
  assert.deepEqual(await readFile(join(target, 'plugin.js')), pluginBefore)
  await assert.rejects(readdir(join(target, 'backups')), /ENOENT/)
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

test('keeps desktop acknowledgements on session auth and local polling on token auth', () => {
  assert.match(sourceBackendInit, /\/api\/plugins\/renderline\/command/)
  assert.match(sourceBackendInit, /\/api\/plugins\/renderline\/control\/result/)
  assert.doesNotMatch(sourceBackendInit, /["']\/api\/plugins\/renderline\/result["']/)
  assert.match(sourceDashboardApi, /@router\.post\("\/result"\)/)
  assert.match(sourceDashboardApi, /@router\.get\("\/control\/result"\)/)
  assert.match(sourceSidecarApi, /"operationId": reservation\["operationId"\]/)
  assert.match(sourceControlCli, /control\/result\?cursor=\$\{cursor\}/)
  assert.doesNotMatch(sourceControlCli, /control\/result\/\$\{encodeURIComponent\(id\)\}/)
  assert.match(sourceControlCli, /--acknowledged/)
  assert.match(sourceControlCli, /--ledger-created-at/)
  assert.match(sourceSidecarApi, /"midjourney-control"/)
})
test('durably reserves billable Midjourney commands before the command broadcast', () => {
  assert.match(sourceSidecarApi, /_BILLABLE_LEDGER_LOCK = asyncio\.Lock\(\)/)
  assert.match(sourceSidecarApi, /return _renderline_home\(\)/)
  assert.match(sourceSidecarApi, /"idempotencyKeyHash"/)
  assert.match(sourceSidecarApi, /"requestFingerprint"/)
  assert.match(sourceSidecarApi, /"targetFingerprint"/)
  assert.match(sourceSidecarApi, /os\.fsync\(destination\.fileno\(\)\)/)
  assert.match(sourceSidecarApi, /os\.replace\(temporary, ledger_path\)/)
  assert.match(sourceSidecarApi, /os\.fsync\(directory_fd\)/)
  assert.match(sourceSidecarApi, /stat\.S_ISLNK/)
  assert.match(sourceSidecarApi, /os\.chmod\(ledger_path, 0o600\)/)
  assert.match(sourceSidecarApi, /if existing:\n            return \{"queued": False, "existing": True/)
  assert.match(sourceSidecarApi, /with _ledger_transaction\(\) as \(ledger_path, ledger\):/)
  assert.match(sourceSidecarApi, /_register_receipt_context\(result, ledger\)/)
  assert.match(sourceSidecarApi, /_acknowledge_in_ledger\(result_id, ledger\)/)
  assert.match(sourceSidecarApi, /_write_billable_ledger_payload\(ledger_path, ledger\)/)
})
