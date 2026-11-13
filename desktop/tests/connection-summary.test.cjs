'use strict';
// T3-I2 (global connection summary independent of the locally inspected tab) and
// T3-I4 (normalized, dismissible renderer errors). Everything here is synthetic:
// no Electron, no real QQ/NapCat, no network.
const test = require('node:test');
const assert = require('node:assert/strict');
const { connectionViewModel, connectionSummary, createController } = require('../ui/model.js');

const napcatChannel = {
  channel: 'napcat', label: '普通 QQ 小号', platformType: 'aiocqhttp', platformId: 'qq',
  platformEnabled: true, configured: true, targetIssue: '', bound: true,
  processRunning: true, loginState: 'online', protocolConnected: true, identityKnown: true, health: 'connected',
};
const officialChannel = {
  channel: 'official', label: 'QQ 官方机器人', platformType: 'qq_official', platformId: 'official-test',
  platformEnabled: false, configured: true, targetIssue: '', bound: true,
  processRunning: false, loginState: 'stopped', protocolConnected: false, identityKnown: false, health: 'disabled',
};

function liveNapcatState() {
  return {
    settings: { qqConnectionMode: 'napcat', officialConfigured: false, ownerQQ: '123456789' },
    state: { installed: true, running: true, platform: { id: 'win32-x64' }, setup: { qqConnectionMode: 'napcat', modelConfigured: true } },
    workspace: { napcat: { configured: true, externalOnly: false, running: true, loginState: 'online', protocolConnected: true } },
    connections: { channels: [napcatChannel, officialChannel] },
  };
}

test('T3-I4: the Electron IPC prefix is removed from the user-facing error', async () => {
  const bridge = {
    invoke: async () => { throw new Error("Error invoking remote method 'dswhale:action': Error: [APP-001] 至少要保留一路可用的 QQ 连接；如要切换，请先启用另一条连接"); },
    onState() { return () => {}; },
  };
  const controller = createController({ bridge });
  await assert.rejects(controller.act('stop'));
  assert.equal(controller.get().error, '[APP-001] 至少要保留一路可用的 QQ 连接；如要切换，请先启用另一条连接');
  assert.doesNotMatch(controller.get().error, /Error invoking remote method/);
  assert.doesNotMatch(controller.get().error, /^Error:/);
});

test('T3-I4: dismissing the banner clears the local error but not an in-flight action', async () => {
  let release;
  let push;
  const gate = new Promise(resolve => { release = resolve; });
  const fault = '[APP-001] 对话服务已退出，请检查配置后重试';
  const bridge = {
    invoke: async action => {
      if (action === 'inspect') return { installed: true, running: true };
      if (action === 'workspace-status') return { health: null, backups: [], appUpdate: null, napcat: null, preferences: {} };
      if (action === 'appearance-get') return null;
      await gate; return { connections: {} };
    },
    onState(callback) { push = callback; return () => {}; },
  };
  const controller = createController({ bridge });
  await controller.init();
  const pending = controller.act('stop');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(controller.get().pending, 'stop');

  // main publishes this through dswhale:state — it is a real fault, not a
  // renderer-local rejection, and the visible banner can still be dismissed.
  push({ error: fault });
  assert.equal(controller.get().state.error, fault);
  assert.equal(controller.get().error, '');
  controller.dismissError();
  assert.equal(controller.get().dismissedError, fault);
  assert.equal(controller.get().error, '');
  assert.equal(controller.get().state.error, fault, 'dismissing must not clear the real main-process fault');
  assert.equal(controller.get().pending, 'stop', 'dismissing a banner must not release the action fence');

  release();
  await pending;
  assert.equal(controller.get().pending, '');
});

test('T3-I4: a successful read keeps a dismissed fault hidden until a new fault arrives', async () => {
  let push;
  const bridge = {
    invoke: async action => (action === 'connections-status' ? { connections: {} } : {}),
    onState(callback) { push = callback; return () => {}; },
  };
  const controller = createController({ bridge });
  await controller.init();
  const fault = '[APP-001] 对话服务已退出，请检查配置后重试';
  push({ error: fault });
  controller.dismissError();
  assert.equal(controller.get().dismissedError, fault);

  await controller.act('workspace-status');
  assert.equal(controller.get().dismissedError, fault, 'a successful read does not revive a dismissed fault');
  assert.equal(controller.get().state.error, fault, 'the fault itself is retained');
});

test('T3-I4: dismissError clears the local error and retry metadata', async () => {
  const bridge = {
    invoke: async () => { throw new Error("Error invoking remote method 'dswhale:action': Error: [APP-001] 对话服务已退出，请检查配置后重试"); },
    onState() { return () => {}; },
  };
  const controller = createController({ bridge });
  await assert.rejects(controller.act('connections-status', {}));
  // connections-status is read-only and fails: the error banner is local data.
  assert.equal(controller.get().error, '[APP-001] 对话服务已退出，请检查配置后重试');
  controller.dismissError();
  assert.equal(controller.get().error, '');
  assert.equal(controller.get().retry, null);
});

// ---------------------------------------------------------------------------
// R2 — the global summary resolves both channels from enabled state and live
// workspace health. The legacy qqConnectionMode may only break ties.
// ---------------------------------------------------------------------------
const liveNapcatChannel = { ...napcatChannel };
const disabledNapcatChannel = {
  ...napcatChannel,
  platformEnabled: false, processRunning: false, loginState: 'stopped',
  protocolConnected: false, health: 'disabled',
};
const liveOfficialChannel = {
  ...officialChannel,
  platformEnabled: true, configured: true, protocolConnected: true,
  health: 'connected', loginState: 'official',
};

function liveOfficialState() {
  return {
    settings: {
      qqConnectionMode: 'napcat', defaultDelivery: 'official', officialConfigured: true,
      officialOwnerUMO: 'official-test:FriendMessage:owner', ownerQQ: '123456789',
    },
    state: { installed: true, running: true, platform: { id: 'win32-x64' }, setup: { qqConnectionMode: 'napcat', ownerConfigured: true, modelConfigured: true } },
    workspace: {
      napcat: { configured: true, externalOnly: false, running: false, loginState: 'stopped', protocolConnected: false },
      official: { protocolConnected: true },
    },
    connections: { channels: [disabledNapcatChannel, liveOfficialChannel] },
  };
}

test('R3: a cleared main-process fault re-arms the same-text dismissal', async () => {
  let push;
  const bridge = {
    invoke: async action => (action === 'connections-status' ? { connections: {} } : {}),
    onState(callback) { push = callback; return () => {}; },
  };
  const controller = createController({ bridge });
  await controller.init();
  const fault = '启动未完成，请打开窗口查看体检结果';
  const visible = () => {
    const current = controller.get();
    const raw = current.error || current.state.error;
    return raw && raw !== current.dismissedError ? raw : '';
  };

  push({ error: fault });
  assert.equal(visible(), fault);
  controller.dismissError();
  assert.equal(visible(), '');

  // main.cjs startServices publishes error:undefined before a tray retry.
  push({ error: undefined, startup: { stage: 'starting-conversation' } });
  assert.equal(controller.get().dismissedError, '', 'an explicit error clear ends the old dismissal');

  push({ error: fault, startup: { stage: 'failed' } });
  assert.equal(controller.get().state.error, fault);
  assert.equal(visible(), fault, 'the same text after an actual clear is a new fault');
});

test('R3: an ordinary snapshot without an error field keeps the dismissal', async () => {
  let push;
  const bridge = {
    invoke: async action => (action === 'connections-status' ? { connections: {} } : {}),
    onState(callback) { push = callback; return () => {}; },
  };
  const controller = createController({ bridge });
  await controller.init();
  const fault = '启动未完成，请打开窗口查看体检结果';
  push({ error: fault });
  controller.dismissError();

  push({ running: true, startup: { stage: 'checking-qq' } });
  assert.equal(controller.get().dismissedError, fault, 'an update that does not mention error keeps the dismissal');
  assert.equal(controller.get().state.error, fault, 'nor does it clear the real fault');
});

test('R7: dismissing a fault keeps its operation identity, so the same text can return as a new fault', async () => {
  let push;
  const bridge = {
    invoke: async action => (action === 'connections-status' ? { connections: {} } : {}),
    onState(callback) { push = callback; return () => {}; },
  };
  const controller = createController({ bridge });
  await controller.init();
  const fault = '[APP-001] 对话服务已退出，请检查配置后重试';
  const feedback = operationId => ({ kind: 'error', scope: 'action', code: 'APP-001', message: fault, retryable: true, active: true, operationId });
  const visible = () => {
    const current = controller.get();
    const raw = current.error || current.state.error;
    const dismissed = raw && raw === current.dismissedError && (!current.faultFeedbackId || current.faultFeedbackId === current.dismissedFeedbackId);
    return raw && !dismissed ? raw : '';
  };

  push({ error: fault, feedback: feedback('a'.repeat(16)) });
  assert.equal(visible(), fault);
  controller.dismissError();
  assert.equal(controller.get().dismissedError, fault);
  assert.equal(controller.get().dismissedFeedbackId, 'a'.repeat(16));
  assert.equal(visible(), '');

  push({ error: fault, feedback: { kind: 'warning', scope: 'workspace', code: 'APP-001', message: fault, retryable: true, active: true, operationId: 'w'.repeat(16) } });
  assert.equal(controller.get().state.error, fault);
  assert.equal(visible(), '', 'an unrelated warning must not revive the dismissed fault');

  push({ error: fault, feedback: feedback('b'.repeat(16)) });
  assert.equal(controller.get().state.error, fault);
  assert.equal(visible(), fault, 'the same message under a new error is a new fault');
});

test('R7: a successful read with cleared feedback still keeps the dismissed fault hidden', async () => {
  let push;
  const bridge = {
    invoke: async action => (action === 'connections-status' ? { connections: {} } : {}),
    onState(callback) { push = callback; return () => {}; },
  };
  const controller = createController({ bridge });
  await controller.init();
  const fault = '[APP-001] 对话服务已退出，请检查配置后重试';
  push({ error: fault, feedback: { kind: 'error', scope: 'action', code: 'APP-001', message: fault, retryable: true, active: true, operationId: 'a'.repeat(16) } });
  controller.dismissError();
  push({ workspaceWarning: '', feedback: null });
  const current = controller.get();
  const raw = current.error || current.state.error;
  const dismissed = raw && raw === current.dismissedError && (!current.faultFeedbackId || current.faultFeedbackId === current.dismissedFeedbackId);
  assert.equal(raw, fault, 'the fault text remains in state');
  assert.ok(dismissed, 'a successful read does not revive the dismissed box');
});
