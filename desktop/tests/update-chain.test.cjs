'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const chainlib = require('../lib/update-chain.cjs');
const protocol = require('../lib/update-protocol.cjs');

function target(change = {}) {
  return {
    version: '0.4.0a1', tag: 'dwhale-v0.4.0-alpha.1', commit: 'a'.repeat(40),
    manifestSha256: 'b'.repeat(64), runtimeLockSha256: 'c'.repeat(64),
    assets: Object.fromEntries(Object.entries(protocol.SUFFIXES).map(([platform, suffix]) => [platform, {
      name: `DWhale-0.4.0-alpha.1-${suffix}`, size: 1024, sha256: 'd'.repeat(64),
    }])),
    ...change,
  };
}

function chain(change = {}) {
  return {
    format: 1, chainId: 'e'.repeat(32), bridge: { version: '0.4.0a0', tag: 'v0.4.0a0' },
    originVersion: '0.3.0a14', originRuntime: { astrbot: '4.29.3', python: '3.12', node: '22.23.4', ffmpeg: '9.0.2' },
    originV1State: { format: 1, phase: 'install-launched', targetVersion: '0.4.0a0' },
    originBackup: null, originInstaller: null,
    fixedFinalTarget: target(), hops: [], terminalState: 'pending', ...change,
  };
}

test('a signed bridge chain fixes exactly one later target', () => {
  const value = chainlib.validate(chain());
  assert.deepEqual(chainlib.nextTarget(value, '0.4.0-alpha.0'), target());
  assert.throws(() => chainlib.nextTarget(value, '0.3.0a14'), { code: 'CHAIN_INVALID' });
  assert.equal(chainlib.parse(Buffer.from(JSON.stringify(value))).chainId, 'e'.repeat(32));
});

test('chain advances only while pending and then refuses a second target', () => {
  const started = chainlib.advance(chain(), 'install-launched', '0.4.0a1');
  assert.equal(started.terminalState, 'install-launched');
  assert.equal(started.hops.at(-1).to, '0.4.0a1');
  const done = chainlib.advance(started, 'completed', '0.4.0a1');
  assert.equal(done.terminalState, 'completed');
  assert.equal(chainlib.nextTarget(done, '0.4.0-alpha.0'), null);
  assert.throws(() => chainlib.advance(done, 'install-launched', '0.4.0a1'), { code: 'CHAIN_INVALID' });
  assert.equal(chainlib.advance(chain(), 'cancelled', '0.4.0a0').terminalState, 'cancelled');
});

test('chain rejects a downgrade target, foreign tags and rewritten installers', () => {
  const invalid = value => assert.throws(() => chainlib.validate(value), { code: 'CHAIN_INVALID' });
  invalid(chain({ fixedFinalTarget: target({ version: '0.4.0a0', tag: 'dwhale-v0.4.0-alpha.0' }) }));
  invalid(chain({ fixedFinalTarget: target({ tag: 'v0.4.0a1' }) }));
  invalid(chain({ fixedFinalTarget: target({ commit: 'not-a-commit' }) }));
  invalid(chain({ bridge: { version: '0.4.0a1', tag: 'v0.4.0a1' }, fixedFinalTarget: target({ version: '0.4.0a0', tag: 'dwhale-v0.4.0-alpha.0' }) }));
  const broken = target();
  broken.assets['linux-x64'] = { ...broken.assets['linux-x64'], size: 0 };
  invalid(chain({ fixedFinalTarget: broken }));
  invalid(chain({ terminalState: 'resumed' }));
  invalid({ ...chain(), extra: true });
  assert.throws(() => chainlib.parse('{'), { code: 'CHAIN_INVALID' });
});

test('chain terminal state blocks automatic continuation after a restart', () => {
  const cancelled = chainlib.advance(chain(), 'cancelled', '0.4.0a0');
  assert.equal(chainlib.nextTarget(cancelled, '0.4.0-alpha.0'), null);
  const rolled = chainlib.advance(chain(), 'rolled-back', '0.4.0a0');
  assert.equal(chainlib.nextTarget(rolled, '0.4.0-alpha.0'), null);
});
