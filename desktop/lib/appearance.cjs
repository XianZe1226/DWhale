'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const FORMAT = 1;
const MATERIALS = new Set(['frosted', 'liquid']);
const KEYS = ['format', 'material', 'revision'];
const DEFAULTS = Object.freeze({ format: FORMAT, material: 'frosted', revision: 0 });
const MESSAGES = { APPEARANCE_INVALID: '外观设置格式无效，请重试', APPEARANCE_PATH: '外观设置目录不安全，未保存', APPEARANCE_SAVE: '外观设置未保存，请重试' };

class AppearanceError extends Error {
  constructor(code) { super(MESSAGES[code] || MESSAGES.APPEARANCE_SAVE); this.name = 'AppearanceError'; this.code = Object.hasOwn(MESSAGES, code) ? code : 'APPEARANCE_SAVE'; }
}

function validate(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== KEYS.length || Object.keys(value).some(key => !KEYS.includes(key))) throw new AppearanceError('APPEARANCE_INVALID');
  if (value.format !== FORMAT || !MATERIALS.has(value.material) || !Number.isInteger(value.revision) || value.revision < 0) throw new AppearanceError('APPEARANCE_INVALID');
  return { format: FORMAT, material: value.material, revision: value.revision };
}

async function regularFile(file) {
  let stat;
  try { stat = await fs.lstat(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw new AppearanceError('APPEARANCE_PATH');
  return stat;
}

class Appearance {
  constructor({ userData }) { this.file = path.join(path.resolve(userData), 'desktop-appearance.json'); this.pending = Promise.resolve(); }
  async _read() {
    try {
      if (!(await regularFile(this.file))) return { ...DEFAULTS };
      const bytes = await fs.readFile(this.file);
      return validate(JSON.parse(bytes.toString('utf8')));
    } catch (error) {
      if (error instanceof AppearanceError) throw error;
      return { ...DEFAULTS };
    }
  }
  async read() { await this.pending.catch(() => {}); return this._read(); }
  save(material) {
    const work = this.pending.catch(() => {}).then(async () => {
      if (!MATERIALS.has(material)) throw new AppearanceError('APPEARANCE_INVALID');
      const previous = await this._read();
      const next = { format: FORMAT, material, revision: previous.revision + 1 };
      const directory = path.dirname(this.file);
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      const temporary = path.join(directory, `.dswhale-appearance-${crypto.randomBytes(8).toString('hex')}.tmp`);
      try {
        const handle = await fs.open(temporary, 'wx', 0o600);
        try { await handle.writeFile(JSON.stringify(next) + '\n'); await handle.sync(); } finally { await handle.close(); }
        await fs.rename(temporary, this.file);
        return next;
      } catch (error) {
        await fs.rm(temporary, { force: true }).catch(() => {});
        if (error instanceof AppearanceError) throw error;
        throw new AppearanceError('APPEARANCE_SAVE');
      }
    });
    this.pending = work;
    return work;
  }
}

module.exports = { Appearance, AppearanceError, validate, DEFAULTS, FORMAT, MATERIALS };
