'use strict';

// Minimal cron. data/cron.json is an array of {id, whenTs, prompt, chatId, fromId, recurMs?, cronExpr?}
// Persisted, checked every 30s. Fires by invoking onFire({prompt, chatId, fromId}).
//
// Entries with `cronExpr` (5-field crontab) recompute next `whenTs` after firing,
// so they recur forever on the cron schedule. `recurMs` is the legacy fixed-interval path.

const fs = require('fs');
const path = require('path');

// ─── crontab parsing ────────────────────────────────────────────────────────
// Accepts: *, N, N-M, */K, N,M,O, and combinations within a field.
// 5 fields: minute(0-59) hour(0-23) dom(1-31) month(1-12) dow(0-6, 0=Sun).
// No support for names (JAN/MON), no @reboot/@daily aliases.

const FIELD_RANGES = [
  [0, 59],  // minute
  [0, 23],  // hour
  [1, 31],  // day-of-month
  [1, 12],  // month
  [0, 6]    // day-of-week (0=Sun, 6=Sat; 7 also treated as Sun for leniency)
];

function _parseField(field, fieldIdx) {
  const [lo, hi] = FIELD_RANGES[fieldIdx];
  const values = new Set();
  for (const part of field.split(',')) {
    const p = part.trim();
    if (!p) throw new Error(`empty term in field ${fieldIdx}`);
    // */K or N-M/K or N/K
    let stepBase = p, step = 1;
    if (p.includes('/')) {
      const [base, sRaw] = p.split('/');
      const s = parseInt(sRaw, 10);
      if (!Number.isFinite(s) || s <= 0) throw new Error(`bad step in ${p}`);
      stepBase = base;
      step = s;
    }
    let rLo, rHi;
    if (stepBase === '*') { rLo = lo; rHi = hi; }
    else if (stepBase.includes('-')) {
      const [a, b] = stepBase.split('-').map(n => parseInt(n, 10));
      if (!Number.isFinite(a) || !Number.isFinite(b)) throw new Error(`bad range ${stepBase}`);
      rLo = a; rHi = b;
    } else {
      const n = parseInt(stepBase, 10);
      if (!Number.isFinite(n)) throw new Error(`bad number ${stepBase}`);
      // Bare number with step (e.g. 5/15) means "starting at 5, step 15 up to hi"
      rLo = n; rHi = (p.includes('/') ? hi : n);
    }
    // Leniency: dow=7 → 0 (Sunday)
    if (fieldIdx === 4) {
      if (rLo === 7) rLo = 0;
      if (rHi === 7) rHi = 0;
    }
    if (rLo < lo || rHi > hi || rLo > rHi) throw new Error(`out of range ${p} (field ${fieldIdx})`);
    for (let v = rLo; v <= rHi; v += step) values.add(v);
  }
  return values;
}

function cronParse(expr) {
  const fields = String(expr).trim().split(/\s+/);
  if (fields.length !== 5) throw new Error('expected 5 fields');
  return {
    minute: _parseField(fields[0], 0),
    hour:   _parseField(fields[1], 1),
    dom:    _parseField(fields[2], 2),
    month:  _parseField(fields[3], 3),
    dow:    _parseField(fields[4], 4)
  };
}

// Strict validator — used to reject junk Haiku output before persistence.
// Accepts the same surface cronParse does.
function cronValid(expr) {
  try { cronParse(expr); return true; } catch { return false; }
}

// Compute next fire time strictly AFTER `fromTs` (local server time).
// Brute-force minute-by-minute up to 4 years out.
function cronNext(expr, fromTs = Date.now()) {
  const parsed = cronParse(expr);
  const d = new Date(fromTs);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1); // strictly after
  const limit = new Date(fromTs + 4 * 366 * 86400_000);
  while (d <= limit) {
    const m = d.getMinutes(), h = d.getHours(), dom = d.getDate(), mo = d.getMonth() + 1, dow = d.getDay();
    // Classic cron rule: if BOTH dom and dow are restricted (not "*"), match either.
    // We approximate "restricted" as "not the full range".
    const domRestricted = parsed.dom.size !== 31;
    const dowRestricted = parsed.dow.size !== 7;
    const domOk = parsed.dom.has(dom);
    const dowOk = parsed.dow.has(dow);
    const dayOk = (domRestricted && dowRestricted) ? (domOk || dowOk) : (domOk && dowOk);
    if (parsed.minute.has(m) && parsed.hour.has(h) && parsed.month.has(mo) && dayOk) {
      return d.getTime();
    }
    d.setMinutes(d.getMinutes() + 1);
  }
  return null;
}

// ─── human-readable summary ─────────────────────────────────────────────────
const DOW_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH_NAMES = ['', 'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function _fieldSummary(field, isStar, set) {
  if (isStar) return { star: true, values: null };
  return { star: false, values: [...set].sort((a, b) => a - b) };
}

function cronToHuman(expr) {
  let p;
  try { p = cronParse(expr); } catch { return `schedule: \`${expr}\``; }
  const fields = expr.trim().split(/\s+/);
  const min = _fieldSummary(fields[0], fields[0] === '*', p.minute);
  const hr  = _fieldSummary(fields[1], fields[1] === '*', p.hour);
  const dom = _fieldSummary(fields[2], fields[2] === '*', p.dom);
  const mon = _fieldSummary(fields[3], fields[3] === '*', p.month);
  const dow = _fieldSummary(fields[4], fields[4] === '*', p.dow);

  const pad = n => String(n).padStart(2, '0');

  // "every N minutes" — minute=*/N, everything else star
  const stepMatch = fields[0].match(/^\*\/(\d+)$/);
  if (stepMatch && hr.star && dom.star && mon.star && dow.star) {
    return `every ${stepMatch[1]} minutes`;
  }
  // hourly: minute=N (single), hour=*, rest=*
  if (!min.star && min.values.length === 1 && hr.star && dom.star && mon.star && dow.star) {
    return `every hour at :${pad(min.values[0])}`;
  }
  // every hour step: hour=*/N, minute=M
  const hrStep = fields[1].match(/^\*\/(\d+)$/);
  if (!min.star && min.values.length === 1 && hrStep && dom.star && mon.star && dow.star) {
    return `every ${hrStep[1]} hours at :${pad(min.values[0])}`;
  }

  const parts = [];

  // Time-of-day
  if (!min.star && min.values.length === 1 && !hr.star && hr.values.length === 1) {
    parts.push(`at ${pad(hr.values[0])}:${pad(min.values[0])}`);
  } else if (!min.star && min.values.length === 1 && hr.star) {
    parts.push(`at :${pad(min.values[0])} every hour`);
  } else if (min.star && hr.star) {
    parts.push(`every minute`);
  } else {
    // Fallback: describe fields generically
    if (!min.star) parts.push(`minute ${min.values.join(',')}`);
    if (!hr.star) parts.push(`hour ${hr.values.join(',')}`);
  }

  // Day selectors
  const dayBits = [];
  if (!dow.star) {
    const names = dow.values.map(v => DOW_NAMES[v]).join('/');
    dayBits.push(`on ${names}`);
  }
  if (!dom.star) {
    dayBits.push(`on day ${dom.values.join(',')} of month`);
  }
  if (!mon.star) {
    dayBits.push(`in ${mon.values.map(v => MONTH_NAMES[v]).join('/')}`);
  }
  if (dayBits.length) parts.push(dayBits.join(' '));
  else if (dow.star && dom.star && mon.star) parts.push('every day');

  return parts.join(' ');
}

// ─── scheduler ──────────────────────────────────────────────────────────────

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

  add({ whenTs, prompt, chatId, fromId, recurMs, cronExpr }) {
    const arr = this._load();
    const entry = { id: `cr-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, whenTs, prompt, chatId, fromId, recurMs, cronExpr };
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
      if (e.cronExpr) {
        const next = cronNext(e.cronExpr, now);
        if (next) keep.push({ ...e, whenTs: next });
      } else if (e.recurMs) {
        keep.push({ ...e, whenTs: now + e.recurMs });
      }
    }
    this._save(keep);
  }
}

module.exports = { Scheduler, cronParse, cronValid, cronNext, cronToHuman };
