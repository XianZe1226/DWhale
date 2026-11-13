'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

function harness({ saveFails = false, recovery = {}, backendRunning = true, qqRunning = true, loginState = 'online', backendReadyWait, qqStatusWait, qqConfigureWait, qqMode='napcat', startFails = false, settingsOverrides = {}, hostQuery = null, workspace = null, dialogResponse = 1, settingsHistory = null, useRealWorkspace = false } = {}) {
  const file = path.resolve(__dirname, '../main.cjs'), native = createRequire(file);
  const events = [], snapshots = [], loadedURLs = [], savePayloads = [], restorePayloads = [], wirePorts = [], views = [];
  const settingsState = { configRevision: 'abcdef12', defaultDelivery: 'official', officialBound: false, officialOwnerUMO: '', ...settingsOverrides };
  const supervisor = { dashboard:async()=> 'http://127.0.0.1:6185/', running: backendRunning, async stop() { events.push('stop-conversation'); this.running = false; },
    async start() { if (this.running) return; events.push('start-conversation'); if(startFails)throw Error('synthetic backend failure'); await backendReadyWait; this.running = true; } };
  const effectiveWorkspace = workspace;
  const manager = { runtime:'synthetic-runtime',host: 'synthetic-host', inspectCalls:0, async inspect() { this.inspectCalls += 1; return { installed: true }; },
    async install() { events.push('prepare-backend'); } };
  class LocalView { constructor() { views.push(this); this.webContents={setWindowOpenHandler(){},on(){},close(){},isDestroyed:()=>false,loadURL:async url=>{loadedURLs.push(url);events.push('open-qq-management');}}; } setBounds(){} }
  const dialogs = [];
  const dialogReply = typeof dialogResponse === 'function' ? dialogResponse : () => dialogResponse;
  const electron = { session:{fromPartition:()=>({clearStorageData:async()=>{}})}, WebContentsView:LocalView, dialog:{showMessageBox:async(...args)=>{dialogs.push(args.at(-1));return {response:dialogReply()};}}, app: { setName() {}, getVersion: () => '0.3.0-alpha.8', requestSingleInstanceLock: () => true,
    whenReady: () => new Promise(() => {}), on() {} }, protocol: { registerSchemesAsPrivileged() {} } };
  const fakeServices = { ...native('./lib/services.cjs'), settingsCommand: async (_manager, command, payload) => {
    if (command === 'save') {
      events.push('save-settings'); savePayloads.push(payload);
      if (saveFails) throw Error('synthetic save failure');
      const patch = payload && payload.patch && typeof payload.patch === 'object' ? payload.patch : payload;
      if (patch && typeof patch === 'object') Object.assign(settingsState, patch);
    }
    if (command === 'history') return settingsHistory || { format: 1, records: [], migrationReceipt: null };
    if (command === 'restore-field') {
      events.push('restore-field'); restorePayloads.push(payload);
      const record = settingsHistory?.records?.find(item => item.id === payload?.recordId);
      const change = record?.changes?.find(item => item.field === payload?.field);
      if (change && 'before' in change) Object.assign(settingsState, { [payload.field]: change.before });
    }
    return { ...settingsState, qqConnectionMode:'official', dashboardPort: settingsState.dashboardPort ?? 6185 };
  } };
  const context = { require: name => name === 'electron' ? electron : name === './lib/services.cjs' ? fakeServices
    : name === 'node:fs/promises' ? {writeFile:async()=>{},rm:async()=>{}, readdir: async () => { throw Object.assign(Error(), { code: 'ENOENT' }); } } : native(name),
    __dirname: path.dirname(file), process, console, Buffer, setTimeout, clearTimeout };
  vm.runInNewContext(fs.readFileSync(file, 'utf8') + `;globalThis.hooks={perform,stopAll,publishOfficialStatus,restoreFile,refresh,getState:()=>state,requestShutdown:()=>{shutdownRequested=true;},set(values){
    state.installed=true;operations={snapshot:async()=>{}};hostCommand=async()=>{};manager=values.manager; supervisor=values.supervisor;
    window={isDestroyed:()=>false,webContents:{send:(_channel,value)=>values.snapshot(value)},contentView:{addChildView(){},removeChildView(){}},getContentSize:()=>[1220,850]};
    extensions={operation:null,run:async()=>({})};appUpdater={status:async()=>({recovery:values.recovery})};hostQueryOverride=values.hostQuery||null;if(values.workspace)workspace=values.workspace;}};`, context);
  context.hooks.set({ manager, supervisor, recovery, hostQuery, workspace: effectiveWorkspace, snapshot: value => snapshots.push(JSON.parse(JSON.stringify(value))) });
  return { ...context.hooks, events, snapshots, loadedURLs, savePayloads, restorePayloads, wirePorts, views, dialogs, supervisor, settingsState, manager };
}


test('saving a plugin toggle restarts the backend through the official host', async () => {
  const h = harness();
  await h.perform('settings-save', { biliEnabled: true });
  assert.equal(h.supervisor.running, true);
  assert.deepEqual(h.events, ['stop-conversation', 'save-settings', 'start-conversation']);
});

test('a failed settings save recovers the conversation through the official host', async () => {
  const h = harness({ saveFails: true });
  await assert.rejects(h.perform('settings-save', { biliEnabled: true }), /synthetic save failure/);
  assert.equal(h.supervisor.running, true);
  assert.equal(h.events.includes('stop-qq'), false);
  assert.equal(h.events.includes('launch-qq'), false);
});

test('backend environment preparation stops only the owned host', async () => {
  const h = harness();
  await h.perform('install');
  assert.deepEqual(h.events, ['stop-conversation', 'prepare-backend']);
});

test('models console uses the actual providers route and cache-only bundle refresh entry',async()=>{
 const h=harness();await h.perform('open-panel',{panel:'models'});
 const url=new URL(h.loadedURLs[0]);assert.equal(url.origin,'http://127.0.0.1:6185');assert.equal(url.hash,'#/providers');
 assert.ok(url.searchParams.get('astrbot_bundle')?.includes('0.3.0-alpha.8'));assert.ok(url.searchParams.get('astrbot_bundle')?.includes('4.29.3'));
});

test('official QQ startup starts its host as its only service',async()=>{
 const h=harness({backendRunning:false});
 await h.perform('start');
 assert.equal(h.supervisor.running,true);
 assert.equal(h.events.includes('launch-qq'),false);assert.equal(h.events.includes('apply-connection'),false);
 assert.ok(h.getState().workspace?.official);
});


test('restoring an official-only backup does not configure a personal component',async()=>{
 const h=harness({qqMode:'official',qqRunning:false});
 await h.restoreFile('synthetic-backup.zip');
});

test('viewing or repeating loaded settings never restarts the backend', async () => {
  const h = harness();
  const state = await h.perform('settings-save', {});
  assert.equal(state.changed, false);
  const identical = await h.perform('settings-save', { patch: { dashboardPort: 6185 } });
  assert.equal(identical.changed, false);
  assert.deepEqual(h.events, []);
  assert.deepEqual(h.savePayloads, []);
  assert.equal(h.supervisor.running, true);
});

test('changed settings carry only the patch and the loaded revision', async () => {
  const h = harness();
  const state = await h.perform('settings-save', { patch: { biliEnabled: true }, expectedRevision: 'abcdef12' });
  assert.equal(state.changed, true);
  assert.deepEqual(JSON.parse(JSON.stringify(h.savePayloads)), [{ patch: { biliEnabled: true }, expectedRevision: 'abcdef12' }]);
  assert.deepEqual(h.events, ['stop-conversation', 'save-settings', 'start-conversation']);
});

test('legacy bare patches still save through the compatibility path', async () => {
  const h = harness();
  await h.perform('settings-save', { biliEnabled: true });
  assert.deepEqual(JSON.parse(JSON.stringify(h.savePayloads)), [{ biliEnabled: true }]);
  assert.deepEqual(h.events, ['stop-conversation', 'save-settings', 'start-conversation']);
});


test('warm navigation reuses cached inspect and workspace snapshots until a mutation', async () => {
  let workspaceCalls = 0;
  const workspace = {
    async perform() {
      workspaceCalls += 1;
      return { health: { checks: [], summary: { requiredFailures: 0, warnings: 0 } }, backups: [], appUpdate: {}, official: {}, preferences: { tray: false, startAtLogin: false, resumeAfterWake: false }, diagnosticFiles: [] };
    },
  };
  const h = harness({ workspace });
  for (let index = 0; index < 50; index += 1) await h.perform('inspect');
  assert.equal(h.manager.inspectCalls, 1);
  for (let index = 0; index < 50; index += 1) await h.perform('workspace-status');
  assert.equal(workspaceCalls, 1);
  await h.perform('install');
  await h.perform('inspect');
  assert.equal(h.manager.inspectCalls, 2);
  await h.perform('workspace-status');
  assert.equal(workspaceCalls, 2);
});

test('reopening the same console reuses one bounded view and stop closes it', async () => {
  const h = harness();
  const initial = h.loadedURLs.length;
  await h.perform('open-panel', { panel: 'models' });
  assert.equal(h.views.length, 1);
  assert.equal(h.loadedURLs.length, initial + 1);
  await h.perform('open-panel', { panel: 'models' });
  assert.equal(h.views.length, 1);
  assert.equal(h.loadedURLs.length, initial + 1);
  await h.perform('open-panel', { panel: 'astrbot' });
  assert.equal(h.views.length, 2);
  assert.equal(h.loadedURLs.length, initial + 2);
  await h.perform('stop');
  assert.equal(h.snapshots.at(-1)?.panel, undefined);
});

test('a stale settings revision is rejected before the conversation stops', async () => {
  const h = harness();
  await assert.rejects(
    h.perform('settings-save', { patch: { biliEnabled: true }, expectedRevision: 'ffffffff' }),
    /另一处更新/,
  );
  assert.deepEqual(h.events, []);
  assert.deepEqual(h.savePayloads, []);
  assert.equal(h.supervisor.running, true);
});

test('a late inspect response cannot overwrite post-mutation state', async () => {
  const h = harness();
  let releaseOld;
  let calls = 0;
  h.manager.inspect = async () => {
    calls += 1;
    if (calls === 1) {
      return new Promise(resolve => {
        releaseOld = () => resolve({ installed: false, marker: 'old', components: [], needsPrepare: true });
      });
    }
    return { installed: true, marker: 'new', components: [], needsPrepare: false };
  };
  const oldRefresh = h.refresh();
  for (let attempt = 0; attempt < 50 && typeof releaseOld !== 'function'; attempt += 1) {
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(typeof releaseOld, 'function');
  await h.perform('install');
  releaseOld();
  const oldResult = await oldRefresh;
  assert.equal(oldResult.stale, true);
  assert.equal(h.getState().marker, 'new');
  assert.equal(h.getState().installed, true);
});

test('concurrent read-only queries no longer reject each other', async () => {
  let release;
  const workspace = {
    perform: async action => {
      if (action === 'workspace-status') {
        await new Promise(resolve => { release = resolve; });
        return { health: null, backups: [], appUpdate: {}, official: {}, preferences: {}, diagnosticFiles: [] };
      }
      return {};
    },
  };
  const h = harness({ workspace });
  const first = h.perform('workspace-status');
  for (let attempt = 0; attempt < 50 && typeof release !== 'function'; attempt += 1) {
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(typeof release, 'function');
  const settings = await h.perform('settings-get');
  assert.ok(settings && typeof settings === 'object');
  release();
  await first;
});

test('leaving and returning to the same console reuses the hidden view, switching rebuilds it', async () => {
  const h = harness();
  const initial = h.loadedURLs.length;
  await h.perform('open-panel', { panel: 'models' });
  assert.equal(h.views.length, 1);
  assert.equal(h.loadedURLs.length, initial + 1);
  await h.perform('home');
  assert.equal(h.getState().panel, undefined);
  assert.equal(h.views.length, 1);
  await h.perform('open-panel', { panel: 'models' });
  assert.equal(h.views.length, 1);
  assert.equal(h.loadedURLs.length, initial + 1);
  await h.perform('home');
  await h.perform('open-panel', { panel: 'astrbot' });
  assert.equal(h.views.length, 2);
  assert.equal(h.loadedURLs.length, initial + 2);
  await h.perform('stop');
  assert.equal(h.getState().panel, undefined);
});

test('settings history and per-field restore use the real payload and revision', async () => {
  const recordId = '1700000000000000000-abcdef12';
  const history = {
    format: 1,
    records: [{ id: recordId, changedAt: 1700000000, changes: [{ field: 'proactiveEnabled', before: true, after: false }] }],
    migrationReceipt: { migrationVersion: 1, archivedFields: [], verifiedAt: 1700000000 },
  };
  const h = harness({ settingsHistory: history });
  const listed = await h.perform('settings-history');
  assert.equal(listed.records[0].id, recordId);
  assert.equal(listed.migrationReceipt.migrationVersion, 1);
  const payload = { recordId, field: 'proactiveEnabled', expectedRevision: 'abcdef12' };
  const eventsBefore = h.events.length;
  await assert.rejects(
    h.perform('settings-restore-field', { ...payload, expectedRevision: 'ffffffff' }),
    /另一处更新/,
  );
  assert.equal(h.events.length, eventsBefore);
  await h.perform('settings-restore-field', payload);
  assert.deepEqual(JSON.parse(JSON.stringify(h.restorePayloads.at(-1))), payload);
  assert.equal(h.events.includes('stop-conversation'), true);
  assert.equal(h.events.includes('start-conversation'), true);
});

test('synthetic five-minute console navigation keeps one view and one load', async () => {
  const h = harness();
  const initial = h.loadedURLs.length;
  await h.perform('open-panel', { panel: 'models' });
  for (let index = 0; index < 50; index += 1) {
    await h.perform('home');
    await h.perform('open-panel', { panel: 'models' });
  }
  assert.equal(h.views.length, 1);
  assert.equal(h.loadedURLs.length, initial + 1);
});

test('settings restore rechecks the revision after the native dialog', async () => {
  let h;
  const recordId = '1700000000000000000-abcdef12';
  h = harness({
    settingsHistory: { format: 1, records: [{ id: recordId, changedAt: 1700000000, changes: [{ field: 'proactiveEnabled', before: true, after: false }] }], migrationReceipt: null },
    dialogResponse: () => { h.settingsState.configRevision = 'ffffffff'; return 1; },
  });
  const eventsBefore = h.events.length;
  await assert.rejects(
    h.perform('settings-restore-field', { recordId, field: 'proactiveEnabled', expectedRevision: 'abcdef12' }),
    /另一处更新/,
  );
  assert.deepEqual(h.restorePayloads, []);
  assert.equal(h.events.slice(eventsBefore).includes('stop-conversation'), false);
});

test('a stale connections response cannot overwrite the newer published state', async () => {
  let releaseOld;
  let statusCalls = 0;
  const h = harness({
    hostQuery: async args => {
      if (args[0] === 'status') {
        statusCalls += 1;
        if (statusCalls === 1) return new Promise(resolve => {
          releaseOld = () => resolve({ platforms: [
            { id: 'qq', type: 'aiocqhttp', enable: true, configured: true },
            { id: 'official-test', type: 'qq_official', enable: true, configured: true },
          ] });
        });
        return { platforms: [
          { id: 'qq', type: 'aiocqhttp', enable: true, configured: true },
          { id: 'official-test', type: 'qq_official', enable: false, configured: true },
        ] };
      }
      if (args[0] === 'pending') return { pending: false };
      return {};
    },
  });
  const oldCall = h.perform('connections-status');
  for (let attempt = 0; attempt < 50 && typeof releaseOld !== 'function'; attempt += 1) await new Promise(resolve => setImmediate(resolve));
  assert.equal(typeof releaseOld, 'function');
  await h.perform('stop');
  const fresh = await h.perform('connections-status');
  assert.equal(fresh.connections.channels.find(item => item.channel === 'official').platformEnabled, false);
  releaseOld();
  await assert.rejects(oldCall, /状态已更新|退出/);
  const finalConnections = h.getState().connections;
  assert.equal(finalConnections.channels.find(item => item.channel === 'official').platformEnabled, false);
  assert.equal(finalConnections.revision, fresh.connections.revision);
});
