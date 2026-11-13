'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const protocol = require('../lib/update-protocol.cjs');

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const trust = { repository: protocol.REPOSITORY, algorithm: 'ed25519', publicKey: publicKey.export({ type: 'spki', format: 'pem' }) };
const sign = bytes => crypto.sign(null, bytes, privateKey);
const raw = value => Buffer.from(JSON.stringify(value));
const npmOf = version => version.replace(/a(\d+)$/, '-alpha.$1');

function legacy(change = {}) {
  const version = change.version || '0.4.0a0';
  const npmVersion = npmOf(version);
  const manifest = {
    schemaVersion: 1, product: 'DSWhale', repository: protocol.REPOSITORY, version, npmVersion,
    channel: 'alpha', tag: `v${version}`, commit: 'a'.repeat(40), minimumOS: protocol.MINIMUM_OS,
    runtime: { astrbot: '4.29.3', python: '3.12', node: '22.23.4', ffmpeg: '9.0.2' },
    impact: { runtime: true, dataMigration: false, configuration: false, rollbackCompatible: false },
    assets: Object.fromEntries(Object.entries(protocol.SUFFIXES).map(([platform, suffix]) => {
      const name = `DSWhale-${npmVersion}-${suffix}`;
      return [platform, { name, url: `${protocol.RELEASE_BASE}v${version}/${name}`, size: 10, sha256: 'b'.repeat(64) }];
    })),
  };
  return { ...manifest, ...change };
}

function modern(change = {}) {
  const version = '0.4.0a1';
  const npmVersion = npmOf(version);
  const tag = `dwhale-v${npmVersion}`;
  const manifest = {
    schemaVersion: 2, product: 'DWhale', productId: protocol.PRODUCT_ID, repository: protocol.REPOSITORY,
    tag, version, pythonVersion: version, npmVersion, channel: 'alpha', commit: 'c'.repeat(40),
    minimumOS: protocol.MINIMUM_OS,
    runtime: { astrbot: '4.29.5', python: '3.12', node: '22.23.4', ffmpeg: '9.0.2' },
    runtimeLockSha256: 'd'.repeat(64),
    impact: { runtime: true, dataMigration: true, configuration: true, rollbackCompatible: false },
    assets: Object.fromEntries(Object.entries(protocol.SUFFIXES).map(([platform, suffix]) => {
      const name = `DWhale-${npmVersion}-${suffix}`;
      return [platform, { name, url: `${protocol.RELEASE_BASE}${tag}/${name}`, size: 10, sha256: 'e'.repeat(64) }];
    })),
  };
  return { ...manifest, ...change };
}

test('version model orders alpha < beta < rc < final and maps npm names', () => {
  const ordered = ['0.4.0a1', '0.4.0a2', '0.4.0b1', '0.4.0rc1', '0.4.0'];
  for (let index = 1; index < ordered.length; index++) {
    assert.equal(protocol.compareVersions(ordered[index - 1], ordered[index]), -1);
  }
  assert.equal(protocol.compareVersions('0.4.0', '0.4.0rc1'), 1);
  assert.equal(protocol.parseVersion('0.4.0-alpha.1').text, '0.4.0a1');
  assert.equal(protocol.parseVersion('0.4.0-beta.2').npmVersion, '0.4.0-beta.2');
  assert.equal(protocol.normalizeVersion('0.4.0-rc.1'), '0.4.0rc1');
  assert.equal(protocol.normalizeVersion('0.4'), null);
  assert.equal(protocol.channelFor(protocol.parseVersion('0.4.0rc1')), 'alpha');
  assert.equal(protocol.channelFor(protocol.parseVersion('0.4.0')), 'stable');
});

test('tags separate the new release namespace from legacy bridge releases', () => {
  assert.deepEqual(protocol.parseTag('dwhale-v0.4.0-alpha.1'), {
    namespace: 'dwhale', tag: 'dwhale-v0.4.0-alpha.1', version: '0.4.0a1', npmVersion: '0.4.0-alpha.1', preRelease: true, channel: 'alpha',
  });
  assert.equal(protocol.parseTag('v0.4.0a0').namespace, 'legacy');
  assert.equal(protocol.parseTag('v0.4.0').namespace, 'legacy');
  assert.equal(protocol.parseTag('v0.4.0b1'), null);
  assert.equal(protocol.parseTag('dwhale-v0.4.0').namespace, 'dwhale');
  assert.equal(protocol.parseTag('dwhale-v0.4.1').version, '0.4.1');
  assert.equal(protocol.parseTag('v0.3.0a14').namespace, 'legacy');
});

test('legacy schema1 keeps the exact old contract and fixed runtime matrix', () => {
  const bytes = raw(legacy());
  const verified = protocol.verifyManifest(bytes, sign(bytes), { trust });
  assert.equal(verified.version, '0.4.0a0');
  assert.equal(verified.assets['darwin-arm64'].name, 'DSWhale-0.4.0-alpha.0-macOS-arm64.dmg');
  const invalid = value => {
    const bytes = raw(value);
    assert.throws(() => protocol.verifyManifest(bytes, sign(bytes), { trust }), { code: 'MANIFEST_INVALID' });
  };
  invalid(legacy({ runtime: { astrbot: '4.29.4', python: '3.12', node: '22.23.4', ffmpeg: '9.0.2' } }));
  invalid(legacy({ tag: 'dwhale-v0.4.0-alpha.0' }));
});

test('schema2 accepts a pinned runtime different from the old matrix', () => {
  const bytes = raw(modern());
  const verified = protocol.verifyModern(bytes, sign(bytes), { trust });
  assert.equal(verified.product, 'DWhale');
  assert.equal(verified.tag, 'dwhale-v0.4.0-alpha.1');
  assert.equal(verified.runtime.astrbot, '4.29.5');
  assert.equal(verified.assets['linux-x64'].name, 'DWhale-0.4.0-alpha.1-Linux-x86_64.deb');
  assert.equal(verified.assets['linux-x64'].url, `${protocol.RELEASE_BASE}dwhale-v0.4.0-alpha.1/DWhale-0.4.0-alpha.1-Linux-x86_64.deb`);
});

test('schema2 rejects a mismatched tag, product, runtime lock digest and asset URL', () => {
  for (const change of [
    { tag: 'dwhale-v0.4.0-alpha.2' },
    { product: 'DSWhale' },
    { runtimeLockSha256: 'not-a-digest' },
    { assets: { ...modern().assets, 'darwin-arm64': { ...modern().assets['darwin-arm64'], name: 'DSWhale-x.dmg' } } },
    { assets: { ...modern().assets, 'linux-x64': { ...modern().assets['linux-x64'], url: 'https://example.com/x.deb' } } },
  ]) {
    const bytes = raw(modern(change));
    assert.throws(() => protocol.verifyModern(bytes, sign(bytes), { trust }), { name: 'ProtocolError' });
  }
});

test('signature covers raw bytes before any field parsing', () => {
  const bytes = raw(modern());
  assert.throws(() => protocol.verifyModern(bytes, sign(Buffer.from('other')), { trust }), { code: 'SIGNATURE_INVALID' });
  const mangled = Buffer.from(bytes.toString('utf8').replace('DWhale', 'DSWhale'));
  assert.throws(() => protocol.verifyModern(mangled, sign(bytes), { trust }), { code: 'SIGNATURE_INVALID' });
});


test('official-only release routing pins the new repository and rejects the memorial repository', () => {
  assert.equal(protocol.REPOSITORY, 'XianZe1226/DWhale');
  assert.equal(protocol.RELEASE_BASE, 'https://github.com/XianZe1226/DWhale/releases/download/');
  const bundledTrust = require('../lib/release-trust.json');
  assert.equal(bundledTrust.repository, 'XianZe1226/DWhale');
  assert.equal(bundledTrust.legacyPublicKey, '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEACU77a+cdop5SQIsWC114ZNkq3CNfNgrbaSk+rMNGtyE=\n-----END PUBLIC KEY-----\n');
  const old = modern({ repository: 'XianZe1226/DSWhale' });
  for (const asset of Object.values(old.assets)) asset.url = asset.url.replace('/DWhale/', '/DSWhale/');
  const bytes = raw(old);
  assert.throws(() => protocol.verifyModern(bytes, sign(bytes), { trust }), { code: 'MANIFEST_INVALID' });
  assert.throws(() => protocol.verifyModern(raw(modern()), sign(raw(modern())), { trust: { ...trust, repository: 'XianZe1226/DSWhale' } }), { code: 'SIGNATURE_INVALID' });
});
