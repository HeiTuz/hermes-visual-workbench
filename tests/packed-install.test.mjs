import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
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
    "/api/plugins/visual-workbench/command",
    "/api/plugins/visual-workbench/control/result",
]
assert len(context.providers) == 1
provider = context.providers[0]
assert provider.verify_token(token="wrong") is None
principal = provider.verify_token(token=provider._token)
assert principal and principal.principal == "visual-workbench-local-control"
token_path = home / "plugins" / "visual-workbench" / "control.token"
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

class Socket:
    def __init__(self):
        self.accepted = False
        self.closed = None
    async def close(self, code):
        self.closed = code
    async def accept(self):
        self.accepted = True
    async def send_json(self, value):
        pass
    async def receive_text(self):
        raise api.WebSocketDisconnect()

unauthorized = Socket()
web_server._ws_auth_ok = lambda ws: False
asyncio.run(api.stream_commands(unauthorized))
assert not unauthorized.accepted
assert unauthorized.closed == api.http_status.WS_1008_POLICY_VIOLATION

authorized = Socket()
web_server._ws_auth_ok = lambda ws: True
asyncio.run(api.stream_commands(authorized))
assert authorized.accepted
assert authorized.closed is None
print("packed-host-probe-ok")
`

function command(command, args, cwd) {
  return spawnSync(command, args, { cwd, encoding: 'utf8' })
}

test('packed archive contains installer sources and installs from packed bytes', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'hermes-visual-workbench-packed-'))
  t.after(() => rm(directory, { force: true, recursive: true }))

  const packed = command('npm', ['pack', '--pack-destination', directory], root)
  assert.equal(packed.status, 0, packed.stderr)
  const archive = join(directory, (await readdir(directory)).find(name => name.endsWith('.tgz')))
  const listing = command('tar', ['-tzf', archive], directory)
  assert.equal(listing.status, 0, listing.stderr)
  assert.match(listing.stdout, /^package\/backend\/plugin.yaml$/m)
  assert.match(listing.stdout, /^package\/backend\/__init__.py$/m)
  assert.doesNotMatch(listing.stdout, /^package\/fixtures\//m)

  const project = join(directory, 'project')
  await mkdir(project)
  const npmInstalled = command('npm', ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', archive], project)
  assert.equal(npmInstalled.status, 0, npmInstalled.stderr)
  const packageRoot = join(project, 'node_modules', 'hermes-visual-workbench')
  const home = join(directory, 'home')
  const installer = join(project, 'node_modules', '.bin', 'hermes-visual-workbench')
  const run = args => command(installer, ['--hermes-home', home, ...args], project)

  assert.equal(run(['--dry-run']).status, 0)
  const installed = run(['--install'])
  assert.equal(installed.status, 0, installed.stderr)
  assert.equal(await readFile(join(home, 'desktop-plugins', 'visual-workbench', 'plugin.js'), 'utf8'), await readFile(join(packageRoot, 'plugin.js'), 'utf8'))
  assert.equal(run(['--verify']).status, 0)
  const repeated = run(['--install'])
  assert.equal(repeated.status, 0, repeated.stderr)
  assert.match(repeated.stdout, /Verified Visual Workbench/)

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
    ['skills/midjourney-visual-workbench/SKILL.md', '# prior packed skill\n'],
    ['plugins/visual-workbench/plugin.yaml', 'prior packed manifest\n'],
    ['plugins/visual-workbench/__init__.py', '# prior packed backend\n'],
    ['plugins/visual-workbench/dashboard/manifest.json', '{}\n'],
    ['plugins/visual-workbench/dashboard/plugin_api.py', '# prior packed api\n']
  ]) await writeFile(join(home, 'desktop-plugins', 'visual-workbench', relative), contents).catch(async error => {
    if (error.code !== 'ENOENT') throw error
    await writeFile(join(home, relative), contents)
  })
  const updated = run(['--update'])
  assert.equal(updated.status, 0, updated.stderr)
  const rolledBack = run(['--rollback'])
  assert.equal(rolledBack.status, 0, rolledBack.stderr)
  assert.equal(await readFile(join(home, 'desktop-plugins', 'visual-workbench', 'plugin.js'), 'utf8'), '// prior packed plugin\n')
})
