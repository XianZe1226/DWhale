'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const model = require('../ui/model.js');

function settingsFixture({ phase = 'ready', failSave = false, fastDOM = false, delaySave = false } = {}) {
  const handlers = {};
  const attrs = {};
  const page = { scrollTop: 0, focus() {} };
  const body = {};
  let markup = '';
  let writes = 0;
  let options = [];
  const status = { textContent: '', classList: { toggle() {} } };
  let finishSave;
  const saveGate = new Promise(resolve => { finishSave = resolve; });
  const root = { get innerHTML() { return markup; }, set innerHTML(value) {
    markup = value; writes += 1;
    options = [...value.matchAll(/<button\b[^>]*data-action="appearance-select"[^>]*>/g)].map(([html]) => {
      const values = Object.fromEntries([...html.matchAll(/([\w-]+)="([^"]*)"/g)].map(([, key, value]) => [key, value]));
      return { dataset: { material: values['data-material'] }, setAttribute(name, value) { values[name] = value; }, getAttribute(name) { return values[name]; } };
    });
  }, addEventListener(name, callback) { handlers[name] = callback; }, querySelectorAll(selector) { return selector === '[data-action="appearance-select"]' ? options : []; } };
  if (fastDOM) root.querySelector = selector => selector === '#appearance-state' ? status : null;
  const document = { body, activeElement: body, documentElement: { setAttribute(name, value) { attrs[name] = value; } }, getElementById(id) { return id === 'app' ? root : id === 'announcer' ? {} : page; }, querySelector() { return page; } };
  const bridge = {
    onState() { return () => {}; },
    async invoke(action, payload) {
      if (action === 'inspect') return { installed: true, running: true, phase, platform: { id: 'win32-x64', supported: true }, appearance: { format: 1, material: 'frosted', revision: 1 }, setup: {} };
      if (action === 'workspace-status') return { appUpdate: { currentVersion: '0.4.0a2', phase: 'idle' }, preferences: {}, backups: [], diagnosticFiles: [] };
      if (action === 'settings-get') return { dashboardPort: 6185 };
      if (action === 'settings-history') return { records: [] };
      if (action === 'appearance-save') {
        if (delaySave) await saveGate;
        if (failSave) throw new Error('外观设置未保存，请重试');
        return { format: 1, material: payload.material, revision: 2 };
      }
      return {};
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../ui/app.js'), 'utf8'), { window: { DSWhaleUI: model, dswhale: bridge, addEventListener() {} }, document, location: { search: '?screen=settings' }, URLSearchParams });
  return { html: () => markup, attrs, writes: () => writes, options: () => options, status, finishSave, async settle() { for (let i = 0; i < 12; i++) await new Promise(setImmediate); }, click(material) { return handlers.click({ target: { disabled: false, dataset: { action: 'appearance-select', material }, closest() { return this; } } }); } };
}

test('appearance stays selectable during environment work and shows local save failure', async () => {
  const fixture = settingsFixture({ phase: 'installing', failSave: true });
  await fixture.settle();
  const choices = [...fixture.html().matchAll(/<button\b[^>]*data-action="appearance-select"[^>]*>/g)].map(match => match[0]);
  assert.equal(choices.length, 2);
  assert.ok(choices.every(button => !/\sdisabled(?:\s|>)/.test(button)));
  await fixture.click('liquid');
  await fixture.settle();
  assert.equal(fixture.attrs['data-material'], 'frosted');
  assert.match(fixture.html(), /id="appearance-state"[^>]*[\s\S]*?外观设置未保存/);
  assert.doesNotMatch(fixture.html(), /class="alert error"/);
});

test('settings opens with compact material choices and collapsed technical details', async () => {
  const fixture = settingsFixture();
  await fixture.settle();
  assert.match(fixture.html(), /class="appearance-heading"/);
  const details = fixture.html().match(/<details\b[^>]*id="settings-details"[^>]*>/)?.[0];
  assert.ok(details);
  assert.doesNotMatch(details, /\sopen(?:\s|>)/);
  assert.match(fixture.html(), /版本与诊断/);
});

test('liquid material has no document-wide pointer animation loop', () => {
  const script = fs.readFileSync(path.join(__dirname, '../ui/app.js'), 'utf8');
  assert.doesNotMatch(script, /document\.addEventListener\('pointermove'/);
});


test('appearance changes patch the selected radio without rebuilding the page', async () => {
  const fixture = settingsFixture({ fastDOM: true, delaySave: true });
  await fixture.settle();
  const initialWrites = fixture.writes();
  const originalOptions = fixture.options();
  const save = fixture.click('liquid');
  assert.equal(fixture.attrs['data-material'], 'liquid');
  assert.equal(fixture.status.textContent, '正在保存…');
  assert.equal(originalOptions[1].getAttribute('aria-checked'), 'true');
  assert.equal(originalOptions[1].getAttribute('tabindex'), '0');
  assert.equal(fixture.writes(), initialWrites);
  fixture.finishSave();
  await save;
  assert.equal(fixture.status.textContent, '选择后自动保存');
  assert.equal(fixture.options(), originalOptions);
  assert.equal(fixture.writes(), initialWrites);
});

test('appearance save failure patches the committed radio and keeps the page intact', async () => {
  const fixture = settingsFixture({ fastDOM: true, failSave: true });
  await fixture.settle();
  const initialWrites = fixture.writes();
  await fixture.click('liquid');
  assert.equal(fixture.attrs['data-material'], 'frosted');
  assert.equal(fixture.options()[0].getAttribute('aria-checked'), 'true');
  assert.match(fixture.status.textContent, /未保存/);
  assert.equal(fixture.writes(), initialWrites);
});


test('background connection health uses the configured field exported by the backend', () => {
  const main = fs.readFileSync(path.join(__dirname, '../main.cjs'), 'utf8');
  const backend = fs.readFileSync(path.join(__dirname, '../../dswhale/desktop_settings.py'), 'utf8');
  assert.match(backend, /"qqConfigured": value\["officialConfigured"\]/);
  assert.match(main, /officialHealthStatus\(state\.setup\?\.qqConfigured === true\)/);
});
