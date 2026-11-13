'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {validateRequest} = require('../lib/security.cjs');
test('desktop has no personal QQ executable surfaces', () => {
 for (const file of ['main.cjs','lib/workspace.cjs','ui/app.js','ui/model.js']) assert.doesNotMatch(fs.readFileSync(path.join(__dirname,'..',file),'utf8'), /napcat/i, file);
 for (const name of ['napcat.cjs','napcat-session.cjs','napcat-assets.json','qq-connections.cjs']) assert.equal(fs.existsSync(path.join(__dirname,'../lib',name)), false);
});
test('personal QQ and redundant channel mutation IPC are rejected', () => {
 const shell = {mainFrame: {}};
 for (const action of ['napcat-install','napcat-configure','napcat-wire','napcat-stop','napcat-login-code','connection-change','connection-confirm']) assert.throws(() => validateRequest({sender: shell, senderFrame: shell.mainFrame}, shell, action, {}));
});
