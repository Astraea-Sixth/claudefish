'use strict';

// Append-only JSONL delivery queue. Survives crashes.
// Entries: { id, kind, payload, status: 'pending'|'sent'|'failed', ts }

const fs = require('fs');
const path = require('path');

// Cap queue file size. Past this, we compact eagerly on next read. Keeps disk
// bounded even if something spams enqueue during an outage.
const MAX_QUEUE_BYTES = 10 * 1024 * 1024; // 10 MB

class DeliveryQueue {
  constructor(file) {
    this.file = file;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (!fs.existsSync(file)) fs.writeFileSync(file, '', 'utf8');
  }

  _readAll() {
    try {
      const st = fs.statSync(this.file);
      if (st.size > MAX_QUEUE_BYTES && !this._compacting) {
        console.warn(`[queue] ${this.file} is ${st.size}B (> ${MAX_QUEUE_BYTES}B) — compacting`);
        this._compacting = true;
        try { this.compact(); } catch (e) { console.error(`[queue] eager compact failed: ${e.message}`); }
        this._compacting = false;
      }
    } catch {}
    const raw = fs.readFileSync(this.file, 'utf8');
    return raw.split('\n').filter(Boolean).map(l => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  }

  _append(entry) {
    fs.appendFileSync(this.file, JSON.stringify(entry) + '\n', 'utf8');
  }

  enqueue(kind, payload) {
    const entry = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, kind, payload, status: 'pending', ts: Date.now() };
    this._append(entry);
    return entry;
  }

  markStatus(id, status) {
    this._append({ id, status, ts: Date.now(), _update: true });
  }

  pending() {
    const all = this._readAll();
    const latest = new Map();
    for (const e of all) latest.set(e.id, { ...(latest.get(e.id) || {}), ...e });
    return Array.from(latest.values()).filter(e => e.status === 'pending' && !e._update);
  }

  async drain(sendFn) {
    for (const e of this.pending()) {
      try {
        await sendFn(e.kind, e.payload);
        this.markStatus(e.id, 'sent');
      } catch (err) {
        console.error(`[queue] ${e.id} failed: ${err.message}`);
        this.markStatus(e.id, 'failed');
      }
    }
  }

  // Rewrite the queue file keeping only pending entries. Intentionally drops
  // sent/failed history — the file grows per-message and we'd blow up disk
  // usage over months of chatter. If you need an audit trail of what was sent,
  // use the session JSONL in data/sessions/ instead.
  compact() {
    const latest = new Map();
    for (const e of this._readAll()) {
      const prev = latest.get(e.id) || {};
      latest.set(e.id, { ...prev, ...e });
    }
    const keep = Array.from(latest.values()).filter(e => e.status === 'pending');
    const tmp = `${this.file}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, keep.map(e => JSON.stringify(e)).join('\n') + (keep.length ? '\n' : ''), 'utf8');
    fs.renameSync(tmp, this.file);
  }
}

module.exports = { DeliveryQueue };
