'use strict';

// Signed schema1 bridge handoff. The bridge installer itself is authenticated
// by the legacy manifest, and its transition description fixes one exact
// schema2 target. This module only parses and advances that bounded chain; it
// never fetches an arbitrary URL.

const crypto = require('node:crypto');
const protocol = require('./update-protocol.cjs');

const FORMAT = 1;
const STATES = ['pending', 'install-launched', 'completed', 'cancelled', 'rolled-back'];
const KEYS = ['format', 'chainId', 'bridge', 'originVersion', 'originRuntime', 'originV1State', 'originBackup', 'originInstaller', 'fixedFinalTarget', 'hops', 'terminalState'];
const TARGET_KEYS = ['version', 'tag', 'commit', 'manifestSha256', 'runtimeLockSha256', 'assets'];
const BRIDGE_KEYS = ['version', 'tag'];
const HOP_KEYS = ['at', 'from', 'to', 'phase'];

class ChainError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ChainError';
    this.code = 'CHAIN_INVALID';
  }
}

function exact(value, keys) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

function validate(value) {
  if (!exact(value, KEYS) || value.format !== FORMAT) throw new ChainError('chain fields are invalid');
  if (typeof value.chainId !== 'string' || !/^[a-f0-9]{32}$/.test(value.chainId)) throw new ChainError('chain id is invalid');
  if (!STATES.includes(value.terminalState)) throw new ChainError('chain state is invalid');
  if (!exact(value.bridge, BRIDGE_KEYS) || typeof value.bridge.version !== 'string') throw new ChainError('bridge identity is invalid');
  const bridge = protocol.parseVersion(value.bridge.version);
  if (!bridge || value.bridge.tag !== `v${bridge.text}`) throw new ChainError('bridge version is invalid');
  const origin = protocol.parseVersion(value.originVersion);
  if (!origin) throw new ChainError('origin version is invalid');
  if (!exact(value.originRuntime, protocol.RUNTIME_KEYS)) throw new ChainError('origin runtime is invalid');
  for (const key of protocol.RUNTIME_KEYS) {
    if (typeof value.originRuntime[key] !== 'string') throw new ChainError('origin runtime is invalid');
  }
  if (!value.originV1State || typeof value.originV1State !== 'object' || Array.isArray(value.originV1State)) throw new ChainError('origin state is invalid');
  if (value.originBackup !== null && (typeof value.originBackup !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(value.originBackup))) throw new ChainError('origin backup is invalid');
  if (value.originInstaller !== null) {
    if (!exact(value.originInstaller, ['name', 'size', 'sha256'])) throw new ChainError('origin installer is invalid');
    if (typeof value.originInstaller.name !== 'string' || !/^[A-Za-z0-9._-]{1,160}$/.test(value.originInstaller.name)) throw new ChainError('origin installer is invalid');
    if (!Number.isSafeInteger(value.originInstaller.size) || value.originInstaller.size <= 0 || value.originInstaller.size > protocol.MAX_INSTALLER) throw new ChainError('origin installer is invalid');
    if (!/^[a-f0-9]{64}$/.test(value.originInstaller.sha256)) throw new ChainError('origin installer is invalid');
  }
  const target = value.fixedFinalTarget;
  if (!exact(target, TARGET_KEYS)) throw new ChainError('target fields are invalid');
  const parsed = protocol.parseVersion(target.version);
  if (!parsed) throw new ChainError('target version is invalid');
  if (target.tag !== `dwhale-v${parsed.npmVersion}`) throw new ChainError('target tag is invalid');
  if (protocol.compareVersions(target.version, bridge) <= 0) throw new ChainError('target must follow the bridge');
  if (typeof target.commit !== 'string' || !/^[a-f0-9]{40}$/.test(target.commit)) throw new ChainError('target commit is invalid');
  for (const key of ['manifestSha256', 'runtimeLockSha256']) {
    if (typeof target[key] !== 'string' || !/^[a-f0-9]{64}$/.test(target[key])) throw new ChainError('target digest is invalid');
  }
  if (!target.assets || typeof target.assets !== 'object' || Array.isArray(target.assets) || Object.keys(target.assets).sort().join(',') !== Object.keys(protocol.PLATFORMS).sort().join(',')) {
    throw new ChainError('target installers are invalid');
  }
  for (const [platform, suffix] of Object.entries(protocol.PLATFORMS)) {
    const asset = target.assets[platform];
    if (!exact(asset, ['name', 'size', 'sha256'])) throw new ChainError('target installer fields are invalid');
    if (asset.name !== `DWhale-${parsed.npmVersion}-${suffix}`) throw new ChainError('target installer name is invalid');
    if (!Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > protocol.MAX_INSTALLER) throw new ChainError('target installer size is invalid');
    if (!/^[a-f0-9]{64}$/.test(asset.sha256)) throw new ChainError('target installer digest is invalid');
  }
  if (!Array.isArray(value.hops) || value.hops.length > 8) throw new ChainError('chain hops are invalid');
  for (const hop of value.hops) {
    if (!exact(hop, HOP_KEYS)) throw new ChainError('chain hop is invalid');
    if (!protocol.parseVersion(hop.from) || !protocol.parseVersion(hop.to) || !STATES.includes(hop.phase)) throw new ChainError('chain hop is invalid');
    if (!Number.isSafeInteger(hop.at) || hop.at <= 0) throw new ChainError('chain hop time is invalid');
  }
  return value;
}

function parse(bytes) {
  try {
    return validate(JSON.parse(Buffer.isBuffer(bytes) ? bytes.toString('utf8') : String(bytes)));
  } catch (error) {
    if (error instanceof ChainError) throw error;
    throw new ChainError('chain is unreadable');
  }
}

function advance(value, phase, to) {
  const chain = validate(value);
  if (chain.terminalState !== 'pending' && chain.terminalState !== 'install-launched' && !(chain.terminalState === 'completed' && phase === 'rolled-back')) throw new ChainError('chain is closed');
  if (!['install-launched', 'completed', 'cancelled', 'rolled-back'].includes(phase)) throw new ChainError('chain phase is invalid');
  chain.terminalState = phase;
  chain.hops.push({ at: Date.now(), from: chain.bridge.version, to, phase });
  return validate(chain);
}

function nextTarget(value, currentVersion) {
  const chain = validate(value);
  if (chain.terminalState !== 'pending') return null;
  if (protocol.normalizeVersion(currentVersion) !== chain.bridge.version) throw new ChainError('running app is not the bridge');
  return { ...chain.fixedFinalTarget };
}

module.exports = { FORMAT, STATES, ChainError, validate, parse, advance, nextTarget };
