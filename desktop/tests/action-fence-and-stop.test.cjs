'use strict';
// T5-O1 (action-lock boundary) and T3-O1 (stop command / process exit / state
// event / final UI) — synthetic diagnosis of the a12 main-process state machine.
//
// Everything here is synthetic: fake supervisor/napcat/manager, no real QQ,
// no real NapCat, no network, no user data.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

function harness({ platform = process.platform, backendRunning = true, qqRunning = true, backendReadyWait, startFails = false, settingsFails = false, migrateFails = false, hostQuery = null, extensionsRun = async () => ({}), contentSize = [1220, 850] } = {}) {
  const file = path.resolve(__dirname, '../main.cjs'), native = createRequire(file);
  const settingsCommands = [];
  const events = [], snapshots = [], loadedURLs = [], views = [];
  const userData = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'dwhale-main-'));
  test.after(() => fs.rmSync(userData, { recursive: true, force: true }));
  const settingsState = { configRevision: 'abcdef12', defaultDelivery: 'napcat', napcatBound: true, officialBound: false, officialOwnerUMO: '' };
  const supervisor = {
    dashboard: async () => 'http://127.0.0.1:6185/', running: backendRunning,
    async stop() { events.push('stop-conversation'); this.running = false; },
    async start() { settingsCommands.push('host-start'); if (this.running) return; events.push('start-conversation'); if (startFails) throw Error('synthetic backend failure'); await backendReadyWait; this.running = true; },
  };
  const napcat = {
    configurationCalls: 0, running: qqRunning, child: { exitCode: null, killed: false, pid: 987654321 },
    identityToken: 'identity-token-a', identityKnown: true,
    async identityRevision() { return { token: this.identityToken, known: this.identityKnown }; },
    async stop() { events.push('stop-qq'); this.running = false; },
    async start() { if (!this.running) { events.push('launch-qq'); this.running = true; } return this.status(); },
    async configure() { this.configurationCalls += 1; },
    async wire() { events.push('apply-connection'); return this.status(); },
    async loginInfo() { return { url: 'http://127.0.0.1:6099/webui/', token: 'synthetic-only-management-token' }; },
    async status() { return { configured: true, externalOnly: false, canStart: true, running: this.running, loginState: this.running ? 'online' : 'stopped', hasSavedLogin: true, connectionConfigured: true, protocolConnected: false }; },
  };
  const manager = {
    runtime: 'synthetic-runtime', host: 'synthetic-host', inspectCalls: 0,
    async inspect() { this.inspectCalls += 1; return { installed: true }; },
    async install() {},
  };
  class LocalView {
    constructor() {
      views.push(this);
      this.listeners = new Map();
      this.appliedCSS = [];
      let currentURL = '';
      let destroyed = false;
      this.webContents = {
        setWindowOpenHandler() {},
        on: (name, callback) => this.listeners.set(name, callback),
        close() { destroyed = true; },
        isDestroyed: () => destroyed,
        getURL: () => currentURL,
        insertCSS: async css => { this.appliedCSS.push(css); return 'synthetic-style-key'; },
        loadURL: async url => { currentURL = url; loadedURLs.push(url); events.push('open-panel'); this.listeners.get('dom-ready')?.(); },
      };
    }
    setBounds(bounds) { this.bounds = { ...bounds }; }
  }
  const electron = {
    session: { fromPartition: () => ({ clearStorageData: async () => {} }) },
    WebContentsView: LocalView,
    dialog: { showMessageBox: async () => ({ response: 1 }) },
    app: { setName() {}, setAppUserModelId() {}, addPath() {}, setPath() {}, getVersion: () => '0.3.0-alpha.12', getPath: name => name === 'userData' ? userData : path.join(userData, name), requestSingleInstanceLock: () => true, whenReady: () => new Promise(() => {}), on() {} },
    protocol: { registerSchemesAsPrivileged() {} },
  };
  const fakeServices = {
    ...native('./lib/services.cjs'),
    settingsCommand: async (_manager, command, payload) => {
      settingsCommands.push(command);
      if (command === 'migrate' && migrateFails) throw Error('synthetic migration failure');
      if (command === 'read' && settingsFails) throw Error('synthetic settings failure');
      if (command === 'save') {
        events.push('save-settings');
        const patch = payload && payload.patch && typeof payload.patch === 'object' ? payload.patch : payload;
        if (patch && typeof patch === 'object') Object.assign(settingsState, patch);
      }
      if (command === 'history') return { format: 1, records: [], migrationReceipt: null };
      return { ...settingsState, qqConnectionMode: 'napcat', onebotPort: 6199, onebotToken: 'synthetic-existing-token' };
    },
  };
  const context = {
    require: name => name === 'electron' ? electron : name === './lib/services.cjs' ? fakeServices
      : name === 'node:fs/promises' ? native(name) : native(name),
    __dirname: path.dirname(file), process: { ...process, platform }, console, Buffer, setTimeout, clearTimeout,
  };
  vm.runInNewContext(fs.readFileSync(file, 'utf8') + `;globalThis.hooks={perform,stopAll,publishOfficialStatus,refresh,reportActionError,adoptPackagedTransitionLock,getState:()=>state,set(values){
    state.installed=true;operations={snapshot:async()=>{}};hostCommand=async()=>{};manager=values.manager;supervisor=values.supervisor;
    window={isDestroyed:()=>false,webContents:{send:(_channel,value)=>values.snapshot(value)},contentView:{addChildView(){},removeChildView(){}},getContentSize:()=>values.contentSize||[1220,850]};
    extensions={operation:null,run:values.extensionsRun||(async()=>({}))};appUpdater={status:async()=>({recovery:{}})};hostQueryOverride=values.hostQuery||null;}};`, context);
  context.hooks.set({ manager, supervisor, napcat, hostQuery, extensionsRun, contentSize, snapshot: value => snapshots.push(JSON.parse(JSON.stringify(value))) });
  return { ...context.hooks, settingsCommands, events, snapshots, loadedURLs, views, napcat, supervisor, settingsState, manager, userData };
}

const onlinePlatforms = () => async args => {
  if (args[0] === 'status') return { platforms: [{ id: 'qq', type: 'aiocqhttp', enable: true, configured: true }] };
  if (args[0] === 'pending') return { pending: false };
  return {};
};

function deferred() {
  let release;
  const promise = new Promise(resolve => { release = () => resolve(); });
  return { promise, release };
}

// ---------------------------------------------------------------------------
// T5-O1 — action-lock boundary
// ---------------------------------------------------------------------------
test('T5-O1 spec: a rejected concurrent action does not release the fence held by the running action', async () => {
  const backendReadyWait = deferred();
  const h = harness({ backendRunning: false, qqRunning: false, backendReadyWait: backendReadyWait.promise, hostQuery: onlinePlatforms() });

  const start = h.perform('start');                       // A: controlled-latency fake start
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.getState().running, false);

  // B: a second action is refused while A owns the fence.
  await assert.rejects(h.perform('open-panel', { panel: 'models' }), /当前操作尚未完成，请稍候/);
  assert.equal(h.views.length, 0, 'rejected open-panel must not create a panel view');
  assert.deepEqual(h.events.filter(e => e === 'open-panel'), []);

  // The rejection itself must not have released A's ownership: C is still refused.
  await assert.rejects(h.perform('stop'), /当前操作尚未完成，请稍候/);
  assert.equal(h.napcat.running, false, 'stop must not have run while fenced');
  assert.deepEqual(h.events, ['start-conversation']);

  // A read-only inspect is still served while A runs; it must report the live
  // state without clearing the fence either.
  const mid = await h.perform('inspect');
  assert.equal(mid.running, false);
  await assert.rejects(h.perform('stop'), /当前操作尚未完成，请稍候/);

  backendReadyWait.release();
  await start;
  assert.equal(h.getState().running, true, 'A eventually completes normally');

  // C is executable once A settles.
  const stopped = await h.perform('stop');
  assert.equal(stopped.running, false);
  assert.ok(h.events.includes('stop-conversation'));
});

test('T5-O1 spec: a failed action still releases the fence', async () => {
  const h = harness({ backendRunning: false, qqRunning: false, startFails: true, hostQuery: onlinePlatforms() });
  await assert.rejects(h.perform('start'), /synthetic backend failure/);
  // Not fenced any more: the next action runs instead of being refused.
  const state = await h.perform('stop');
  assert.equal(state.running, false);
  // The failing start already unwinds the backend (one stop); the manual stop is the
  // second one. What matters is that it was not refused by a leaked fence.
  assert.equal(h.supervisor.running, false);
  assert.ok(h.events.includes('stop-conversation'));
});

test('T5-O1 spec: the fence refusal reaches the user as a clean [APP-001] message', async () => {
  const backendReadyWait = deferred();
  const h = harness({ backendRunning: false, qqRunning: false, backendReadyWait: backendReadyWait.promise, hostQuery: onlinePlatforms() });
  const start = h.perform('start');
  await new Promise(resolve => setImmediate(resolve));

  let refused = null;
  try { await h.perform('open-panel', { panel: 'models' }); } catch (error) { refused = error; }
  assert.ok(refused, 'open-panel must be refused while start is in flight');

  // ipcMain.handle wraps the thrown error through reportActionError.
  const message = await h.reportActionError(refused, 'open-panel');
  assert.equal(message, '[APP-001] 当前操作尚未完成，请稍候');
  assert.doesNotMatch(message, /Error invoking remote method/);

  backendReadyWait.release();
  await start;
});

// ---------------------------------------------------------------------------
// T3-O1 — stop command / process exit / state event / final interface
// ---------------------------------------------------------------------------
test('T3-O1 spec: stop closes the panel and publishes a complete stopped state', async () => {
  const h = harness({ backendRunning: true, qqRunning: true, hostQuery: onlinePlatforms() });
  await h.perform('open-panel', { panel: 'qq' });
  assert.equal(h.getState().panel, 'qq');
  h.snapshots.length = 0;

  const state = await h.perform('stop');

  assert.equal(state.running, false);
  assert.equal(state.startup.stage, 'stopped');
  assert.equal(state.panel, undefined);
  assert.equal(state.error, undefined);
  assert.equal(h.napcat.running, true, 'stopping the conversation must keep the QQ (NapCat) process');
  assert.deepEqual(h.events, ['open-panel', 'stop-conversation']);

  // Event order: the panel is closed first, the running:false flip comes last.
  const panelClosed = h.snapshots.findIndex(s => s.panel === undefined);
  const stopped = h.snapshots.findIndex(s => s.running === false);
  assert.ok(panelClosed >= 0 && stopped >= 0, 'both events are published');
  assert.ok(panelClosed <= stopped, 'panel closes before the stopped state is published');
});

test('T3-O1 spec: a renderer that missed the stop event recovers through inspect (reload path)', async () => {
  const h = harness({ backendRunning: true, qqRunning: true, hostQuery: onlinePlatforms() });
  await h.perform('stop');
  h.snapshots.length = 0;                       // simulate a renderer that lost the IPC push

  const recovered = await h.perform('inspect'); // what renderer reload/init does

  assert.equal(recovered.running, false, 'inspect must report the live supervisor state');
  assert.notEqual(recovered.stale, true);
  assert.ok(h.snapshots.length >= 1);
});

test('T3-O1 spec: a stop in flight shows the pre-stop state and publishes no progress stage', async () => {
  const h = harness({ backendRunning: true, qqRunning: true, hostQuery: onlinePlatforms() });
  await h.perform('inspect');                   // main-process state now mirrors supervisor.running === true
  assert.equal(h.getState().running, true);
  h.snapshots.length = 0;
  const gate = deferred();
  h.supervisor.stop = async () => { h.events.push('stop-conversation'); await gate.promise; h.supervisor.running = false; };

  const stop = h.perform('stop');
  await new Promise(resolve => setImmediate(resolve));

  // Documented boundary: until supervisor.stop() settles the UI still reads running:true
  // and no intermediate "stopping" stage exists (app.js has no such stage either).
  assert.equal(h.getState().running, true);
  assert.ok(h.snapshots.every(s => s.startup?.stage !== 'stopped'));
  assert.ok(h.snapshots.some(s => s.panel === undefined), 'the panel is closed before the process is gone');

  // Other actions are fenced during the stop.
  await assert.rejects(h.perform('open-panel', { panel: 'models' }), /当前操作尚未完成/);

  gate.release();
  const final = await stop;
  assert.equal(final.running, false);
  assert.equal(final.startup.stage, 'stopped');
});

// ---------------------------------------------------------------------------
// R1 — a warm start that fails in a readiness probe must not stop the host or
// the QQ channel that was already running before the attempt.
// ---------------------------------------------------------------------------
test('R1 spec: a warm start whose extension probe fails keeps the existing host and QQ running', async () => {
  const h = harness({
    backendRunning: true,
    qqRunning: true,
    extensionsRun: async () => { throw Error('synthetic extension probe failure'); },
    hostQuery: onlinePlatforms(),
  });

  await assert.rejects(h.perform('start'), /synthetic extension probe failure/);

  assert.equal(h.getState().running, true, 'the pre-existing host is still reported as running');
  assert.equal(h.supervisor.running, true);
  assert.equal(h.napcat.running, true, 'the existing QQ login must not be stopped by a readiness failure');
  assert.deepEqual(h.events, [], 'no component owned by this attempt was stopped');
  assert.equal(h.getState().startup.stage, 'failed');

  // The action fence is still released normally.
  await h.perform('inspect');
});

test('R1 spec: a warm start whose settings read fails keeps the existing host and QQ running', async () => {
  const h = harness({ backendRunning: true, qqRunning: true, settingsFails: true, hostQuery: onlinePlatforms() });

  await assert.rejects(h.perform('start'), /synthetic settings failure/);

  assert.equal(h.getState().running, true);
  assert.equal(h.supervisor.running, true);
  assert.equal(h.napcat.running, true);
  assert.deepEqual(h.events, []);
  assert.equal(h.getState().startup.stage, 'failed');
  await h.perform('inspect');
});

test('R1 spec: a cold start that fails before launching the host cleans up nothing extra', async () => {
  const h = harness({
    backendRunning: false,
    qqRunning: false,
    extensionsRun: async () => { throw Error('synthetic extension probe failure'); },
    hostQuery: onlinePlatforms(),
  });

  await assert.rejects(h.perform('start'), /synthetic extension probe failure/);

  assert.equal(h.getState().running, false);
  assert.equal(h.supervisor.running, false);
  assert.equal(h.napcat.running, false);
  assert.deepEqual(h.events, [], 'nothing was started, so there is nothing to unwind');
  assert.equal(h.getState().startup.stage, 'failed');
  // The failed attempt must not leak the action fence.
  await h.perform('inspect');
});

test('R1 spec: a cold start that launched the host still unwinds that owned host', async () => {
  const h = harness({ backendRunning: false, qqRunning: false, startFails: true, hostQuery: onlinePlatforms() });

  await assert.rejects(h.perform('start'), /synthetic backend failure/);

  assert.equal(h.getState().running, false);
  assert.equal(h.supervisor.running, false);
  assert.ok(h.events.includes('start-conversation'));
  assert.ok(h.events.includes('stop-conversation'), 'the host launched by this attempt is stopped again');
  assert.equal(h.getState().startup.stage, 'failed');
  await h.perform('inspect');
});

// ---------------------------------------------------------------------------
// T3-I3 — the first state event must carry a real startup stage, before the
// slow readiness probes (extensions.run("status") + settings read) complete.
// ---------------------------------------------------------------------------
test('T3-I3 spec: a real startup stage is published before the readiness probes', async () => {
  const gate = deferred();
  const h = harness({ backendRunning: false, qqRunning: false, extensionsRun: () => gate.promise, hostQuery: onlinePlatforms() });

  const start = h.perform('start');
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(h.getState().startup?.stage, 'starting-conversation', 'main process publishes the real stage immediately');
  assert.ok(h.snapshots.length >= 1, 'the renderer receives a state event while the probes are still running');
  assert.equal(h.snapshots[0].startup?.stage, 'starting-conversation', 'the very first snapshot carries the stage');

  gate.release();
  await start;
  assert.equal(h.getState().running, true);
});

test('T3-I3 spec: an early readiness probe failure does not leave a stale starting stage', async () => {
  const h = harness({
    backendRunning: false,
    qqRunning: false,
    extensionsRun: async () => { throw Error('synthetic extension probe failure'); },
    hostQuery: onlinePlatforms(),
  });

  await assert.rejects(h.perform('start'), /synthetic extension probe failure/);
  assert.equal(h.getState().running, false);
  assert.equal(h.getState().startup.stage, 'failed');
});

// ---------------------------------------------------------------------------
// T4-I3 — the embedded console must keep the upstream navigation reachable by
// giving it the full content width below 1220 DIP (the upstream drawer closes
// its navigation at <=960 CSS px).
// ---------------------------------------------------------------------------
async function panelBoundsFor(size) {
  const h = harness({ backendRunning: true, qqRunning: true, hostQuery: onlinePlatforms(), contentSize: size });
  await h.perform('open-panel', { panel: 'astrbot' });
  assert.equal(h.views.length, 1, 'the panel view was created');
  assert.ok(h.views[0].bounds, 'the panel received explicit bounds');
  return h.views[0].bounds;
}

test('T4-I3 spec: a 1219 DIP window gives the embedded console the full content width', async () => {
  const bounds = await panelBoundsFor([1219, 850]);
  assert.deepEqual(bounds, { x: 0, y: 52, width: 1219, height: 798 });
  assert.ok(bounds.width >= 960, 'upstream navigation stays in the permanent drawer');
  assert.ok(bounds.y >= 52, 'the embedded toolbar stays above the console panel');
});

test('T4-I3 spec: a 1220 DIP window keeps the desktop sidebar offset', async () => {
  const bounds = await panelBoundsFor([1220, 850]);
  assert.deepEqual(bounds, { x: 256, y: 52, width: 964, height: 798 });
  assert.ok(bounds.width >= 960);
});

test('T4-I3 spec: the minimum 980x700 window gives the console the full width and height', async () => {
  const bounds = await panelBoundsFor([980, 700]);
  assert.deepEqual(bounds, { x: 0, y: 52, width: 980, height: 648 });
  assert.ok(bounds.width >= 960);
  assert.ok(bounds.height > 0);
});

test('R7: a main-process read failure is a scoped warning envelope, a real action failure stays a fault', async () => {
  const h = harness();
  await h.reportActionError(new Error('synthetic workspace read failure'), 'workspace-status');
  const read = h.snapshots.at(-1);
  assert.match(read.workspaceWarning, /^\[APP-001\] /);
  assert.equal(read.error, undefined);
  assert.equal(read.feedback.kind, 'warning');
  assert.equal(read.feedback.scope, 'workspace');
  assert.match(read.feedback.operationId, /^[0-9a-f]{16}$/);

  await h.reportActionError(new Error('synthetic settings save failure'), 'settings-save');
  const save = h.snapshots.at(-1);
  assert.match(save.error, /^\[APP-001\] /);
  assert.equal(save.feedback.kind, 'error');
  assert.equal(save.feedback.scope, 'action');
  assert.notEqual(save.feedback.operationId, read.feedback.operationId);
});

test('R3: the packaged installer-digest chain wins and a mismatched writable chain is archived', async t => {
  const fs = require('node:fs/promises');
  const os = require('node:os');
  const crypto = require('node:crypto');
  const updateChain = require('../lib/update-chain.cjs');
  const h = harness();
  const source = await fs.mkdtemp(path.join(os.tmpdir(), 'dwhale-intent-source-'));
  t.after(() => fs.rm(source, { recursive: true, force: true }));
  const suffix = { 'win32-x64': 'Windows-x86_64-setup.exe', 'darwin-arm64': 'macOS-arm64.dmg', 'linux-x64': 'Linux-x86_64.deb' };
  const chain = (id, manifestDigest) => ({
    format: 1,
    chainId: id,
    bridge: { version: '0.3.0a12', tag: 'v0.3.0a12' },
    originVersion: '0.3.0a11',
    originRuntime: { astrbot: '4.29.3', python: '3.12', node: '22.23.4', ffmpeg: '9.0.2' },
    originV1State: { format: 1, phase: 'install-launched', targetVersion: '0.3.0a12' },
    originBackup: null,
    originInstaller: null,
    fixedFinalTarget: {
      version: '0.4.0a1', tag: 'dwhale-v0.4.0-alpha.1', commit: 'c'.repeat(40), manifestSha256: manifestDigest, runtimeLockSha256: 'd'.repeat(64),
      assets: Object.fromEntries(Object.entries(suffix).map(([platform, name]) => [platform, { name: `DWhale-0.4.0-alpha.1-${name}`, size: 1024, sha256: crypto.createHash('sha256').update(platform).digest('hex') }])),
    },
    hops: [], terminalState: 'pending',
  });
  const packaged = chain('a'.repeat(32), '1'.repeat(64));
  const writable = chain('b'.repeat(32), '2'.repeat(64));
  await fs.writeFile(path.join(source, 'transition-lock.json'), JSON.stringify(packaged));
  const updates = path.join(h.userData, 'runtime', 'app-updates');
  await fs.mkdir(updates, { recursive: true });
  await fs.writeFile(path.join(updates, 'state.json'), JSON.stringify({ format: 1, phase: 'awaiting-verification', targetVersion: '0.3.0a12' }));
  await fs.writeFile(path.join(updates, 'transition-lock.json'), JSON.stringify(writable));
  const adopted = await h.adoptPackagedTransitionLock(source);
  assert.equal(adopted.chainId, packaged.chainId);
  const bytes = await fs.readFile(path.join(updates, 'transition-lock.json'), 'utf8');
  assert.equal(JSON.parse(bytes).chainId, packaged.chainId, 'packaged identity replaces the writable copy');
  const archived = (await fs.readdir(updates)).filter(name => name.startsWith('transition-lock.abandoned-'));
  assert.equal(archived.length, 1);
  assert.equal(JSON.parse(await fs.readFile(path.join(updates, archived[0]), 'utf8')).chainId, writable.chainId);

  const retargeted = chain('a'.repeat(32), '4'.repeat(64));
  await fs.writeFile(path.join(updates, 'transition-lock.json'), JSON.stringify(retargeted));
  await h.adoptPackagedTransitionLock(source);
  assert.equal(JSON.parse(await fs.readFile(path.join(updates, 'transition-lock.json'), 'utf8')).chainId, packaged.chainId);
  assert.equal((await fs.readdir(updates)).filter(name => name.startsWith('transition-lock.abandoned-')).length, 2);

  const tampered = await fs.mkdtemp(path.join(os.tmpdir(), 'dwhale-intent-tampered-'));
  t.after(() => fs.rm(tampered, { recursive: true, force: true }));
  const bad = chain('f'.repeat(32), '5'.repeat(64));
  bad.fixedFinalTarget.manifestSha256 = 'not-a-digest';
  await fs.writeFile(path.join(tampered, 'transition-lock.json'), JSON.stringify(bad));
  assert.equal(await h.adoptPackagedTransitionLock(tampered), null);
  assert.equal(JSON.parse(await fs.readFile(path.join(updates, 'transition-lock.json'), 'utf8')).chainId, packaged.chainId);

  const fresh = harness();
  assert.equal(await fresh.adoptPackagedTransitionLock(source), null, 'a fresh install has no old-update intent');
  await assert.rejects(fs.readFile(path.join(fresh.userData, 'runtime', 'app-updates', 'transition-lock.json')));

  const intended = harness();
  const intendedUpdates = path.join(intended.userData, 'runtime', 'app-updates');
  await fs.mkdir(intendedUpdates, { recursive: true });
  await fs.writeFile(path.join(intendedUpdates, 'state.json'), JSON.stringify({ format: 1, phase: 'awaiting-verification', targetVersion: '0.3.0a12' }));
  const intendedAdopted = await intended.adoptPackagedTransitionLock(source);
  assert.equal(intendedAdopted.chainId, packaged.chainId);
  assert.equal(JSON.parse(await fs.readFile(path.join(intendedUpdates, 'transition-lock.json'), 'utf8')).chainId, packaged.chainId);

  // The exact a14 updater launches the bridge with install-launched; a genuine
  // handoff must adopt that phase, not confuse it with a fresh install.
  const launched = harness();
  const launchedUpdates = path.join(launched.userData, 'runtime', 'app-updates');
  await fs.mkdir(launchedUpdates, { recursive: true });
  await fs.writeFile(path.join(launchedUpdates, 'state.json'), JSON.stringify({ format: 1, phase: 'install-launched', targetVersion: '0.3.0a12' }));
  const launchedAdopted = await launched.adoptPackagedTransitionLock(source);
  assert.equal(launchedAdopted.chainId, packaged.chainId);

  // A target download interrupted before it finished must also resume rather
  // than look like a bridge-only install.
  const resumed = harness();
  const resumedUpdates = path.join(resumed.userData, 'runtime', 'app-updates');
  await fs.mkdir(resumedUpdates, { recursive: true });
  await fs.writeFile(path.join(resumedUpdates, 'state.json'), JSON.stringify({ format: 1, phase: 'downloading', targetVersion: '0.4.0a1' }));
  const resumedAdopted = await resumed.adoptPackagedTransitionLock(source);
  assert.equal(resumedAdopted.chainId, packaged.chainId);

  const foreign = chain('e'.repeat(32), '3'.repeat(64));
  foreign.bridge = { version: '0.4.0a0', tag: 'v0.4.0a0' };
  const foreignSource = await fs.mkdtemp(path.join(os.tmpdir(), 'dwhale-intent-foreign-'));
  t.after(() => fs.rm(foreignSource, { recursive: true, force: true }));
  await fs.writeFile(path.join(foreignSource, 'transition-lock.json'), JSON.stringify(foreign));
  assert.equal(await h.adoptPackagedTransitionLock(foreignSource), null, 'a chain for another bridge never adopts');
  assert.equal(JSON.parse(await fs.readFile(path.join(updates, 'transition-lock.json'), 'utf8')).chainId, packaged.chainId);
});

test('cold start migrates an already installed runtime before launching the owned host', async () => {
  const h = harness({backendRunning:false});
  await h.perform('start');
  assert.equal(h.settingsCommands.filter(value => value === 'migrate').length, 1);
  assert.ok(h.settingsCommands.indexOf('migrate') < h.settingsCommands.indexOf('host-start'));
  assert.equal(h.events.includes('launch-qq'), false);
});
test('migration failure prevents any host start and leaves the runtime stopped', async () => {
  const h = harness({backendRunning:false,migrateFails:true});
  await assert.rejects(h.perform('start'), /migration failure/);
  assert.equal(h.settingsCommands.includes('host-start'), false);
  assert.equal(h.supervisor.running, false);
  assert.deepEqual(h.events, []);
});
test('warm owned host reuse skips offline migration', async () => {
  const h = harness({backendRunning:true,migrateFails:true});
  await h.perform('start');
  assert.equal(h.settingsCommands.includes('migrate'), false);
  assert.equal(h.supervisor.running, true);
});

test('background official observations preserve the readiness stage until startup completes', async () => {
  const gate = deferred();
  const h = harness({backendRunning:true,extensionsRun:async()=>gate.promise});
  const start = h.perform('start');
  await new Promise(resolve => setImmediate(resolve));
  h.publishOfficialStatus({protocolConnected:true});
  assert.equal(h.getState().startup.stage, 'checking-qq');
  gate.release();
  await start;
  assert.equal(h.getState().startup.stage, 'official-connecting');
});

test('Windows main-process harness can stop without starting any service', async () => {
  const h = harness({ platform: 'win32' });
  const state = await h.perform('stop');
  assert.equal(state.running, false);
  assert.deepEqual(h.events, ['stop-conversation']);
});


test('managed AstrBot views receive the narrow form adapter on load and reload', async () => {
  const h = harness({ backendRunning: true, contentSize: [980, 700] });
  for (const panel of ['astrbot', 'models', 'memory', 'persona', 'qq']) {
    await h.perform('open-panel', { panel });
    const view = h.views.at(-1);
    assert.equal(view.appliedCSS.length, 1, panel + ' initial document');
    assert.equal(view.appliedCSS[0], require('../lib/console-layout.cjs'));
    view.listeners.get('dom-ready')();
    assert.equal(view.appliedCSS.length, 2, panel + ' reloaded document');
  }
  const detached = h.views[0];
  const previous = detached.appliedCSS.length;
  detached.listeners.get('dom-ready')();
  assert.equal(detached.appliedCSS.length, previous, 'detached console ignores late document events');
});

test('the Bilibili console keeps its own form layout', async () => {
  const h = harness({ backendRunning: true });
  h.manager.host = path.join(h.userData, 'synthetic-host');
  h.supervisor.startedAt = Date.now();
  const control = path.join(h.manager.host, 'data/plugin_data/astrbot_plugin_dswhale/bilibili/control.json');
  fs.mkdirSync(path.dirname(control), { recursive: true });
  fs.writeFileSync(control, JSON.stringify({ port: 49123, token: 'synthetic-bili-token' }));
  await h.perform('open-panel', { panel: 'bilibili' });
  const view = h.views.at(-1);
  assert.equal(view.appliedCSS.length, 0);
  view.listeners.get('dom-ready')?.();
  assert.equal(view.appliedCSS.length, 0);
});
