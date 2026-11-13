'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const APP_ID = 'dev.dswhale.desktop';
const RECORD_NAME = 'legacy-bundle-choice.json';
const LEGACY_NAME = 'DSWhale.app';

function durableBundlePaths(home) {
  return [path.join('/Applications', 'DWhale.app'), path.join(home, 'Applications', 'DWhale.app')].map(value => path.resolve(value));
}
function isDurableBundle(bundlePath, home) {
  const resolved = path.resolve(bundlePath);
  return durableBundlePaths(home).includes(resolved);
}
function isDurableLegacyBundle(bundlePath, home) {
  const resolved = path.resolve(bundlePath);
  return [path.join('/Applications', LEGACY_NAME), path.join(home, 'Applications', LEGACY_NAME)].map(value => path.resolve(value)).includes(resolved);
}
function parseChoices(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  // Older drafts stored the map directly. Accept it once, but never write it back.
  if (value.format === 1 && value.choices && typeof value.choices === 'object' && !Array.isArray(value.choices)) return { ...value.choices };
  if (value.format === undefined && !Object.hasOwn(value, 'choices')) return { ...value };
  return {};
}
async function readChoices(file) {
  try { return parseChoices(JSON.parse(await fs.readFile(file, 'utf8'))); } catch { return {}; }
}
async function writeChoices(file, choices) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, JSON.stringify({ format: 1, choices }), { mode: 0o600 });
  await fs.rename(temporary, file);
}
async function bundleIdentifier(bundlePath, run = execFileAsync) {
  const plist = path.join(bundlePath, 'Contents', 'Info.plist');
  const { stdout } = await run('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', plist], { maxBuffer: 16 * 1024 });
  return String(stdout).trim();
}

async function migrateLegacyBundles({
  currentBundle, home, userData, dialog, shell, branding, packaged = true,
  platform = process.platform, run = execFileAsync,
}) {
  if (platform !== 'darwin' || !packaged) return {};
  const resolvedCurrent = path.resolve(currentBundle);
  if (!isDurableBundle(resolvedCurrent, home)) return {};
  const markerFile = path.join(userData, RECORD_NAME);
  const choices = await readChoices(markerFile);
  for (const candidate of branding.macBundleCandidates(home)) {
    if (!candidate.legacy || branding.sameBundlePath(candidate.path, resolvedCurrent)) continue;
    if ((!isDurableBundle(candidate.path, home) && !isDurableLegacyBundle(candidate.path, home)) || choices[candidate.path]) continue;
    try {
      const entry = await fs.lstat(candidate.path);
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      if (await bundleIdentifier(candidate.path, run) !== APP_ID) continue;
    } catch { continue; }
    const result = await dialog.showMessageBox({
      type: 'info', title: 'DWhale 名称已更新',
      message: '发现旧版 DSWhale.app。',
      detail: 'DWhale 使用新的应用名称，但账号、记忆和设置都已保留。是否将旧版移到废纸篓？',
      buttons: ['移到废纸篓', '保留旧版'], defaultId: 0, cancelId: 1, noLink: true,
    });
    if (result.response === 0) {
      try { await shell.trashItem(candidate.path); choices[candidate.path] = 'trashed'; }
      catch { choices[candidate.path] = 'failed'; }
    } else choices[candidate.path] = 'kept';
    try { await writeChoices(markerFile, choices); } catch {}
  }
  return choices;
}

module.exports = { APP_ID, RECORD_NAME, LEGACY_NAME, durableBundlePaths, isDurableBundle, isDurableLegacyBundle, parseChoices, readChoices, writeChoices, bundleIdentifier, migrateLegacyBundles };
