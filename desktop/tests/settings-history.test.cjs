'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { escapeHTML } = require('../ui/model.js');

function renderHistory(field) {
  const source = fs.readFileSync(path.join(__dirname, '../ui/app.js'), 'utf8');
  const start = source.indexOf('  const settingLabels=');
  const end = source.indexOf('  function appearanceCard', start);
  const context = { esc: escapeHTML, desktop: () => true, busy: () => false, disabled: () => '' };
  vm.runInNewContext(`${source.slice(start, end)}\nglobalThis.render = settingsHistoryCard;`, context);
  return context.render({ settings: { configRevision: 'abcdef12' }, settingsHistory: {
    records: [{ id: '1700000000000000000-abcdef12', changedAt: 1700000000, changes: [{ field }] }],
  } });
}

const replyFields = {
  replyStyleMode: '回复方式',
  replyStyleMaxBubbles: '回复目标条数',
  replyStyleInterval: '回复发送间隔',
  replyStylePunctuation: '回复标点处理',
  replyStylePrompt: '回复格式提示',
  replyStyleCustomRegex: '回复自定义正则',
  replyStyleCustomCleanup: '回复自定义清理',
};
for (const [field, label] of Object.entries(replyFields)) {
  test(`history restores the supported ${field} setting with a readable label`, () => {
    const html = renderHistory(field);
    assert.match(html, /data-action="settings-restore-field"/);
    assert.ok(html.includes(`data-field="${field}"`));
    assert.ok(html.includes(`恢复${label}`));
  });
}

test('history rejects personal fields and unrecognized reply-style field names', () => {
  for (const field of ['ownerQQ', 'onebotPort', 'onebotToken', 'platformId', 'signatureEnabled', 'qzoneEnabled', 'replyStyleUnknown', 'replyStyleModeExtra']) {
    assert.doesNotMatch(renderHistory(field), /data-action="settings-restore-field"/);
  }
});
