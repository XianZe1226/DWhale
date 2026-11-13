'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createController } = require('../ui/model.js');
const { Appearance, AppearanceError } = require('../lib/appearance.cjs');

const appearance = (material, revision) => ({ format: 1, material, revision });
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function controller(invoke, initial = appearance('frosted', 4)) {
  let listener;
  const value = createController({ bridge: {
    invoke: (action, payload) => action === 'inspect' ? Promise.resolve({ installed: true, appearance: initial })
      : action === 'workspace-status' ? Promise.resolve({}) : invoke(action, payload),
    onState(callback) { listener = callback; return () => {}; },
  } });
  return { value, publish: state => listener(state) };
}

test('initial inspect and state pushes reconcile the effective material by revision', async () => {
  const h = controller(async () => ({}), appearance('liquid', 7));
  await h.value.init();
  assert.deepEqual(h.value.get().appearance, appearance('liquid', 7));
  h.publish({ appearance: appearance('frosted', 8) });
  assert.deepEqual(h.value.get().appearance, appearance('frosted', 8));
  h.publish({ running: true, appearance: appearance('liquid', 7) });
  assert.deepEqual(h.value.get().appearance, appearance('frosted', 8));
  assert.deepEqual(h.value.get().state.appearance, appearance('frosted', 8));
  assert.equal(h.value.get().state.running, true, 'unrelated live state still merges');
});

for (const action of ['start', 'settings-get']) {
  test(`appearance saves during ${action} without releasing its operation fence`, async () => {
    const gate = deferred();
    const h = controller(async name => name === action ? gate.promise : appearance('liquid', 5));
    await h.value.init();
    const pending = h.value.act(action);
    const save = h.value.act('appearance-save', { material: 'liquid' });
    try {
      await save;
      assert.equal(h.value.get().appearance.material, 'liquid');
      assert.equal(h.value.get().pending, action === 'start' ? 'start' : '');
      await assert.rejects(h.value.act('stop'), /仍在进行/);
    } finally { gate.resolve({ running: true }); await pending; }
    assert.equal(h.value.get().pending, '');
  });
}

test('appearance preview is immediate and does not block a real settings save', async () => {
  const gate = deferred();
  const settings = { dashboardPort: 6185, persona: '合成人格', configRevision: 'abcdef12' };
  const h = controller(async action => action === 'appearance-save' ? gate.promise : settings);
  await h.value.init();
  await h.value.act('settings-get');
  const save = h.value.act('appearance-save', { material: 'liquid' });
  assert.equal(h.value.get().appearance.material, 'liquid');
  assert.equal(h.value.get().state.appearance.material, 'frosted');
  assert.equal(h.value.get().appearancePending, true);
  assert.equal(h.value.get().pending, '');
  await h.value.act('settings-save', { patch: { dashboardPort: 6186 }, expectedRevision: 'abcdef12' });
  gate.resolve(appearance('liquid', 5));
  await save;
  assert.equal(h.value.get().appearancePending, false);
  assert.equal(h.value.get().settings.persona, '合成人格');
});

test('rapid switches retain the last preview and persist the last choice across reload', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dwhale-material-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new Appearance({ userData: directory });
  const gates = [deferred(), deferred()];
  let writes = 0;
  const h = controller(async (action, payload) => {
    if (action !== 'appearance-save') return {};
    const index = writes++;
    await gates[index].promise;
    const result = await store.save(payload.material);
    h.publish({ appearance: result });
    return result;
  }, appearance('frosted', 0));
  await h.value.init();
  const first = h.value.act('appearance-save', { material: 'liquid' });
  const last = h.value.act('appearance-save', { material: 'frosted' });
  assert.equal(h.value.get().appearance.material, 'frosted');
  await tick();
  gates[0].resolve();
  await first;
  assert.equal(h.value.get().appearance.material, 'frosted', 'intermediate IPC publication keeps the latest preview');
  assert.deepEqual(h.value.get().state.appearance, appearance('liquid', 1));
  assert.equal(h.value.get().appearancePending, true);
  gates[1].resolve();
  await last;
  assert.deepEqual(h.value.get().appearance, appearance('frosted', 2));
  assert.deepEqual(await new Appearance({ userData: directory }).read(), appearance('frosted', 2));
  h.publish({ appearance: appearance('liquid', 1) });
  assert.deepEqual(h.value.get().appearance, appearance('frosted', 2));
});

test('latest save failure restores the last committed material and keeps failure local', async () => {
  const firstGate = deferred(), lastGate = deferred();
  let writes = 0;
  const h = controller(async action => {
    if (action === 'appearance-save') return ++writes === 1 ? firstGate.promise : lastGate.promise;
    if (action === 'install') throw new Error('合成环境失败');
    return {};
  });
  await h.value.init();
  await assert.rejects(h.value.act('install'), /合成环境失败/);
  const feedback = h.value.get().feedback, retry = h.value.get().retry;
  const first = h.value.act('appearance-save', { material: 'liquid' });
  const last = h.value.act('appearance-save', { material: 'frosted' });
  const rejected = assert.rejects(last, /外观未保存/);
  firstGate.resolve(appearance('liquid', 5));
  await first;
  lastGate.reject(new Error('外观未保存'));
  await rejected;
  assert.deepEqual(h.value.get().appearance, appearance('liquid', 5));
  assert.deepEqual(h.value.get().state.appearance, appearance('liquid', 5));
  assert.equal(h.value.get().appearancePending, false);
  assert.equal(h.value.get().appearanceError, '外观未保存');
  assert.equal(h.value.get().error, '合成环境失败');
  assert.equal(h.value.get().feedback, feedback);
  assert.equal(h.value.get().retry, retry);
});

test('a superseded failed save keeps the latest preview and the write queue recovers', async () => {
  const firstGate = deferred(), lastGate = deferred();
  let writes = 0;
  const h = controller(async () => ++writes === 1 ? firstGate.promise : lastGate.promise);
  await h.value.init();
  const first = h.value.act('appearance-save', { material: 'liquid' });
  const rejected = assert.rejects(first, /合成写入失败/);
  const last = h.value.act('appearance-save', { material: 'frosted' });
  firstGate.reject(new Error('合成写入失败'));
  await rejected;
  assert.equal(h.value.get().appearance.material, 'frosted');
  assert.equal(h.value.get().appearanceError, '');
  assert.equal(h.value.get().appearancePending, true);
  lastGate.resolve(appearance('frosted', 5));
  await last;
  assert.deepEqual(h.value.get().appearance, appearance('frosted', 5));
  assert.equal(h.value.get().appearancePending, false);
});

test('a delayed appearance read cannot overwrite a newer committed save', async () => {
  const readGate = deferred();
  const h = controller(async action => action === 'appearance-get' ? readGate.promise : appearance('liquid', 5));
  await h.value.init();
  const read = h.value.act('appearance-get');
  await h.value.act('appearance-save', { material: 'liquid' });
  readGate.resolve(appearance('frosted', 4));
  await read;
  assert.deepEqual(h.value.get().appearance, appearance('liquid', 5));
  assert.deepEqual(h.value.get().state.appearance, appearance('liquid', 5));
});

test('appearance directory failures are classified without exposing local paths', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dwhale-material-failure-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const occupied = path.join(directory, 'occupied');
  fs.writeFileSync(occupied, 'synthetic');
  await assert.rejects(new Appearance({ userData: occupied }).save('liquid'), error => {
    assert.ok(error instanceof AppearanceError);
    assert.equal(error.code, 'APPEARANCE_SAVE');
    assert.equal(error.message.includes(directory), false);
    return true;
  });
});
