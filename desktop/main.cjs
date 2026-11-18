'use strict';
const { app, BrowserWindow, WebContentsView, ipcMain, protocol, net, session, dialog, shell, clipboard, Tray, Menu, nativeImage, nativeTheme, powerMonitor } = require('electron');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs/promises');
const { pathToFileURL, URL } = require('node:url');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { RuntimeManager, SetupError, runBounded } = require('./lib/runtime.cjs');
const { validateRequest, permittedNavigation, biliURL, consolePopupTarget } = require('./lib/security.cjs');
const officialConnection = require('./lib/official-connection.cjs');
const { ServiceSupervisor, settingsCommand, replyStylePreview, readConnectionHealth } = require('./lib/services.cjs');
const { ExtensionRunner, runExtensionAction } = require('./lib/extensions.cjs');
const { Operations } = require('./lib/operations.cjs');
const { Workspace, WORKSPACE_ACTIONS } = require('./lib/workspace.cjs');
const { AppUpdater, UpdateError } = require('./lib/app-updater.cjs');
const runtimeLockModule = require('./lib/runtime-lock.cjs');
const { normalizeVersion } = require('./lib/update-protocol.cjs');
const updateChain = require('./lib/update-chain.cjs');
const { UpdateScheduler } = require('./lib/update-scheduler.cjs');
const { Preferences, PreferencesError } = require('./lib/preferences.cjs');
const { DiagnosticsError } = require('./lib/diagnostics.cjs');
const { readNetworkConfig, createElectronTransport, systemProxyURL, NetworkError } = require('./lib/network.cjs');
const { StatusCache } = require('./lib/status-cache.cjs');
const { VisibilityMonitor } = require('./lib/visibility-monitor.cjs');
const windowChrome = require('./lib/window-chrome.cjs');
const { Appearance, AppearanceError } = require('./lib/appearance.cjs');
const consoleLayout = require('./lib/console-layout.cjs');
const branding = require('./lib/branding.cjs');
const macMigration = require('./lib/mac-migration.cjs');
class UserActionError extends Error {}

app.setName('DWhale');
// Display name changes, but existing DSWhale accounts/personas/memory must stay in place.
if (!app.isPackaged && process.env.DSWHALE_DESKTOP_TEST_DATA) app.setPath('userData', path.resolve(process.env.DSWHALE_DESKTOP_TEST_DATA));
else if (typeof app.getPath === 'function') app.setPath('userData', path.join(app.getPath('appData'), 'DSWhale'));
if (process.platform === 'win32') app.setAppUserModelId('dev.dswhale.desktop');
protocol.registerSchemesAsPrivileged([{ scheme: 'dswhale', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
let operations, appUpdater, updateScheduler, workspace, preferenceStore, appearanceStore, tray, preferences = {tray:false,startAtLogin:false,resumeAfterWake:false}, installerHandedOff = false, installerExitScheduled = false;
let window, panelView, panelKey = '', panelGeneration = 0, panelAttached = false, manager, supervisor, extensions, quitting = false, shutdownRequested = false, activeAction, startupInProgress = false, startupOperation, externalConnectionMonitor;
let systemSuspended = false, stateDeliveryPending = false;
const activeCommands = new Set();
const statusCache = new StatusCache({ ttl: 2500 });
const READ_ONLY_ACTIONS = new Set(['inspect', 'home', 'settings-get', 'workspace-status', 'backup-list', 'extensions-status', 'connections-status', 'settings-history', 'reply-style-preview', 'appearance-get']);
const CONCURRENT_READ_ACTIONS = new Set(['settings-get', 'workspace-status', 'backup-list', 'connections-status', 'settings-history', 'reply-style-preview', 'appearance-get']);
let state = { version: app.getVersion(), platform: { id: '', label: '本机', supported: true, detail: '' }, chrome: windowChrome.chromeFor(process.platform), appearance: { format: 1, material: 'frosted', revision: 0 }, phase: 'idle', installed: false, running: false, components: [], setup: { ownerConfigured: false, qqConfigured: false, modelConfigured: false, memoryConfigured: false, biliEnabled: false } };
function visibleWindow() {
  return window && !window.isDestroyed() && window.isVisible?.() !== false && window.isMinimized?.() !== true;
}
function deliverState() {
  if (shutdownRequested || systemSuspended || !visibleWindow()) { stateDeliveryPending = true; return; }
  window.webContents.send('dswhale:state', state);
  stateDeliveryPending = false;
}
function publish(patch = {}) {
  if (!Object.keys(patch).some(key => !Object.hasOwn(state, key) || !isDeepStrictEqual(state[key], patch[key]))) return state;
  state = { ...state, ...patch };
  deliverState();
  return state;
}
function syncConnectionMonitor(refreshNow = false) {
  const active = !shutdownRequested && !systemSuspended && Boolean(visibleWindow());
  externalConnectionMonitor?.setActive(active);
  if (active && stateDeliveryPending) deliverState();
  if (active && refreshNow) void externalConnectionMonitor?.refresh();
}
function platformTarget(platforms, type, boundId) {
  const candidates = Array.isArray(platforms) ? platforms.filter(item => item && item.type === type) : [];
  if (boundId) {
    const matches = candidates.filter(item => item.id === boundId);
    return matches.length === 1 ? matches[0] : null;
  }
  return candidates.length === 1 ? candidates[0] : null;
}
async function officialHealthStatus(configured = false) {
  let protocolConnected = false;
  let gatewayBlocked = false;
  try {
    const health = await readConnectionHealth({ host: manager.host, running: supervisor.running, startedAt: supervisor.startedAt || 0 });
    protocolConnected = health.channels.official.state === 'connected';
    gatewayBlocked = health.channels.official.state === 'blocked';
  } catch {}
  return { configured, protocolConnected, ...(gatewayBlocked ? { gatewayBlocked } : {}) };
}
function publishOfficialStatus(patch, completeStartup = false) {
  const startup = { stage: supervisor?.running ? patch?.protocolConnected ? 'ready' : 'official-connecting' : 'stopped' };
  return publish({ workspace: { ...state.workspace, official: patch },
    ...(!startupInProgress || completeStartup ? { startup } : {}) });
}
function closePanel() {
  panelGeneration += 1;
  if (panelView) { if (window && !window.isDestroyed() && panelAttached) window.contentView.removeChildView(panelView); panelView.webContents.close(); panelView = null; }
  panelKey = '';
  panelAttached = false;
  publish({ panel: undefined });
}
function hidePanel() {
  if (panelView && window && !window.isDestroyed() && panelAttached) {
    window.contentView.removeChildView(panelView);
    panelAttached = false;
  }
  publish({ panel: undefined });
}
function resizePanel() {
  if (panelView && window) {
    const [width, height] = window.getContentSize();
    // Shared contract with the renderer: the console starts below the native
    // window chrome and its own 52px toolbar, never below the removed 94px bar.
    const bounds = windowChrome.panelBounds({ width, height });
    panelView.setBounds(bounds);
  }
}
async function inspectSnapshot() {
  if (!supervisor.running && !extensions.operation) {
    let pending = false;
    try { pending = (await fs.readdir(path.join(manager.host, '.dswhale-extensions'))).some(name => name.endsWith('-transaction.json')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (pending) await extensions.run('status');
  }
  const result = await manager.inspect();
  let setup = state.setup;
  if (result.installed) { try { setup = await settingsCommand(manager, 'status'); } catch {} }
  return { ...result, setup, qqConnectionMode: 'official', running: supervisor.running, phase: result.installed ? 'ready' : 'idle' };
}
async function cachedRead(key, loader, options = {}) {
  const result = await statusCache.request(key, loader, options);
  if (result.status === 'ok') return result.value;
  if (result.status === 'closed' || shutdownRequested || statusCache.closed) {
    throw new UserActionError('应用正在退出');
  }
  // A stale result never starts an unarbitrated fallback read: the caller must
  // not publish an old snapshot after a newer generation has won.
  const error = new UserActionError('状态已更新，请重新读取');
  error.stale = true;
  throw error;
}
async function refresh() {
  const result = await statusCache.request('inspect', inspectSnapshot);
  if (result.status !== 'ok' || shutdownRequested || statusCache.closed || statusCache.peek('inspect') !== result.value) {
    return { ...state, stale: true };
  }
  return publish(result.value);
}
async function openPanel(panel) {
  if (!supervisor.running) throw new UserActionError('请先启动对话服务');
  let url = await supervisor.dashboard();
  if (panel === 'bilibili') {
    const file = path.join(manager.host, 'data/plugin_data/astrbot_plugin_dswhale/bilibili/control.json');
    let control;
    for (let count = 0; count < 50; count++) {
      try { if ((await fs.stat(file)).mtimeMs >= supervisor.startedAt - 2000) { control = JSON.parse(await fs.readFile(file, 'utf8')); break; } } catch {}
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    url = biliURL(control);
  }
  if (panel !== 'bilibili') {
    const entry = new URL(url);
    // The managed core handles this identity with cache-only invalidation;
    // cookies/storage stay intact. Match the pinned AstrBot runtime matrix.
    entry.searchParams.set('astrbot_bundle', `${app.getVersion()}-astrbot-${appUpdater?.matrix?.astrbot || '4.29.3'}`);
    if (panel === 'models') entry.hash = '/providers';
    if (panel === 'persona') entry.hash = '/persona';
    if (panel === 'qq') entry.hash = '/platforms';
    url = entry.toString();
  }
  const nextKey = [panel, url, panel === 'bilibili' ? 'bili' : 'console'].join('|');
  if (panelView && panelKey === nextKey && !panelView.webContents.isDestroyed()) {
    if (!panelAttached) { window.contentView.addChildView(panelView); panelAttached = true; resizePanel(); }
    publish({ panel }); return;
  }
  closePanel();
  const generation = ++panelGeneration;
  const partition = panel==='bilibili'?'persist:dswhale-bili-console':'persist:dswhale-consoles';
  const view = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, partition } });
  panelView = view; panelKey = nextKey;
  view.webContents.setWindowOpenHandler(details => {
    if (panelView !== view || generation !== panelGeneration) return { action: 'deny' };
    const target = consolePopupTarget(details.url, url);
    if (target) view.webContents.loadURL(target).catch(() => { if (panelView === view && generation === panelGeneration) publish({ error: '页面暂时无法打开，请重试' }); });
    return { action: 'deny' };
  });
  const restrict = (event, target) => { if (!permittedNavigation(target, url)) event.preventDefault(); };
  view.webContents.on('will-navigate', restrict); view.webContents.on('will-redirect', restrict);
  if (panel !== 'bilibili') view.webContents.on('dom-ready', () => {
    if (panelView !== view || generation !== panelGeneration || view.webContents.isDestroyed() || !permittedNavigation(view.webContents.getURL(), url)) return;
    // Apply the scoped layout again after each real dashboard document load.
    view.webContents.insertCSS(consoleLayout).catch(() => {});
  });
  view.webContents.on('render-process-gone', () => { if (panelView === view && generation === panelGeneration) closePanel(); });
  window.contentView.addChildView(view); panelAttached = true; resizePanel();
  publish({ panel });
  try { await view.webContents.loadURL(url); }
  catch { if (panelView === view && generation === panelGeneration) closePanel(); throw new UserActionError('页面尚未就绪，请稍后重试'); }
}
async function backup() {
  if (!state.installed) throw new UserActionError('请先完成环境安装');
  const selected = await dialog.showSaveDialog(window, { title: '保存私人备份（包含账号配置和记忆）', defaultPath: `DWhale-backup-${new Date().toISOString().slice(0, 10)}.zip`, filters: [{ name: 'ZIP 备份', extensions: ['zip'] }] });
  if (selected.canceled) return { canceled: true };
  const wasRunning = supervisor.running; await stopAll();
  try {
    await snapshotTo(selected.filePath);
    return { saved: true };
  } finally { if (wasRunning && !shutdownRequested) await startAll(); }
}
async function snapshotTo(file) {
  await settingsCommand(manager, 'prepare-backup');
  try { await hostCommand(['backup', '--astrbot-dir', manager.host, file]); }
  finally { await settingsCommand(manager, 'finish-backup').catch(() => {}); }
}
async function hostCommand(args) {
  const environment = await manager.environment();
  if (shutdownRequested) throw new UserActionError('应用正在退出');
  return new Promise((resolve, reject) => {
    const child = spawn(manager.python, ['-m', 'dswhale', ...args], { cwd: manager.host, env: environment, windowsHide: true, stdio: 'ignore' });
    activeCommands.add(child);
    const timer = setTimeout(() => child.kill(), 120000);
    const cleanup = () => { clearTimeout(timer); activeCommands.delete(child); };
    child.once('error', () => { cleanup(); reject(new Error('数据操作未完成，请检查保存目录和备份格式')); });
    child.once('close', code => { cleanup(); code === 0 ? resolve() : reject(new Error('数据操作未完成，原数据或操作前的备份会保留')); });
  });
}
async function stopAll() { closePanel(); await supervisor.stop(); }
async function stopConversation() { closePanel(); await supervisor.stop(); publish({ running: false, startup: { stage: 'stopped' } }); }
function startAll() {
  if (startupOperation) return startupOperation;
  const pending = startServices().finally(() => { if (startupOperation === pending) startupOperation = null; });
  startupOperation = pending; return pending;
}
function settingsEnvelope(payload) {
  if (payload && typeof payload === 'object' && Object.hasOwn(payload, 'patch')) return { patch: payload.patch || {}, expectedRevision: payload.expectedRevision };
  return { patch: payload && typeof payload === 'object' ? payload : {}, expectedRevision: undefined };
}
function settingsPatchChanged(before, patch) {
  return Object.keys(patch || {}).some(key => JSON.stringify(patch[key]) !== JSON.stringify(before?.[key]));
}
let hostQueryOverride = null;
function assertAlive() {
  if (shutdownRequested) throw new UserActionError('应用正在退出');
}
async function confirmDestructiveAction({ title, message, detail }) {
  assertAlive();
  const result = await dialog.showMessageBox(window, {
    type: 'warning', title, message, detail,
    buttons: ['取消', '确认'], defaultId: 0, cancelId: 0, noLink: true,
  });
  if (!result || result.response !== 1) return false;
  assertAlive();
  return true;
}
async function queryHost(args, timeout = 20000) {
  if (hostQueryOverride) return hostQueryOverride(args);
  const environment = await manager.environment();
  if (shutdownRequested) throw new UserActionError('应用正在退出');
  const bytes = await runBounded(manager.python, ['-m', 'dswhale.platform_manager', ...args], { env: environment, cwd: manager.host, timeout, maxBytes: 65536 });
  return JSON.parse(bytes.toString('utf8'));
}
async function connectionPlatforms() {
  try { const value = await queryHost(['status', '--host', manager.host]); return Array.isArray(value?.platforms) ? value.platforms : []; }
  catch { return []; }
}
async function connectionSnapshot() {
  const settings = await settingsCommand(manager, 'read');
  const [platforms, health] = await Promise.all([
    connectionPlatforms(),
    readConnectionHealth({ host: manager.host, running: supervisor.running, startedAt: supervisor.startedAt || 0 }),
  ]);
  return officialConnection.snapshot({ platforms, health,
    bindings: { official: settings.officialBound === true },
    boundPlatformIds: { official: settings.officialBoundPlatformId || '' } });
}
async function startServices() {
  const stillOpen = () => { if (shutdownRequested) throw new UserActionError('应用正在退出，启动已取消'); };
  stillOpen();
  if (!state.installed) throw new UserActionError('请先准备运行环境');
  const recovery = appUpdater ? (await appUpdater.status()).recovery : null;
  if (recovery?.servicesMustRemainStopped) throw new UserActionError('更新或回退尚未完成，请先在应用设置中修复并体检');
  // Publish a real phase before the readiness probes below: extensions.run("status")
  // and the settings read can take several seconds, and the renderer must show
  // what the main process is actually doing during that window.
  const hostWasRunning = supervisor.running === true;
  let startAttempted = false;
  startupInProgress = true;
  publish({ startup: { stage: supervisor.running ? 'checking-qq' : 'starting-conversation' }, error: undefined });
  let connectionSettings = null;
  try {
    await extensions.run('status');
    if (shutdownRequested) throw new UserActionError('应用正在退出');
    connectionSettings = await settingsCommand(manager, 'read'); stillOpen();
    publish({ qqConnectionMode: 'official' });
    if (!hostWasRunning) { await settingsCommand(manager, 'migrate'); stillOpen(); }
    startAttempted = true;
    await supervisor.start();
    stillOpen();
    publish({ running: true, startup: { stage: 'checking-qq' } });
    const platforms = await connectionPlatforms().catch(() => null);
    const officialTarget = platforms ? platformTarget(platforms, 'qq_official', connectionSettings.officialBoundPlatformId) : null;
    publishOfficialStatus(await officialHealthStatus(Boolean(officialTarget?.enable)), true); stillOpen();
    return await refresh();
  } catch (error) {
    // Only unwind what this invocation actually owns. A readiness probe can fail
    // before supervisor.start(); a warm start must leave the already-running
    // host untouched, and must report the real state.
    if (startAttempted && !hostWasRunning && typeof supervisor.stop === 'function') await supervisor.stop();
    publish({ running: Boolean(supervisor.running), startup: { stage: 'failed' } });
    throw error;
  } finally { startupInProgress = false; }
}
async function restoreFile(file, {rebuild = true} = {}) {
  if (!state.installed) throw new UserActionError('请先准备运行环境，再导入自己的备份');
  await stopAll();
  publish({phase:'installing',step:'备份当前数据并恢复所选配置',progress:null,error:undefined});
  await operations.snapshot({reason:'import'});
  await fs.writeFile(path.join(manager.runtime,'desktop-install.json'),JSON.stringify({version:'needs-import-repair'}));
  await hostCommand(['restore','--astrbot-dir',manager.host,file]);
  await settingsCommand(manager,'prepare-import');
  await fs.rm(path.join(manager.runtime,'.desktop-auth.pending.json'),{force:true});
  await session.fromPartition('persist:dswhale-consoles').clearStorageData();
  if (rebuild) { await manager.install(); if(shutdownRequested)throw new UserActionError('应用正在退出'); await refresh(); }
  return {restored:true};
}
async function restore() {
  const selected = await dialog.showOpenDialog(window,{title:'导入自己创建的 DWhale ZIP 备份',properties:['openFile'],filters:[{name:'DWhale ZIP 备份',extensions:['zip']}]});
  if (selected.canceled || !selected.filePaths.length) return {canceled:true};
  // A backup is a trusted artefact: it replaces data/ and any plugin code inside
  // runs the next time services start. Make that an explicit confirmation.
  const confirm = await dialog.showMessageBox(window,{type:'warning',title:'确认导入备份',message:'备份会替换当前数据，其中的插件代码会在下次启动服务时加载',detail:'请只导入你本人创建的 DWhale 备份；来源不明的备份可能包含会运行的插件代码。',buttons:['继续导入','取消'],defaultId:1,cancelId:1});
  if (confirm.response !== 0) return {canceled:true};
  return restoreFile(selected.filePaths[0]);
}
function showWindow() { if (window && !window.isDestroyed()) { window.show(); if(window.isMinimized())window.restore();window.focus(); } }
function applyPreferences(value) {
  preferences=value;
  if(!value.tray) { tray?.destroy();tray=null;return; }
  if(!tray) { const icon=process.platform==='darwin' ? nativeImage.createFromPath(path.join(__dirname,'assets/trayTemplate.png')) : nativeImage.createFromPath(path.join(__dirname,'assets/icon.png')).resize({width:20,height:20}); if(process.platform==='darwin')icon.setTemplateImage(true); tray=new Tray(icon);tray.setToolTip('DWhale');tray.on('click',showWindow); }
  tray.setContextMenu(Menu.buildFromTemplate([{label:'打开 DWhale',click:showWindow},{label:'启动对话与 QQ',click:()=>perform('start').catch(()=>publish({error:'启动未完成，请打开窗口查看体检结果'}))},{label:'停止对话服务',click:()=>perform('stop').catch(()=>{})},{type:'separator'},{label:'退出',click:()=>app.quit()}]));
}
function scheduleInstallerExit() {
  if (!installerHandedOff || installerExitScheduled) return;
  installerExitScheduled = true;
  setTimeout(() => app.quit(), 500);
}
async function finishPendingUpdate() {
  if(activeAction||shutdownRequested)return;
  // A signed bridge installer fixed one exact schema2 target before it ran.
  // Continue that bounded chain before any normal update/verification path and
  // before services or login state are touched.
  const chain=appUpdater.transitionLock;
  if(chain&&normalizeVersion(chain.bridge?.version)===normalizeVersion(app.getVersion())){
    // A fresh bridge with no old-updater handoff state must not create a new
    // install intent from the packaged description alone.
    const pending=await appUpdater.status().catch(()=>null);
    const resumable=['awaiting-verification','downloading','downloaded','install-ready'];
    if(!pending||!resumable.includes(pending.phase))return;
    activeAction='install';
    try{await appUpdater.continueTransition({automatic:true});scheduleInstallerExit();publish({phase:'install-launched'});}
    catch{publish({phase:'error',error:'[UPD-001] 更新衔接未完成，备份已保留，请重试或回退到原版本'});}
    finally{activeAction=null;}
    return;
  }
  const status=await appUpdater.status();
  if(!['awaiting-verification','awaiting-rollback-verification'].includes(status.phase))return;
  activeAction='install';
  try { await manager.install();await refresh();const health=await operations.health();await appUpdater.completeVerification({healthy:health.summary.requiredFailures===0});publish({error:health.summary.requiredFailures?'[UPD-001] 更新后的体检未通过，请在应用设置查看恢复选项':undefined}); }
  catch { await appUpdater.completeVerification({healthy:false}).catch(()=>{});publish({phase:'error',error:'[UPD-001] 更新准备未完成，备份已保留，请重试修复或回退'}); }
  finally {activeAction=null;}
}
async function perform(action, payload) {
  if (shutdownRequested) throw new UserActionError('应用正在退出');
  if (action === 'inspect') return activeAction ? state : refresh();
  if (action === 'home') { hidePanel(); return state; }
  if (action === 'settings-get') return cachedRead('settings', () => settingsCommand(manager, 'read'));
  if (action === 'appearance-get') return appearanceStore.read();
  if (action === 'appearance-save') { const next = await appearanceStore.save(payload?.material); publish({ appearance: next }); return next; }
  if (action === 'reply-style-preview') {
    if (!payload || typeof payload.text !== 'string' || payload.text.length > 8192) throw new UserActionError('预览文本不能超过 8192 个字符');
    return await replyStylePreview(manager, payload);
  }
  if (action === 'settings-history') { if (!state.installed) throw new UserActionError('请先准备运行环境'); return cachedRead('settings-history', () => settingsCommand(manager, 'history')); }
  const concurrentRead = CONCURRENT_READ_ACTIONS.has(action);
  if (activeAction) throw new UserActionError('当前操作尚未完成，请稍候');
  if (!READ_ONLY_ACTIONS.has(action)) statusCache.invalidate();
  const ownsAction = !concurrentRead;
  if (ownsAction) activeAction = action;
  try {
    // Metadata checks never claim activeAction. Conflicting updater mutations
    // cancel and settle that check while retaining the normal action fence.
    if (action.startsWith('app-update-') || action === 'install') await updateScheduler?.cancel();
    if (WORKSPACE_ACTIONS.has(action)) {
      if (action === 'workspace-status') return cachedRead('workspace', () => workspace.perform(action, payload));
      const result = await workspace.perform(action, payload);
      return result;
    }
    if (action === 'extensions-status' || action.startsWith('extension-')) {
      if (!state.installed) throw new UserActionError('请先准备运行环境');
      return await runExtensionAction({ runner: extensions, supervisor, closePanel, publish, refresh, isClosing: () => shutdownRequested }, action === 'extensions-status' ? 'status' : action.slice(10), payload?.id);
    }
    if (action === 'install') { if(appUpdater?.transitionLock){const pending=await appUpdater.status();if(!['awaiting-verification','downloading','downloaded','install-ready'].includes(pending.phase))throw new UserActionError('当前没有可继续的更新；请重新检查更新。');await appUpdater.continueTransition();scheduleInstallerExit();return state;} const prior=appUpdater?await appUpdater.status():null; if(prior?.recovery?.servicesMustRemainStopped)await stopAll();else await stopConversation(); await manager.install(); await refresh(); const pending=appUpdater?await appUpdater.status():null; if(pending?.recovery?.requiresHealthVerification){const health=await operations.health();await appUpdater.completeVerification({healthy:health.summary.requiredFailures===0});} return state; }
    if (action === 'start') return await startAll();
    if (action === 'stop') { await stopConversation();return publish({running:false,error:undefined}); }
    if (action === 'open-panel') { await openPanel(payload.panel); return state; }
    if (action === 'settings-save') {
      const before = await settingsCommand(manager, 'read');
      const { patch, expectedRevision } = settingsEnvelope(payload);
      // Repeating a loaded form must not write files, create backups or restart services.
      if (!settingsPatchChanged(before, patch)) return { ...before, changed: false };
      if (expectedRevision !== undefined && expectedRevision !== before.configRevision) {
        // Stale saves must not interrupt the host or write files.
        throw new UserActionError('设置已在另一处更新，请刷新并核对本次修改后重试');
      }
      const wasRunning = supervisor.running; await stopConversation();
      let result = null;
      try {
        result = await settingsCommand(manager, 'save', expectedRevision === undefined ? patch : { patch, expectedRevision });
      } finally {
        if (wasRunning && !shutdownRequested) await startAll();
        if (!shutdownRequested) await refresh();
      }
      return { ...result, changed: true };
    }
    if (action === 'connections-status') {
      if (!state.installed) throw new UserActionError('请先准备运行环境');
      const connections = await cachedRead('connections', connectionSnapshot, { ttl: 2000 });
      publish({ connections });
      return { connections };
    }
    if (action === 'settings-restore-field') {
      assertAlive();
      if (!state.installed) throw new UserActionError('请先准备运行环境');
      const before = await settingsCommand(manager, 'read');
      if (payload.expectedRevision !== before.configRevision) {
        throw new UserActionError('设置已在另一处更新，请刷新并核对本次修改后重试');
      }
      const confirmed = await confirmDestructiveAction({
        title: '恢复本机设置',
        message: '确认恢复这一项设置？',
        detail: `将把「${payload.field}」恢复到本地历史值；对话服务会重启。`,
      });
      if (!confirmed) return { canceled: true };
      assertAlive();
      const afterDialog = await settingsCommand(manager, 'read');
      if (payload.expectedRevision !== afterDialog.configRevision) {
        throw new UserActionError('设置已在另一处更新，请刷新并核对本次修改后重试');
      }
      assertAlive();
      const wasRunning = supervisor.running;
      await stopConversation();
      let result = null;
      try {
        result = await settingsCommand(manager, 'restore-field', payload);
      } finally {
        if (wasRunning && !shutdownRequested) await startAll();
        if (!shutdownRequested) await refresh();
      }
      publish({ notice: '设置项已恢复。' });
      return { ...result, changed: true };
    }
    if (action === 'open-data') { await fs.mkdir(manager.runtime, { recursive: true }); const error = await shell.openPath(manager.runtime); if (error) throw new UserActionError('无法打开数据目录'); return {}; }
    if (action === 'initial-login') {
      const file = path.join(manager.runtime, 'desktop-auth.json');
      let value;
      try {
        value = JSON.parse(await fs.readFile(file, 'utf8'));
        const config = JSON.parse((await fs.readFile(path.join(manager.host, 'data/cmd_config.json'), 'utf8')).replace(/^\uFEFF/, ''));
        if (!config.dashboard?.password_change_required) { await fs.rm(file, { force: true }); value = null; }
      } catch { value = null; }
      if (!value || typeof value.username !== 'string' || typeof value.password !== 'string' || value.password.length < 16 || value.password.length > 256) {
        await dialog.showMessageBox(window, { type: 'info', message: '请使用你已设置的控制台账户与密码', detail: '已有安装沿用原密码。修改密码后，首次安装口令不会继续显示。', buttons: ['知道了'] });
        return {};
      }
      const choice = await dialog.showMessageBox(window, { type: 'info', title: '首次登录控制台', message: `用户名：${value.username}`, detail: `临时口令：${value.password}\n\n首次登录后，请按页面提示设置自己的密码。此口令仅保存在这台电脑，不会上传。`, buttons: ['复制口令', '关闭'], defaultId: 1, cancelId: 1 });
      if (choice.response === 0) clipboard.writeText(value.password);
      return {};
    }
    if (action === 'backup') return await backup();
    if (action === 'restore') return await restore();
  } finally {
    // publish() sends the whole main state. Keep its updater snapshot current so
    // later service events cannot replace the renderer's newer manual result.
    if (action.startsWith('app-update-') || action === 'install') {
      try { publish({appUpdate:await appUpdater.status()}); } catch {}
    }
    if (ownsAction) activeAction = null;
  }
}
async function reportActionError(error, action) {
  const safe=error instanceof UserActionError||error instanceof UpdateError||error instanceof NetworkError||error instanceof SetupError||error instanceof PreferencesError||error instanceof DiagnosticsError||error instanceof AppearanceError||error?.code==='PORT-001';
  const code=error instanceof UpdateError?'UPD-001':error instanceof NetworkError?'NET-001':error?.code==='PORT-001'?'PORT-001':'APP-001';
  const message=`[${code}] ${safe?error.message:'操作未完成，请重新检查状态或导出诊断'}`;
  // Reporting must never replace the user-facing action error: the event log or
  // the operations object may be unavailable during an early failure.
  try { await operations?.events?.write({component:error instanceof UpdateError?'update':'app',action:['start','stop','install','restore'].includes(action)?action:'check',code}); } catch {}
  if (action === 'appearance-save' || action === 'appearance-get') return message;
  const feedback={kind:READ_ONLY_ACTIONS.has(action)?'warning':'error',scope:READ_ONLY_ACTIONS.has(action)?(action==='settings-get'?'settings':'workspace'):'action',code,message,retryable:true,active:true,operationId:crypto.randomBytes(8).toString('hex')};
  if(READ_ONLY_ACTIONS.has(action)){
    const patch=action==='settings-get'?{settingsWarning:message}:{workspaceWarning:message};
    publish({...patch,feedback});
  } else {
    publish({error:message,feedback,...(['install','restore'].includes(action)?{phase:'error',installed:false,progress:null}:{})});
  }
  return message;
}
async function adoptPackagedTransitionLock(source) {
  const packaged = path.join(source, 'transition-lock.json');
  let raw;
  try { raw = await fs.readFile(packaged); } catch { return null; }
  let candidate;
  try {
    candidate = updateChain.validate(JSON.parse(raw.toString('utf8')));
    if (normalizeVersion(candidate.bridge.version) !== normalizeVersion(app.getVersion())) return null;
  } catch { publish({ error: '[UPD-001] 更新衔接信息无效，原版本与备份保持不变' }); return null; }
  const directory = path.join(app.getPath('userData'), 'runtime', 'app-updates');
  const file = path.join(directory, 'transition-lock.json');
  // A packaged description is only authoritative after the old updater
  // actually launched this bridge. Without that pending-update record a
  // fresh install must not acquire a continuation intent.
  let intent;
  try { intent = JSON.parse(await fs.readFile(path.join(directory, 'state.json'), 'utf8')); } catch { return null; }
  const phase = String(intent?.phase || '');
  if (!['install-launched','awaiting-verification','downloading','downloaded','install-ready'].includes(phase)
    || intent?.direction === 'rollback') return null;
  let intentTarget;
  try { intentTarget = normalizeVersion(intent.targetVersion); } catch { return null; }
  if (intentTarget !== normalizeVersion(candidate.bridge.version)
    && intentTarget !== normalizeVersion(candidate.fixedFinalTarget.version)) return null;
  try {
    const existing = updateChain.parse(await fs.readFile(file));
    if (existing.chainId === candidate.chainId
      && JSON.stringify(existing.fixedFinalTarget) === JSON.stringify(candidate.fixedFinalTarget)
      && existing.bridge.version === candidate.bridge.version) return existing;
    const archived = path.join(directory, `transition-lock.abandoned-${Date.now()}.json`);
    await fs.rename(file, archived);
  } catch {}
  try {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${file}.tmp`;
    await fs.writeFile(temporary, raw, { mode: 0o600 });
    await fs.rename(temporary, file);
  } catch { publish({ error: '[UPD-001] 更新衔接信息无法写入，请重试' }); return null; }
  return candidate;
}
async function migrateLegacyMacBundle() {
  await macMigration.migrateLegacyBundles({
    currentBundle: path.resolve(path.dirname(process.execPath), '..', '..'),
    home: app.getPath('home'),
    userData: app.getPath('userData'),
    dialog,
    shell,
    branding,
    packaged: app.isPackaged,
  });
}

function applyNativeControlColors() {
  if (process.platform !== 'win32' || !window || typeof window.setTitleBarOverlay !== 'function') return;
  try { window.setTitleBarOverlay(windowChrome.titleBarOverlay(nativeTheme.shouldUseDarkColors)); } catch {}
}

async function createWindow() {
  const source = app.isPackaged ? path.join(process.resourcesPath, 'backend') : path.resolve(__dirname, '..');
  const downloadSession=session.fromPartition('persist:dswhale-downloads');
  const transport=createElectronTransport(downloadSession);
  manager = new RuntimeManager({ source, runtime: path.join(app.getPath('userData'), 'runtime'), fetch:transport,proxyResolver:()=>systemProxyURL(downloadSession),onProgress: patch => publish(patch) });
  extensions = new ExtensionRunner(manager);
  supervisor = new ServiceSupervisor({ manager, onChange: patch => { if (!patch.running && panelView) closePanel(); publish(patch); syncConnectionMonitor(true); } });
  // Runtime activation is committed by bootstrap.prepare() after its staged
  // post-activation verification, before the install action returns. A later
  // cold-start failure (for example a busy port) must not roll the host back:
  // the UI may already have saved settings into the new generation.
  preferenceStore=new Preferences({userData:app.getPath('userData'),app});
  operations=new Operations({manager,supervisor,snapshotTo});
  const distro={};if(process.platform==='linux'){try{for(const line of(await fs.readFile('/etc/os-release','utf8')).split('\n')){const m=line.match(/^(ID|VERSION_ID)=["']?([^"']+)["']?$/);if(m)distro[m[1]]=m[2];}}catch{}}
  let runtimeLock=null;
  try { runtimeLock=runtimeLockModule.load(path.join(source,'runtime-lock.json')); } catch {}
  const transitionLock=await adoptPackagedTransitionLock(source);
  appUpdater=new AppUpdater({runtime:manager.runtime,currentVersion:app.getVersion(),distro,runtimeLock,transitionLock,
    fetch:async(url,options)=>transport(url,{...options,network:await readNetworkConfig(manager.runtime)}),
    download:async(asset,file,options)=>require('./lib/runtime.cjs').downloadVerified(asset,file,{...options,fetch:transport,network:await readNetworkConfig(manager.runtime)}),
    stopServices:stopAll,snapshot:({reason})=>operations.snapshot({reason:reason.includes('rollback')?'rollback':'update'}),
    restoreSnapshot:async(id)=>restoreFile(await operations.backupFile(id),{rebuild:false}),
    launchInstaller:async({file,signal})=>{if(process.platform==='win32'){if(!app.isPackaged)throw new UserActionError('开发环境请使用官方安装包');await require('./lib/installer.cjs').launchWindowsUpdate({file,exePath:app.getPath('exe'),signal});}else{const error=await shell.openPath(file);if(error)throw new UserActionError('安装程序未打开，请重试；备份已保留');}installerHandedOff=true;},
    onProgress:patch=>publish({appUpdateProgress:patch.progress})});
  workspace=new Workspace({manager,operations,appUpdater,preferences:preferenceStore,
    isInstalled:()=>state.installed,isClosing:()=>shutdownRequested,stopServices:stopAll,getState:()=>state,restoreFile,trash:file=>shell.trashItem(file),applyPreferences,
    chooseDiagnostic:async()=>{const preview=await dialog.showMessageBox(window,{type:'info',message:'导出诊断元信息',detail:'包含 health.json、events.json、versions.json、README.txt。只记录版本、状态和事件代码，不包含账号、路径、聊天、记忆、人格、密钥或原始日志。',buttons:['继续保存','取消'],defaultId:1,cancelId:1});if(preview.response!==0)return null;const choice=await dialog.showSaveDialog(window,{defaultPath:'DWhale-diagnostics.zip',filters:[{name:'诊断 ZIP',extensions:['zip']}]});return choice.canceled?null:choice.filePath;},
    confirmUpdate:async version=>{const answer=await dialog.showMessageBox(window,{type:'info',title:'覆盖安装更新',message:`DWhale ${version} 已准备好`,detail:process.platform==='win32'?'将备份数据、关闭应用并覆盖安装到当前目录，无需重新选择位置。原有配置、聊天、记忆和 QQ 设备数据会保留。':'将备份数据并打开系统安装程序。请按系统提示覆盖原应用，个人数据会保留。',buttons:['覆盖安装','稍后'],defaultId:0,cancelId:1});return answer.response===0;},
    afterInstaller:async()=>scheduleInstallerExit()});
  for(const name of ['persist:dswhale-consoles','persist:dswhale-bili-console']){const consoleSession=session.fromPartition(name);consoleSession.setPermissionRequestHandler((_contents,_permission,callback)=>callback(false));consoleSession.setPermissionCheckHandler(()=>false);}
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  window = new BrowserWindow({ width: 1220, height: 850, useContentSize: true, minWidth: windowChrome.MIN_WIDTH, minHeight: windowChrome.MIN_HEIGHT, ...windowChrome.browserWindowOptions(process.platform, os.release(), nativeTheme.shouldUseDarkColors), title: 'DWhale', backgroundColor: nativeTheme.shouldUseDarkColors ? '#111b29' : '#eef3f8', icon: path.join(__dirname, 'assets/icon.png'), webPreferences: { preload: path.join(__dirname, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true } });
  window.setMenuBarVisibility(false);
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.on('resize', resizePanel);
  ipcMain.handle('dswhale:action', async (event, action, payload) => {
    validateRequest(event, window.webContents, action, payload);
    try {
      const result = await perform(action, payload);
      if (['workspace-status', 'inspect', 'health-check'].includes(action)) publish({ workspaceWarning: '', feedback: null });
      if (action === 'settings-get') publish({ settingsWarning: '', feedback: null });
      return result;
    }
    catch (error) { throw new UserActionError(await reportActionError(error, action)); }
  });
  appearanceStore = new Appearance({ userData: app.getPath('userData') });
  publish({ appearance: await appearanceStore.read() });
  await window.loadURL('dswhale://desktop/index.html');
  let savedPreferences = preferences;
  try { savedPreferences = await preferenceStore.read(); }
  catch { publish({ workspaceWarning: '无法读取应用偏好，已使用默认设置，请重试检测' }); }
  applyPreferences(savedPreferences);
  // Rewrite our own login item to the renamed executable; foreign entries stay untouched.
  if (savedPreferences.startAtLogin) await preferenceStore.save(savedPreferences).catch(() => {});
  const openedAtLogin=process.platform==='darwin'&&app.getLoginItemSettings().wasOpenedAtLogin;
  if(preferences.tray&&(process.argv.includes('--hidden')||openedAtLogin))window.hide();
  window.on('close',event=>{if(preferences.tray&&!shutdownRequested&&!quitting){event.preventDefault();window.hide();}});
  // A transient status read is not a failed user operation: keep the window
  // usable and let the renderer show an in-place retry warning.
  await refresh().catch(()=>publish({workspaceWarning:'无法读取运行环境，请重试检测'}));
  await finishPendingUpdate();
  updateScheduler=new UpdateScheduler({
    shouldRun:()=>!activeAction&&!shutdownRequested,
    check:()=>appUpdater.check({automatic:true}),
    cancelCheck:()=>appUpdater.cancel(),
    onResult:appUpdate=>publish({appUpdate}),
  });
  updateScheduler.start();
  externalConnectionMonitor = new VisibilityMonitor({
    shouldRun: () => !shutdownRequested && !activeAction && supervisor.running,
    read: () => officialHealthStatus(state.setup?.qqConfigured === true),
    onResult: status => publishOfficialStatus(status),
  });
  externalConnectionMonitor.start(!systemSuspended && Boolean(visibleWindow()));
  for (const event of ['show', 'restore', 'focus']) window.on(event, () => syncConnectionMonitor(true));
  for (const event of ['hide', 'minimize']) window.on(event, () => syncConnectionMonitor());
  let wasRunning = false;
  powerMonitor.on('suspend', () => { wasRunning = supervisor.running; systemSuspended = true; syncConnectionMonitor(); });
  powerMonitor.on('resume', () => {
    if (shutdownRequested) return;
    systemSuspended = false;
    updateScheduler?.resume();
    syncConnectionMonitor(true);
    if (preferences.resumeAfterWake && wasRunning && !supervisor.running && !activeAction) perform('start').catch(() => publish({ error: '系统已唤醒，请重新检查连接' }));
    else publish({ notice: '系统已唤醒，可重新检查连接状态' });
  });
  window.on('closed', () => { externalConnectionMonitor?.stop(); window = null; });
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.focus(); } });
  app.whenReady().then(async () => {
    protocol.handle('dswhale', request => {
      const url = new URL(request.url), name = url.pathname.replace(/^\//, '') || 'index.html';
      if (request.method !== 'GET' || url.hostname !== 'desktop' || !['index.html', 'style.css', 'app.js', 'model.js', 'dwhale-hero.png', 'dwhale-whale.png', 'background.png'].includes(name)) return new Response('Not found', { status: 404 });
      return net.fetch(pathToFileURL(path.join(__dirname, 'ui', name)).toString());
    });
    await createWindow();
  applyNativeControlColors();
  nativeTheme.on('updated', applyNativeControlColors);
  migrateLegacyMacBundle().catch(()=>{});
  }).catch(() => { dialog.showErrorBox('DWhale 未能打开', '请重新安装对应平台的桌面安装包；现有数据会保留。'); app.quit(); });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', event => {
    if (quitting) return;
    event.preventDefault();
    if (shutdownRequested) return;
    shutdownRequested = true;
    externalConnectionMonitor?.stop();
    updateScheduler?.stop();
    for (const child of activeCommands) child.kill();
    Promise.resolve().then(async()=>{for(const close of [()=>appUpdater?.cancel(),()=>operations?.close(),()=>extensions?.close(),()=>manager?.cancel(),()=>supervisor?.stop(),()=>startupOperation?.catch(()=>{}),()=>stopAll(),()=>statusCache.close()]){try{await close();}catch{}}}).finally(()=>{quitting=true;app.quit();});
  });
}
