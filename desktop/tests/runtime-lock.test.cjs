'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const lock = require('../lib/runtime-lock.cjs');

const repositoryLock = path.resolve(__dirname, '../../runtime-lock.json');

test('the shipped lock is the single validated runtime matrix', async () => {
  const value = lock.load(repositoryLock);
  assert.equal(value.product, 'DWhale');
  assert.equal(value.runtime.astrbot, '4.29.4');
  assert.equal(value.legacy.astrbot, '4.29.3');
  assert.match(value.digest, /^[a-f0-9]{64}$/);
  assert.equal(value.digest, lock.digest(await fs.readFile(repositoryLock)));
  assert.deepEqual(Object.keys(value.runtime).sort(), ['astrbot', 'ffmpeg', 'node', 'python']);
});

test('the lock rejects a foreign runtime, product and unsafe source', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dswhale-lock-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const valid = JSON.parse(await fs.readFile(repositoryLock, 'utf8'));
  for (const change of [
    { product: 'DSWhale' },
    { source: 'http://pypi.org/project/astrbot/' },
    { runtime: { ...valid.runtime, astrbot: 'latest' } },
    { runtime: { ...valid.runtime, extra: '24.0.0' } },
    { format: 2 },
    { ignored: true },
  ]) {
    const file = path.join(directory, 'runtime-lock.json');
    await fs.writeFile(file, JSON.stringify({ ...valid, ...change }));
    assert.throws(() => lock.load(file), { code: 'RUNTIME_LOCK_INVALID' });
  }
});

test('digest changes when the pinned AstrBot version changes', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dswhale-lock-digest-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const valid = JSON.parse(await fs.readFile(repositoryLock, 'utf8'));
  valid.runtime.astrbot = '4.29.5';
  const file = path.join(directory, 'runtime-lock.json');
  await fs.writeFile(file, JSON.stringify(valid));
  const changed = lock.load(file);
  const shipped = lock.load(repositoryLock);
  assert.notEqual(changed.digest, shipped.digest);
});
