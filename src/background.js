'use strict';

// Background task runner with disk persistence. Records appended to
// `data/background.jsonl` on spawn/finish. On boot, any record still marked
// `running` is rewritten as `interrupted` and the user is notified.

const fs = require('fs');
const path = require('path');

class BackgroundTasks {
  constructor({ deliver, file } = {}) {
    this.deliver = deliver;
    this.file = file;
    if (file) fs.mkdirSync(path.dirname(file), { recursive: true });
    this.tasks = new Map(); // id -> task record
    this.counter = 0;
  }

  _persist(record) {
    if (!this.file) return;
    try { fs.appendFileSync(this.file, JSON.stringify(record) + '\n', 'utf8'); }
    catch (e) { console.error(`[bg] persist: ${e.message}`); }
  }

  // Replay prior bg.jsonl to rebuild memory, detect interrupted tasks, and
  // find any completed-but-undelivered tasks (delivery was lost to a restart).
  // Returns { interrupted, undelivered } — both should be surfaced to the user.
  recoverOnBoot() {
    if (!this.file || !fs.existsSync(this.file)) return { interrupted: [], undelivered: [] };
    const byId = new Map();
    const raw = fs.readFileSync(this.file, 'utf8').split('\n').filter(Boolean);
    for (const line of raw) {
      try {
        const r = JSON.parse(line);
        byId.set(r.id, { ...(byId.get(r.id) || {}), ...r });
      } catch {}
    }
    const interrupted = [];
    const undelivered = [];
    for (const r of byId.values()) {
      if (r.status === 'running') {
        r.status = 'interrupted';
        r.finishedAt = Date.now();
        r.result = { error: 'process restarted before task completed' };
        this._persist(r);
        interrupted.push(r);
      } else if ((r.status === 'done' || r.status === 'error') && !r.delivered) {
        undelivered.push(r);
      }
      this.tasks.set(r.id, r);
    }
    return { interrupted, undelivered };
  }

  markDelivered(id) {
    const r = this.tasks.get(id);
    if (!r) return;
    r.delivered = true;
    r.deliveredAt = Date.now();
    this._persist(r);
  }

  spawn(runner, { userId, chatId, label } = {}) {
    const id = `bg-${Date.now().toString(36)}-${(++this.counter).toString(36)}`;
    const record = { id, label: label || 'task', userId, chatId, startedAt: Date.now(), status: 'running' };
    this.tasks.set(id, record);
    this._persist(record);
    (async () => {
      let result;
      try { result = await runner(); }
      catch (e) { result = { error: e.message }; }
      record.result = result;
      record.finishedAt = Date.now();
      record.status = result && result.error ? 'error' : 'done';
      this._persist(record);
      if (this.deliver && chatId) {
        // Re-read the in-memory record right before sending: boot-recovery may
        // have queued a re-delivery between our persist and this line. If
        // delivered flipped true, skip sending to prevent a duplicate.
        const current = this.tasks.get(id);
        if (current && current.delivered) {
          return;
        }
        try {
          await this.deliver(record);
          record.delivered = true;
          record.deliveredAt = Date.now();
          this._persist(record);
        } catch (e) { console.error(`[bg] deliver: ${e.message}`); }
      }
    })();
    return id;
  }

  get(id) { return this.tasks.get(id); }

  list({ userId } = {}) {
    const arr = [...this.tasks.values()];
    return userId ? arr.filter(t => String(t.userId) === String(userId)) : arr;
  }
}

module.exports = { BackgroundTasks };
