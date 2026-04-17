'use strict';

// Minimal cron. data/cron.json is an array of {id, whenTs, prompt, chatId, fromId, recurMs?}
// Persisted, checked every 30s. Fires by invoking onFire({prompt, chatId, fromId}).

const fs = require('fs');
const path = require('path');

class Scheduler {
  constructor(file, onFire) {
    this.file = file;
    this.onFire = onFire;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (!fs.existsSync(file)) fs.writeFileSync(file, '[]', 'utf8');
    this.timer = null;
  }
  _load() {
    try { return JSON.parse(fs.readFileSync(this.file, 'utf8')); }
    catch { return []; }
  }
  _save(arr) {
    const tmp = `${this.file}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(arr, null, 2), 'utf8');
    fs.renameSync(tmp, this.file);
  }

  list() { return this._load(); }

  add({ whenTs, prompt, chatId, fromId, recurMs }) {
    const arr = this._load();
    const entry = { id: `cr-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, whenTs, prompt, chatId, fromId, recurMs };
    arr.push(entry);
    this._save(arr);
    return entry;
  }

  remove(id) {
    const arr = this._load().filter(e => e.id !== id);
    this._save(arr);
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick().catch(e => console.error(`[cron] ${e.message}`)), 30 * 1000);
    // initial tick after 2s so pending fires dispatch soon after startup
    setTimeout(() => this.tick().catch(() => {}), 2000);
  }

  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  async tick() {
    const now = Date.now();
    const arr = this._load();
    const due = arr.filter(e => e.whenTs <= now);
    const keep = arr.filter(e => e.whenTs > now);
    for (const e of due) {
      try { await this.onFire(e); } catch (err) { console.error(`[cron] fire ${e.id}: ${err.message}`); }
      if (e.recurMs) keep.push({ ...e, whenTs: now + e.recurMs });
    }
    this._save(keep);
  }
}

module.exports = { Scheduler };
