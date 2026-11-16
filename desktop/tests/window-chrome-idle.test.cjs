'use strict';
// Main-process tests use synthetic windows and clocks. No installed runtime,
// native client, account data, or real Electron process is opened.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const chrome = require('../lib/window-chrome.cjs');
const { AppearanceError } = require('../lib/appearance.cjs');

function mainHarness({ openWindow = false, dark = true, userData } = {}) {
  const file = path.resolve(__dirname, '../main.cjs');
  const native = createRequire(file);
  const messages = [];
  let capturedOptions;
  let healthReads = 0;
  const clock = fakeClock();
  const powerMonitor = new (require('node:events').EventEmitter)();
  const handlers = {};
  const ipcHandlers = new Map();
  const ipcRenderer = new (require('node:events').EventEmitter)();
  const nativeWindow = {
    visible: true, minimized: false,
    isDestroyed: () => false,
    isVisible() { return this.visible; },
    isMinimized() { return this.minimized; },
    on(name, callback) { handlers[name] = callback; },
    setMenuBarVisibility() {},
    loadURL: async () => {},
    webContents: { mainFrame: {}, send(channel, value) { const state = structuredClone(value); messages.push({ channel, state }); ipcRenderer.emit(channel, {}, state); }, setWindowOpenHandler() {}, on() {} },
  };
  const electron = {
    app: { setName() {}, setAppUserModelId() {}, setPath() {}, getPath: name => userData ? name === 'userData' ? userData : path.join(userData, name) : path.join(require('node:os').tmpdir(), 'dwhale-synthetic-window', name), getVersion: () => '0.4.0-alpha.2', requestSingleInstanceLock: () => false, quit() {} },
    protocol: { registerSchemesAsPrivileged() {} },
    powerMonitor, ipcMain: { handle(channel, callback) { ipcHandlers.set(channel, callback); } },
    nativeTheme: { shouldUseDarkColors: dark },
    session: {
      fromPartition: () => ({ setProxy() {}, fetch() { throw Error('unexpected request'); }, setPermissionRequestHandler() {}, setPermissionCheckHandler() {} }),
      defaultSession: { setPermissionRequestHandler() {}, setPermissionCheckHandler() {} },
    },
    BrowserWindow: class { constructor(options) { capturedOptions = options; if (!openWindow) throw Error('captured window options'); return nativeWindow; } },
  };
  const services = {
    ...native('./lib/services.cjs'),
    ServiceSupervisor: class { constructor(options) { Object.assign(this, options); this.running = false; } },
    readConnectionHealth: async () => { healthReads += 1; return { channels: { official: { state: 'connected', protocolConnected: true } } }; },
  };
  const { RuntimeManager } = native('./lib/runtime.cjs');
  const { AppUpdater } = native('./lib/app-updater.cjs');
  const { UpdateScheduler } = native('./lib/update-scheduler.cjs');
  const { VisibilityMonitor } = native('./lib/visibility-monitor.cjs');
  const context = {
    require: id => {
      if (id === 'electron') return electron;
      if (id === './lib/services.cjs') return services;
      if (id === './lib/runtime.cjs') return { ...native(id), RuntimeManager: class extends RuntimeManager { async inspect() { return { installed: false }; } } };
      if (id === './lib/app-updater.cjs') return { ...native(id), AppUpdater: class extends AppUpdater { async status() { return { phase: 'idle' }; } async check() { return { phase: 'idle' }; } } };
      if (id === './lib/update-scheduler.cjs') return { UpdateScheduler: class extends UpdateScheduler { constructor(options) { super({ ...options, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout }); } } };
      if (id === './lib/visibility-monitor.cjs') return { VisibilityMonitor: class extends VisibilityMonitor { constructor(options) { super({ ...options, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout }); } } };
      return native(id);
    },
    __dirname: path.dirname(file), process: { ...process, platform: 'win32' },
    console, Buffer, setTimeout, clearTimeout,
  };
  vm.runInNewContext(fs.readFileSync(file, 'utf8') + `
    globalThis.hooks = {
      publish, publishOfficialStatus, createWindow, reportActionError, getState: () => state,
      sync: () => typeof syncConnectionMonitor === 'function' && syncConnectionMonitor(),
      setWindow(value) { window = value; supervisor = { running: true }; },
      changeRunning(value) { supervisor.running = value; supervisor.onChange({ running: value }); },
      setBusy(value) { activeAction = value ? 'synthetic-action' : null; },
      disposeMonitoring() { externalConnectionMonitor?.stop(); updateScheduler?.stop(); },
    };`, context);
  context.hooks.setWindow(nativeWindow);
  const request = async (action, payload, event = { sender: nativeWindow.webContents, senderFrame: nativeWindow.webContents.mainFrame }) => {
    const result = await ipcHandlers.get('dswhale:action')(event, action, structuredClone(payload));
    return structuredClone(result);
  };
  ipcRenderer.invoke = (channel, action, payload) => {
    assert.equal(channel, 'dswhale:action');
    return request(action, payload);
  };
  let bridge;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../preload.cjs'), 'utf8'), {
    require(id) {
      assert.equal(id, 'electron');
      return { contextBridge: { exposeInMainWorld(name, value) { assert.equal(name, 'dswhale'); bridge = value; } }, ipcRenderer };
    },
  });
  return { ...context.hooks, bridge, request, nativeWindow, messages, handlers, clock, powerMonitor, healthReads: () => healthReads, options: () => capturedOptions };
}

test('transparent native Windows controls use theme glyphs and reserve their content area', () => {
  assert.deepEqual(chrome.titleBarOverlay(false), { color: '#00000000', symbolColor: '#475569', height: 40 });
  assert.deepEqual(chrome.titleBarOverlay(true), { color: '#00000000', symbolColor: '#dbe6f6', height: 40 });
  assert.equal(chrome.chromeFor('win32').titlebarHeight, 40);
  assert.equal(chrome.chromeFor('win32').controlsInset, 150);
  assert.equal(chrome.chromeFor('win32').controlsLeftInset, 0);
  assert.equal(chrome.chromeFor('darwin').controlsLeftInset, 80);
  assert.equal(chrome.chromeFor('darwin').controlsInset, 0);
  assert.equal(chrome.chromeFor('linux').titlebarHeight, 0);
  assert.equal(chrome.browserWindowOptions('win32', '10.0.22621').titleBarStyle, 'hidden');
});

test('embedded panel geometry uses content dimensions at the sidebar breakpoint', () => {
  assert.deepEqual(chrome.panelBounds({ width: 1219, height: 850 }), { x: 0, y: 52, width: 1219, height: 798 });
  assert.deepEqual(chrome.panelBounds({ width: 1220, height: 850 }), { x: 256, y: 52, width: 964, height: 798 });
  assert.deepEqual(chrome.panelBounds({ width: 980, height: 700 }), { x: 0, y: 52, width: 980, height: 648 });
});

test('window construction uses the page content size and initial system theme for native controls', async () => {
  const h = mainHarness();
  await assert.rejects(h.createWindow(), /captured window options/);
  const options = h.options();
  assert.equal(options.width, 1220);
  assert.equal(options.height, 850);
  assert.equal(options.useContentSize, true, 'native frame dimensions cannot shrink the initial page below the sidebar breakpoint');
  assert.equal(options.titleBarOverlay.symbolColor, '#dbe6f6');
  assert.equal(options.titleBarOverlay.color, '#00000000');
  assert.equal(options.backgroundColor, '#111b29');
  assert.equal(options.webPreferences.sandbox, true);
  assert.equal(options.webPreferences.contextIsolation, true);
});

test('light windows start with the matching light canvas beneath transparent native controls', async () => {
  const h = mainHarness({ dark: false });
  await assert.rejects(h.createWindow(), /captured window options/);
  assert.equal(h.options().backgroundColor, '#eef3f8');
  assert.equal(h.options().titleBarOverlay.symbolColor, '#475569');
});

test('the packaged main process includes its visibility monitor dependency', () => {
  const config = require('../../electron-builder.cjs');
  assert.ok(config.files.includes('desktop/lib/visibility-monitor.cjs'));
});

test('repeated equivalent health snapshots avoid whole-state IPC and still return current state', () => {
  const h = mainHarness();
  h.publishOfficialStatus({ configured: true, protocolConnected: false });
  h.publishOfficialStatus({ protocolConnected: false, configured: true });
  assert.equal(h.messages.length, 1, 'equivalent object keys do not cause another renderer update');
  assert.equal(h.publish({}), h.getState());
  assert.equal(h.messages.length, 1);
  h.publishOfficialStatus({ configured: true, protocolConnected: true });
  assert.equal(h.messages.length, 2);
  assert.equal(h.messages[1].state.startup.stage, 'ready');
});

test('hidden and minimized windows retain current state and deliver it once after becoming visible', () => {
  const h = mainHarness();
  h.nativeWindow.visible = false;
  h.publish({ notice: 'first' });
  h.publish({ notice: 'latest' });
  assert.equal(h.messages.length, 0);
  assert.equal(h.getState().notice, 'latest');
  h.nativeWindow.visible = true;
  h.nativeWindow.minimized = true;
  h.sync();
  assert.equal(h.messages.length, 0);
  h.nativeWindow.minimized = false;
  h.sync();
  h.sync();
  assert.equal(h.messages.length, 1);
  assert.equal(h.messages[0].state.notice, 'latest');
});

test('appearance persistence failures stay local and retain existing service fault feedback', async () => {
  const h = mainHarness();
  h.publish({ running: true, error: 'existing service fault', feedback: { code: 'PORT-001', active: true } });
  const before = h.getState();
  const messages = h.messages.length;
  assert.equal(await h.reportActionError(new AppearanceError('APPEARANCE_SAVE'), 'appearance-save'), '[APP-001] 外观设置未保存，请重试');
  assert.equal(h.getState(), before);
  assert.equal(h.messages.length, messages);
  assert.equal(await h.reportActionError(new AppearanceError('APPEARANCE_PATH'), 'appearance-get'), '[APP-001] 外观设置目录不安全，未保存');
  assert.equal(h.getState(), before);
});

test('normal window lifecycle pauses only UI probes and refreshes on service changes, show, focus and wake', async () => {
  const h = mainHarness({ openWindow: true });
  test.after(() => h.disposeMonitoring());
  await h.createWindow();
  await h.clock.advance(5000);
  assert.equal(h.healthReads(), 0);
  h.changeRunning(true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.healthReads(), 1, 'starting services while already visible refreshes their observed connection');
  h.nativeWindow.visible = false;
  h.handlers.hide();
  h.publish({ notice: 'latest hidden state' });
  await h.clock.advance(60_000);
  assert.equal(h.healthReads(), 1);
  assert.equal(h.getState().running, true, 'window visibility does not stop background services');
  h.powerMonitor.emit('suspend');
  h.powerMonitor.emit('resume');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.healthReads(), 1, 'resume keeps a hidden window idle');
  h.nativeWindow.visible = true;
  h.handlers.show();
  h.handlers.focus();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.healthReads(), 2, 'show and focus coalesce into one immediate probe');
  h.setBusy(true);
  await h.clock.advance(10_000);
  assert.equal(h.healthReads(), 2);
  h.setBusy(false);
  await h.clock.advance(5000);
  assert.equal(h.healthReads(), 3, 'finishing a busy action resumes scheduled probes without another focus');
  h.powerMonitor.emit('suspend');
  const deliveries = h.messages.length;
  h.publish({ notice: 'suspended state' });
  await h.clock.advance(60_000);
  assert.equal(h.healthReads(), 3);
  assert.equal(h.messages.length, deliveries);
  h.powerMonitor.emit('resume');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.healthReads(), 4);
  h.nativeWindow.minimized = true;
  h.handlers.minimize();
  await h.clock.advance(60_000);
  assert.equal(h.healthReads(), 4);
  h.nativeWindow.minimized = false;
  h.handlers.restore();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.healthReads(), 5);
  h.handlers.closed();
  await h.clock.advance(60_000);
  assert.equal(h.healthReads(), 5);
});

function fakeClock() {
  let now = 0;
  let nextId = 0;
  const timers = new Map();
  return {
    timers,
    setTimeout(callback, delay) { const id = ++nextId; timers.set(id, { callback, at: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    async advance(milliseconds) {
      const target = now + milliseconds;
      while (true) {
        const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > target) break;
        timers.delete(next[0]); now = next[1].at; next[1].callback();
        await new Promise(resolve => setImmediate(resolve));
      }
      now = target;
      await new Promise(resolve => setImmediate(resolve));
    },
  };
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function monitorHarness({ read = async () => ({ connected: true }), shouldRun = () => true } = {}) {
  const { VisibilityMonitor } = require('../lib/visibility-monitor.cjs');
  const clock = fakeClock();
  const results = [];
  let reads = 0;
  const monitor = new VisibilityMonitor({
    read: () => { reads += 1; return read(); }, shouldRun,
    onResult: value => results.push(value),
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
  });
  return { clock, monitor, results, reads: () => reads };
}

test('slow health reads remain single-flight and the next interval begins after completion', async () => {
  const pending = deferred();
  const h = monitorHarness({ read: () => pending.promise });
  h.monitor.start();
  await h.clock.advance(5000);
  await h.clock.advance(60_000);
  h.monitor.refresh();
  h.monitor.refresh();
  assert.equal(h.reads(), 1);
  assert.equal(h.clock.timers.size, 0);
  pending.resolve({ connected: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.results.length, 1);
  assert.equal(h.clock.timers.size, 1);
  await h.clock.advance(4999);
  assert.equal(h.reads(), 1);
  await h.clock.advance(1);
  assert.equal(h.reads(), 2);
  h.monitor.stop();
});

test('hidden and suspended monitors remove timers and refresh immediately when active', async () => {
  const h = monitorHarness();
  h.monitor.start(false);
  await h.clock.advance(60_000);
  assert.equal(h.reads(), 0);
  assert.equal(h.clock.timers.size, 0);
  h.monitor.setActive(true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.reads(), 1);
  h.monitor.setActive(false);
  assert.equal(h.clock.timers.size, 0);
  await h.clock.advance(60_000);
  assert.equal(h.reads(), 1);
  h.monitor.setActive(true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.reads(), 2);
  h.monitor.stop();
});

test('resuming during a paused read discards its late result and queues one fresh read', async () => {
  const pending = deferred();
  let first = true;
  const h = monitorHarness({ read: () => { if (first) { first = false; return pending.promise; } return { connected: true }; } });
  h.monitor.start();
  const firstRead = h.monitor.refresh();
  await new Promise(resolve => setImmediate(resolve));
  h.monitor.setActive(false);
  h.monitor.setActive(true);
  h.monitor.refresh();
  pending.resolve({ connected: false });
  await firstRead;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.reads(), 2);
  assert.deepEqual(h.results, [{ connected: true }]);
  assert.equal(h.clock.timers.size, 1);
  h.monitor.stop();
});

test('busy actions and stopped services postpone probes and normal polling recovers without focus', async () => {
  let allowed = false;
  const h = monitorHarness({ shouldRun: () => allowed });
  h.monitor.start();
  await h.clock.advance(10_000);
  assert.equal(h.reads(), 0);
  allowed = true;
  await h.clock.advance(5000);
  assert.equal(h.reads(), 1);
  h.monitor.stop();
});

test('failed reads recover and a stopped monitor never publishes a late result', async () => {
  const pending = deferred();
  let first = true;
  const h = monitorHarness({ read: () => { if (first) { first = false; throw Error('synthetic read failure'); } return pending.promise; } });
  h.monitor.start();
  await h.clock.advance(5000);
  assert.equal(h.reads(), 1);
  assert.equal(h.clock.timers.size, 1);
  await h.clock.advance(5000);
  assert.equal(h.reads(), 2);
  h.monitor.stop();
  pending.resolve({ connected: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.results.length, 0);
  assert.equal(h.clock.timers.size, 0);
});


// A missing permission entry must fail these tests at the real IPC boundary.
// The window and transport are synthetic; validator, handler, store and model are real.
function appearanceSession(t, userData) {
  const directory = userData || fs.mkdtempSync(path.join(fs.realpathSync(require('node:os').tmpdir()), 'dwhale-ipc-appearance-'));
  if (!userData) t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const h = mainHarness({ openWindow: true, userData: directory });
  t.after(() => h.disposeMonitoring());
  return { h, directory, file: path.join(directory, 'desktop-appearance.json') };
}

test('real preload and registered IPC persist appearance and restore it in a fresh window', async t => {
  const { h, directory, file } = appearanceSession(t);
  const data = path.join(directory, 'runtime/host/data');
  fs.mkdirSync(data, { recursive: true });
  for (const name of ['provider.json', 'persona.json', 'memory.json']) fs.writeFileSync(path.join(data, name), 'synthetic original');
  await h.createWindow();
  const controller = require('../ui/model.js').createController({ bridge: h.bridge });
  t.after(() => controller.dispose());
  await controller.init();
  await controller.act('appearance-save', { material: 'liquid' });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { format: 1, material: 'liquid', revision: 1 });
  assert.equal(controller.get().appearance.material, 'liquid');
  assert.equal(controller.get().appearanceError, '');
  assert.deepEqual(await h.bridge.invoke('appearance-get'), { format: 1, material: 'liquid', revision: 1 });
  for (const name of ['provider.json', 'persona.json', 'memory.json']) assert.equal(fs.readFileSync(path.join(data, name), 'utf8'), 'synthetic original');
  controller.dispose();
  h.disposeMonitoring();
  const fresh = appearanceSession(t, directory).h;
  await fresh.createWindow();
  const next = require('../ui/model.js').createController({ bridge: fresh.bridge });
  t.after(() => next.dispose());
  await next.init();
  assert.equal(next.get().appearance.material, 'liquid');
  assert.equal(next.get().state.appearance.revision, 1);
});

test('rapid renderer appearance saves pass the IPC guard during an unrelated main action', async t => {
  const { h, file } = appearanceSession(t);
  await h.createWindow();
  const controller = require('../ui/model.js').createController({ bridge: h.bridge });
  t.after(() => controller.dispose());
  await controller.init();
  h.setBusy(true);
  t.after(() => h.setBusy(false));
  const choices = ['liquid', 'frosted', 'liquid', 'frosted', 'liquid'];
  await Promise.all(choices.map(material => controller.act('appearance-save', { material })));
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.material, 'liquid');
  assert.equal(saved.revision, choices.length);
  assert.equal(controller.get().appearance.material, 'liquid');
  assert.equal(controller.get().appearancePending, false);
});

test('appearance IPC rejects invalid payloads and foreign frames without writing files', async t => {
  const { h, file } = appearanceSession(t);
  await h.createWindow();
  for (const payload of [null, undefined, [], 'liquid', { material: 'unknown' }, { material: 'liquid', path: 'other.json' }, { material: 'liquid', revision: 12 }]) {
    await assert.rejects(h.bridge.invoke('appearance-save', payload));
  }
  for (const payload of [{}, { extra: true }, false]) await assert.rejects(h.bridge.invoke('appearance-get', payload));
  const shell = h.nativeWindow.webContents;
  for (const event of [{ sender: {}, senderFrame: shell.mainFrame }, { sender: shell, senderFrame: {} }]) {
    await assert.rejects(h.request('appearance-save', { material: 'liquid' }, event), /不允许此操作/);
    await assert.rejects(h.request('appearance-get', undefined, event), /不允许此操作/);
  }
  assert.equal(fs.existsSync(file), false);
  await h.bridge.invoke('appearance-save', { material: 'liquid' });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).material, 'liquid');
});

test('an actual persistence failure clears locally after a successful IPC save', async t => {
  const { h, file } = appearanceSession(t);
  await h.createWindow();
  const controller = require('../ui/model.js').createController({ bridge: h.bridge });
  t.after(() => controller.dispose());
  await controller.init();
  fs.mkdirSync(file);
  await assert.rejects(controller.act('appearance-save', { material: 'liquid' }));
  assert.ok(controller.get().appearanceError);
  assert.equal(controller.get().appearance.material, 'frosted');
  assert.equal(controller.get().error, '');
  fs.rmdirSync(file);
  await controller.act('appearance-save', { material: 'liquid' });
  assert.equal(controller.get().appearance.material, 'liquid');
  assert.equal(controller.get().appearanceError, '');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).material, 'liquid');
});
