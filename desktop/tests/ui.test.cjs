const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const uiPath = path.join(__dirname, '../ui/model.js');
const load = () => { assert.ok(fs.existsSync(uiPath), 'desktop UI controller exists'); return require(uiPath); };
const TrueValue = 1;

function connectionData({ state = {}, qq = {}, settings = { ownerQQ: '12345678' }, appUpdate = null } = {}) {
  return { settings, state: { installed: true, running: false, platform: { id: 'win32-x64', supported: true },
    setup: { ownerConfigured: true, modelConfigured: true }, ...state }, workspace: { appUpdate, napcat: {
      configured: true, externalOnly: false, running: false, hasSavedLogin: true, loginState: 'stopped', connectionConfigured: true,
      protocolConnected: false, ...qq } } };
}

test('browser mode never invents an installed or running service', () => {
  const { createController } = load();
  const c = createController();
  assert.equal(c.get().mode, 'unavailable');
  assert.equal(c.get().state.running, false);
  assert.equal(c.get().state.installed, false);
});

test('explicit preview is read only and privileged actions cannot be invoked', async () => {
  const { createController } = load();
  const c = createController({ preview: true });
  assert.equal(c.get().mode, 'preview');
  await assert.rejects(c.act('start'), /预览/);
  await assert.rejects(c.act('settings-save', {}), /预览/);
});

test('desktop consumes inspect and subscription state without fabricating readiness', async () => {
  const { createController } = load();
  let listener;
  let removed = false;
  const c = createController({ bridge: {
    invoke: async a => a === 'inspect' ? { installed: false, running: false, phase: 'idle', components: [] } : {},
    onState: cb => { listener = cb; return () => { removed = true; }; },
  }});
  await c.init();
  assert.equal(c.get().state.installed, false);
  listener({ installed: true, running: false, phase: 'ready', setup: { ownerConfigured: true } });
  assert.equal(c.get().state.installed, true);
  assert.equal(c.get().state.running, false);
  assert.equal(c.get().state.setup.ownerConfigured, true);
  c.dispose();
  assert.equal(removed, true);
});

test('actions pass only contracted panel identifiers and preserve error for retry', async () => {
  const { createController } = load();
  const calls = [];
  const c = createController({ bridge: { invoke: async (a, p) => { calls.push([a, p]); if (a === 'install') throw new Error('网络不可用'); return {}; }, onState: () => () => {} }});
  await c.act('open-panel', { panel: 'memory' });
  assert.deepEqual(calls[0], ['open-panel', { panel: 'memory' }]);
  await assert.rejects(c.act('open-panel', { panel: 'https://example.org' }), /面板/);
  await assert.rejects(c.act('run-command', {}), /操作/);
  await assert.rejects(c.act('install'), /网络不可用/);
  assert.equal(c.get().pending, '');
  assert.equal(c.get().error, '网络不可用');
  assert.equal(c.get().retry.action, 'install');
});

test('settings payload serializes only supplied fields and excludes hasModels', async () => {
  const { settingsPayload } = load();
  assert.deepEqual(settingsPayload({ ownerQQ: ' 123456 ', platformId: ' qq ', dashboardPort: '6199', unusedLegacyToken: 'local secret', biliEnabled: true, proactiveEnabled: false, hasModels: true }), {
    dashboardPort: 6199, biliEnabled: true, proactiveEnabled: false,
  });
  assert.deepEqual(settingsPayload({}), {});
  assert.equal(settingsPayload({ proactiveEnabled: false }).proactiveEnabled, false);
  assert.equal('biliEnabled' in settingsPayload({ proactiveEnabled: false }), false);
  assert.throws(() => settingsPayload({ dashboardPort: '0' }), /端口/);
  assert.throws(() => settingsPayload({ dashboardPort: '6199.5' }), /端口/);
  assert.throws(() => settingsPayload({ proactiveEnabled: TrueValue }), /开关/);
});

test('settings patch keeps only fields the user actually changed', () => {
  const { settingsPatch } = load();
  const baseline = { ownerQQ: '123456', platformId: 'qq', dashboardPort: 6199, dashboardPort: 6185, unusedLegacyToken: 'token', proactiveEnabled: true, biliEnabled: false, signatureEnabled: false, qzoneEnabled: false, configRevision: 'abcdef12' };
  assert.deepEqual(settingsPatch(baseline, baseline), {});
  assert.deepEqual(settingsPatch({ ...baseline, proactiveEnabled: false }, baseline), { proactiveEnabled: false });
  assert.deepEqual(settingsPatch({ ...baseline, dashboardPort: '6200' }, baseline), { dashboardPort: 6200 });
  assert.deepEqual(settingsPatch({ ownerQQ: ' 123456 ' }, baseline), {});
  assert.deepEqual(settingsPatch({ ownerQQ: '123456', biliEnabled: false }, { ...baseline, biliEnabled: false }), {});
});

test('text escaping prevents backend detail from becoming active markup', () => {
  assert.equal(load().escapeHTML('<img src=x onerror="x">&'), '&lt;img src=x onerror=&quot;x&quot;&gt;&amp;');
});

test('shell uses local assets, restrictive CSP and accessible live feedback', () => {
  const htmlPath = path.join(__dirname, '../ui/index.html');
  assert.ok(fs.existsSync(htmlPath), 'shell HTML exists');
  const html = fs.readFileSync(htmlPath, 'utf8');
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /lang="zh-CN"/);
  assert.doesNotMatch(html, /https?:\/\/.*(?:script|stylesheet)/);
});

test('invalid settings remain visible and no secret is retained for retry', async () => {
  const { createController } = load();
  const c = createController({ bridge: { invoke: async () => { throw new Error('写入失败'); }, onState: () => () => {} } });
  await assert.rejects(c.act('settings-save', { dashboardPort: 0, unusedLegacyToken: 'secret' }), /端口/);
  assert.match(c.get().error, /端口/);
  assert.equal(c.get().pending, '');
  await assert.rejects(c.act('settings-save', { dashboardPort: 6199, unusedLegacyToken: 'secret' }), /写入失败/);
  assert.equal(c.get().retry, null);
});

test('duplicate actions are rejected until the actual bridge operation settles', async () => {
  const { createController } = load();
  let finish;
  const c = createController({ bridge: { invoke: action => action==='workspace-status'?Promise.resolve({}):new Promise(resolve => { finish = resolve; }), onState: () => () => {} } });
  const task = c.act('install');
  assert.equal(c.get().pending, 'install');
  await assert.rejects(c.act('start'), /仍在进行/);
  finish({ phase: 'ready', installed: true, running: false });
  await task;
  assert.equal(c.get().state.installed, true);
  assert.equal(c.get().state.running, false);
  assert.equal(c.get().pending, '');
});

test('initial login opens a native dialog without retaining its result in renderer state', async () => {
  const { createController } = load();
  const calls = [];
  const c = createController({ bridge: { invoke: async action => { calls.push(action); return { displayed: true }; }, onState: () => () => {} } });
  await c.act('initial-login');
  assert.deepEqual(calls, ['initial-login']);
  assert.equal(c.get().notice, '');
  assert.equal(c.get().settings, null);
});

test('restore success tells the user to review configuration and keeps the service stopped', async () => {
  const { createController } = load();
  const c = createController({ bridge: { invoke: async action => ({ canceled: false, phase: 'ready', installed: true, running: false }), onState: () => () => {} } });
  await c.act('restore');
  assert.equal(c.get().notice, '备份已导入，请检查配置后启动服务');
  assert.equal(c.get().state.running, false);
});

test('canceled backup and restore dialogs never report success', async () => {
  const { createController } = load();
  const c = createController({ bridge: { invoke: async () => ({ canceled: true }), onState: () => () => {} } });
  await c.act('backup');
  assert.equal(c.get().notice, '');
  await c.act('restore');
  assert.equal(c.get().notice, '');
});

const extensionStatus = () => ({
  memory: { installed: true, version: '1.0.0', latest: null, canUpdate: false, canRollback: false },
  memes: { installed: false, version: null, latest: null, canUpdate: false, canRollback: false },
});

test('opening the plugin store reads local status without checking or installing', async () => {
  const { createController } = load();
  const calls = [];
  const c = createController({ bridge: {
    invoke: async (action, payload) => { calls.push([action, payload]); return action === 'inspect' ? { installed: true, running: false } : extensionStatus(); },
    onState: () => () => {},
  }});
  await c.init();
  await c.act('extensions-status');
  assert.deepEqual(calls, [['inspect', undefined], ['workspace-status', undefined], ['extensions-status', undefined]]);
  assert.equal(c.get().extensions.memory.version, '1.0.0');
  assert.equal(c.get().extensionChecks.memory, false);
});

test('plugin update requires a successful explicit check and only sends allowlisted IDs', async () => {
  const { createController } = load();
  const calls = [];
  const checked = extensionStatus();
  checked.memory.latest = '1.1.0';
  checked.memory.canUpdate = true;
  const c = createController({ bridge: {
    invoke: async (action, payload) => { calls.push([action, payload]); return checked; },
    onState: () => () => {},
  }});
  await c.act('extensions-status');
  await assert.rejects(c.act('extension-update', { id: 'memory' }), /检查/);
  await assert.rejects(c.act('extension-check', { id: 'other' }), /插件/);
  await c.act('extension-check', { id: 'memory', url: 'https://untrusted.invalid' });
  assert.equal(c.get().extensionChecks.memory, true);
  await c.act('extension-update', { id: 'memory' });
  assert.deepEqual(calls, [['extensions-status', undefined], ['extension-check', { id: 'memory' }], ['extension-update', { id: 'memory' }]]);
  assert.equal(c.get().extensionChecks.memory, false);
  assert.match(c.get().notice, /检查.*启动/);
  assert.equal(c.get().state.running, false);
});

test('optional meme installation uses its checked candidate and preserves memory status', async () => {
  const { createController } = load();
  const checked = extensionStatus();
  checked.memes = { installed: false, version: null, latest: '2.0.0', canUpdate: true, canRollback: false };
  const updated = extensionStatus();
  updated.memes = { installed: true, version: '2.0.0', latest: '2.0.0', canUpdate: false, canRollback: true };
  const c = createController({ bridge: { invoke: async action => action === 'extension-update' ? updated : checked, onState: () => () => {} } });
  await c.act('extension-check', { id: 'memes' });
  await c.act('extension-update', { id: 'memes' });
  assert.equal(c.get().extensions.memes.installed, true);
  assert.equal(c.get().extensions.memory.version, '1.0.0');
  assert.match(c.get().notice, /安装/);
});

test('plugin failures retain retry context without replacing installed versions', async () => {
  const { createController } = load();
  const checked = extensionStatus();
  checked.memory = { installed: true, version: '1.0.0', latest: '1.1.0', canUpdate: true, canRollback: false };
  let fail = false;
  const c = createController({ bridge: { invoke: async () => { if (fail) throw new Error('下载未完成'); return checked; }, onState: () => () => {} } });
  await c.act('extension-check', { id: 'memory' });
  fail = true;
  await assert.rejects(c.act('extension-update', { id: 'memory' }), /下载未完成/);
  assert.equal(c.get().extensions.memory.version, '1.0.0');
  assert.equal(c.get().notice, '');
  assert.equal(c.get().error, '下载未完成');
  assert.deepEqual(c.get().retry, { action: 'extension-update', payload: { id: 'memory' } });
  assert.equal(c.get().pending, '');
  assert.equal(c.get().pendingExtension, '');
});

test('rollback requires a snapshot and success closes the console for review', async () => {
  const { createController } = load();
  let listener;
  const current = extensionStatus();
  const c = createController({ bridge: {
    invoke: async action => action === 'inspect' ? { installed: true, running: true, panel: 'memory' } : current,
    onState: cb => { listener = cb; return () => {}; },
  }});
  await c.init();
  await c.act('extensions-status');
  await assert.rejects(c.act('extension-rollback', { id: 'memory' }), /回退/);
  current.memory.canRollback = true;
  await c.act('extensions-status');
  listener({ running: false, panel: '' });
  await c.act('extension-rollback', { id: 'memory' });
  assert.equal(c.get().state.running, false);
  assert.equal(c.get().state.panel, '');
  assert.match(c.get().notice, /回退.*检查.*启动/);
});

test('canceled or malformed plugin responses never report a successful upgrade', async () => {
  const { createController } = load();
  const checked = extensionStatus();
  checked.memory.canUpdate = true;
  checked.memory.latest = '1.1.0';
  let result = checked;
  const c = createController({ bridge: { invoke: async () => result, onState: () => () => {} } });
  await c.act('extension-check', { id: 'memory' });
  result = { canceled: true };
  await c.act('extension-update', { id: 'memory' });
  assert.doesNotMatch(c.get().notice, /已更新|已安装/);
  assert.equal(c.get().extensions.memory.version, '1.0.0');
  result = {};
  await assert.rejects(c.act('extension-update', { id: 'memory' }), /状态/);
  assert.equal(c.get().notice, '');
  assert.equal(c.get().extensions.memory.version, '1.0.0');
});

const workspaceStatus = (patch={}) => ({health:{checks:[],summary:{requiredFailures:0,warnings:0}},backups:[],appUpdate:{currentVersion:'0.3.0a3',targetVersion:null,channel:'alpha',phase:'idle',canDownload:false,canInstall:false,canRollback:false,actions:['check'],impact:null,recovery:{interrupted:false}},network:{mode:'system',proxyUrl:'',noProxy:'',pypiIndex:'',npmRegistry:'',assetMirrors:[]},napcat:{supported:false,configured:false,needsLogin:true,connectionConfigured:false,running:false,code:'EXTERNAL_REQUIRED',nextStep:'连接外部 OneBot 服务',guideURL:'https://napneko.github.io/'},preferences:{tray:false,startAtLogin:false,resumeAfterWake:false},diagnosticFiles:['health.json','events.json','versions.json','README.txt'],...patch});

function renderApp({ screen = 'intelligence', invoke, workspace=workspaceStatus() } = {}) {
  const handlers = {};
  const page = { scrollTop: 0, focus() {} };
  const announcer = { textContent: '' };
  const body = {};
  let markup = '';
  let htmlWrites = 0;
  let buttons = [];
  const inputValues = {};
  let document;
  const root = {
    get innerHTML() { return markup; },
    set innerHTML(value) {
      htmlWrites += 1;
      markup = value;
      document.activeElement = body;
      buttons = [...value.matchAll(/<button\b([^>]*)>/g)].map(([, attrs]) => {
        const attr = key => attrs.match(new RegExp(`(?:^|\\s)${key}="([^"]*)"`))?.[1];
        return { id: attr('id'), disabled: /\sdisabled(?:\s|$)/.test(attrs), dataset: { action: attr('data-action'), panel: attr('data-panel'), route: attr('data-route'), extension: attr('data-extension'), item:attr('data-item'), record:attr('data-record'), field:attr('data-field'), channel:attr('data-channel'), enabled:attr('data-enabled') }, focus() { if (!this.disabled) document.activeElement = this; } };
      });
    },
    addEventListener(name, callback) { handlers[name] = callback; },
    querySelectorAll() { return buttons; },
  };
  document = { body, activeElement: body, getElementById(id) { if (inputValues[id] !== undefined) return { value: inputValues[id], focus() {}, type: 'text' }; return id === 'app' ? root : id === 'announcer' ? announcer : id === 'main-content' ? page : buttons.find(button => button.id === id); }, querySelector() { return page; } };
  const calls = [];
  let stateListener;
  const bridge = { invoke: async (action, payload) => { calls.push([action, payload && JSON.parse(JSON.stringify(payload))]); return action==='workspace-status'?workspace:invoke(action, payload); }, onState: callback => { stateListener = callback; return () => {}; } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../ui/app.js'), 'utf8'), {
    window: { DSWhaleUI: load(), dswhale: bridge, addEventListener() {} }, document,
    location: { search: `?screen=${screen}` }, URLSearchParams,
  });
  return {
    calls, html: () => root.innerHTML, htmlWrites: () => htmlWrites, announcement: () => announcer.textContent,
    focused: () => document.activeElement?.id,
    focus: (action, id) => buttons.find(button => button.dataset.action === action && button.dataset.extension === id)?.focus(),
    focusItem: (action,item) => buttons.find(button=>button.dataset.action===action&&button.dataset.item===item)?.focus(),
    settle: () => new Promise(resolve => setImmediate(resolve)),
    click: (action, id, operation, mode) => handlers.click({ target: { closest() { return this; }, dataset: { action, extension: id, operation, ...(mode ? { mode } : {}) }, hasAttribute() { return false; } } }),
    clickItem: (action, item, operation) => handlers.click({ target: { closest() { return this; }, dataset: { action, item, operation }, hasAttribute() { return false; } } }),
    clickWithDataset: action => { const button=buttons.find(item=>item.dataset.action===action); assert.ok(button); return handlers.click({target:{...button,closest(){return this;},hasAttribute(){return false;}}}); },
    clickPrimary: () => { const button=buttons.find(button=>button.id==='connection-primary');assert.ok(button,'one clear connection action is present');return handlers.click({target:{...button,closest(){return this;},hasAttribute(){return false;}}}); },
    pushState: value => stateListener(value),
    toggle: (id, open) => { assert.equal(typeof handlers.toggle,'function','expanded sections track their state');handlers.toggle({target:{id,open}}); },
    navigate: route => handlers.click({target:{closest(){return this;},dataset:{route},hasAttribute(){return false;}}}),
    change: (id, checked) => handlers.change({ target: { id, type: 'checkbox', checked, matches() { return true; } } }),
    input: (id, value) => handlers.input({target:{id,type:'text',value,matches(){return true;}}}),
    setInput: (id, value) => { inputValues[id] = value; },
    compositionStart: id => handlers.compositionstart({target:{id,closest(){return this;}}}),
    compositionEnd: id => handlers.compositionend({target:{id,closest(){return this;}}}),
    clickConnection: (channel, enabled) => handlers.click({ target: { closest() { return this; }, dataset: { action: 'connection-change', channel, enabled }, hasAttribute() { return false; } } }),
    select: (id, value) => handlers.change({target:{id,type:'select-one',value,matches(){return true;}}}),
  };
}

test('plugin cards read local status, escape version text and wait for an explicit check', async () => {
  const status = extensionStatus();
  status.memory.version = '<img src=x>';
  const app = renderApp({ invoke: async action => action === 'inspect' ? { installed: true, running: true } : status });
  await app.settle();
  assert.deepEqual(app.calls, [['inspect', undefined], ['workspace-status', undefined], ['settings-get', undefined], ['extensions-status', undefined]]);
  assert.match(app.html(), /LivingMemory/);
  assert.match(app.html(), /表情包管理器/);
  assert.match(app.html(), /&lt;img src=x&gt;/);
  assert.match(app.html(), /当前版本/);
  assert.match(app.html(), /最新版本/);
  assert.doesNotMatch(app.html(), /data-action="extension-review"/);
});

test('checked plugin installs directly while rollback can be reviewed and canceled', async () => {
  const status = extensionStatus();
  status.memes = { installed: false, version: null, latest: '2.0.0', canUpdate: true, canRollback: true };
  const app = renderApp({ invoke: async action => action === 'inspect' ? { installed: true, running: true } : status });
  await app.settle();
  await app.click('extension-check', 'memes');
  assert.match(app.html(), /停止服务/);
  assert.match(app.html(), /备份/);
  await app.click('extension-update', 'memes');
  assert.deepEqual(app.calls.at(-1), ['extension-update', { id: 'memes' }]);
  await app.click('extension-review', 'memes', 'extension-rollback');
  assert.match(app.html(), /确认回退/);
  await app.click('extension-cancel', 'memes');
  assert.match(app.html(), /已取消/);
  assert.equal(app.calls.filter(([action]) => action === 'extension-rollback').length, 0);
  await app.click('extension-review', 'memes', 'extension-rollback');
  assert.match(app.html(), /确认回退/);
  await app.click('extension-confirm', 'memes');
  assert.deepEqual(app.calls.at(-1), ['extension-rollback', { id: 'memes' }]);
  assert.match(app.announcement(), /回退.*检查.*启动/);
});

test('a failed repeated check disables an old update candidate until checking succeeds', async () => {
  const { createController } = load();
  const status = extensionStatus();
  status.memory.latest = '1.1.0';
  status.memory.canUpdate = true;
  let fail = false;
  const c = createController({ bridge: { invoke: async () => { if (fail) throw new Error('检查失败'); return status; }, onState: () => () => {} } });
  await c.act('extension-check', { id: 'memory' });
  fail = true;
  await assert.rejects(c.act('extension-check', { id: 'memory' }), /检查失败/);
  await assert.rejects(c.act('extension-update', { id: 'memory' }), /检查/);
  assert.equal(c.get().extensions.memory.version, '1.0.0');
  assert.equal(c.get().extensionChecks.memory, false);
});

test('restoring a backup invalidates plugin versions and checked candidates', async () => {
  const { createController } = load();
  const status = extensionStatus();
  status.memory.canUpdate = true;
  const c = createController({ bridge: { invoke: async action => action === 'restore' ? { canceled: false, running: false } : status, onState: () => () => {} } });
  await c.act('extension-check', { id: 'memory' });
  await c.act('restore');
  assert.equal(c.get().extensions, null);
  assert.equal(c.get().extensionChecks.memory, false);
  assert.equal(c.get().extensionChecks.memes, false);
});

test('canceling rollback announces cancellation even after a successful check', async () => {
  const status = extensionStatus();
  status.memory.canRollback = true;
  const app = renderApp({ invoke: async action => action === 'inspect' ? { installed: true, running: false } : status });
  await app.settle();
  await app.click('extension-check', 'memory');
  await app.click('extension-review', 'memory', 'extension-rollback');
  await app.click('extension-cancel', 'memory');
  assert.match(app.announcement(), /已取消/);
});

test('keyboard focus returns to the plugin check button after its update button disappears', async () => {
  const status = extensionStatus();
  status.memory.latest = '1.1.0';
  status.memory.canUpdate = true;
  const updated = extensionStatus();
  updated.memory = { installed: true, version: '1.1.0', latest: '1.1.0', canUpdate: false, canRollback: true };
  const app = renderApp({ invoke: async action => action === 'inspect' ? { installed: true, running: false } : action === 'extension-update' ? updated : status });
  await app.settle();
  app.focus('extension-check', 'memory');
  await app.click('extension-check', 'memory');
  assert.equal(app.focused(), 'extension-check-memory');
  app.focus('extension-update', 'memory');
  await app.click('extension-update', 'memory');
  assert.equal(app.focused(), 'extension-check-memory');
});

test('a failed local status read offers retry without leaving the cards in loading state', async () => {
  let fail = true;
  const app = renderApp({ invoke: async action => {
    if (action === 'inspect') return { installed: true, running: false };
    if (fail) throw new Error('本机状态读取失败');
    return extensionStatus();
  }});
  await app.settle();
  assert.match(app.html(), /本机状态读取失败/);
  assert.match(app.html(), /重试读取/);
  assert.doesNotMatch(app.html(), /<dd>正在读取<\/dd>/);
  fail = false;
  await app.click('extensions-status');
  assert.match(app.html(), /1\.0\.0/);
  assert.doesNotMatch(app.html(), /本机状态读取失败/);
});

test('initial workspace status is offline even before the first environment installation', async()=>{
  const calls=[];
  const c=load().createController({bridge:{invoke:async(action,payload)=>{calls.push([action,payload]);return action==='inspect'?{installed:false}:workspaceStatus();},onState:()=>()=>{}}});
  await c.init();
  assert.deepEqual(calls,[['inspect',undefined],['workspace-status',undefined]]);
  assert.equal(c.get().workspace.network,undefined);
  assert.equal(c.get().workspace.preferences.startAtLogin,false);
  assert.equal(c.get().state.installed,false);
});

test('workspace action patches preserve other cards and never enter environment state', async()=>{
  const c=load().createController({bridge:{invoke:async action=>action==='workspace-status'?workspaceStatus():{health:{checks:[{id:'bili',name:'视频服务',ok:false}],summary:{requiredFailures:1,warnings:0}},privateRaw:'SECRET'},onState:()=>()=>{}}});
  await c.act('workspace-status');await c.act('health-check');
  assert.equal(c.get().workspace.health.checks[0].ok,false);
  assert.equal(c.get().workspace.network,undefined);
  assert.equal(c.get().state.health,undefined);
  assert.equal(c.get().workspace.privateRaw,undefined);
});

test('connection ports include dashboard and reject privileged or colliding local ports',()=>{
  const {settingsPayload}=load();
  assert.deepEqual(settingsPayload({dashboardPort:6199}),{dashboardPort:6199});
  assert.deepEqual(settingsPayload({dashboardPort:'6186'}),{dashboardPort:6186});
  assert.throws(()=>settingsPayload({dashboardPort:80}),/端口/);
  assert.deepEqual(settingsPayload({dashboardPort:6199}),{dashboardPort:6199});
});

test('application updates enforce manager capabilities and strip caller installer URLs',async()=>{
  const calls=[];
  const appUpdate={...workspaceStatus().appUpdate,targetVersion:'0.3.0a4',canDownload:true};
  const c=load().createController({bridge:{invoke:async(action,payload)=>{calls.push([action,payload]);return action==='workspace-status'?workspaceStatus({appUpdate}):action==='inspect'?{installed:true}:{appUpdate:{...appUpdate,phase:'downloaded',canInstall:true}};},onState:()=>()=>{}}});
  await assert.rejects(c.act('app-update-download'),/检查/);
  await c.init();
  await c.act('app-update-download',{url:'https://evil.invalid'});
  assert.deepEqual(calls.at(-1),['app-update-download',undefined]);
  await c.act('app-update-install',{file:'/bad'});
  assert.deepEqual(calls.at(-1),['app-update-install',undefined]);
  assert.equal(c.get().state.running,false);
  assert.doesNotMatch(c.get().notice,/更新成功|已安装/);
  await assert.rejects(c.act('app-update-check',{channel:'nightly'}),/通道/);
});

test('manual network settings are not exposed by the desktop controller',async()=>{const c=load().createController({bridge:{invoke:async()=>{throw Error('must not invoke');},onState:()=>()=>{}}});await assert.rejects(c.act('network-save',{proxyUrl:'http://127.0.0.1:7890'}));});

test('automatic backup actions accept only a listed local ID and no caller path',async()=>{
  const calls=[];
  const c=load().createController({bridge:{invoke:async(action,payload)=>{calls.push([action,payload]);return action==='workspace-status'?workspaceStatus({backups:[{id:'safe.zip',created:'2026-11-01',size:2048,source:'app-update'}]}):{backups:[]};},onState:()=>()=>{}}});
  await c.act('workspace-status');
  await assert.rejects(c.act('backup-delete',{id:'../private.zip'}),/备份/);
  await c.act('backup-delete',{id:'safe.zip',path:'/private'});
  assert.deepEqual(calls.at(-1),['backup-delete',{id:'safe.zip'}]);
  assert.deepEqual(c.get().workspace.backups,[]);
});

test('settings show networking before install without checking updates or enabling startup',async()=>{
  const app=renderApp({screen:'settings',invoke:async action=>action==='inspect'?{installed:false}:{} });
  await app.settle();
  assert.doesNotMatch(app.html(),/id="network-mode"|network-proxyUrl|save-network/);
  assert.match(app.html(),/Clash/);
  assert.match(app.html(),/id="pref-startAtLogin"/);
  assert.doesNotMatch(app.html(),/id="pref-startAtLogin"[^>]* checked/);
  assert.match(app.html(),/更新清单.*签名|签名.*更新清单/);
  assert.match(app.html(),/系统签名|系统公证/);
  assert.equal(app.calls.some(([a])=>a.startsWith('app-update-')),false);
  assert.deepEqual(app.calls,[['inspect',undefined],['workspace-status',undefined]]);
});

test('backup restore and delete require inline review and cancellation never invokes a mutation',async()=>{
  const backup={id:'backup-safe.zip',created:'2026-11-01T00:00:00Z',size:2048,source:'app-update'};
  const app=renderApp({screen:'settings',workspace:workspaceStatus({backups:[backup]}),invoke:async action=>action==='inspect'?{installed:true,running:true}:{backups:[backup],health:{checks:[],summary:{requiredFailures:0,warnings:0}}}});
  await app.settle();
  await app.clickItem('backup-review','backup-safe.zip','backup-restore');
  assert.match(app.html(),/确认恢复/);
  await app.click('backup-cancel');
  assert.equal(app.calls.some(([a])=>a==='backup-restore'),false);
  await app.clickItem('backup-review','backup-safe.zip','backup-delete');
  assert.match(app.html(),/确认删除/);
  await app.click('backup-confirm');
  assert.deepEqual(app.calls.at(-1),['backup-delete',{id:'backup-safe.zip'}]);
});

test('environment doctor escapes details and shows actual versus expected versions',async()=>{
  const health={checks:[{id:'PKG_DSWH',name:'应用组件',ok:false,required:true,detail:'<img src=x>',code:'PKG_MISSING',fix:'准备环境'}],summary:{requiredFailures:1,warnings:0}};
  const app=renderApp({screen:'environment',workspace:workspaceStatus({health}),invoke:async()=>({installed:true,running:false,versionMatrix:{expected:{dswhale:'0.3.0a3',node:'22.23.4'},actual:{dswhale:'0.3.0a2',node:'24.0.0'}}})});
  await app.settle();
  assert.match(app.html(),/环境检查/);
  assert.match(app.html(),/&lt;img src=x&gt;/);
  assert.match(app.html(),/预期版本/);
  assert.match(app.html(),/实际版本/);
  assert.match(app.html(),/24\.0\.0/);
});

test('upstream newer or offline is shown as unverified without replacing the lock',async()=>{
  const newer=renderApp({screen:'environment',invoke:async()=>({installed:true,upstreamCore:{status:'newer',locked:'4.29.4',latestStable:'4.30.0'}})});
  await newer.settle();
  assert.match(newer.html(),/核心版本未验证/);
  assert.match(newer.html(),/4\.30\.0/);
  assert.match(newer.html(),/4\.29\.4/);
  const offline=renderApp({screen:'environment',invoke:async()=>({installed:true,upstreamCore:{status:'offline',locked:'4.29.4'}})});
  await offline.settle();
  assert.match(offline.html(),/启动前上游检查未完成/);
});

test('Bilibili doctor exposes package and video check failures with a repair action',async()=>{
  const health={checks:[{id:'BILI_BRIDGE',name:'视频连接服务',ok:false,required:true,detail:'请修复视频桥接',code:'BILI_FAILED'},{id:'PKG_DSWH',name:'应用组件',ok:true,required:true,detail:'版本可用',code:'OK'}],summary:{requiredFailures:1,warnings:0}};
  const app=renderApp({screen:'bilibili',workspace:workspaceStatus({health}),invoke:async action=>action==='inspect'?{installed:true,running:false}:{dashboardPort:6199,biliEnabled:false}});
  await app.settle();
  assert.match(app.html(),/视频连接服务/);
  assert.match(app.html(),/请修复视频桥接/);
  assert.match(app.html(),/修复运行环境/);
});

test('preferences save without adding any network configuration form',async()=>{
  const app=renderApp({screen:'settings',invoke:async(action,payload)=>action==='inspect'?{installed:false}:action==='preferences-save'?{preferences:payload}:{} });
  await app.settle();assert.doesNotMatch(app.html(),/network-mode|network-proxyUrl|save-network/);
  app.change('pref-tray',true);app.change('pref-resumeAfterWake',true);await app.click('save-preferences');
  assert.deepEqual(app.calls.at(-1),['preferences-save',{tray:true,startAtLogin:false,resumeAfterWake:true}]);
  assert.equal(app.calls.some(([action])=>action==='settings-save'||action==='network-save'),false);
});

test('a failed destructive action requires a new confirmation instead of an unrestricted retry',async()=>{
  const c=load().createController({bridge:{invoke:async action=>action==='workspace-status'?workspaceStatus({backups:[{id:'safe.zip'}]}):Promise.reject(new Error('删除未完成')),onState:()=>()=>{}}});
  await c.act('workspace-status');await assert.rejects(c.act('backup-delete',{id:'safe.zip'}));
  assert.equal(c.get().retry,null);
  assert.equal(c.get().workspace.backups.length,1);
});

test('managed core guidance stays in the native toolbar and settings expose its version matrix',async()=>{
  const app=renderApp({screen:'settings',invoke:async action=>action==='inspect'?{installed:true,panel:'models',versionMatrix:{expected:{astrbot:'4.29.3'},actual:{astrbot:'4.29.3'}}}:{}});
  await app.settle();
  assert.match(app.html(),/内核由 DWhale 统一管理，更新请到应用设置/);
});

test('visiting reliability routes refreshes only local workspace status',async()=>{
  const app=renderApp({screen:'overview',invoke:async action=>action==='inspect'?{installed:true}:{dashboardPort:6199,dashboardPort:6185}});
  await app.settle();await app.navigate('settings');await app.navigate('environment');
  assert.equal(app.calls.filter(([action])=>action==='workspace-status').length,3);
  assert.equal(app.calls.some(([action])=>action.startsWith('app-update-')),false);
});

test('environment preparation and legacy restore refresh local health immediately without checking updates',async()=>{
  const calls=[];let installed=false;
  const health={checks:[{id:'bili-files',name:'B站桥接组件',ok:true}],summary:{requiredFailures:0,warnings:0}};
  const c=load().createController({bridge:{invoke:async action=>{
    calls.push(action);
    if(action==='inspect')return {installed:false};
    if(action==='install'){installed=true;return {installed:true,phase:'ready'};}
    if(action==='restore')return {restored:true};
    return workspaceStatus({health:installed?health:null});
  },onState:()=>()=>{}}});
  await c.init();assert.equal(c.get().workspace.health,null);
  await c.act('install');assert.equal(c.get().state.installed,true);assert.equal(c.get().workspace.health?.checks?.[0]?.ok,true);
  await c.act('restore');
  assert.deepEqual(calls,['inspect','workspace-status','install','workspace-status','restore','workspace-status']);
});

test('canceling a backup review returns keyboard focus to its original control',async()=>{
  const app=renderApp({screen:'settings',workspace:workspaceStatus({backups:[{id:'safe.zip',created:'2026-11-01',size:1024}]}),invoke:async()=>({installed:true})});
  await app.settle();app.focusItem('backup-review','safe.zip');await app.clickItem('backup-review','safe.zip','backup-restore');
  await app.click('backup-cancel');assert.equal(app.focused(),'backup-restore-0');
});

test('diagnostics can export before environment installation and announce progress',async()=>{
  let finish;
  const app=renderApp({screen:'settings',invoke:async action=>action==='inspect'?{installed:false}:action==='workspace-status'?workspaceStatus():action==='diagnostics-export'?new Promise(resolve=>{finish=resolve;}):{}});
  await app.settle();assert.doesNotMatch(app.html(),/data-action="diagnostics-export"[^>]*disabled/);
  const saving=app.click('diagnostics-export');await app.settle();
  assert.match(app.announcement(),/正在准备诊断报告/);
  finish({saved:true});await saving;
});

test('automatic update publications reach workspace without changing global errors or notices',async()=>{
 let listener;const c=load().createController({bridge:{invoke:async action=>action==='inspect'?{installed:true}:workspaceStatus(),onState:cb=>{listener=cb;return()=>{};}}});await c.init();
 const update={phase:'available',targetVersion:'0.3.0a6',canDownload:true};listener({appUpdate:update});assert.deepEqual(c.get().workspace.appUpdate,update);assert.equal(c.get().error,'');assert.equal(c.get().notice,'');assert.equal(c.get().pending,'');
});
test('available update appears in navigation outside settings and opens update controls',async()=>{
 const app=renderApp({screen:'overview',invoke:async()=>({installed:true}),workspace:workspaceStatus({appUpdate:{phase:'available',targetVersion:'0.3.0a6',canDownload:true}})});await app.settle();
 assert.match(app.html(),/data-route="settings"[^>]*>[\s\S]*?aria-label="有应用更新"/);await app.navigate('settings');assert.match(app.html(),/id="app-update-title"/);assert.match(app.html(),/data-action="app-update-start"/);assert.equal(app.calls.some(([action])=>action==='app-update-check'),false);
});

test('available and downloaded update states each show one Update button and no separate install or rollback',async()=>{
 for(const phase of ['available','downloaded']){
  const appUpdate={...workspaceStatus().appUpdate,phase,targetVersion:'0.3.0a10',canDownload:true,canInstall:phase==='downloaded',canRollback:true,previousVersion:'0.3.0a8'};
  const app=renderApp({screen:'settings',workspace:workspaceStatus({appUpdate}),invoke:async action=>action==='inspect'?{installed:true}:{appUpdate}});
  await app.settle();
  assert.equal((app.html().match(/data-action="app-update-start"/g)||[]).length,1);
  assert.doesNotMatch(app.html(),/data-action="app-update-(?:download|install|check)"|app-rollback-review|rollback-restore-data/);
 }
});

test('live update progress remains visible while the update call is pending',async()=>{
 const appUpdate={...workspaceStatus().appUpdate,phase:'available',targetVersion:'0.3.0a10',canDownload:true};let finish;
 const app=renderApp({screen:'settings',workspace:workspaceStatus({appUpdate}),invoke:async action=>action==='inspect'?{installed:true}:action==='app-update-start'?new Promise(resolve=>{finish=resolve;}):{appUpdate}});
 await app.settle();const pending=app.click('app-update-start');await Promise.resolve();
 app.pushState({appUpdateProgress:{stage:'downloading',label:'正在下载更新',ratio:.5,receivedBytes:1024**2,totalBytes:2097152}});
 assert.match(app.html(),/id="app-update-progress"/);assert.match(app.html(),/<progress[^>]*value="0.5"/);assert.match(app.html(),/50%/);
 assert.match(app.html(),/1.0 MB.*2.0 MB/);
 finish({canceled:true,appUpdate:{...appUpdate,phase:'downloaded',canInstall:true}});await pending;
 assert.doesNotMatch(app.html(),/更新成功|已安装/);
});

test('official mode offers official setup and exact private binding without NapCat actions',()=>{
 const base=connectionData();base.settings={qqConnectionMode:'official',officialOwnerUMO:'',officialConfigured:false};
 base.state.running=false;let view=load().connectionViewModel(base);assert.equal(view.action,'start');
 base.state.running=true;view=load().connectionViewModel(base);assert.equal(view.action,'open-panel');assert.equal(view.panel,'qq');
 base.settings.officialConfigured=true;view=load().connectionViewModel(base);assert.equal(view.stage,'official-owner');assert.equal(view.action,'save-settings');
 base.settings.officialOwnerUMO='official-test:FriendMessage:OPAQUE-TEST';base.workspace.napcat.protocolConnected=false;base.workspace.official={protocolConnected:true};
 view=load().connectionViewModel(base);assert.equal(view.stage,'ready');assert.doesNotMatch(JSON.stringify(view),/napcat-install|napcat-wire/);
});

test('saving an unchanged connection form reports no changes without writing', async () => {
  const settings = { ownerQQ: '123456', platformId: 'qq', dashboardPort: 6199, dashboardPort: 6185, unusedLegacyToken: 'token', proactiveEnabled: true };
  const app = renderApp({ screen: 'connect', workspace: workspaceStatus(), invoke: async action => action === 'inspect'
    ? { installed: true, running: true, platform: { id: 'win32-x64', supported: true }, setup: { ownerConfigured: true } }
    : settings });
  await app.settle();
  await app.click('save-settings');
  assert.equal(app.calls.some(([action]) => action === 'settings-save'), false);
  assert.match(app.announcement(), /没有需要保存的修改/);
});

test('identical state pushes do not rebuild the page while changed state still updates', async () => {
  const settings = { officialConfigured:true, officialOwnerUMO:'bot:FriendMessage:OPENID', ownerQQ: '123456', platformId: 'qq', dashboardPort: 6199, dashboardPort: 6185, unusedLegacyToken: 'token' };
  const qq = { ...connectionData().workspace.napcat, running: true, loginState: 'online', protocolConnected: true };
  const app = renderApp({ screen: 'connect', workspace: workspaceStatus({ official: {protocolConnected:true} }), invoke: async action => action === 'inspect'
    ? { installed: true, running: true, platform: { id: 'win32-x64', supported: true }, setup: { ownerConfigured: true } }
    : settings });
  await app.settle();
  const writes = app.htmlWrites();
  for (let index = 0; index < 100; index += 1) app.pushState({});
  assert.equal(app.htmlWrites(), writes);
  app.pushState({ workspace: { official: { protocolConnected: false } } });
  assert.equal(app.htmlWrites(), writes + 1);
  assert.match(app.html(), /官方/);
});

test('Chinese input composition defers rebuilds and applies the latest state afterwards', async () => {
  const settings = { officialConfigured:true, officialOwnerUMO:'bot:FriendMessage:OPENID', ownerQQ: '123456', platformId: 'qq', dashboardPort: 6199, dashboardPort: 6185, unusedLegacyToken: 'token' };
  const app = renderApp({ screen: 'connect', workspace: workspaceStatus({ official: {protocolConnected:true} }), invoke: async action => action === 'inspect'
    ? { installed: true, running: true, platform: { id: 'win32-x64', supported: true }, setup: { ownerConfigured: true } }
    : settings });
  await app.settle();
  const writes = app.htmlWrites();
  app.compositionStart('officialOwnerUMO');
  app.pushState({ workspace: { official: { protocolConnected: false } } });
  assert.equal(app.htmlWrites(), writes);
  app.compositionEnd('officialOwnerUMO');
  await app.settle();
  assert.equal(app.htmlWrites(), writes + 1);
});

test('viewing the official tab on an old napcat install renders the official binding field', async () => {
  const settings = { ownerQQ: '123456', platformId: 'qq', dashboardPort: 6199, dashboardPort: 6185, unusedLegacyToken: 'token', qqConnectionMode: 'official', officialConfigured: true, officialOwnerUMO: '', napcatConfigured: true };
  const app = renderApp({ screen: 'connect', workspace: workspaceStatus(), invoke: async action => {
    if (action === 'inspect') return { installed: true, running: true, platform: { id: 'win32-x64', supported: true }, setup: { ownerConfigured: true } };
    if (action === 'connections-status') return { connections: { channels: [
      { channel: 'napcat', platformEnabled: true, platformId: 'qq', bound: true, health: 'connected', protocolConnected: true, targetIssue: '', platformCandidates: [] },
      { channel: 'official', platformEnabled: true, platformId: 'official-test', bound: false, health: 'connecting', protocolConnected: false, targetIssue: '', platformCandidates: [] },
    ] } };
    return settings;
  } });
  await app.settle();

  await app.settle();
  assert.match(app.html(), /id="officialOwnerUMO"/);
  assert.doesNotMatch(app.html(), /id="ownerQQ"/);
  assert.match(app.html(), /QQ 官方机器人/);
});

test('settings page shows recent local changes and restores one field with the real payload', async () => {
  const settings = { ownerQQ: '123456', platformId: 'qq', dashboardPort: 6199, dashboardPort: 6185, unusedLegacyToken: 'token', proactiveEnabled: false, configRevision: 'abcdef12' };
  const history = {
    format: 1,
    records: [{ id: '1700000000000000000-abcdef12', changedAt: 1700000000, changes: [{ field: 'proactiveEnabled', before: true, after: false }] }],
    migrationReceipt: { migrationVersion: 1, archivedFields: ['legacy_field'], verifiedAt: 1700000000 },
  };
  const app = renderApp({
    screen: 'settings',
    workspace: workspaceStatus(),
    invoke: async action => {
      if (action === 'inspect') return { installed: true, running: true, platform: { id: 'win32-x64', supported: true }, setup: { ownerConfigured: true } };
      if (action === 'settings-history') return history;
      if (action === 'workspace-status') return workspaceStatus();
      if (action === 'settings-get' || action === 'settings-save' || action === 'settings-restore-field') return settings;
      return {};
    },
  });
  await app.settle();
  assert.equal(app.calls.some(([action]) => action === 'settings-history'), false);
  app.toggle('settings-details', true);
  for (let i = 0; i < 8; i++) await app.settle();
  assert.match(app.html(), /最近修改/);
  assert.match(app.html(), /升级保护检查：迁移版本 1/);
  assert.match(app.html(), /恢复主动互动/);
  const restore = app.html().match(/data-action="settings-restore-field"[^>]*data-record="([^"]+)"[^>]*data-field="([^"]+)"/);
  assert.ok(restore);
  await app.clickWithDataset('settings-restore-field');
  await app.settle();
  const call = app.calls.filter(([action]) => action === 'settings-restore-field').at(-1);
  assert.deepEqual(call[1], {
    recordId: '1700000000000000000-abcdef12',
    field: 'proactiveEnabled',
    expectedRevision: 'abcdef12',
  });
  assert.ok(app.calls.filter(([action]) => action === 'settings-history').length >= 2);
});

test('controller merges pushed official health and connection snapshots into the view source', async () => {
  const model = load();
  let listener;
  const bridge = {
    onState: callback => { listener = callback; return () => {}; },
    invoke: async action => {
      if (action === 'inspect') return { installed: true, running: true, platform: { id: 'darwin-arm64', supported: true }, setup: {} };
      if (action === 'workspace-status') return {
        health: null, backups: [], appUpdate: {}, napcat: { running: true, loginState: 'online', protocolConnected: true },
        official: { protocolConnected: false }, preferences: { tray: false, startAtLogin: false, resumeAfterWake: false }, diagnosticFiles: [],
      };
      if (action === 'settings-get') return { qqConnectionMode: 'official', officialConfigured: true, officialOwnerUMO: 'official-test:FriendMessage:OPAQUE', configRevision: 'abcdef12' };
      return {};
    },
  };
  const controller = model.createController({ bridge });
  await controller.init();
  await controller.act('settings-get');

  assert.equal(model.connectionViewModel(controller.get()).stage, 'official-connecting');
  listener({ workspace: { official: { protocolConnected: true } } });
  assert.equal(model.connectionViewModel(controller.get()).stage, 'ready');
  assert.deepEqual(controller.get().workspace.official, { protocolConnected: true });
  listener({ workspace: { official: { protocolConnected: false } } });
  assert.equal(model.connectionViewModel(controller.get()).stage, 'official-connecting');
  // The pushed official health is authoritative when it carries a boolean;
  // a connection snapshot alone is the fallback source.
  listener({ connections: { channels: [{ channel: 'official', protocolConnected: true, health: 'connected' }] } });
  assert.deepEqual(controller.get().connections.channels[0].channel, 'official');
  assert.equal(model.connectionViewModel(controller.get()).stage, 'official-connecting');
  listener({ workspace: { official: null } });
  assert.equal(model.connectionViewModel(controller.get()).stage, 'ready');
});

test('controller allows concurrent read-only actions but keeps the mutation fence', async () => {
  const model = load();
  let releaseWorkspace;
  const bridge = {
    onState: () => () => {},
    invoke: async action => {
      if (action === 'workspace-status') {
        await new Promise(resolve => { releaseWorkspace = () => resolve({ health: null, backups: [], appUpdate: {}, napcat: {}, preferences: {}, diagnosticFiles: [] }); });
        return { health: null, backups: [], appUpdate: {}, napcat: {}, preferences: {}, diagnosticFiles: [] };
      }
      if (action === 'settings-get') return { configRevision: 'abcdef12' };
      return {};
    },
  };
  const controller = model.createController({ bridge });
  const first = controller.act('workspace-status');
  for (let attempt = 0; attempt < 50 && typeof releaseWorkspace !== 'function'; attempt += 1) await new Promise(resolve => setImmediate(resolve));
  assert.equal(typeof releaseWorkspace, 'function');
  const settings = await controller.act('settings-get');
  assert.ok(settings && typeof settings === 'object');
  await assert.rejects(controller.act('settings-save', { patch: { dashboardPort: 6285 } }), /上一项操作/);
  releaseWorkspace();
  await first;
  assert.equal(controller.get().pending, '');
  await controller.act('settings-save', { patch: { dashboardPort: 6285 } });
});


test('official state uses the resolved target and per-instance credentials, not the enabled flag', () => {
  const model = load();
  const snapshotView = (...args) => model.connectionViewModel(officialSnapshotData(...args));

  const disabled = snapshotView(
    [{ id: 'bot', type: 'qq_official', enable: false, configured: true }],
    { bound: true, boundId: 'bot', configured: false },
  );
  assert.equal(disabled.stage, 'official-disabled');

  const enabledUnbound = snapshotView(
    [{ id: 'bot', type: 'qq_official', enable: true, configured: true }],
    { configured: true },
  );
  assert.equal(enabledUnbound.stage, 'official-owner');

  const ambiguous = snapshotView(
    [
      { id: 'bot-a', type: 'qq_official', enable: true, configured: true },
      { id: 'bot-b', type: 'qq_official', enable: true, configured: true },
    ],
    { configured: true },
  );
  assert.equal(ambiguous.stage, 'official-owner');
  assert.match(ambiguous.title, /绑定/);

  const missingBound = snapshotView(
    [{ id: 'new-bot', type: 'qq_official', enable: true, configured: true }],
    { bound: true, boundId: 'removed-bot', configured: true },
  );
  assert.equal(missingBound.stage, 'official-owner');
  assert.match(missingBound.title, /重新绑定/);

  const none = snapshotView([], { configured: false });
  assert.equal(none.stage, 'official-setup');
});

test('official target problems never render as an explicitly disabled connection', async () => {
  const model = load();
  const data = officialSnapshotData(
    [
      { id: 'bot-a', type: 'qq_official', enable: true, configured: true },
      { id: 'bot-b', type: 'qq_official', enable: true, configured: true },
    ],
    { configured: true },
  );
  data.connections.channels.find(item => item.channel === 'official').bound = false;
  assert.notEqual(model.connectionViewModel(data).stage, 'official-disabled');

  const app = renderApp({
    screen: 'connect',
    workspace: workspaceStatus({ official: { protocolConnected: true } }),
    invoke: async action => {
      if (action === 'inspect') return { installed: true, running: true, platform: { id: 'win32-x64', supported: true }, setup: { ownerConfigured: true } };
      if (action === 'connections-status') return { connections: data.connections };
      if (action === 'settings-history') return { format: 1, records: [], migrationReceipt: null };
      return data.settings;
    },
  });
  await app.settle();
  const officialCard = app.html().match(/<section class="card connection-main"[\s\S]*?<\/section>/)?.[0] || '';
  assert.match(officialCard, /待确认|待绑定/);
  assert.doesNotMatch(officialCard, /已停用/);
  assert.match(officialCard, /检测到多个官方机器人平台/);
});

test('a resolved official target uses only its own credentials, never a sibling platform', () => {
  const model = load();
  const data = officialSnapshotData(
    [
      { id: 'official-a', type: 'qq_official', enable: true, configured: false },
      { id: 'official-b', type: 'qq_official', enable: false, configured: true },
    ],
    { bound: true, boundId: 'official-a', configured: false },
  );
  assert.equal(data.connections.channels.find(item => item.channel === 'official').platformId, 'official-a');
  assert.equal(model.connectionViewModel(data).stage, 'official-setup');
  assert.equal(model.connectionViewModel(data).action, 'open-panel');
  data.workspace.official = { protocolConnected: false };
  assert.equal(model.connectionViewModel(data).stage, 'official-setup');
  data.workspace.official = { protocolConnected: true };
  assert.equal(model.connectionViewModel(data).stage, 'official-setup');

  const stoppedTarget = officialSnapshotData(
    [
      { id: 'official-a', type: 'qq_official', enable: false, configured: false },
      { id: 'official-b', type: 'qq_official', enable: true, configured: true },
    ],
    { bound: true, boundId: 'official-a', configured: false },
  );
  assert.equal(model.connectionViewModel(stoppedTarget).stage, 'official-setup');
  assert.notEqual(model.connectionViewModel(stoppedTarget).stage, 'official-disabled');
});

test('unresolved targets with no enabled configured candidate guide configuration before binding', () => {
  const model = load();
  const ambiguous = officialSnapshotData(
    [
      { id: 'official-a', type: 'qq_official', enable: false, configured: true },
      { id: 'official-b', type: 'qq_official', enable: false, configured: true },
    ],
    { configured: false },
  );
  const ambiguousView = model.connectionViewModel(ambiguous);
  assert.equal(ambiguousView.stage, 'official-target');
  assert.equal(ambiguousView.action, 'open-panel');
  assert.doesNotMatch(JSON.stringify(ambiguousView), /保存私聊绑定|save-settings/);

  const missingBound = officialSnapshotData(
    [{ id: 'replacement-bot', type: 'qq_official', enable: false, configured: true }],
    { bound: true, boundId: 'removed-bot', configured: false },
  );
  const missingView = model.connectionViewModel(missingBound);
  assert.equal(missingView.stage, 'official-target');
  assert.equal(missingView.action, 'open-panel');
  assert.doesNotMatch(JSON.stringify(missingView), /保存私聊绑定|save-settings/);

  const enabledAmbiguous = officialSnapshotData(
    [
      { id: 'official-a', type: 'qq_official', enable: true, configured: true },
      { id: 'official-b', type: 'qq_official', enable: false, configured: true },
    ],
    { configured: true },
  );
  assert.equal(model.connectionViewModel(enabledAmbiguous).stage, 'official-owner');
  assert.equal(model.connectionViewModel(enabledAmbiguous).action, 'save-settings');

  const enabledReplacement = officialSnapshotData(
    [{ id: 'replacement-bot', type: 'qq_official', enable: true, configured: true }],
    { bound: true, boundId: 'removed-bot', configured: true },
  );
  assert.equal(model.connectionViewModel(enabledReplacement).stage, 'official-owner');
  assert.match(model.connectionViewModel(enabledReplacement).title, /重新绑定/);
});

test('all-disabled target guidance hides the binding form and missing-bound timeline says rebind', async () => {
  const model = load();
  const data = officialSnapshotData(
    [
      { id: 'official-a', type: 'qq_official', enable: false, configured: true },
      { id: 'official-b', type: 'qq_official', enable: false, configured: true },
    ],
    { configured: false },
  );
  data.settings.qqConnectionMode = 'official';
  const app = renderApp({
    screen: 'connect',
    workspace: workspaceStatus({ official: { protocolConnected: true } }),
    invoke: async action => {
      if (action === 'inspect') return { installed: true, running: true, platform: { id: 'win32-x64', supported: true }, setup: { ownerConfigured: true } };
      if (action === 'connections-status') return { connections: data.connections };
      if (action === 'settings-history') return { format: 1, records: [], migrationReceipt: null };
      return data.settings;
    },
  });
  await app.settle();
  assert.match(app.html(), /先启用官方机器人实例/);
  assert.match(app.html(), /data-action="open-panel"/);
  assert.doesNotMatch(app.html(), /id="officialOwnerUMO"/);

  const missing = officialSnapshotData(
    [{ id: 'replacement-bot', type: 'qq_official', enable: true, configured: true }],
    { bound: true, boundId: 'removed-bot', configured: true },
  );
  assert.equal(model.connectionViewModel(missing).stage, 'official-owner');
  missing.settings.qqConnectionMode = 'official';
  const missingApp = renderApp({
    screen: 'connect',
    workspace: workspaceStatus({ official: { protocolConnected: false } }),
    invoke: async action => {
      if (action === 'inspect') return { installed: true, running: true, platform: { id: 'win32-x64', supported: true }, setup: { ownerConfigured: true } };
      if (action === 'connections-status') return { connections: missing.connections };
      if (action === 'settings-history') return { format: 1, records: [], migrationReceipt: null };
      return missing.settings;
    },
  });
  await missingApp.settle();
  assert.match(missingApp.html(), /绑定失效，等待重新绑定/);
});

test('a resolved unconfigured target keeps setup and never claims a live gateway', async () => {
  const data = officialSnapshotData(
    [
      { id: 'official-a', type: 'qq_official', enable: true, configured: false },
      { id: 'official-b', type: 'qq_official', enable: false, configured: true },
    ],
    { bound: true, boundId: 'official-a', configured: false },
  );
  data.settings.qqConnectionMode = 'official';
  const app = renderApp({
    screen: 'connect',
    workspace: workspaceStatus({ official: { protocolConnected: true } }),
    invoke: async action => {
      if (action === 'inspect') return { installed: true, running: true, platform: { id: 'win32-x64', supported: true }, setup: { ownerConfigured: true } };
      if (action === 'connections-status') return { connections: data.connections };
      if (action === 'settings-history') return { format: 1, records: [], migrationReceipt: null };
      return data.settings;
    },
  });
  await app.settle();
  assert.match(app.html(), /创建或连接 QQ 官方机器人/);
  assert.match(app.html(), /等待完成配置/);
  assert.doesNotMatch(app.html(), /网关已连接/);
  const officialCard = app.html().match(/<section class="card connection-main"[\s\S]*?<\/section>/)?.[0] || '';
  assert.match(officialCard, /待配置/);
  assert.match(officialCard, /等待完成配置/);
  assert.doesNotMatch(officialCard, /消息连接[\s\S]*已连接/);
});

test('blocked binding guidance does not advertise a future owner binding step', async () => {
  const data = officialSnapshotData(
    [
      { id: 'official-a', type: 'qq_official', enable: false, configured: true },
      { id: 'official-b', type: 'qq_official', enable: false, configured: true },
    ],
    { configured: false },
  );
  data.settings.qqConnectionMode = 'official';
  const app = renderApp({
    screen: 'connect',
    workspace: workspaceStatus({ official: { protocolConnected: true } }),
    invoke: async action => {
      if (action === 'inspect') return { installed: true, running: true, platform: { id: 'win32-x64', supported: true }, setup: { ownerConfigured: true } };
      if (action === 'connections-status') return { connections: data.connections };
      if (action === 'settings-history') return { format: 1, records: [], migrationReceipt: null };
      return data.settings;
    },
  });
  await app.settle();
  assert.match(app.html(), /先启用官方机器人实例/);
  assert.match(app.html(), /待实例启用后绑定/);
  assert.doesNotMatch(app.html(), /等待复制会话 ID/);
});

test('an interrupted pending update keeps the primary Update action visible without download flags',async()=>{
 const appUpdate={...workspaceStatus().appUpdate,phase:'install-ready',targetVersion:'0.4.0a1',canDownload:false,canInstall:false};
 const app=renderApp({screen:'settings',workspace:workspaceStatus({appUpdate}),invoke:async action=>action==='inspect'?{installed:true}:{appUpdate}});
 await app.settle();
 assert.equal((app.html().match(/data-action="app-update-start"/g)||[]).length,1);
 await app.click('app-update-start');
 assert.equal(app.calls.some(([action])=>action==='app-update-start'),true);
});

function officialSnapshotData(platforms, { bound = false, boundId = '', configured = false } = {}) {
  const qqConnections = require('../lib/official-connection.cjs');
  const data = connectionData({
    state: { running: true },
    settings: {
      qqConnectionMode: 'official',
      officialConfigured: configured,
      officialOwnerUMO: bound ? 'bound-bot:FriendMessage:OPAQUE' : '',
    },
  });
  data.connections = qqConnections.snapshot({
    platforms,
    bindings: { official: bound },
    boundPlatformIds: { official: boundId },
    health: { official: { state: 'connected', protocolConnected: true } },
  });
  data.workspace.official = { protocolConnected: true };
  data.connectionTab = 'official';
  return data;
}


test('overview uses the initial official setup summary before loading private settings', async () => {
  const app = renderApp({
    screen: 'overview',
    workspace: workspaceStatus({ official: { configured: true, protocolConnected: true } }),
    invoke: async action => action === 'inspect' ? {
      installed: true, running: true,
      setup: { ownerConfigured: true, qqConfigured: true },
      workspace: { official: { configured: true, protocolConnected: true } },
    } : {},
  });
  await app.settle();
  assert.match(app.html(), /网关已连接/);
  assert.match(app.html(), /主人私聊<\/strong><span>已绑定/);
  assert.doesNotMatch(app.html(), /等待完成配置/);
  assert.equal(app.calls.some(([action]) => action === 'settings-get'), false);
});
