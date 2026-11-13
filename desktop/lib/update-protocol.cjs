'use strict';

const crypto = require('node:crypto');

const REPOSITORY = 'XianZe1226/DWhale';
const PRODUCT_ID = 'dev.dswhale.desktop';
const RELEASE_BASE = 'https://github.com/XianZe1226/DWhale/releases/download/';
const MAX_MANIFEST = 65536;
const MAX_INSTALLER = 4 * 1024 ** 3;
const RUNTIME_KEYS = ['astrbot', 'python', 'node', 'ffmpeg'];
const LEGACY_MATRIX = { astrbot: '4.29.3', python: '3.12', node: '22.23.4', ffmpeg: '9.0.2' };
const PLATFORMS = { 'win32-x64': 'Windows-x86_64-setup.exe', 'darwin-arm64': 'macOS-arm64.dmg', 'linux-x64': 'Linux-x86_64.deb' };
const LEGACY_SUFFIXES = { 'win32-x64': 'Windows-x86_64-setup.exe', 'darwin-arm64': 'macOS-arm64.dmg', 'linux-x64': 'Linux-x86_64.deb' };
const MINIMUM_OS = { win32: '10.0.19045', darwin: '13.0', linux: ['ubuntu:22.04', 'ubuntu:24.04'] };
const IMPACT_KEYS = ['runtime', 'dataMigration', 'configuration', 'rollbackCompatible'];
const V1_KEYS = ['schemaVersion', 'product', 'repository', 'version', 'npmVersion', 'channel', 'tag', 'commit', 'minimumOS', 'runtime', 'impact', 'assets'];
const V2_KEYS = ['schemaVersion', 'product', 'productId', 'repository', 'tag', 'version', 'pythonVersion', 'npmVersion', 'channel', 'commit', 'minimumOS', 'runtime', 'runtimeLockSha256', 'impact', 'assets'];
const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:(a|b|rc)(\d+))?$/;
const NPM_VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-(alpha|beta|rc)\.(\d+))?$/;
const SHA256 = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const TOKEN = /^[0-9][0-9A-Za-z.+_-]{0,119}$/;

class ProtocolError extends Error {
  constructor(code) {
    super(code);
    this.name = 'ProtocolError';
    this.code = code;
  }
}

function fail(code) { throw new ProtocolError(code); }
function isObject(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function exactKeys(value, expected) {
  return isObject(value) && Object.keys(value).sort().join(',') === [...expected].sort().join(',');
}
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function frozen(value, expected) {
  return canonical(value) === canonical(expected);
}

function parseVersion(value) {
  if (typeof value !== 'string' || value.length > 64) return null;
  let match = VERSION.exec(value);
  if (!match) {
    match = NPM_VERSION.exec(value);
    if (!match) return null;
  }
  const [, major, minor, patch, rawLetter, number] = match;
  const letter = rawLetter === 'alpha' ? 'a' : rawLetter === 'beta' ? 'b' : rawLetter;
  const stage = letter ? ({ a: 'alpha', b: 'beta', rc: 'rc' })[letter] : 'final';
  const rank = { alpha: 0, beta: 1, rc: 2, final: 3 }[stage];
  const stageNumber = stage === 'final' ? 0 : Number(number);
  const text = stage === 'final' ? `${major}.${minor}.${patch}` : `${major}.${minor}.${patch}${letter}${stageNumber}`;
  const npmVersion = stage === 'final' ? text : `${major}.${minor}.${patch}-${stage}.${stageNumber}`;
  return { text, npmVersion, major: Number(major), minor: Number(minor), patch: Number(patch), stage, stageNumber, rank, preRelease: stage !== 'final' };
}

function compareVersions(left, right) {
  const a = typeof left === 'string' ? parseVersion(left) : left;
  const b = typeof right === 'string' ? parseVersion(right) : right;
  if (!a || !b) return null;
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  if (a.rank !== b.rank) return a.rank < b.rank ? -1 : 1;
  if (a.stageNumber !== b.stageNumber) return a.stageNumber < b.stageNumber ? -1 : 1;
  return 0;
}

function normalizeVersion(value) {
  const parsed = parseVersion(value);
  return parsed ? parsed.text : null;
}

function channelFor(parsed) {
  return parsed.preRelease ? 'alpha' : 'stable';
}

function tagged(version) {
  const parsed = parseVersion(version);
  return parsed ? `v${parsed.text}` : null;
}

function newTagged(npmVersion) {
  return `dwhale-v${npmVersion}`;
}

function parseTag(tag) {
  if (typeof tag !== 'string' || tag.length > 96) return null;
  if (tag.startsWith('dwhale-v')) {
    const parsed = parseVersion(tag.slice('dwhale-v'.length));
    if (!parsed || newTagged(parsed.npmVersion) !== tag) return null;
    return { namespace: 'dwhale', tag, version: parsed.text, npmVersion: parsed.npmVersion, preRelease: parsed.preRelease, channel: channelFor(parsed) };
  }
  if (tag.startsWith('v')) {
    const parsed = parseVersion(tag.slice(1));
    if (!parsed || parsed.stage === 'beta' || parsed.stage === 'rc') return null;
    if (tagged(parsed.text) !== tag) return null;
    return { namespace: 'legacy', tag, version: parsed.text, npmVersion: parsed.npmVersion, preRelease: parsed.preRelease, channel: channelFor(parsed) };
  }
  return null;
}

function verifySignature(raw, signature, trust) {
  if (!Buffer.isBuffer(raw) || raw.length > MAX_MANIFEST) fail('MANIFEST_TOO_LARGE');
  if (!isObject(trust) || trust.repository !== REPOSITORY || trust.algorithm !== 'ed25519' || typeof trust.publicKey !== 'string') fail('SIGNATURE_INVALID');
  if (!Buffer.isBuffer(signature) || signature.length !== 64) fail('SIGNATURE_INVALID');
  let valid = false;
  try {
    valid = crypto.verify(null, raw, trust.publicKey, signature);
  } catch {
    fail('SIGNATURE_INVALID');
  }
  if (!valid) fail('SIGNATURE_INVALID');
}

function parseSigned(raw, signature, trust) {
  verifySignature(raw, signature, trust);
  let value;
  try {
    value = JSON.parse(raw.toString('utf8'));
  } catch {
    fail('MANIFEST_INVALID');
  }
  if (!isObject(value)) fail('MANIFEST_INVALID');
  return value;
}

function runtimeMatrix(value) {
  if (!exactKeys(value, RUNTIME_KEYS)) fail('MANIFEST_INVALID');
  for (const key of RUNTIME_KEYS) {
    if (typeof value[key] !== 'string' || !TOKEN.test(value[key])) fail('MANIFEST_INVALID');
  }
  return { astrbot: value.astrbot, python: value.python, node: value.node, ffmpeg: value.ffmpeg };
}

function impact(value) {
  if (!exactKeys(value, IMPACT_KEYS)) fail('MANIFEST_INVALID');
  for (const key of IMPACT_KEYS) {
    if (typeof value[key] !== 'boolean') fail('MANIFEST_INVALID');
  }
  return { runtime: value.runtime, dataMigration: value.dataMigration, configuration: value.configuration, rollbackCompatible: value.rollbackCompatible };
}

function minimumOS(value) {
  if (!frozen(value, MINIMUM_OS)) fail('MANIFEST_INVALID');
  return value;
}

function installers(value, version, name, base) {
  if (!exactKeys(value, Object.keys(PLATFORMS))) fail('MANIFEST_INVALID');
  const assets = {};
  for (const [platform, suffix] of Object.entries(PLATFORMS)) {
    const asset = value[platform];
    if (!exactKeys(asset, ['name', 'url', 'size', 'sha256'])) fail('MANIFEST_INVALID');
    if (asset.name !== name(version, suffix)) fail('MANIFEST_INVALID');
    if (asset.url !== `${base}${asset.name}`) fail('MANIFEST_INVALID');
    if (!Number.isInteger(asset.size) || asset.size <= 0 || asset.size > MAX_INSTALLER) fail('MANIFEST_INVALID');
    if (!SHA256.test(asset.sha256)) fail('MANIFEST_INVALID');
    assets[platform] = { name: asset.name, url: asset.url, size: asset.size, sha256: asset.sha256 };
  }
  return assets;
}

function verifyLegacy(raw, signature, options = {}) {
  const trust = options.trust;
  const value = parseSigned(raw, signature, trust);
  if (!exactKeys(value, V1_KEYS) || value.schemaVersion !== 1) fail('MANIFEST_INVALID');
  const parsed = parseVersion(value.version);
  if (!parsed || value.product !== 'DSWhale' || value.repository !== REPOSITORY) fail('MANIFEST_INVALID');
  if (options.expectedVersion && parsed.text !== normalizeVersion(options.expectedVersion)) fail('MANIFEST_INVALID');
  if (value.npmVersion !== parsed.npmVersion || value.channel !== channelFor(parsed)) fail('MANIFEST_INVALID');
  if (value.tag !== tagged(parsed.text)) fail('MANIFEST_INVALID');
  if (typeof value.commit !== 'string' || !COMMIT.test(value.commit)) fail('MANIFEST_INVALID');
  minimumOS(value.minimumOS);
  const runtime = runtimeMatrix(value.runtime);
  if (!frozen(runtime, options.runtime || LEGACY_MATRIX)) fail('MANIFEST_INVALID');
  const impactValue = impact(value.impact);
  const assets = installers(value.assets, parsed.npmVersion, (version, suffix) => `DSWhale-${version}-${suffix}`, `${RELEASE_BASE}v${parsed.text}/`);
  return {
    schemaVersion: 1,
    product: 'DSWhale',
    repository: REPOSITORY,
    version: parsed.text,
    npmVersion: parsed.npmVersion,
    channel: channelFor(parsed),
    tag: value.tag,
    commit: value.commit,
    minimumOS: value.minimumOS,
    runtime,
    impact: impactValue,
    assets,
  };
}

function verifyModern(raw, signature, options = {}) {
  const trust = options.trust;
  const value = parseSigned(raw, signature, trust);
  if (!exactKeys(value, V2_KEYS) || value.schemaVersion !== 2) fail('MANIFEST_INVALID');
  const parsed = parseVersion(value.version);
  if (!parsed || value.product !== 'DWhale' || value.productId !== PRODUCT_ID || value.repository !== REPOSITORY) fail('MANIFEST_INVALID');
  if (value.pythonVersion !== parsed.text || value.npmVersion !== parsed.npmVersion) fail('MANIFEST_INVALID');
  if (value.tag !== newTagged(parsed.npmVersion) || value.channel !== channelFor(parsed)) fail('MANIFEST_INVALID');
  if (options.expectedTag && value.tag !== options.expectedTag) fail('MANIFEST_INVALID');
  if (options.expectedVersion && parsed.text !== normalizeVersion(options.expectedVersion)) fail('MANIFEST_INVALID');
  if (typeof value.commit !== 'string' || !COMMIT.test(value.commit)) fail('MANIFEST_INVALID');
  minimumOS(value.minimumOS);
  const runtime = runtimeMatrix(value.runtime);
  if (typeof value.runtimeLockSha256 !== 'string' || !SHA256.test(value.runtimeLockSha256)) fail('MANIFEST_INVALID');
  const impactValue = impact(value.impact);
  const assets = installers(value.assets, parsed.npmVersion, (version, suffix) => `DWhale-${version}-${suffix}`, `${RELEASE_BASE}${value.tag}/`);
  return {
    schemaVersion: 2,
    product: 'DWhale',
    productId: PRODUCT_ID,
    repository: REPOSITORY,
    version: parsed.text,
    pythonVersion: parsed.text,
    npmVersion: parsed.npmVersion,
    tag: value.tag,
    channel: channelFor(parsed),
    commit: value.commit,
    minimumOS: value.minimumOS,
    runtime,
    runtimeLockSha256: value.runtimeLockSha256,
    impact: impactValue,
    assets,
  };
}

function manifestKind(raw) {
  try {
    const value = JSON.parse(Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw));
    return value && value.schemaVersion === 2 ? 2 : 1;
  } catch {
    return null;
  }
}

function verifyManifest(raw, signature, options = {}) {
  const kind = manifestKind(raw);
  if (kind === 2) return verifyModern(raw, signature, options);
  return verifyLegacy(raw, signature, options);
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

module.exports = {
  LEGACY_MATRIX,
  REPOSITORY,
  PRODUCT_ID,
  RELEASE_BASE,
  MAX_MANIFEST,
  MAX_INSTALLER,
  MINIMUM_OS,
  SUFFIXES: LEGACY_SUFFIXES,
  PLATFORMS,
  RUNTIME_KEYS,
  IMPACT_KEYS,
  ProtocolError,
  parseVersion,
  compareVersions,
  normalizeVersion,
  channelFor,
  parseTag,
  verifySignature,
  verifyLegacy,
  verifyModern,
  verifyManifest,
  manifestKind,
  sha256,
};
