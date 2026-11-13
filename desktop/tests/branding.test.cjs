'use strict';
// T4: display rename keeps technical identity and ships the DWhale visual assets.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '../..');
function builder(env = {}) {
  const key = require.resolve('../../electron-builder.cjs');
  delete require.cache[key];
  const saved = {};
  for (const [name, value] of Object.entries(env)) { saved[name] = process.env[name]; process.env[name] = value; }
  try { return require(key); } finally { for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } }
}

test('T4: full builds use the DWhale display identity while the app id stays stable', () => {
  const config = builder({ DSWALE_BRIDGE: '' });
  assert.equal(config.appId, 'dev.dswhale.desktop');
  assert.equal(config.productName, 'DWhale');
  assert.match(config.mac.artifactName, /^DWhale-\$\{version\}/);
  assert.match(config.win.artifactName, /^DWhale-\$\{version\}/);
  assert.match(config.linux.artifactName, /^DWhale-\$\{version\}/);
  assert.equal(config.dmg.title, 'DWhale ${version}');
  assert.equal(config.linux.maintainer, 'DWhale Contributors');
  assert.equal(config.linux.desktop.entry.StartupWMClass, 'DWhale');
  assert.equal(require(path.join(root, 'package.json')).productName, 'DWhale');
});

test('T4: the frozen bridge candidate keeps legacy DSWhale names for the old updater', () => {
  const config = builder({ DSWALE_BRIDGE: '1' });
  assert.equal(config.productName, 'DSWhale');
  assert.match(config.mac.artifactName, /^DSWhale-\$\{version\}/);
  assert.match(config.win.artifactName, /^DSWhale-\$\{version\}/);
  assert.match(config.linux.artifactName, /^DSWhale-\$\{version\}/);
  assert.equal(config.dmg.title, 'DSWhale ${version}');
  assert.equal(config.linux.maintainer, 'DSWhale Contributors');
  assert.equal(config.linux.desktop.entry.StartupWMClass, 'DSWhale');
});

test('T4: packaging ships the new artwork and tray template but keeps the legacy data directory', () => {
  const config = builder({ DSWALE_BRIDGE: '' });
  for (const file of ['desktop/ui/dwhale-hero.png', 'desktop/ui/dwhale-whale.png', 'desktop/assets/icon.png', 'desktop/assets/icons/**/*', 'desktop/assets/trayTemplate.png', 'desktop/assets/trayTemplate@2x.png']) assert.ok(config.files.includes(file), file);
  const main = fs.readFileSync(path.join(root, 'desktop/main.cjs'), 'utf8');
  assert.match(main, /app\.setName\('DWhale'\)/);
  assert.match(main, /path\.join\(app\.getPath\('appData'\), 'DSWhale'\)/);
  assert.match(main, /title: 'DWhale'/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).name, 'dswhale-desktop');
});

test('T4: icon artifacts are real multi-size ICO/ICNS and a monochrome tray template', () => {
  const assets = path.join(root, 'desktop/assets');
  const ico = fs.readFileSync(path.join(assets, 'icon.ico'));
  assert.equal(ico.readUInt16LE(2), 1);
  assert.ok(ico.readUInt16LE(4) >= 7);
  assert.equal(fs.readFileSync(path.join(assets, 'icon.icns')).subarray(0, 4).toString(), 'icns');
  for (const size of [16, 32, 48, 256, 512]) assert.ok(fs.existsSync(path.join(assets, 'icons', `${size}x${size}.png`)));
  assert.ok(fs.existsSync(path.join(assets, 'trayTemplate.png')));
  assert.ok(fs.existsSync(path.join(assets, 'trayTemplate@2x.png')));
});

test('R5: Windows updates accept the DWhale executable in a legacy install directory', () => {
  const { windowsUpdateArgs } = require('../lib/installer.cjs');
  assert.deepEqual(windowsUpdateArgs('C:\\Users\\Test\\DSWhale\\DWhale.exe'), ['--updated', '/currentuser', '/D=C:\\Users\\Test\\DSWhale']);
  assert.deepEqual(windowsUpdateArgs('C:\\Users\\Test\\DSWhale\\DSWhale.exe'), ['--updated', '/currentuser', '/D=C:\\Users\\Test\\DSWhale']);
  assert.throws(() => windowsUpdateArgs('C:\\Users\\Test\\DSWhale\\Other.exe'), /无法确认当前应用安装位置/);
  assert.throws(() => windowsUpdateArgs('relative\\DWhale.exe'), /无法确认当前应用安装位置/);
});

test('R5: mac migration keeps one app and release scripts collect both identity modes', () => {
  const branding = require('../lib/branding.cjs');
  const candidates = branding.macBundleCandidates('/Users/Test');
  assert.deepEqual(candidates.map(item => item.path), [
    '/Applications/DWhale.app', '/Applications/DSWhale.app',
    '/Users/Test/Applications/DWhale.app', '/Users/Test/Applications/DSWhale.app',
  ]);
  assert.equal(candidates.filter(item => item.legacy).length, 2);
  assert.ok(branding.sameBundlePath('/Applications/DWhale.app/', '/Applications/DWhale.app'));
  const main = fs.readFileSync(path.join(root, 'desktop/main.cjs'), 'utf8');
  const migration = fs.readFileSync(path.join(root, 'desktop/lib/mac-migration.cjs'), 'utf8');
  assert.match(main, /macMigration\.migrateLegacyBundles/);
  assert.match(migration, /shell\.trashItem\(candidate\.path\)/);
  assert.match(migration, /isDurableLegacyBundle/);
  assert.match(migration, /bundleIdentifier/);
  assert.match(migration, /writeChoices/);
  const build = fs.readFileSync(path.join(root, 'scripts/build_release.py'), 'utf8');
  assert.match(build, /DWhale-\{__version__\}-source\.zip/);
  const workflow = fs.readFileSync(path.join(root, '.github/workflows/desktop.yml'), 'utf8');
  assert.match(workflow, /desktop-dist\/DWhale-\*\.exe/);
  assert.match(workflow, /desktop-dist\/DSWhale-\*\.exe/);
  assert.match(workflow, /name\.startswith\(\('DSWhale-', 'DWhale-'\)\)/);
  const fuses = fs.readFileSync(path.join(root, 'scripts/verify-electron-fuses.cjs'), 'utf8');
  assert.match(fuses, /DWhale\.app/);
  assert.match(fuses, /DSWhale\.app/);
});


test('R5C: Mac migration only accepts durable exact-id bundles and an envelope record', async () => {
  const mac = require('../lib/mac-migration.cjs');
  assert.equal(mac.APP_ID, 'dev.dswhale.desktop');
  assert.equal(mac.isDurableBundle('/Applications/DWhale.app', '/Users/Test'), true);
  assert.equal(mac.isDurableBundle('/Users/Test/Applications/DWhale.app', '/Users/Test'), true);
  assert.equal(mac.isDurableBundle('/Volumes/DWhale/DWhale.app', '/Users/Test'), false);
  assert.equal(mac.isDurableBundle('/Applications/DSWhale.app', '/Users/Test'), false);
  assert.deepEqual(mac.parseChoices({ format: 1, choices: { '/Applications/DSWhale.app': 'kept' } }), { '/Applications/DSWhale.app': 'kept' });
  assert.deepEqual(mac.parseChoices({ '/Applications/DSWhale.app': 'kept' }), { '/Applications/DSWhale.app': 'kept' });
  assert.deepEqual(mac.parseChoices({ format: 1 }), {});
  const id = await mac.bundleIdentifier('/Applications/DSWhale.app', async () => ({ stdout: 'dev.dswhale.desktop\n' }));
  assert.equal(id, 'dev.dswhale.desktop');
  assert.equal(await mac.bundleIdentifier('/Applications/DSWhale.app', async () => ({ stdout: 'com.example.other\n' })), 'com.example.other');
});
