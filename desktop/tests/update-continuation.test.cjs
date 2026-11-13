'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { AppUpdater } = require('../lib/app-updater.cjs');

const pair = crypto.generateKeyPairSync('ed25519');
const trust = { repository: 'XianZe1226/DWhale', algorithm: 'ed25519', publicKey: pair.publicKey.export({ format: 'pem', type: 'spki' }) };
const base = 'https://github.com/XianZe1226/DWhale/releases/download/';
const bytes = Buffer.from('installer-fixture');
const sha = crypto.createHash('sha256').update(bytes).digest('hex');
const commit = 'c'.repeat(40);
const runtimeLockSha = 'd'.repeat(64);
const suffixes = { 'win32-x64': 'Windows-x86_64-setup.exe', 'darwin-arm64': 'macOS-arm64.dmg', 'linux-x64': 'Linux-x86_64.deb' };

function legacy(version = '0.4.0a0', raw = bytes) {
  const npmVersion = version.replace(/a(\d+)$/, '-alpha.$1');
  const digest = crypto.createHash('sha256').update(raw).digest('hex');
  const assets = {};
  for (const [platform, suffix] of Object.entries(suffixes)) {
    const name = `DSWhale-${npmVersion}-${suffix}`;
    assets[platform] = { name, url: `${base}v${version}/${name}`, size: raw.length, sha256: digest };
  }
  return { schemaVersion: 1, product: 'DSWhale', repository: 'XianZe1226/DWhale', version, npmVersion, channel: 'alpha', tag: `v${version}`, commit: 'a'.repeat(40), minimumOS: { win32: '10.0.19045', darwin: '13.0', linux: ['ubuntu:22.04', 'ubuntu:24.04'] }, runtime: { astrbot: '4.29.3', python: '3.12', node: '22.23.4', ffmpeg: '9.0.2' }, impact: { runtime: true, dataMigration: false, configuration: false, rollbackCompatible: true }, assets };
}

async function cacheOriginManifest(updates, raw) {
  const document = signed(legacy('0.3.0a14', raw));
  const directory = path.join(updates, 'manifests', '0.3.0a14');
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'release-manifest.json'), document.raw);
  await fs.writeFile(path.join(directory, 'release-manifest.sig'), document.signature);
}

function modern() {
  const version = '0.4.0a1', npmVersion = '0.4.0-alpha.1', tag = `dwhale-v${npmVersion}`;
  const assets = {};
  for (const [platform, suffix] of Object.entries(suffixes)) {
    const name = `DWhale-${npmVersion}-${suffix}`;
    assets[platform] = { name, url: `${base}${tag}/${name}`, size: bytes.length, sha256: sha };
  }
  return { schemaVersion: 2, product: 'DWhale', productId: 'dev.dswhale.desktop', repository: 'XianZe1226/DWhale', tag, version, pythonVersion: version, npmVersion, channel: 'alpha', commit, minimumOS: { win32: '10.0.19045', darwin: '13.0', linux: ['ubuntu:22.04', 'ubuntu:24.04'] }, runtime: { astrbot: '4.29.4', python: '3.12', node: '22.23.4', ffmpeg: '9.0.2' }, runtimeLockSha256: runtimeLockSha, impact: { runtime: true, dataMigration: true, configuration: true, rollbackCompatible: false }, assets };
}

function signed(value) {
  const raw = Buffer.from(JSON.stringify(value));
  return { raw, signature: crypto.sign(null, raw, pair.privateKey) };
}

test('a bridge continues exactly its fixed signed target without starting services', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dswhale-continuation-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const previous = signed(legacy());
  const target = modern();
  const updates = path.join(directory, 'app-updates');
  const originDir = path.join(directory, 'app-updates', 'installers', '0.3.0a14');
  await fs.mkdir(originDir, { recursive: true });
  await fs.mkdir(updates, { recursive: true });
  const originName = 'DSWhale-0.3.0-alpha.14-macOS-arm64.dmg';
  const originBytes = Buffer.from('origin-installer-fixture');
  await fs.writeFile(path.join(originDir, originName), originBytes);
  await cacheOriginManifest(updates, originBytes);
  await fs.writeFile(path.join(updates, 'state.json'), JSON.stringify({ format: 1, phase: 'awaiting-verification', channel: 'alpha', targetVersion: '0.4.0a0', previousVersion: '0.3.0a14', backup: { id: 'ORIGIN-a14-backup' } }));
  const targetSigned = signed(target);
  const targetSha = crypto.createHash('sha256').update(targetSigned.raw).digest('hex');
  const fixed = {
    version: target.version, tag: target.tag, commit, manifestSha256: targetSha, runtimeLockSha256: runtimeLockSha,
    assets: Object.fromEntries(Object.entries(target.assets).map(([platform, asset]) => [platform, { name: asset.name, size: asset.size, sha256: asset.sha256 }])),
  };
  const transitionLock = {
    format: 1, chainId: 'e'.repeat(32), bridge: { version: '0.4.0a0', tag: 'v0.4.0a0' },
    originVersion: '0.3.0a14', originRuntime: { astrbot: '4.29.3', python: '3.12', node: '22.23.4', ffmpeg: '9.0.2' },
    originV1State: { format: 1, phase: 'install-launched', targetVersion: '0.4.0a0' },
    originBackup: null, originInstaller: null, fixedFinalTarget: fixed, hops: [], terminalState: 'pending',
  };
  const events = [], progress = [], fetched = [];
  const fetch = async url => {
    fetched.push(url);
    if (url === `${base}v0.4.0a0/release-manifest.json`) return new Response(previous.raw);
    if (url === `${base}v0.4.0a0/release-manifest.sig`) return new Response(previous.signature);
    if (url === `${base}${target.tag}/release-manifest.json`) return new Response(targetSigned.raw);
    if (url === `${base}${target.tag}/release-manifest.sig`) return new Response(targetSigned.signature);
    throw new Error(`unexpected ${url}`);
  };
  const manager = new AppUpdater({
    runtime: directory, currentVersion: '0.4.0-alpha.0', platform: 'darwin', arch: 'arm64', osRelease: '24.0.0', trust,
    transitionLock, fetch, download: async (asset, file) => { events.push(`download:${asset.name}`); await fs.writeFile(file, bytes); },
    stopServices: async () => events.push('stop'),
    snapshot: async () => { events.push('snapshot'); return { id: 'bridge-backup', fingerprint: 'f'.repeat(64) }; },
    launchInstaller: async payload => events.push(`launch:${payload.version}`),
    restoreSnapshot: async () => {}, onProgress: patch => progress.push(patch.progress),
  });
  await manager.continueTransition();
  assert.deepEqual(events.filter(item => !item.startsWith('download:')), ['stop', 'snapshot', 'launch:0.4.0a1']);
  assert.equal(events.filter(item => item.startsWith('download:')).length, 1);
  assert.ok(!fetched.some(url => url.includes('/v0.4.0a0/')));
  const chain = JSON.parse(await fs.readFile(path.join(directory, 'app-updates', 'transition-lock.json'), 'utf8'));
  assert.equal(chain.terminalState, 'install-launched');
  assert.equal(chain.hops.at(-1).to, '0.4.0a1');
  assert.equal(chain.originBackup, 'ORIGIN-a14-backup');
  assert.equal(chain.originInstaller.name, originName);
  const recorded = JSON.parse(await fs.readFile(path.join(directory, 'app-updates', 'state.json'), 'utf8'));
  assert.equal(recorded.rollbackRecord.previousVersion, '0.3.0a14');
  assert.equal(recorded.rollbackRecord.backup.id, 'ORIGIN-a14-backup');
  const firstDownload = progress.find(item => item.phase === 'downloading');
  assert.equal(firstDownload.transferredBytes, 0);
  assert.equal(firstDownload.ratio, 0);
  assert.equal(firstDownload.transferTotalBytes, bytes.length);
  assert.ok(progress.some(item => item.phase === 'install-ready'));
  const installed = new AppUpdater({
    runtime: directory, currentVersion: '0.4.0-alpha.1', platform: 'darwin', arch: 'arm64', osRelease: '24.0.0', trust,
    fetch: async () => { throw new Error('must not fetch'); }, download: async () => { throw new Error('must not download'); },
    stopServices: async () => {}, snapshot: async () => ({ id: 'x', fingerprint: 'f'.repeat(64) }), launchInstaller: async () => {},
  });
  await installed.completeVerification({ healthy: true, version: '0.4.0a1' });
  const completed = JSON.parse(await fs.readFile(path.join(directory, 'app-updates', 'transition-lock.json'), 'utf8'));
  assert.equal(completed.terminalState, 'completed');
});

test('a cancelled bridge chain never auto-continues on a later start', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dswhale-continuation-cancel-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const target = modern(), doc = signed(target);
  const fixed = {
    version: target.version, tag: target.tag, commit, manifestSha256: crypto.createHash('sha256').update(doc.raw).digest('hex'), runtimeLockSha256: runtimeLockSha,
    assets: Object.fromEntries(Object.entries(target.assets).map(([platform, asset]) => [platform, { name: asset.name, size: asset.size, sha256: asset.sha256 }])),
  };
  const transitionLock = {
    format: 1, chainId: 'e'.repeat(32), bridge: { version: '0.4.0a0', tag: 'v0.4.0a0' },
    originVersion: '0.3.0a14', originRuntime: { astrbot: '4.29.3', python: '3.12', node: '22.23.4', ffmpeg: '9.0.2' },
    originV1State: { format: 1, phase: 'install-launched' }, originBackup: null, originInstaller: null, fixedFinalTarget: fixed, hops: [], terminalState: 'pending',
  };
  const manager = new AppUpdater({
    runtime: directory, currentVersion: '0.4.0-alpha.0', platform: 'darwin', arch: 'arm64', osRelease: '24.0.0', trust,
    transitionLock, fetch: async () => { throw new Error('must not fetch'); }, download: async () => { throw new Error('must not download'); },
    stopServices: async () => {}, snapshot: async () => ({ id: 'x', fingerprint: 'f'.repeat(64) }), launchInstaller: async () => {},
  });
  await manager.cancel();
  await assert.rejects(manager.continueTransition(), { code: 'TRANSITION_INVALID' });
});

test('a failed continuation rolls back to the original a14 backup and installer', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dswhale-continuation-rollback-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const previous = signed(legacy());
  const target = modern();
  const targetSigned = signed(target);
  const updates = path.join(directory, 'app-updates');
  const originDir = path.join(updates, 'installers', '0.3.0a14');
  await fs.mkdir(originDir, { recursive: true });
  const originName = 'DSWhale-0.3.0-alpha.14-macOS-arm64.dmg';
  const originBytes = Buffer.from('origin-installer-fixture');
  await fs.writeFile(path.join(originDir, originName), originBytes);
  await cacheOriginManifest(updates, originBytes);
  await fs.writeFile(path.join(updates, 'state.json'), JSON.stringify({ format: 1, phase: 'awaiting-verification', channel: 'alpha', targetVersion: '0.4.0a0', previousVersion: '0.3.0a14', backup: { id: 'ORIGIN-a14-backup' } }));
  const fixed = {
    version: target.version, tag: target.tag, commit, manifestSha256: crypto.createHash('sha256').update(targetSigned.raw).digest('hex'), runtimeLockSha256: runtimeLockSha,
    assets: Object.fromEntries(Object.entries(target.assets).map(([platform, asset]) => [platform, { name: asset.name, size: asset.size, sha256: asset.sha256 }])),
  };
  const transitionLock = {
    format: 1, chainId: 'f'.repeat(32), bridge: { version: '0.4.0a0', tag: 'v0.4.0a0' },
    originVersion: '0.3.0a14', originRuntime: { astrbot: '4.29.3', python: '3.12', node: '22.23.4', ffmpeg: '9.0.2' },
    originV1State: { format: 1, phase: 'install-launched', targetVersion: '0.4.0a0' },
    originBackup: null, originInstaller: null, fixedFinalTarget: fixed, hops: [], terminalState: 'pending',
  };
  const fetch = async url => {
    if (url === `${base}v0.4.0a0/release-manifest.json`) return new Response(previous.raw);
    if (url === `${base}v0.4.0a0/release-manifest.sig`) return new Response(previous.signature);
    if (url === `${base}${target.tag}/release-manifest.json`) return new Response(targetSigned.raw);
    if (url === `${base}${target.tag}/release-manifest.sig`) return new Response(targetSigned.signature);
    throw new Error(`unexpected ${url}`);
  };
  const first = new AppUpdater({
    runtime: directory, currentVersion: '0.4.0-alpha.0', platform: 'darwin', arch: 'arm64', osRelease: '24.0.0', trust,
    transitionLock, fetch, download: async (asset, file) => fs.writeFile(file, bytes),
    stopServices: async () => {}, snapshot: async () => ({ id: 'bridge-backup', fingerprint: 'f'.repeat(64) }), launchInstaller: async () => {},
  });
  await first.continueTransition();
  const chain = JSON.parse(await fs.readFile(path.join(updates, 'transition-lock.json'), 'utf8'));
  const events = [];
  const second = new AppUpdater({
    runtime: directory, currentVersion: '0.4.0-alpha.1', platform: 'darwin', arch: 'arm64', osRelease: '24.0.0', trust,
    transitionLock: chain, fetch: async () => { throw new Error('must not fetch'); }, download: async () => { throw new Error('must not download'); },
    stopServices: async () => events.push('stop'),
    snapshot: async () => { events.push('snapshot'); return { id: 'before-rollback', fingerprint: 'a'.repeat(64) }; },
    restoreSnapshot: async (id, options) => events.push(`restore:${id}:${options.currentBackupId}`),
    launchInstaller: async payload => events.push(`launch:${payload.version}:${payload.rollback}`),
  });
  await second.rollback();
  assert.deepEqual(events, ['stop', 'snapshot', 'restore:ORIGIN-a14-backup:before-rollback', 'launch:0.3.0a14:true']);
  const rolled = JSON.parse(await fs.readFile(path.join(updates, 'transition-lock.json'), 'utf8'));
  assert.equal(rolled.terminalState, 'rolled-back');
  assert.equal(rolled.hops.at(-1).to, '0.3.0a14');
  const state = JSON.parse(await fs.readFile(path.join(updates, 'state.json'), 'utf8'));
  assert.equal(state.phase, 'rolled-back');
  assert.equal(state.targetVersion, '0.3.0a14');
  assert.equal(state.previousVersion, undefined);
  assert.equal(state.rollbackRecord, undefined);
  assert.equal(state.preRollbackBackup.id, 'before-rollback');
});

test('R4: recovery media follows the installed source, not a guessed legacy tag', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dswhale-recovery-source-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const target = modern();
  const targetSigned = signed(target);
  const fetched = [];
  const full = new AppUpdater({
    runtime: directory, currentVersion: '0.4.0-alpha.1', platform: 'darwin', arch: 'arm64', osRelease: '24.0.0', trust,
    fetch: async url => {
      fetched.push(url);
      if (url === `${base}${target.tag}/release-manifest.json`) return new Response(targetSigned.raw);
      if (url === `${base}${target.tag}/release-manifest.sig`) return new Response(targetSigned.signature);
      throw new Error(`unexpected ${url}`);
    },
  });
  assert.deepEqual(full._currentSource(), { namespace: 'dwhale', tag: 'dwhale-v0.4.0-alpha.1' });
  const current = await full._currentManifest();
  assert.equal(current.version, '0.4.0a1');
  assert.deepEqual(fetched, [`${base}${target.tag}/release-manifest.json`, `${base}${target.tag}/release-manifest.sig`]);

  const previous = signed(legacy());
  const legacyFetched = [];
  const bridge = new AppUpdater({
    runtime: directory, currentVersion: '0.4.0-alpha.0', platform: 'darwin', arch: 'arm64', osRelease: '24.0.0', trust,
    transitionLock: { bridge: { version: '0.4.0a0', tag: 'v0.4.0a0' } },
    fetch: async url => {
      legacyFetched.push(url);
      if (url === `${base}v0.4.0a0/release-manifest.json`) return new Response(previous.raw);
      if (url === `${base}v0.4.0a0/release-manifest.sig`) return new Response(previous.signature);
      throw new Error(`unexpected ${url}`);
    },
  });
  assert.deepEqual(bridge._currentSource(), { namespace: 'legacy', tag: 'v0.4.0a0' });
  assert.equal((await bridge._currentManifest()).version, '0.4.0a0');
  assert.deepEqual(legacyFetched, [`${base}v0.4.0a0/release-manifest.json`, `${base}v0.4.0a0/release-manifest.sig`]);
});

test('R2: an automatic continuation failure pauses instead of looping on restart', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dswhale-continuation-failure-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const previous = signed(legacy());
  const target = modern();
  const targetSigned = signed(target);
  const updates = path.join(directory, 'app-updates');
  const originDir = path.join(updates, 'installers', '0.3.0a14');
  await fs.mkdir(originDir, { recursive: true });
  await fs.mkdir(updates, { recursive: true });
  const originName = 'DSWhale-0.3.0-alpha.14-macOS-arm64.dmg';
  const originBytes = Buffer.from('origin-installer-fixture');
  await fs.writeFile(path.join(originDir, originName), originBytes);
  await cacheOriginManifest(updates, originBytes);
  await fs.writeFile(path.join(updates, 'state.json'), JSON.stringify({ format: 1, phase: 'awaiting-verification', channel: 'alpha', targetVersion: '0.4.0a0', previousVersion: '0.3.0a14', backup: { id: 'ORIGIN-a14-backup' } }));
  const fixed = {
    version: target.version, tag: target.tag, commit, manifestSha256: crypto.createHash('sha256').update(targetSigned.raw).digest('hex'), runtimeLockSha256: runtimeLockSha,
    assets: Object.fromEntries(Object.entries(target.assets).map(([platform, asset]) => [platform, { name: asset.name, size: asset.size, sha256: asset.sha256 }])),
  };
  const transitionLock = {
    format: 1, chainId: 'a'.repeat(32), bridge: { version: '0.4.0a0', tag: 'v0.4.0a0' },
    originVersion: '0.3.0a14', originRuntime: { astrbot: '4.29.3', python: '3.12', node: '22.23.4', ffmpeg: '9.0.2' },
    originV1State: { format: 1, phase: 'install-launched', targetVersion: '0.4.0a0' },
    originBackup: null, originInstaller: null, fixedFinalTarget: fixed, hops: [], terminalState: 'pending',
  };
  const offline = new AppUpdater({
    runtime: directory, currentVersion: '0.4.0-alpha.0', platform: 'darwin', arch: 'arm64', osRelease: '24.0.0', trust, transitionLock,
    fetch: async () => { throw new Error('synthetic offline'); }, download: async () => {},
    stopServices: async () => {}, snapshot: async () => ({ id: 'bridge-backup', fingerprint: 'f'.repeat(64) }), launchInstaller: async () => {},
  });
  await assert.rejects(offline.continueTransition({ automatic: true }));
  const marker = JSON.parse(await fs.readFile(path.join(updates, 'continuation-failure.json'), 'utf8'));
  assert.equal(marker.chainId, transitionLock.chainId);

  let fetched = 0;
  const paused = new AppUpdater({
    runtime: directory, currentVersion: '0.4.0-alpha.0', platform: 'darwin', arch: 'arm64', osRelease: '24.0.0', trust, transitionLock,
    fetch: async () => { fetched += 1; throw new Error('must not fetch'); }, download: async () => {},
    stopServices: async () => {}, snapshot: async () => ({ id: 'bridge-backup', fingerprint: 'f'.repeat(64) }), launchInstaller: async () => {},
  });
  await assert.rejects(paused.continueTransition({ automatic: true }), /上次更新衔接未完成/);
  assert.equal(fetched, 0, 'a paused continuation must not touch the network on restart');

  const manual = new AppUpdater({
    runtime: directory, currentVersion: '0.4.0-alpha.0', platform: 'darwin', arch: 'arm64', osRelease: '24.0.0', trust, transitionLock,
    fetch: async url => {
      if (url === `${base}v0.4.0a0/release-manifest.json`) return new Response(previous.raw);
      if (url === `${base}v0.4.0a0/release-manifest.sig`) return new Response(previous.signature);
      if (url === `${base}${target.tag}/release-manifest.json`) return new Response(targetSigned.raw);
      if (url === `${base}${target.tag}/release-manifest.sig`) return new Response(targetSigned.signature);
      throw new Error(`unexpected ${url}`);
    },
    download: async (asset, file) => fs.writeFile(file, bytes),
    stopServices: async () => {}, snapshot: async () => ({ id: 'bridge-backup', fingerprint: 'f'.repeat(64) }), launchInstaller: async () => {},
  });
  await manual.continueTransition();
  await assert.rejects(fs.readFile(path.join(updates, 'continuation-failure.json')));
});

test('a tampered cached origin installer is rejected before stop or restore', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dswhale-origin-tamper-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const target = modern(), targetSigned = signed(target);
  const updates = path.join(directory, 'app-updates');
  const originDir = path.join(updates, 'installers', '0.3.0a14');
  await fs.mkdir(originDir, { recursive: true });
  const originName = 'DSWhale-0.3.0-alpha.14-macOS-arm64.dmg';
  const originBytes = Buffer.from('origin-installer-fixture');
  await fs.writeFile(path.join(originDir, originName), originBytes);
  await cacheOriginManifest(updates, originBytes);
  await fs.writeFile(path.join(updates, 'state.json'), JSON.stringify({ format: 1, phase: 'downloading', channel: 'alpha', targetVersion: '0.4.0a1', previousVersion: '0.3.0a14', backup: { id: 'ORIGIN-a14-backup' } }));
  const fixed = {
    version: target.version, tag: target.tag, commit, manifestSha256: crypto.createHash('sha256').update(targetSigned.raw).digest('hex'), runtimeLockSha256: runtimeLockSha,
    assets: Object.fromEntries(Object.entries(target.assets).map(([platform, asset]) => [platform, { name: asset.name, size: asset.size, sha256: asset.sha256 }])),
  };
  const chain = {
    format: 1, chainId: 'a'.repeat(32), bridge: { version: '0.4.0a0', tag: 'v0.4.0a0' },
    originVersion: '0.3.0a14', originRuntime: { astrbot: '4.29.3', python: '3.12', node: '22.23.4', ffmpeg: '9.0.2' },
    originV1State: { format: 1, phase: 'install-launched', targetVersion: '0.4.0a0' },
    originBackup: 'ORIGIN-a14-backup',
    originInstaller: { name: originName, size: originBytes.length, sha256: crypto.createHash('sha256').update(originBytes).digest('hex') },
    fixedFinalTarget: fixed, hops: [], terminalState: 'install-launched',
  };
  try{require('../lib/update-chain.cjs').validate(chain);}catch(e){console.log('CHAINERR',e.message);}
  await fs.writeFile(path.join(updates, 'transition-lock.json'), JSON.stringify(chain));
  const events = [];
  const manager = new AppUpdater({
    runtime: directory, currentVersion: '0.4.0-alpha.0', platform: 'darwin', arch: 'arm64', osRelease: '24.0.0', trust,
    transitionLock: chain, fetch: async () => { throw new Error('must not fetch'); }, download: async () => { throw new Error('must not download'); },
    stopServices: async () => events.push('stop'), snapshot: async () => ({ id: 'x', fingerprint: 'f'.repeat(64) }),
    restoreSnapshot: async () => events.push('restore'), launchInstaller: async () => events.push('launch'),
  });
  await fs.writeFile(path.join(originDir, originName), Buffer.from('POISONED-origin-fixture'));
  await assert.rejects(manager.rollback(), e => e.code === 'INSTALLER_INVALID');
  assert.deepEqual(events, []);
});

test('an interrupted target download resumes from its persisted fixed target', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dswhale-continuation-resume-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const target = modern(), targetSigned = signed(target);
  const updates = path.join(directory, 'app-updates');
  const originDir = path.join(updates, 'installers', '0.3.0a14');
  await fs.mkdir(originDir, { recursive: true });
  const originName = 'DSWhale-0.3.0-alpha.14-macOS-arm64.dmg';
  await fs.writeFile(path.join(originDir, originName), Buffer.from('origin-installer-fixture'));
  await cacheOriginManifest(updates, Buffer.from('origin-installer-fixture'));
  await fs.writeFile(path.join(updates, 'state.json'), JSON.stringify({ format: 1, phase: 'downloading', channel: 'alpha', targetVersion: '0.4.0a1', previousVersion: '0.3.0a14', backup: { id: 'ORIGIN-a14-backup' }, direction: 'update', errorCode: 'NETWORK_FAILED', failedAction: 'install' }));
  const fixed = {
    version: target.version, tag: target.tag, commit, manifestSha256: crypto.createHash('sha256').update(targetSigned.raw).digest('hex'), runtimeLockSha256: runtimeLockSha,
    assets: Object.fromEntries(Object.entries(target.assets).map(([platform, asset]) => [platform, { name: asset.name, size: asset.size, sha256: asset.sha256 }])),
  };
  const chain = {
    format: 1, chainId: 'e'.repeat(32), bridge: { version: '0.4.0a0', tag: 'v0.4.0a0' }, originVersion: '0.3.0a14',
    originRuntime: { astrbot: '4.29.3', python: '3.12', node: '22.23.4', ffmpeg: '9.0.2' },
    originV1State: { format: 1, phase: 'install-launched' }, originBackup: null, originInstaller: null,
    fixedFinalTarget: fixed, hops: [], terminalState: 'pending',
  };
  await fs.writeFile(path.join(updates, 'transition-lock.json'), JSON.stringify(chain));
  const events = [], fetched = [];
  const manager = new AppUpdater({
    runtime: directory, currentVersion: '0.4.0-alpha.0', platform: 'darwin', arch: 'arm64', osRelease: '24.0.0', trust,
    transitionLock: chain,
    fetch: async url => { fetched.push(url); if (url === `${base}${target.tag}/release-manifest.json`) return new Response(targetSigned.raw); if (url === `${base}${target.tag}/release-manifest.sig`) return new Response(targetSigned.signature); throw new Error(`unexpected ${url}`); },
    download: async (asset, file) => { events.push(`download:${asset.name}`); await fs.writeFile(file, bytes); },
    stopServices: async () => events.push('stop'), snapshot: async () => { events.push('snapshot'); return { id: 'bridge-backup', fingerprint: 'f'.repeat(64) }; },
    launchInstaller: async payload => events.push(`launch:${payload.version}`), restoreSnapshot: async () => {},
  });
  await manager.continueTransition();
  assert.ok(fetched.every(url => url.includes(target.tag)));
  assert.deepEqual(events.filter(item => !item.startsWith('download:')), ['stop', 'snapshot', 'launch:0.4.0a1']);
  const state = JSON.parse(await fs.readFile(path.join(updates, 'state.json'), 'utf8'));
  assert.equal(state.targetVersion, '0.4.0a1');
  assert.equal(state.errorCode, undefined);
});
