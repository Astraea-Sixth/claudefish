'use strict';

// Ranked full-text search over journal + sessions + memory using node:sqlite FTS5.
// Rebuilds the index at startup and incrementally on demand. Zero external deps.

const fs = require('fs');
const path = require('path');

let sqliteLoaded = null;
function loadSqlite() {
  if (sqliteLoaded !== null) return sqliteLoaded;
  try { sqliteLoaded = require('node:sqlite'); } catch { sqliteLoaded = null; }
  return sqliteLoaded;
}

class Archive {
  constructor(dataDir) {
    this.dataDir = dataDir;
    const sqlite = loadSqlite();
    if (!sqlite) { this.db = null; return; }
    const dbFile = path.join(dataDir, 'archive.sqlite');
    this.db = this._openOrRecover(sqlite, dbFile);
    if (!this.db) return;
    try {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS docs USING fts5(
          kind, userId, source, body, ts UNINDEXED, tokenize = 'porter unicode61'
        );
        CREATE TABLE IF NOT EXISTS ingested (source TEXT PRIMARY KEY, mtime INTEGER);
      `);
      // Schema version guard: stamp on fresh, refuse to run on future versions.
      const row = this.db.prepare('PRAGMA user_version').get();
      const ver = row ? Number(row.user_version || 0) : 0;
      if (ver === 0) {
        this.db.exec('PRAGMA user_version = 1');
      } else if (ver > 1) {
        console.error(`[archive] archive.sqlite has user_version=${ver}, this build supports <=1. Refusing to run. Move or delete ${dbFile} to continue.`);
        this.db = null;
      }
    } catch (e) {
      console.warn(`[archive] schema init failed: ${e.message}`);
      this.db = null;
    }
  }

  _openOrRecover(sqlite, dbFile) {
    try {
      return new sqlite.DatabaseSync(dbFile);
    } catch (e) {
      console.warn(`[archive] failed to open ${dbFile}: ${e.message}`);
      try {
        if (fs.existsSync(dbFile)) {
          const backup = `${dbFile}.corrupt.${Date.now()}`;
          fs.renameSync(dbFile, backup);
          console.warn(`[archive] moved corrupt DB to ${backup}, creating fresh`);
        }
        return new sqlite.DatabaseSync(dbFile);
      } catch (e2) {
        console.error(`[archive] recovery also failed: ${e2.message}. FTS search disabled.`);
        return null;
      }
    }
  }

  available() { return !!this.db; }

  _ingestFile(kind, source, body, ts, userId = '') {
    const del = this.db.prepare('DELETE FROM docs WHERE source = ?');
    del.run(source);
    const ins = this.db.prepare('INSERT INTO docs (kind, userId, source, body, ts) VALUES (?, ?, ?, ?, ?)');
    ins.run(kind, String(userId || ''), source, body, Number(ts) || 0);
    const mark = this.db.prepare('INSERT OR REPLACE INTO ingested (source, mtime) VALUES (?, ?)');
    mark.run(source, Number(ts) || 0);
  }

  _needs(source, mtime) {
    const r = this.db.prepare('SELECT mtime FROM ingested WHERE source = ?').get(source);
    return !r || r.mtime < mtime;
  }

  rebuild() {
    if (!this.db) return;
    this._scanDir(path.join(this.dataDir, 'journal'), 'journal');
    this._scanDir(path.join(this.dataDir, 'sessions'), 'sessions');
    this._scanMemory(path.join(this.dataDir, 'memory'));
  }

  _scanDir(dir, kind) {
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      let st; try { st = fs.statSync(full); } catch { continue; }
      if (!st.isFile()) continue;
      if (!this._needs(full, st.mtimeMs | 0)) continue;
      let body; try { body = fs.readFileSync(full, 'utf8'); } catch { continue; }
      this._ingestFile(kind, full, body, st.mtimeMs | 0);
    }
  }

  _scanMemory(root) {
    const usersRoot = path.join(root, 'users');
    if (!fs.existsSync(usersRoot)) return;
    for (const user of fs.readdirSync(usersRoot)) {
      const dir = path.join(usersRoot, user);
      let st; try { st = fs.statSync(dir); } catch { continue; }
      if (!st.isDirectory()) continue;
      this._scanMemoryUser(dir, user);
    }
  }

  _scanMemoryUser(dir, user) {
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.md')) continue;
      const full = path.join(dir, name);
      let st; try { st = fs.statSync(full); } catch { continue; }
      if (!this._needs(full, st.mtimeMs | 0)) continue;
      let body; try { body = fs.readFileSync(full, 'utf8'); } catch { continue; }
      this._ingestFile('memory', full, body, st.mtimeMs | 0, user);
    }
  }

  // Escape FTS5 query: quote every term so punctuation/operators don't break.
  _ftsQuery(q) {
    const terms = q.match(/[A-Za-z0-9_]+/g) || [];
    if (!terms.length) return null;
    return terms.map(t => `"${t}"`).join(' AND ');
  }

  search(q, { userId = null, limit = 20 } = {}) {
    if (!this.db) return null; // caller should fall back to grep
    const ftsQ = this._ftsQuery(q);
    if (!ftsQ) return [];
    const rows = this.db.prepare(`
      SELECT kind, userId, source, ts,
             snippet(docs, 3, '[', ']', ' … ', 16) AS snip,
             bm25(docs) AS rank
      FROM docs WHERE docs MATCH ? ${userId ? "AND (userId = ? OR userId = '')" : ''}
      ORDER BY rank LIMIT ?
    `).all(...(userId ? [ftsQ, String(userId), limit] : [ftsQ, limit]));
    return rows;
  }

  formatHits(hits, dataDir) {
    if (!hits || !hits.length) return '';
    return hits.map(h => {
      const rel = h.source.replace(dataDir + '/', '');
      return `${rel}  ${h.snip.replace(/\s+/g, ' ').trim()}`;
    }).join('\n').slice(0, 3800);
  }
}

module.exports = { Archive };
