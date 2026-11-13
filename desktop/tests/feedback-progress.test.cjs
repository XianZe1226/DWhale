'use strict';
// T2/T3: current-phase download progress and recoverable read failures.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const model = require('../ui/model.js');

const workspace = () => ({
  health: { checks: [], summary: { requiredFailures: 0, warnings: 0 } }, backups: [],
  appUpdate: { currentVersion: '0.3.0a14', targetVersion: '0.4.0a1', channel: 'alpha', phase: 'available', canDownload: true, canInstall: false, canRollback: false, actions: [], impact: null, recovery: {} },
  napcat: { supported: true, configured: false, externalOnly: false, running: false, loginState: 'stopped', protocolConnected: false },
  preferences: { tray: false, startAtLogin: false, resumeAfterWake: false }, diagnosticFiles: [],
});

function renderApp(invoke, screen = 'settings') {
  const handlers = {}; const page = { scrollTop: 0, focus() {} }; const announcer = { textContent: '' }; const body = {};
  let markup = '', buttons = [], document, pushState;
  const root = {
    get innerHTML() { return markup; },
    set innerHTML(value) {
      markup = value; document.activeElement = body;
      buttons = [...value.matchAll(/<button\b([^>]*)>/g)].map(([, attrs]) => {
        const attr = key => attrs.match(new RegExp(`(?:^|\\s)${key}="([^"]*)"`))?.[1];
        return { id: attr('id'), disabled: /\sdisabled(?:\s|$)/.test(attrs), dataset: { action: attr('data-action'), route: attr('data-route') },
          closest(selector) { return selector === 'button' ? this : null; }, hasAttribute() { return false; }, focus() {} };
      });
    },
    addEventListener(name, callback) { handlers[name] = callback; }, querySelectorAll() { return buttons; },
  };
  document = { body, activeElement: body, getElementById(id) { return id === 'app' ? root : id === 'announcer' ? announcer : id === 'main-content' ? page : buttons.find(button => button.id === id); }, querySelector() { return page; } };
  const bridge = {
    invoke: async (action, payload) => action === 'workspace-status' ? workspace() : invoke(action, payload),
    onState(callback) { pushState = callback; return () => {}; },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../ui/app.js'), 'utf8'), { window: { DSWhaleUI: model, dswhale: bridge, addEventListener() {} }, document, location: { search: `?screen=${screen}` }, URLSearchParams });
  return { html: () => root.innerHTML, settle: () => new Promise(resolve => setImmediate(resolve)), push: state => pushState(state) };
}

async function boot(invoke, screen) {
  const app = renderApp(invoke, screen);
  for (let i = 0; i < 12; i += 1) await app.settle();
  return app;
}

test('T3: a failed background workspace read becomes an in-place warning, not a red fault', async () => {
  const app = await boot(async action => {
    if (action === 'inspect') return { installed: true, running: false, phase: 'ready', setup: {} };
    if (action === 'settings-get') return { dashboardPort: 6185 };
    if (action === 'extensions-status') return {};
    return {};
  }, 'settings');
  app.push({ workspaceWarning: '无法读取运行环境，请重试检测' });
  await app.settle();
  assert.match(app.html(), /本机状态暂不可用/);
  assert.doesNotMatch(app.html(), /操作未完成/);
});

test('T3: a real main-process fault still renders the global error with an action', async () => {
  const app = await boot(async action => {
    if (action === 'inspect') return { installed: true, running: false, phase: 'ready', setup: {} };
    if (action === 'settings-get') return { dashboardPort: 6185 };
    if (action === 'extensions-status') return {};
    return {};
  }, 'settings');
  app.push({ error: '[UPD-001] 更新准备未完成，备份已保留，请重试修复或回退' });
  await app.settle();
  assert.match(app.html(), /操作未完成/);
  assert.match(app.html(), /UPD-001/);
});

test('T3: controller keeps settings-read failures local and does not block a later save', async () => {
  let failRead = true;
  const bridge = {
    invoke: async action => { if (action === 'settings-get' && failRead) throw new Error('设置读取失败'); if (action === 'settings-get') return { dashboardPort: 6185 }; if (action === 'settings-save') return { dashboardPort: 6186 }; return {}; },
    onState() { return () => {}; },
  };
  const controller = model.createController({ bridge });
  await assert.rejects(controller.act('settings-get'));
  assert.equal(controller.get().settingsError, '设置读取失败');
  assert.equal(controller.get().error, '');
  failRead = false;
  await controller.act('settings-get');
  assert.equal(controller.get().settingsError, '');
  assert.equal(controller.get().settings.dashboardPort, 6185);
});

test('T3: controller records read warning without arming the global error', async () => {
  const bridge = { invoke: async action => { if (action === 'workspace-status') throw new Error('读取超时'); return {}; }, onState() { return () => {}; } };
  const controller = model.createController({ bridge });
  await assert.rejects(controller.act('workspace-status'));
  assert.equal(controller.get().workspaceError, '读取超时');
  assert.equal(controller.get().error, '');
  assert.equal(controller.get().feedback, null);
});

test('T2: new target download starts at zero instead of showing the cached previous installer', async () => {
  const app = await boot(async action => {
    if (action === 'inspect') return { installed: true, running: false, phase: 'ready', setup: {} };
    if (action === 'settings-get') return { dashboardPort: 6185 };
    if (action === 'extensions-status') return {};
    return {};
  }, 'settings');
  app.push({ appUpdateProgress: { operationId: 'op-1', targetVersion: '0.4.0a1', phase: 'downloading', stage: 'downloading', label: '正在下载 DWhale 更新', transferredBytes: 0, transferTotalBytes: 104857600, cachedBytes: 0, ratio: 0 } });
  await app.settle();
  const html = app.html();
  assert.match(html, /正在下载 DWhale 更新/);
  assert.match(html, /0\.0 MB \/ 100\.0 MB/);
  assert.match(html, /0%/);
  assert.doesNotMatch(html, /50%/);
});

test('T2: an already downloaded target reports ready and never fakes a fresh 0-100%', async () => {
  const app = await boot(async action => {
    if (action === 'inspect') return { installed: true, running: false, phase: 'ready', setup: {} };
    if (action === 'settings-get') return { dashboardPort: 6185 };
    if (action === 'extensions-status') return {};
    return {};
  }, 'settings');
  app.push({ appUpdate: { ...workspace().appUpdate, phase: 'downloaded' }, appUpdateProgress: { operationId: 'op-2', targetVersion: '0.4.0a1', phase: 'downloaded', stage: 'downloaded', label: '安装包已就绪', transferredBytes: 104857600, transferTotalBytes: 104857600, cachedBytes: 104857600, ratio: 1 } });
  await app.settle();
  const html = app.html();
  assert.match(html, /安装包已就绪，可继续安装/);
  assert.match(html, /100%/);
});
