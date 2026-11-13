'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const migration = require('../lib/mac-migration.cjs');

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dwhale-mac-migration-'));
  const home = path.join(root, 'home');
  const current = path.join(home, 'Applications', 'DWhale.app');
  const legacy = path.join(home, 'Applications', 'DSWhale.app');
  const userData = path.join(root, 'user-data');
  await fs.mkdir(current, { recursive: true });
  await fs.mkdir(legacy, { recursive: true });
  const prompts = [];
  const trashed = [];
  const dialog = { showMessageBox: async options => { prompts.push(options); return { response: 0 }; } };
  const shell = { trashItem: async target => { trashed.push(target); } };
  const branding = {
    sameBundlePath: (a, b) => path.resolve(a) === path.resolve(b),
    macBundleCandidates: () => [
      { path: current, legacy: false },
      { path: legacy, legacy: true },
    ],
  };
  return { root, home, current, legacy, userData, prompts, trashed, dialog, shell, branding };
}

const base = env => ({
  currentBundle: env.current,
  home: env.home,
  userData: env.userData,
  dialog: env.dialog,
  shell: env.shell,
  branding: env.branding,
  packaged: true,
  platform: 'darwin',
  run: async () => ({ stdout: 'dev.dswhale.desktop\n' }),
});

test('trashes the exact legacy bundle once and reuses the envelope', async () => {
  const env = await fixture();
  await migration.migrateLegacyBundles(base(env));
  assert.equal(env.prompts.length, 1);
  assert.deepEqual(env.trashed, [env.legacy]);
  const record = JSON.parse(await fs.readFile(path.join(env.userData, 'legacy-bundle-choice.json'), 'utf8'));
  assert.equal(record.format, 1);
  assert.equal(record.choices[env.legacy], 'trashed');
  await migration.migrateLegacyBundles(base(env));
  assert.equal(env.prompts.length, 1);
});

test('keeps a bundle without trashing it and does not reprompt', async () => {
  const env = await fixture();
  env.dialog.showMessageBox = async options => { env.prompts.push(options); return { response: 1 }; };
  await migration.migrateLegacyBundles(base(env));
  assert.equal(env.trashed.length, 0);
  const record = JSON.parse(await fs.readFile(path.join(env.userData, 'legacy-bundle-choice.json'), 'utf8'));
  assert.equal(record.choices[env.legacy], 'kept');
  await migration.migrateLegacyBundles(base(env));
  assert.equal(env.prompts.length, 1);
});

test('never offers a foreign bundle id or a non-durable current bundle', async () => {
  const foreign = await fixture();
  await migration.migrateLegacyBundles({ ...base(foreign), run: async () => ({ stdout: 'com.example.other\n' }) });
  assert.equal(foreign.prompts.length, 0);
  assert.equal(foreign.trashed.length, 0);

  const mounted = await fixture();
  await migration.migrateLegacyBundles({ ...base(mounted), currentBundle: '/Volumes/DWhale/DWhale.app' });
  assert.equal(mounted.prompts.length, 0);
  assert.equal(mounted.trashed.length, 0);
});

test('accepts a legacy flat record and records trash failure', async () => {
  const env = await fixture();
  await fs.mkdir(env.userData, { recursive: true });
  await fs.writeFile(path.join(env.userData, 'legacy-bundle-choice.json'), JSON.stringify({ [env.legacy]: 'kept' }));
  await migration.migrateLegacyBundles(base(env));
  assert.equal(env.prompts.length, 0);

  const failed = await fixture();
  failed.shell.trashItem = async () => { throw new Error('permission denied'); };
  await migration.migrateLegacyBundles(base(failed));
  const record = JSON.parse(await fs.readFile(path.join(failed.userData, 'legacy-bundle-choice.json'), 'utf8'));
  assert.equal(record.choices[failed.legacy], 'failed');
});
