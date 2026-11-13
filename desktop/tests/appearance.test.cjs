'use strict';
// T5-I1/T5-I2: two-material appearance state, shared window geometry, and the
// rendering contract that keeps the native window chrome immersive.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { Appearance, AppearanceError, DEFAULTS } = require('../lib/appearance.cjs');
const chrome = require('../lib/window-chrome.cjs');
const model = require('../ui/model.js');

const root = path.resolve(__dirname, '../..');

test('appearance store defaults to frosted and persists one material with a revision', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dwhale-appearance-'));
  try {
    const store = new Appearance({ userData: directory });
    assert.deepEqual(await store.read(), { ...DEFAULTS });
    const saved = await store.save('liquid');
    assert.equal(saved.material, 'liquid');
    assert.equal(saved.revision, 1);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory, 'desktop-appearance.json'), 'utf8')), { format: 1, material: 'liquid', revision: 1 });
    const second = await store.save('frosted');
    assert.equal(second.material, 'frosted');
    assert.equal(second.revision, 2);
    assert.equal((await new Appearance({ userData: directory }).read()).material, 'frosted');
    await assert.rejects(store.save('glass'), AppearanceError);
    assert.equal((await store.read()).material, 'frosted', 'invalid input never rewrites the stored choice');
    fs.writeFileSync(path.join(directory, 'desktop-appearance.json'), '{broken');
    assert.deepEqual(await new Appearance({ userData: directory }).read(), { ...DEFAULTS }, 'corruption degrades to defaults, not a crash');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('window chrome shares one panel/toolbar contract and platform fallbacks', () => {
  assert.deepEqual(chrome.panelBounds({ width: 1220, height: 850 }), { x: 256, y: 52, width: 964, height: 798 });
  assert.deepEqual(chrome.panelBounds({ width: 980, height: 700 }), { x: 0, y: 52, width: 980, height: 648 });
  assert.equal(chrome.chromeFor('darwin').immersive, true);
  assert.equal(chrome.chromeFor('win32').immersive, true);
  assert.equal(chrome.chromeFor('linux').immersive, false);
  assert.deepEqual(chrome.browserWindowOptions('darwin'), { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 16 } });
  const win11 = chrome.browserWindowOptions('win32', '10.0.22621');
  assert.equal(win11.titleBarStyle, 'hidden');
  assert.equal(win11.titleBarOverlay.height, 40);
  assert.equal(win11.backgroundMaterial, 'mica');
  assert.equal(chrome.browserWindowOptions('win32', '10.0.19045').backgroundMaterial, undefined, 'Win10 keeps the in-app fallback');
  assert.deepEqual(chrome.browserWindowOptions('linux', '6.8.0'), {});
});

test('main and renderer use the shared contract instead of the removed 94px bar', () => {
  const main = fs.readFileSync(path.join(root, 'desktop/main.cjs'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'desktop/ui/app.js'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'desktop/ui/style.css'), 'utf8');
  assert.match(main, /windowChrome\.panelBounds/);
  assert.match(main, /browserWindowOptions\(process\.platform/);
  assert.match(app, /window-drag/);
  assert.doesNotMatch(app, /<header class="topbar">/);
  assert.match(css, /--header:\s*0px/);
  assert.match(css, /\.panel-toolbar\s*\{\s*height:\s*52px/);
  assert.match(css, /data-material="liquid"/);
  assert.match(css, /prefers-reduced-transparency/);
  assert.match(css, /background:\s*radial-gradient/);
});

function renderSettings(invoke, state = {}) {
  const handlers = {};
  const page = { scrollTop: 0, focus() {} };
  const documentElement = { attrs: {}, setAttribute(name, value) { this.attrs[name] = value; } };
  const body = {};
  const announcer = { textContent: '' };
  let markup = '';
  const rootNode = {
    get innerHTML() { return markup; },
    set innerHTML(value) { markup = value; document.activeElement = body; },
    addEventListener(name, callback) { handlers[name] = callback; },
    querySelectorAll() { return []; },
  };
  const document = {
    documentElement, body, activeElement: body,
    getElementById(id) { return id === 'app' ? rootNode : id === 'announcer' ? announcer : id === 'main-content' ? page : null; },
    querySelector() { return page; },
  };
  const bridge = { invoke: async (action, payload) => action === 'workspace-status' ? { health: null, backups: [], appUpdate: null, napcat: null, preferences: {}, diagnosticFiles: [] } : invoke(action, payload), onState() { return () => {}; } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../ui/app.js'), 'utf8'), { window: { DSWhaleUI: model, dswhale: bridge, addEventListener() {} }, document, location: { search: '?screen=settings' }, URLSearchParams });
  return { html: () => markup, attrs: documentElement.attrs, settle: () => new Promise(resolve => setImmediate(resolve)) };
}

test('settings shows exactly two material cards and applies the saved choice', async () => {
  const app = renderSettings(async action => {
    if (action === 'inspect') return { installed: true, running: false, phase: 'ready', platform: { id: 'darwin' }, setup: {}, appearance: { format: 1, material: 'liquid', revision: 3 } };
    if (action === 'settings-get') return { dashboardPort: 6185 };
    if (action === 'extensions-status') return {};
    return {};
  });
  for (let i = 0; i < 12; i += 1) await app.settle();
  const html = app.html();
  assert.match(html, /<h2 id="appearance-title">外观<\/h2>/);
  assert.match(html, /毛玻璃/);
  assert.match(html, /液态玻璃/);
  assert.equal((html.match(/data-action="appearance-select"/g) || []).length, 2);
  assert.match(html, /data-material="liquid"[^>]*aria-checked="true"|aria-checked="true"[^>]*data-material="liquid"/);
  assert.equal(app.attrs['data-material'], 'liquid');
  assert.doesNotMatch(html, /page-context/);
  assert.doesNotMatch(html, /class="topbar"/);
});

test('R9/R10/R11: platform inset, dark reduced transparency and liquid edge optics', async () => {
  const app = fs.readFileSync(path.join(root, 'desktop/ui/app.js'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'desktop/ui/style.css'), 'utf8');
  const main = fs.readFileSync(path.join(root, 'desktop/main.cjs'), 'utf8');
  assert.match(app, /data\.state\.platform\?\.id \|\| data\.state\.chrome\?\.platform/);
  assert.match(css, /padding-right:\s*max\(var\(--controls-inset\)/);
  assert.match(css, /height:\s*var\(--titlebar-height\)/);
  assert.match(css, /@media \(prefers-reduced-transparency: reduce\) and \(prefers-color-scheme: dark\)/);
  assert.match(css, /--surface:\s*#1b2a3e/);
  assert.match(css, /--muted:\s*#b1bfd3/);
  assert.match(css, /--surface-highlight:\s*inset 0 1px 0 rgba\(255, 255, 255, \.98\)/);
  assert.match(css, /--surface-blur:\s*9px/);
  assert.match(css, /--surface-blur:\s*18px/);
  assert.deepEqual(chrome.titleBarOverlay(true), { color: '#00000000', symbolColor: '#dbe6f6', height: 40 });
  assert.deepEqual(chrome.titleBarOverlay(false), { color: '#00000000', symbolColor: '#475569', height: 40 });
  assert.match(main, /setTitleBarOverlay\(windowChrome\.titleBarOverlay\(nativeTheme\.shouldUseDarkColors\)\)/);

  const rgb = hex => [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16) / 255).map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  const luminance = value => 0.2126 * value[0] + 0.7152 * value[1] + 0.0722 * value[2];
  const ratio = (foreground, background) => {
    const values = rgb(foreground).map((_, index) => [luminance(rgb(foreground)), luminance(rgb(background))]).sort((a, b) => b - a);
    return (values[0][0] + 0.05) / (values[0][1] + 0.05);
  };
  assert.ok(ratio('#b1bfd3', '#1b2a3e') >= 4.5, `dark reduced-transparency body contrast ${ratio('#b1bfd3', '#1b2a3e').toFixed(2)}:1`);
  assert.ok(ratio('#e4edf8', '#1b2a3e') >= 4.5);

  const rendered = renderSettings(async action => {
    if (action === 'inspect') return { installed: true, running: false, phase: 'ready', platform: { id: 'win32-x64' }, setup: {}, appearance: { format: 1, material: 'liquid', revision: 3 } };
    if (action === 'settings-get') return { dashboardPort: 6185 };
    if (action === 'extensions-status') return {};
    return {};
  });
  for (let i = 0; i < 12; i += 1) await rendered.settle();
  assert.equal(rendered.attrs['data-platform'], 'win32');
});
