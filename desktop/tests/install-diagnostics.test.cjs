'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

test('hosted setup diagnostics expose curated metadata and discard private output', () => {
  const messages = [];
  const child = { stderr: new EventEmitter() };
  const childProcess = { spawn: () => child };
  const source = fs.readFileSync(path.join(__dirname, 'install-smoke.cjs'), 'utf8');
  const prefix = source.slice(0, source.indexOf('const { RuntimeManager'));
  vm.runInNewContext(prefix, {
    require: name => name === 'node:child_process' ? childProcess : require(name),
    process: { env: { GITHUB_ACTIONS: 'true' } },
    console: { error: (...values) => messages.push(values.join(' ')) },
  });
  childProcess.spawn('synthetic');
  child.stderr.emit('data', Buffer.from('private credentials and paths stay private\n'));
  child.stderr.emit('data', Buffer.from('DSWHALE_CI_DIAGNOSTIC ' + JSON.stringify({
    file: 'install.py', function: 'install_plugin', line: 90, type: 'PermissionError',
    errno: 13, winerror: 5, secret: 'private synthetic token', path: '/private/synthetic',
  }) + '\n'));
  child.stderr.emit('data', Buffer.from('DSWHALE_CI_DIAGNOSTIC ' + JSON.stringify({
    file: '/private/synthetic/install.py', function: 'install_plugin', line: 90, type: 'PermissionError',
  }) + '\n'));
  assert.equal(messages.length, 1);
  assert.match(messages[0], /PermissionError/);
  assert.match(messages[0], /"winerror":5/);
  assert.doesNotMatch(messages.join(''), /private|token|secret|credentials/);
});
