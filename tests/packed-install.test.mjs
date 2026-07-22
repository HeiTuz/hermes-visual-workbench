import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import test from 'node:test'

const root = resolve(import.meta.dirname, '..')
const PACKED_HOST_PROBE = String.raw`
import asyncio
import importlib.util
import os
import sys
import types
from pathlib import Path

package_root = Path(sys.argv[1])
home = Path(sys.argv[2])
token_routes = []

class DashboardAuthProvider:
    pass

class TokenPrincipal:
    def __init__(self, **values):
        self.__dict__.update(values)

class Placeholder:
    pass

hermes_cli = types.ModuleType("hermes_cli")
hermes_cli.__path__ = []
hermes_cli.__version__ = "0.18.2"
web_server = types.ModuleType("hermes_cli.web_server")
web_server._ws_auth_ok = lambda ws: False
hermes_cli.web_server = web_server
dashboard_auth = types.ModuleType("hermes_cli.dashboard_auth")
dashboard_auth.__path__ = []
auth_base = types.ModuleType("hermes_cli.dashboard_auth.base")
auth_base.DashboardAuthProvider = DashboardAuthProvider
auth_base.LoginStart = Placeholder
auth_base.Session = Placeholder
auth_base.TokenPrincipal = TokenPrincipal
token_auth = types.ModuleType("hermes_cli.dashboard_auth.token_auth")
token_auth.register_token_route = token_routes.append
hermes_constants = types.ModuleType("hermes_constants")
hermes_constants.get_hermes_home = lambda: str(home)
sys.modules.update({
    "hermes_cli": hermes_cli,
    "hermes_cli.web_server": web_server,
    "hermes_cli.dashboard_auth": dashboard_auth,
    "hermes_cli.dashboard_auth.base": auth_base,
    "hermes_cli.dashboard_auth.token_auth": token_auth,
    "hermes_constants": hermes_constants,
})

def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(module)
    return module

backend = load("packed_visual_workbench_backend", package_root / "backend" / "__init__.py")

class Context:
    def __init__(self):
        self.providers = []
    def register_dashboard_auth_provider(self, provider):
        self.providers.append(provider)

context = Context()
backend.register(context)
assert token_routes == [
    "/api/plugins/renderline/command",
    "/api/plugins/renderline/control/result",
]
assert len(context.providers) == 1
provider = context.providers[0]
assert provider.verify_token(token="wrong") is None
principal = provider.verify_token(token=provider._token)
assert principal and principal.principal == "renderline-local-control"
token_path = home / "plugins" / "renderline" / "control.token"
assert token_path.is_file()
assert os.stat(token_path).st_mode & 0o077 == 0

api = load("packed_visual_workbench_dashboard", package_root / "dashboard" / "plugin_api.py")
route_methods = {
    route.path: set(getattr(route, "methods", None) or [])
    for route in api.router.routes
}
assert "GET" in route_methods["/result"]
assert "GET" in route_methods["/state"]
assert "POST" in route_methods["/command"]
assert "GET" in route_methods["/control/result"]
assert "/commands" in route_methods
sidecar = (package_root / "sidecar" / "app.py").read_text()
assert "renderline-sidecar" in sidecar
assert "_BILLABLE_LEDGER_LOCK = asyncio.Lock()" in sidecar
print("packed-host-probe-ok")
`
const PLUGIN_IMPORT_LOADER = String`
const modules = {
  '@hermes/plugin-sdk': \`
    export const atom = value => ({ value })
    export const Badge = () => null
    export const Button = () => null
    export const Codicon = () => null
    export const EmptyState = () => null
    export const host = { notify() {}, panes: { setOpen() {} } }
    export const Input = () => null
    export const ScrollArea = () => null
    export const Separator = () => null
    export const Textarea = () => null
    export const Tip = () => null
    export const useValue = () => null
  \`,
  react: \`
    export const useEffect = () => {}
    export const useRef = value => ({ current: value })
    export const useState = value => [value, () => {}]
    export const useSyncExternalStore = (_subscribe, getSnapshot) => getSnapshot()
  \`,
  'react/jsx-runtime': \`
    export const jsx = () => null
    export const jsxs = () => null
  \`
}
export async function resolve(specifier, context, nextResolve) {
  if (Object.hasOwn(modules, specifier)) {
    return { shortCircuit: true, url: 'data:text/javascript,' + encodeURIComponent(modules[specifier]) }
  }
  return nextResolve(specifier, context)
}
`

const INSTALLED_RELAY_PROBE = String.raw`
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'

const [checkoutEntry, installedEntry, qcCoreEntry] = process.argv.slice(2)
const NOW = '2026-07-17T00:00:00.000Z'

async function state(entry, disposition = 'PASS', capture = true) {
  globalThis.setInterval = () => 1
  globalThis.clearInterval = () => {}
  let defaults
  const { default: plugin } = await import(pathToFileURL(entry).href + '?relay-fixture')
  plugin.register({
    storage: {
      get(_key, fallback) { return fallback },
      set(key, value) {
        if (key === 'workbench.v7') defaults = structuredClone(value)
      }
    },
    socket() {},
    onDispose() {},
    registerMany() {}
  })
  assert.ok(defaults, 'plugin did not persist its restored default state')

  const { linkPanelState } = await import(pathToFileURL(qcCoreEntry).href)
  const url = 'https://www.midjourney.com/jobs/11111111-1111-4111-8111-111111111111'
  const targetId = 'trelay-0000'
  const linked = linkPanelState({
    ...defaults,
    browserPanels: {
      ...defaults.browserPanels,
      result: { ...defaults.browserPanels.result, url, targetId }
    }
  }, 'result', {
    profileId: 'midjourney',
    contextId: 'crelay-0000',
    linkedAt: NOW
  })
  return {
    ...linked,
    capture: capture ? {
      panelId: 'result',
      targetId,
      url,
      width: 1440,
      height: 900,
      viewport: { preset: 'desktop', width: 1440, height: 900, responsive: false },
      createdAt: NOW,
      path: '/tmp/relay-result.png'
    } : null,
    job: { ...linked.job, id: 'relay-run', state: 'QC_RUNNING', createdAt: NOW, updatedAt: NOW },
    candidates: {
      ...linked.candidates,
      A: { ...linked.candidates.A, summary: 'Reviewed relay candidate', score: 95, disposition }
    }
  }
}

async function relay(entry, name, current, requestId, failPost = false) {
  let tick
  globalThis.setInterval = callback => {
    tick = callback
    return 1
  }
  globalThis.clearInterval = () => {}
  const { default: plugin } = await import(pathToFileURL(entry).href + '?relay-probe=' + name)
  const calls = []
  plugin.register({
    storage: {
      get(key, fallback) { return key === 'workbench.v7' ? current : fallback },
      set() {}
    },
    socket() {},
    onDispose() {},
    registerMany() {},
    async rest(path, options) {
      calls.push({ path, options })
      if (path === '/selection-request') {
        return { version: 1, request_id: requestId, candidate_id: 'A', revision: 7, run_id: 'relay-run', scope: 'renderline' }
      }
      if (failPost) throw new Error('sidecar unavailable')
      return {}
    }
  })
  assert.equal(typeof tick, 'function', name + ' did not register relay timer')
  return {
    calls,
    tick,
    setFailPost(value) { failPost = value }
  }
}

for (const [label, entry] of [['checkout', checkoutEntry], ['installed', installedEntry]]) {
  const pass = await relay(entry, label + '-pass', await state(entry), label + '-pass')
  await pass.tick()
  assert.deepEqual(pass.calls, [
    { path: '/selection-request', options: undefined },
    { path: '/selection-ack', options: { method: 'POST', body: { version: 1, request_id: label + '-pass', ok: true, candidate_id: 'A', contextId: 'crelay-0000', revision: 7 } } }
  ], label + ' PASS acknowledgement')

  const blocked = await relay(entry, label + '-blocked', await state(entry, 'PASS', false), label + '-blocked')
  await blocked.tick()
  assert.deepEqual(blocked.calls, [
    { path: '/selection-request', options: undefined },
    { path: '/selection-ack', options: { method: 'POST', body: { version: 1, request_id: label + '-blocked', ok: false, error: 'DELIVERY_BLOCKED' } } }
  ], label + ' blocked acknowledgement')

  const retry = await relay(entry, label + '-retry', await state(entry), label + '-retry', true)
  await retry.tick()
  assert.equal(retry.calls.length, 2, label + ' failed POST')
  retry.setFailPost(false)
  await retry.tick()
  assert.deepEqual(retry.calls.slice(2), [
    { path: '/selection-request', options: undefined },
    { path: '/selection-ack', options: { method: 'POST', body: { version: 1, request_id: label + '-retry', ok: true, candidate_id: 'A', contextId: 'crelay-0000', revision: 7 } } }
  ], label + ' retries failed POST')
}
console.log('installed-relay-probe-ok')
`
function command(command, args, cwd) {
  return spawnSync(command, args, { cwd, encoding: 'utf8' })
}

test('packed archive contains installer sources and installs from packed bytes', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'renderline-packed-'))
  t.after(() => rm(directory, { force: true, recursive: true }))

  const packed = command('npm', ['pack', '--pack-destination', directory], root)
  assert.equal(packed.status, 0, packed.stderr)
  const archive = join(directory, (await readdir(directory)).find(name => name.endsWith('.tgz')))
  const listing = command('tar', ['-tzf', archive], directory)
  assert.equal(listing.status, 0, listing.stderr)
  assert.match(listing.stdout, /^package\/backend\/plugin.yaml$/m)
  assert.match(listing.stdout, /^package\/backend\/__init__.py$/m)
  assert.match(listing.stdout, /^package\/scripts\/handoff-receipt\.mjs$/m)
  assert.doesNotMatch(listing.stdout, /^package\/fixtures\//m)

  const project = join(directory, 'project')
  await mkdir(project)
  const npmInstalled = command('npm', ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', archive], project)
  assert.equal(npmInstalled.status, 0, npmInstalled.stderr)
  const packageRoot = join(project, 'node_modules', 'renderline')
  const home = join(directory, 'home')
  const installer = join(project, 'node_modules', '.bin', 'renderline')
  const run = args => command(installer, ['--hermes-home', home, ...args], project)

  assert.equal(run(['--dry-run']).status, 0)
  const installed = run(['--install'])
  assert.equal(installed.status, 0, installed.stderr)
  assert.equal(await readFile(join(home, 'desktop-plugins', 'renderline', 'plugin.js'), 'utf8'), await readFile(join(packageRoot, 'plugin.js'), 'utf8'))
  assert.equal(await readFile(join(home, 'desktop-plugins', 'renderline', 'scripts', 'handoff-receipt.mjs'), 'utf8'), await readFile(join(packageRoot, 'scripts', 'handoff-receipt.mjs'), 'utf8'))
  assert.equal(run(['--verify']).status, 0)
  const repeated = run(['--install'])
  assert.equal(repeated.status, 0, repeated.stderr)
  assert.match(repeated.stdout, /Verified Renderline/)
  const loader = join(directory, 'plugin-import-loader.mjs')
  const relayProbe = join(directory, 'installed-relay-probe.mjs')
  await writeFile(loader, PLUGIN_IMPORT_LOADER)
  await writeFile(relayProbe, INSTALLED_RELAY_PROBE)
  const relayRun = command(process.execPath, [
    '--experimental-loader', loader,
    relayProbe,
    join(root, 'plugin.js'),
    join(home, 'desktop-plugins', 'renderline', 'plugin.js'),
    join(packageRoot, 'scripts', 'qc-core.mjs')
  ], project)
  assert.equal(relayRun.status, 0, relayRun.stderr)
  assert.equal(relayRun.stdout.trim(), 'installed-relay-probe-ok')

  const hostProbe = command('python3', ['-c', PACKED_HOST_PROBE, packageRoot, home], project)
  assert.equal(hostProbe.status, 0, hostProbe.stderr)
  assert.equal(hostProbe.stdout.trim(), 'packed-host-probe-ok')

  const packedPlugin = await readFile(join(packageRoot, 'plugin.js'), 'utf8')
  for (const capability of ['browser?.capture', 'browser?.cdp']) {
    assert.ok(packedPlugin.includes(capability), `packed plugin lacks typed ${capability} capability`)
  }
  assert.match(packedPlugin, /ctx\.socket\('\/commands'/)
  for (const [relative, contents] of [
    ['plugin.js', '// prior packed plugin\n'],
    ['skills/renderline/SKILL.md', '# prior packed skill\n'],
    ['plugins/renderline/plugin.yaml', 'prior packed manifest\n'],
    ['plugins/renderline/__init__.py', '# prior packed backend\n'],
    ['plugins/renderline/dashboard/manifest.json', '{}\n'],
    ['plugins/renderline/dashboard/plugin_api.py', '# prior packed api\n']
  ]) await writeFile(join(home, 'desktop-plugins', 'renderline', relative), contents).catch(async error => {
    if (error.code !== 'ENOENT') throw error
    await writeFile(join(home, relative), contents)
  })
  const markerPath = join(home, 'desktop-plugins', 'renderline', '.renderline-install.json')
  const priorMarker = JSON.parse(await readFile(markerPath, 'utf8'))
  for (const file of priorMarker.files) {
    file.sha256 = createHash('sha256').update(await readFile(file.path)).digest('hex')
  }
  await writeFile(markerPath, `${JSON.stringify(priorMarker, null, 2)}\n`)
  const updated = run(['--update'])
  assert.equal(updated.status, 0, updated.stderr)
  const rolledBack = run(['--rollback'])
  assert.equal(rolledBack.status, 0, rolledBack.stderr)
  assert.equal(await readFile(join(home, 'desktop-plugins', 'renderline', 'plugin.js'), 'utf8'), '// prior packed plugin\n')
})
