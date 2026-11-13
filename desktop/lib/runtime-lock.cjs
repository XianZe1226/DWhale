'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const KEY = 'runtime-lock.json';
const MATRIX_KEYS = ['astrbot', 'python', 'node', 'ffmpeg'];
const VERSION = /^[0-9][0-9A-Za-z.+_-]{0,119}$/;
const ASTRBOT = /^[0-9]+\.[0-9]+\.[0-9]+$/;

class RuntimeLockError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RuntimeLockError';
    this.code = 'RUNTIME_LOCK_INVALID';
  }
}

function matrix(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RuntimeLockError('runtime lock matrix is invalid');
  const keys = Object.keys(value).sort();
  if (keys.join(',') !== [...MATRIX_KEYS].sort().join(',')) throw new RuntimeLockError('runtime lock matrix keys are invalid');
  const result = {};
  for (const key of MATRIX_KEYS) {
    const item = value[key];
    if (typeof item !== 'string' || !VERSION.test(item)) throw new RuntimeLockError('runtime lock matrix value is invalid');
    result[key] = item;
  }
  if (!ASTRBOT.test(result.astrbot)) throw new RuntimeLockError('runtime lock AstrBot version is invalid');
  return result;
}

function validate(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RuntimeLockError('runtime lock is invalid');
  if (value.format !== 1 || value.product !== 'DWhale') throw new RuntimeLockError('runtime lock identity is invalid');
  const keys = Object.keys(value).sort();
  if (keys.join(',') !== ['format', 'product', 'verifiedAt', 'source', 'runtime', 'legacy'].sort().join(',')) {
    throw new RuntimeLockError('runtime lock fields are invalid');
  }
  for (const key of ['verifiedAt', 'source']) {
    if (typeof value[key] !== 'string' || !value[key]) throw new RuntimeLockError('runtime lock metadata is invalid');
  }
  if (!value.source.startsWith('https://')) throw new RuntimeLockError('runtime lock source must be HTTPS');
  return {
    format: 1,
    product: 'DWhale',
    verifiedAt: value.verifiedAt,
    source: value.source,
    runtime: matrix(value.runtime),
    legacy: matrix(value.legacy),
  };
}

function parse(bytes) {
  let value;
  try {
    value = JSON.parse(Buffer.isBuffer(bytes) ? bytes.toString('utf8') : String(bytes));
  } catch {
    throw new RuntimeLockError('runtime lock is unreadable');
  }
  return validate(value);
}

function load(file) {
  const resolved = file ? path.resolve(file) : path.join(__dirname, '..', '..', KEY);
  let bytes;
  try {
    bytes = fs.readFileSync(resolved);
  } catch {
    throw new RuntimeLockError('runtime lock is missing');
  }
  return { ...parse(bytes), file: resolved, bytes, digest: crypto.createHash('sha256').update(bytes).digest('hex') };
}

function digest(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

module.exports = { KEY, MATRIX_KEYS, RuntimeLockError, validate, parse, load, digest };
