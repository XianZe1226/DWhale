'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { AppUpdater } = require('../lib/app-updater.cjs');

const pair = crypto.generateKeyPairSync('ed25519');
const trust = {
  repository: 'XianZe1226/DWhale',
  algorithm: 'ed25519',
  publicKey: pair.publicKey.export({ format: 'pem', type: 'spki' }),
};
const bytes = Buffer.from('synthetic-windows-installer');
const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
const suffixes = {
  'win32-x64': 'Windows-x86_64-setup.exe',
  'darwin-arm64': 'macOS-arm64.dmg',
  'linux-x64': 'Linux-x86_64.deb',
};

function manifest(version) {
  const npmVersion = version.replace(/a(\d+)$/, '-alpha.$1');
  const tag = `dwhale-v${npmVersion}`;
  return {
    schemaVersion: 2, product: 'DWhale', productId: 'dev.dswhale.desktop',
    repository: 'XianZe1226/DWhale', version, pythonVersion: version, npmVersion,
    tag, channel: 'alpha', commit: 'a'.repeat(40),
    minimumOS: { win32: '10.0.19045', darwin: '13.0', linux: ['ubuntu:22.04', 'ubuntu:24.04'] },
    runtime: { astrbot: '4.29.4', python: '3.12', node: '22.23.4', ffmpeg: '9.0.2' },
    runtimeLockSha256: 'b'.repeat(64),
    impact: { runtime: true, dataMigration: true, configuration: true, rollbackCompatible: false },
    assets: Object.fromEntries(Object.entries(suffixes).map(([platform, suffix]) => {
      const name = `DWhale-${npmVersion}-${suffix}`;
      return [platform, {
        name, url: `https://github.com/XianZe1226/DWhale/releases/download/${tag}/${name}`,
        size: bytes.length, sha256,
      }];
    })),
  };
}

async function fixture(t, statePatch = {}, { transitionLock = null, badSignature = false } = {}) {
  const runtime = await fs.mkdtemp(path.join(os.tmpdir(), 'dwhale-updater-stale-'));
  t.after(() => fs.rm(runtime, { recursive: true, force: true }));
  const directory = path.join(runtime, 'app-updates');
  const state = {
    format: 1, phase: 'available', channel: 'alpha', highestVersion: '0.4.0a3',
    targetVersion: '0.4.0a3', previousVersion: '0.4.0a2', ...statePatch,
  };
  const versions = [state.targetVersion, state.previousVersion,
    state.rollbackRecord?.targetVersion, state.rollbackRecord?.previousVersion].filter(Boolean);
  for (const version of new Set(versions)) {
    const value = manifest(version);
    const raw = Buffer.from(JSON.stringify(value));
    const cached = path.join(directory, 'manifests', version);
    await fs.mkdir(cached, { recursive: true });
    await fs.writeFile(path.join(cached, 'release-manifest.json'), raw);
    const signature = badSignature && version === state.targetVersion
      ? Buffer.alloc(64) : crypto.sign(null, raw, pair.privateKey);
    await fs.writeFile(path.join(cached, 'release-manifest.sig'), signature);
    const installers = path.join(directory, 'installers', version);
    await fs.mkdir(installers, { recursive: true });
    await fs.writeFile(path.join(installers, value.assets['win32-x64'].name), bytes);
  }
  await fs.writeFile(path.join(directory, 'state.json'), JSON.stringify(state));
  if (transitionLock) {
    await fs.writeFile(path.join(directory, 'transition-lock.json'), JSON.stringify(transitionLock));
  }
  const events = [];
  const config = {
    runtime, currentVersion: '0.4.0-alpha.3', platform: 'win32', arch: 'x64',
    osRelease: '10.0.22631', trust, transitionLock,
    fetch: async () => { events.push('fetch'); throw new Error('unexpected synthetic network request'); },
    download: async () => { events.push('download'); },
    stopServices: async () => { events.push('stop'); },
    snapshot: async () => { events.push('snapshot'); return { id: 'synthetic-backup' }; },
    launchInstaller: async () => { events.push('launch'); },
    restoreSnapshot: async () => { events.push('restore'); },
  };
  return { directory, state, events, config, manager: new AppUpdater(config) };
}

async function diskContents(directory) {
  const files = (await fs.readdir(directory, { recursive: true, withFileTypes: true }))
    .filter(entry => entry.isFile())
    .map(entry => path.join(entry.parentPath, entry.name))
    .sort();
  return Promise.all(files.map(async file => [path.relative(directory, file), await fs.readFile(file)]));
}

for (const phase of ['available', 'downloaded']) {
  for (const targetVersion of ['0.4.0a2', '0.4.0a3']) {
    test(`a running a3 projects cached ${phase} target ${targetVersion} as up-to-date without rewriting state`, async t => {
      const f = await fixture(t, { phase, targetVersion, highestVersion: targetVersion });
      const before = await diskContents(f.directory);
      const status = await f.manager.status();
      assert.equal(status.phase, 'up-to-date');
      assert.equal(status.currentVersion, '0.4.0a3');
      assert.equal(status.targetVersion, targetVersion);
      assert.equal(status.canDownload, false);
      assert.equal(status.canInstall, false);
      assert.deepEqual(status.actions, ['check']);
      assert.equal(status.error, null);
      assert.equal(status.recovery.interrupted, false);
      assert.equal(status.recovery.requiresHealthVerification, false);
      assert.equal(f.manager.state.phase, phase);
      assert.deepEqual(await new AppUpdater(f.config).status(), status);
      assert.deepEqual(await diskContents(f.directory), before);
      assert.deepEqual(f.events, []);
    });
  }
}

test('current cached discovery retains authenticated rollback and the monotonic floor', async t => {
  const f = await fixture(t, {
    phase: 'downloaded', highestVersion: '0.4.0a4',
    backup: { id: 'synthetic-original-backup' },
    rollbackRecord: {
      targetVersion: '0.4.0a3', previousVersion: '0.4.0a2',
      backup: { id: 'synthetic-original-backup' },
    },
  });
  const before = await diskContents(f.directory);
  const status = await f.manager.status();
  assert.equal(status.phase, 'up-to-date');
  assert.equal(status.canRollback, true);
  assert.equal(status.previousVersion, '0.4.0a2');
  assert.equal(status.recovery.rollbackRequiresDataRestore, true);
  assert.deepEqual(status.actions, ['check', 'rollback']);
  assert.equal(f.manager.state.highestVersion, '0.4.0a4');
  assert.deepEqual(await diskContents(f.directory), before);
  f.manager.request = async () => new Response(JSON.stringify([
    { tag_name: 'dwhale-v0.4.0-alpha.3', draft: false, prerelease: true },
  ]));
  await assert.rejects(f.manager.check({ automatic: true }), { code: 'DOWNGRADE_BLOCKED' });
  assert.deepEqual(await diskContents(f.directory), before);
  assert.deepEqual(f.events, []);
});

test('a future signed target remains actionable after restart', async t => {
  for (const phase of ['available', 'downloaded']) {
    const f = await fixture(t, {
      phase, targetVersion: '0.4.0a4', highestVersion: '0.4.0a4', previousVersion: '0.4.0a3',
    });
    const status = await f.manager.status();
    assert.equal(status.phase, phase);
    assert.equal(status.canDownload, true);
    assert.equal(status.canInstall, phase === 'downloaded');
    assert.deepEqual(f.events, []);
  }
});

for (const targetVersion of ['0.4.0a2', '0.4.0a3']) {
  test(`automatic discovery advances a downloaded ${targetVersion} cache after external upgrade to a3`, async t => {
    const rollbackRecord = {
      targetVersion: '0.4.0a3', previousVersion: '0.4.0a2',
      backup: { id: 'synthetic-original-backup' },
    };
    const f = await fixture(t, {
      phase: 'downloaded', targetVersion, backup: { ...rollbackRecord.backup }, rollbackRecord,
    });
    const before = await diskContents(f.directory);
    const future = manifest('0.4.0a4');
    const raw = Buffer.from(JSON.stringify(future));
    const requests = [];
    f.manager.request = async url => {
      requests.push(url);
      if (url === 'https://api.github.com/repos/XianZe1226/DWhale/releases?per_page=100') {
        return new Response(JSON.stringify([{ tag_name: 'dwhale-v0.4.0-alpha.4', draft: false, prerelease: true }]));
      }
      const prefix = 'https://github.com/XianZe1226/DWhale/releases/download/dwhale-v0.4.0-alpha.4/release-manifest';
      if (url === `${prefix}.json`) return new Response(raw);
      if (url === `${prefix}.sig`) return new Response(crypto.sign(null, raw, pair.privateKey));
      throw new Error('unexpected synthetic metadata URL');
    };
    const status = await f.manager.check({ automatic: true });
    assert.equal(status?.targetVersion, '0.4.0a4');
    assert.equal(status.phase, 'available');
    assert.equal(status.canDownload, true);
    assert.equal(status.canRollback, true);
    assert.equal(status.previousVersion, '0.4.0a2');
    assert.equal(requests.length, 3);
    const saved = JSON.parse(await fs.readFile(path.join(f.directory, 'state.json'), 'utf8'));
    assert.equal(saved.highestVersion, '0.4.0a4');
    assert.deepEqual(saved.backup, rollbackRecord.backup);
    assert.deepEqual(saved.rollbackRecord, rollbackRecord);
    const after = new Map(await diskContents(f.directory));
    for (const [file, contents] of before) {
      if (file !== 'state.json') assert.deepEqual(after.get(file), contents);
    }
    assert.deepEqual(f.events, []);
  });
}

test('superseded targets retain interrupted installation and verification phases', async t => {
  for (const phase of [
    'downloading', 'snapshotting', 'install-ready', 'install-launched', 'awaiting-verification',
    'rolling-back', 'rollback-launched', 'awaiting-rollback-verification', 'repair-required',
  ]) {
    const f = await fixture(t, { phase, targetVersion: '0.4.0a2', highestVersion: '0.4.0a2' });
    const before = await diskContents(f.directory);
    const status = await f.manager.status();
    assert.equal(status.phase, phase);
    assert.equal(status.canDownload, false);
    assert.equal(status.canInstall, false);
    assert.equal(status.recovery.requiresHealthVerification,
      ['awaiting-verification', 'awaiting-rollback-verification', 'repair-required'].includes(phase));
    assert.equal(await f.manager.check({ automatic: true }), null);
    assert.deepEqual(await diskContents(f.directory), before);
    assert.deepEqual(f.events, []);
  }
});

test('stale discovery keeps persisted errors and rejects unauthenticated cached metadata', async t => {
  for (const phase of ['available', 'downloaded']) {
    const errored = await fixture(t, { phase, errorCode: 'NETWORK_FAILED', failedAction: 'download' });
    const status = await errored.manager.status();
    assert.equal(status.phase, phase);
    assert.equal(status.error.code, 'NETWORK_FAILED');
    assert.equal(status.recovery.interrupted, true);
    assert.equal(await errored.manager.check({ automatic: true }), null);
    assert.deepEqual(errored.events, []);
    const invalid = await fixture(t, { phase }, { badSignature: true });
    const before = await diskContents(invalid.directory);
    const rejected = await invalid.manager.status();
    assert.equal(rejected.phase, phase);
    assert.equal(rejected.error.code, 'SIGNATURE_INVALID');
    assert.equal(rejected.canDownload, false);
    assert.equal(rejected.canInstall, false);
    assert.deepEqual(await diskContents(invalid.directory), before);
  }
});

test('a packaged bridge retains a downloaded bridge target for its pending migration chain', async t => {
  const final = manifest('0.4.0a4');
  const transitionLock = {
    format: 1, chainId: 'c'.repeat(32),
    bridge: { version: '0.4.0a3', tag: 'v0.4.0a3' },
    originVersion: '0.4.0a2',
    originRuntime: { astrbot: '4.29.4', python: '3.12', node: '22.23.4', ffmpeg: '9.0.2' },
    originV1State: { format: 1, phase: 'install-launched', targetVersion: '0.4.0a3' },
    originBackup: null, originInstaller: null, hops: [], terminalState: 'pending',
    fixedFinalTarget: {
      version: final.version, tag: final.tag, commit: final.commit,
      manifestSha256: crypto.createHash('sha256').update(JSON.stringify(final)).digest('hex'),
      runtimeLockSha256: final.runtimeLockSha256,
      assets: Object.fromEntries(Object.entries(final.assets).map(([platform, asset]) => [
        platform, { name: asset.name, size: asset.size, sha256: asset.sha256 },
      ])),
    },
  };
  const f = await fixture(t, { phase: 'downloaded' }, { transitionLock });
  const before = await diskContents(f.directory);
  const status = await f.manager.status();
  assert.equal(status.phase, 'downloaded');
  assert.equal(status.error, null);
  assert.equal(await f.manager.check({ automatic: true }), null);
  assert.deepEqual(await diskContents(f.directory), before);
  assert.deepEqual(f.events, []);
});
