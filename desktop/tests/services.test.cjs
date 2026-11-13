const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

test('QQ readiness comes from a fresh host connection snapshot rather than open ports or saved configuration', async t => {
  const { readQQConnectionHealth } = require('../lib/services.cjs');
  assert.equal(typeof readQQConnectionHealth, 'function');
  const host = await fs.mkdtemp(path.join(os.tmpdir(), 'dswhale-qq-health-'));
  t.after(() => fs.rm(host, { recursive: true, force: true }));
  const file = path.join(host, 'data/plugin_data/astrbot_plugin_dswhale/health.json');
  await fs.mkdir(path.dirname(file), { recursive: true });
  const context = { host, running: true, startedAt: 1980000, now: 2000000, legacyChannel: 'napcat' };
  for (const [snapshot, expected] of [
    [{ updatedAt: 1999, qqConnected: true, token: 'synthetic-private-token' }, null],
    [{ updatedAt: 1999, qqConnected: false }, null],
    [{ updatedAt: 1900, qqConnected: true }, null],
    [{ updatedAt: 1979, qqConnected: true }, null],
    [{ updatedAt: 2000000, qqConnected: true }, null],
    [{ updatedAt: 1999, qqConnected: 'true' }, null],
  ]) {
    await fs.writeFile(file, JSON.stringify(snapshot));
    assert.equal(await readQQConnectionHealth(context), expected);
  }
  await fs.writeFile(file, JSON.stringify({ updatedAt: 1999, qqConnected: true }));
  assert.equal(await readQQConnectionHealth({ ...context, running: false }), false);
  // A format 1 boolean is never misattributed to the other channel.
  assert.equal(await readQQConnectionHealth({ ...context, channel: 'official' }), null);
  assert.equal(await readQQConnectionHealth({ ...context, channel: 'official', legacyChannel: 'official' }), null);
});

test('missing, malformed and oversized QQ snapshots cannot invent connection readiness', async t => {
  const { readQQConnectionHealth } = require('../lib/services.cjs');
  assert.equal(typeof readQQConnectionHealth, 'function');
  const host = await fs.mkdtemp(path.join(os.tmpdir(), 'dswhale-qq-invalid-health-'));
  t.after(() => fs.rm(host, { recursive: true, force: true }));
  const context = { host, running: true, startedAt: 0, now: 2000000 };
  assert.equal(await readQQConnectionHealth(context), null);
  const file = path.join(host, 'data/plugin_data/astrbot_plugin_dswhale/health.json');
  await fs.mkdir(path.dirname(file), { recursive: true });
  for (const body of ['not-json', '[]', 'x'.repeat(17000)]) {
    await fs.writeFile(file, body);
    assert.equal(await readQQConnectionHealth(context), null);
  }
});

test('host refuses an occupied port and never adopts or stops another process', async () => {
  const { ServiceSupervisor } = require('../lib/services.cjs');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dswhale-services-'));
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  await fs.mkdir(path.join(root, 'data'));
  await fs.writeFile(path.join(root, 'data/cmd_config.json'), JSON.stringify({ dashboard: { host: '127.0.0.1', port: server.address().port } }));
  const supervisor = new ServiceSupervisor({ manager: { host: root, source: root, python: process.execPath, environment: async () => process.env } });
  try {
    await assert.rejects(supervisor.start(), error => {
      assert.equal(error.code, 'PORT-001');
      assert.deepEqual(error.report.occupiedPorts, [server.address().port]);
      assert.deepEqual(error.report.nextSteps.map(step => step.id), ['change-port', 'stop-service-manually']);
      assert.match(error.message, /占用/);
      return true;
    });
    await supervisor.stop();
    assert.ok(server.listening);
    assert.equal(supervisor.running, false);
  } finally { await new Promise(resolve => server.close(resolve)); await fs.rm(root, { recursive: true, force: true }); }
});

test('port preflight reports every occupied configured port without exposing configuration secrets', async () => {
  const { preflightPorts } = require('../lib/services.cjs');
  assert.equal(typeof preflightPorts, 'function');
  const servers = [net.createServer(), net.createServer()];
  try {
    for (const server of servers) await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const ports = servers.map(server => server.address().port);
    const report = await preflightPorts({ dashboard: { host: '127.0.0.1', port: ports[0] }, platform: [
      { enable: true, type: 'aiocqhttp', ws_reverse_port: ports[1], token: 'synthetic-private-token' },
      { enable: false, type: 'aiocqhttp', ws_reverse_port: 1 },
      { enable: true, type: 'aiocqhttp', ws_reverse_port: ports[1] },
    ] });
    assert.equal(report.ok, false);
    assert.equal(report.code, 'PORT-001');
    assert.deepEqual(report.occupiedPorts, [ports[0]]);
    assert.deepEqual(report.ports, [ports[0]]);
    assert.equal(JSON.stringify(report).includes('synthetic-private-token'), false);
    assert.ok(servers.every(server => server.listening));
  } finally { for (const server of servers) if (server.listening) await new Promise(resolve => server.close(resolve)); }
});

for (const platform of ['darwin', 'win32']) test(`owned ${platform} host uses the lifecycle gate and preserves optional session authentication`, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dswhale-managed-start-'));
  const portServer = net.createServer();
  await new Promise(resolve => portServer.listen(0, '127.0.0.1', resolve));
  const port = portServer.address().port;
  await new Promise(resolve => portServer.close(resolve));
  await fs.mkdir(path.join(root, 'data'));
  await fs.writeFile(path.join(root, 'data/cmd_config.json'), JSON.stringify({ dashboard: { host: '127.0.0.1', port } }));
  const initialEnvironment = { SYNTHETIC: 'kept', ASTRBOT_DESKTOP_SESSION_SECRET: 'synthetic inherited desktop session' };
  let child, spawnedEnvironment, fakeServer, launch;
  const events = [];
  const exports = { exports: {} };
  const source = await fs.readFile(path.join(__dirname, '../lib/services.cjs'), 'utf8');
  vm.runInNewContext(source, { module: exports, require: name => name === 'node:child_process' ? { spawn(command, args, options) {
    if (command === 'taskkill') {
      const killer = new EventEmitter();
      child.exitCode = 0; child.emit('exit', 0); child.emit('close', 0);
      return killer;
    }
    launch = { command, args: Array.from(args), options };
    spawnedEnvironment = options.env;
    child = new EventEmitter(); child.pid = 123456789; child.exitCode = null; child.stdout = new PassThrough(); child.stderr = new PassThrough();
    fakeServer = net.createServer().listen(port, '127.0.0.1');
    child.stdout.write('synthetic private host output'); child.stderr.write('synthetic secret error');
    return child;
  } } : require(name), process: { platform, kill() { child.exitCode = 0; child.emit('exit', 0); child.emit('close', 0); } }, setTimeout, clearTimeout, URL });
  const runtime = path.join(root, 'synthetic-runtime');
  const supervisor = new exports.exports.ServiceSupervisor({ manager: { host: root, source: root, runtime, python: 'fake-python', environment: async () => initialEnvironment }, onChange: event => events.push(event) });
  try {
    await supervisor.start();
    const guardedArguments = [path.join(root, 'dswhale/host_start.py'), '--runtime', runtime];
    assert.equal(launch.command, 'fake-python');
    assert.deepEqual(launch.args, platform === 'win32' ? [path.join(root, 'dswhale/winjob.py'), 'fake-python', ...guardedArguments] : guardedArguments);
    assert.equal(launch.options.cwd, root);
    assert.equal(spawnedEnvironment.ASTRBOT_DESKTOP_MANAGED, '1');
    assert.equal(spawnedEnvironment.SYNTHETIC, 'kept');
    assert.equal(spawnedEnvironment.ASTRBOT_DESKTOP_SESSION_SECRET, undefined);
    assert.deepEqual(initialEnvironment, { SYNTHETIC: 'kept', ASTRBOT_DESKTOP_SESSION_SECRET: 'synthetic inherited desktop session' });
    assert.equal(JSON.stringify(events).includes('synthetic'), false);
    if (process.env.DSWHALE_TEST_PYTHON) {
      const { spawnSync } = require('node:child_process');
      const checked = spawnSync(process.env.DSWHALE_TEST_PYTHON, ['-c', `
import asyncio, importlib.metadata, socket
def deny_network(*args, **kwargs):
    raise AssertionError('Managed update must not access the network')
socket.create_connection = deny_network
from astrbot.core.desktop_runtime import is_desktop_session_auth_enabled
from astrbot.dashboard.services.update_service import UpdateService, UpdateServiceError
import os
assert importlib.metadata.version('astrbot') == os.environ['DSWHALE_TEST_EXPECTED_ASTRBOT']
assert not is_desktop_session_auth_enabled()
service = UpdateService(None, None, get_dashboard_version_func=None, pip_install_func=None,
    demo_mode=False, clear_site_data_headers={})
async def check():
    try:
        await service.update_project({'version': 'latest', 'reboot': True})
    except UpdateServiceError as error:
        assert error.code == 'desktop_managed'
    else:
        raise AssertionError('Managed core update was accepted')
    assert service.update_progress == {}
    assert service._update_tasks == {}
asyncio.run(check())
`], { cwd: root, env: { ...process.env, ...spawnedEnvironment, ASTRBOT_DESKTOP_SESSION_SECRET: '', DSWHALE_TEST_EXPECTED_ASTRBOT: require('../../runtime-lock.json').runtime.astrbot }, timeout: 30000, encoding: 'utf8' });
      assert.equal(checked.status, 0, 'Pinned AstrBot must reject core updates before creating update tasks');
    }
  } finally {
    await supervisor.stop();
    if (fakeServer) await new Promise(resolve => fakeServer.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('only loopback dashboard configuration can be embedded', () => {
  const { dashboardURL } = require('../lib/services.cjs');
  assert.equal(dashboardURL({ dashboard: { host: '127.0.0.1', port: 6185 } }), 'http://127.0.0.1:6185/');
  for (const config of [{ dashboard: { host: '0.0.0.0', port: 6185 } }, { dashboard: { host: '127.0.0.1', port: 0 } }, { dashboard: { host: '127.0.0.1', port: 6185, ssl: { enable: true } } }]) assert.throws(() => dashboardURL(config));
});


test('stop fences a pending start before the owned process can spawn', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dswhale-cancel-start-'));
  const portServer = net.createServer();
  await new Promise(resolve => portServer.listen(0, '127.0.0.1', resolve));
  const port = portServer.address().port;
  await new Promise(resolve => portServer.close(resolve));
  await fs.mkdir(path.join(root, 'data'));
  await fs.writeFile(path.join(root, 'data/cmd_config.json'), JSON.stringify({ dashboard: { host: '127.0.0.1', port } }));
  let entered, release, fakeServer, child, spawnCount = 0;
  const inEnvironment = new Promise(resolve => { entered = resolve; });
  const environment = new Promise(resolve => { release = resolve; });
  const exports = { exports: {} };
  const source = await fs.readFile(path.join(__dirname, '../lib/services.cjs'), 'utf8');
  vm.runInNewContext(source, { module: exports, require: name => name === 'node:child_process' ? { spawn() {
    spawnCount++;
    child = new EventEmitter(); child.pid = 123456789; child.exitCode = null; child.stdout = new PassThrough(); child.stderr = new PassThrough();
    fakeServer = net.createServer().listen(port, '127.0.0.1');
    return child;
  } } : require(name), process: { platform: 'darwin', kill() { child.exitCode = 0; child.emit('exit', 0); child.emit('close', 0); } }, setTimeout, clearTimeout, console, URL });
  const supervisor = new exports.exports.ServiceSupervisor({ manager: { host: root, source: root, python: 'fake-python', environment() { entered(); return environment; } } });
  const start = supervisor.start();
  start.catch(() => {});
  try {
    await inEnvironment;
    const stopping = supervisor.stop();
    release(process.env);
    await stopping;
    await assert.rejects(start, /取消|停止/);
    assert.equal(spawnCount, 0);
    assert.equal(supervisor.running, false);
  } finally {
    await supervisor.stop();
    if (fakeServer) await new Promise(resolve => fakeServer.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('installed-runtime settings migration uses the bundled current policy and an explicit host', async () => {
  const module = { exports: {} };
  let invocation;
  const source = await fs.readFile(path.join(__dirname, '../lib/services.cjs'), 'utf8');
  vm.runInNewContext(source, { module, require: name => name === 'node:child_process' ? { spawn(command, args, options) {
    invocation = { command, args, options };
    const child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => {};
    setImmediate(() => { child.stdout.write('{"changed":true}'); child.emit('close', 0); });
    return child;
  } } : require(name), process, Buffer, setTimeout, clearTimeout });
  const manager = { python: '/synthetic/old-runtime/python', host: '/synthetic/explicit-host', source: '/synthetic/current-bundle',
    environment: async () => ({ PYTHONPATH: '/synthetic/obsolete-policy', PRESERVED: 'value' }) };
  await module.exports.settingsCommand(manager, 'migrate');
  assert.equal(invocation.command, manager.python);
  assert.deepEqual(Array.from(invocation.args), ['-m', 'dswhale.desktop_settings', 'migrate', '--host', manager.host]);
  assert.equal(invocation.options.cwd, manager.source);
  assert.equal(invocation.options.env.PYTHONDONTWRITEBYTECODE, '1');
  assert.equal(invocation.options.env.PYTHONPATH, manager.source);
  assert.equal(invocation.options.env.PRESERVED, 'value');
});


test('settings commands ignore a stale host package and keep configuration writes in the explicit host', async t => {
  const { settingsCommand } = require('../lib/services.cjs');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dswhale-settings-policy-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const host = path.join(root, 'host');
  const source = path.join(root, 'bundle');
  await fs.mkdir(path.join(host, 'dswhale'), { recursive: true });
  await fs.mkdir(source);
  await fs.cp(path.join(__dirname, '../../dswhale'), path.join(source, 'dswhale'), {
    recursive: true,
    filter: file => !['__pycache__', 'node_modules'].includes(path.basename(file)) && !file.endsWith('.pyc'),
  });
  await fs.writeFile(path.join(host, 'dswhale/__init__.py'), '');
  await fs.writeFile(path.join(host, 'dswhale/desktop_settings.py'), `print('{"changed":false,"policy":"stale-host-copy"}')\n`);
  const configFile = path.join(host, 'data/cmd_config.json');
  await fs.mkdir(path.dirname(configFile));
  await fs.writeFile(configFile, JSON.stringify({ platform: [{ type: 'aiocqhttp', enable: true }] }));
  const manager = { host, source, python: process.env.DSWHALE_TEST_PYTHON || process.env.DSWHALE_BUILD_PYTHON || (process.platform === 'win32' ? 'python' : 'python3'),
    environment: async () => ({ ...process.env, PYTHONDONTWRITEBYTECODE: '0' }) };
  const migrated = await settingsCommand(manager, 'migrate');
  assert.notEqual(migrated.policy, 'stale-host-copy');
  const config = JSON.parse(await fs.readFile(configFile, 'utf8'));
  assert.equal(config.platform[0].enable, false);
  const settings = await settingsCommand(manager, 'read');
  assert.equal(settings.qqConnectionMode, 'official');
  const saved = await settingsCommand(manager, 'save', { dashboardPort: 6199 });
  assert.equal(saved.dashboardPort, 6199);
  const updatedConfig = JSON.parse(await fs.readFile(configFile, 'utf8'));
  assert.equal(updatedConfig.dashboard.port, 6199);
  await assert.rejects(fs.access(path.join(source, 'data')), { code: 'ENOENT' });
  const bundleFiles = await fs.readdir(source, { recursive: true });
  assert.equal(bundleFiles.some(file => file.split(path.sep).includes('__pycache__') || file.endsWith('.pyc')), false);
});
