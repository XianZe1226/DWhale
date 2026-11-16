'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const fixture = path.join(__dirname, 'fixtures/console-layout.html');
const stylesheet = path.join(__dirname, '../lib/console-layout.cjs');
const cases = [
  { width: 980, sidebar: 245, stacked: true },
  { width: 964, sidebar: 245, stacked: true },
  { width: 740, sidebar: 245, stacked: true },
  { width: 720, sidebar: 245, stacked: true },
  { width: 1041, sidebar: 245, stacked: true },
  { width: 1042, sidebar: 245, stacked: false },
  { width: 980, sidebar: 56, stacked: false },
  { width: 1280, sidebar: 245, stacked: false },
];

if (process.versions.electron) {
  const { app, BrowserWindow, session } = require('electron');
  const root = process.argv[2];
  for (const name of ['appData', 'userData', 'sessionData', 'temp', 'logs', 'crashDumps']) {
    const directory = path.join(root, name);
    fs.mkdirSync(directory, { recursive: true });
    app.setPath(name, directory);
  }
  app.commandLine.appendSwitch('disk-cache-dir', path.join(root, 'cache'));
  app.whenReady().then(async () => {
    session.defaultSession.webRequest.onBeforeRequest((details, done) => {
      done({ cancel: !details.url.startsWith('data:') });
    });
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, done) => done(false));
    const window = new BrowserWindow({
      show: false, width: 980, height: 700, useContentSize: true,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, offscreen: true },
    });
    const html = fs.readFileSync(fixture, 'utf8');
    const css = fs.existsSync(stylesheet) ? require(stylesheet) : '';
    const results = [];
    for (const { width, sidebar } of cases) {
      window.setContentSize(width, 700);
      await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
      await window.webContents.executeJavaScript(`
        document.querySelector('.fixture').style.marginLeft = '${sidebar}px';
        document.querySelector('.fixture').style.width = 'calc(100% - ${sidebar + 6}px)';
      `);
      if (css) await window.webContents.insertCSS(css);
      results.push(await window.webContents.executeJavaScript(`
        new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => {
          const main = document.querySelector('.config-workspace__main');
          const row = document.querySelector('#ordinary');
          const label = row.querySelector('.property-info').getBoundingClientRect();
          const input = row.querySelector('.config-input').getBoundingClientRect();
          const control = row.querySelector('.v-input').getBoundingClientRect();
          const editable = row.querySelector('input').getBoundingClientRect();
          const title = document.querySelector('#long-label .property-name');
          const hint = document.querySelector('#long-label .property-hint');
          const editor = document.querySelector('.fixture-editor');
          const textarea = document.querySelector('.fixture-textarea');
          const unrelated = document.querySelector('#unrelated .property-info').getBoundingClientRect();
          const modalLabel = document.querySelector('#modal .property-info').getBoundingClientRect();
          const modalInput = document.querySelector('#modal .config-input').getBoundingClientRect();
          resolve({
            width: innerWidth, mainWidth: main.clientWidth, mainScrollWidth: main.scrollWidth,
            stacked: input.top >= label.bottom - 1,
            inputWidth: input.width, controlWidth: control.width, editableWidth: editable.width,
            titleClipped: title.scrollWidth > title.clientWidth + 1,
            hintClipped: hint.scrollWidth > hint.clientWidth + 1,
            editorScrollable: editor.scrollWidth > editor.clientWidth,
            textareaScrollable: textarea.scrollWidth > textarea.clientWidth,
            editorWidth: editor.clientWidth,
            unrelatedWidth: unrelated.width,
            modalStacked: modalInput.top >= modalLabel.bottom - 1,
          });
        })))
      `));
    }
    process.stdout.write(`CONSOLE_LAYOUT_RESULT ${JSON.stringify(results)}\n`);
    window.destroy();
    app.exit(0);
  }).catch(error => {
    process.stderr.write(`${error.stack}\n`);
    app.exit(1);
  });
} else {
  const test = require('node:test');
  const assert = require('node:assert/strict');
  const { spawn, spawnSync } = require('node:child_process');
  const noDisplay = process.platform === 'linux' && !process.env.DISPLAY;

  test('managed narrow configuration forms wrap labels and retain editor scrolling', {
    skip: noDisplay ? 'Electron geometry requires DISPLAY on Linux' : false,
    timeout: 30000,
  }, async context => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dwhale-console-layout-'));
    const env = { ...process.env };
    for (const name of ['NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'ELECTRON_ENABLE_LOGGING', 'ELECTRON_LOG_FILE']) delete env[name];
    for (const name of ['HOME', 'CFFIXED_USER_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'APPDATA', 'LOCALAPPDATA', 'USERPROFILE']) {
      env[name] = path.join(directory, name);
      fs.mkdirSync(env[name], { recursive: true });
    }
    const child = spawn(require('electron'), [__filename, directory], {
      env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32',
    });
    const terminate = () => {
      if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', timeout: 5000 });
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      } else {
        try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      }
    };
    let output = '';
    let errors = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { errors += chunk; });
    const timer = setTimeout(terminate, 20000);
    try {
      const code = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', resolve);
      });
      assert.equal(code, 0, errors);
      const result = output.split('\n').find(line => line.startsWith('CONSOLE_LAYOUT_RESULT '));
      assert.ok(result, `Missing geometry result. ${errors}`);
      const layouts = JSON.parse(result.slice('CONSOLE_LAYOUT_RESULT '.length));
      context.diagnostic(JSON.stringify(layouts));
      for (const [index, layout] of layouts.entries()) {
        const expected = cases[index];
        assert.equal(layout.stacked, expected.stacked, `field arrangement at viewport ${layout.width}px and sidebar ${expected.sidebar}px`);
        if (expected.stacked) {
          assert.equal(layout.titleClipped, false, `title clipped at ${layout.width}px`);
          assert.equal(layout.hintClipped, false, `hint clipped at ${layout.width}px`);
          assert.equal(layout.controlWidth, layout.inputWidth, 'narrow text fields fill their available column');
        } else {
          assert.equal(layout.controlWidth, 270, 'wide text fields retain their upstream width limit');
        }
        assert.ok(layout.editableWidth >= layout.controlWidth - 34, 'the editable input has usable space within its field');
        assert.ok(layout.mainScrollWidth <= layout.mainWidth + 1, `form scrolls horizontally at ${layout.width}px`);
        assert.equal(layout.editorScrollable, true, 'the code field retains local horizontal scrolling');
        assert.equal(layout.textareaScrollable, true, 'the textarea retains local horizontal scrolling');
        assert.equal(layout.unrelatedWidth, layout.width / 2, 'wide dialogs retain their original columns');
        assert.equal(layout.modalStacked, true, 'narrow dialog rows adapt to their own available width');
      }
    } finally {
      clearTimeout(timer);
      terminate();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
}
