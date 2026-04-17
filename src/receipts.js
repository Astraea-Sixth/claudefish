'use strict';

// Tamper-evident approval log. Each entry carries the SHA256 of the previous
// entry's canonical form, so any retroactive edit breaks the chain and can be
// detected at verify() time. No keys to manage.

const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');

const GENESIS = '0'.repeat(64);

function canon(entry) {
  // Deterministic serialization: keys sorted.
  const ordered = {};
  for (const k of Object.keys(entry).sort()) ordered[k] = entry[k];
  return JSON.stringify(ordered);
}

function sha256(s) { return createHash('sha256').update(s).digest('hex'); }

class Receipts {
  constructor(file) {
    this.file = file;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (!fs.existsSync(file)) fs.writeFileSync(file, '', 'utf8');
    // Serialize appends so two concurrent callers can't read the same `prev`
    // hash and fork the chain.
    this._writeLock = Promise.resolve();
  }

  _lines() {
    const raw = fs.readFileSync(this.file, 'utf8');
    return raw.split('\n').filter(Boolean);
  }

  _lastHash() {
    const lines = this._lines();
    if (!lines.length) return GENESIS;
    try { return JSON.parse(lines[lines.length - 1]).hash; }
    catch { return GENESIS; }
  }

  append(args) {
    // Serialize under the write lock. Callers get a promise of the entry;
    // existing sync callers can fire-and-forget since any later verify()
    // reads the file fresh.
    const run = () => {
      const { userId, tool, scope, details, decision } = args;
      const prev = this._lastHash();
      const body = {
        ts: Date.now(),
        userId: String(userId || ''),
        tool,
        scope: scope || null,
        details: details || {},
        decision: decision || 'approve',
        prev
      };
      body.hash = sha256(prev + canon(body));
      fs.appendFileSync(this.file, JSON.stringify(body) + '\n', 'utf8');
      return body;
    };
    const p = this._writeLock.then(run, run);
    // Swallow errors on the chain so one failure doesn't break future appends.
    this._writeLock = p.catch(() => {});
    return p;
  }

  verify() {
    const lines = this._lines();
    let prev = GENESIS;
    for (let i = 0; i < lines.length; i++) {
      let entry;
      try { entry = JSON.parse(lines[i]); } catch { return { ok: false, at: i, reason: 'bad json' }; }
      if (entry.prev !== prev) return { ok: false, at: i, reason: 'prev mismatch' };
      const claimed = entry.hash;
      const expected = sha256(prev + canon(stripHash(entry)));
      if (claimed !== expected) return { ok: false, at: i, reason: 'hash mismatch' };
      prev = claimed;
    }
    return { ok: true, entries: lines.length };
  }

  tail(n = 20, { userId = null } = {}) {
    const lines = this._lines();
    const parsed = [];
    for (const line of lines) {
      try { parsed.push(JSON.parse(line)); } catch {}
    }
    const filtered = userId ? parsed.filter(e => String(e.userId) === String(userId)) : parsed;
    return filtered.slice(-n);
  }
}

function stripHash(e) {
  const c = { ...e };
  delete c.hash;
  return c;
}

module.exports = { Receipts };
