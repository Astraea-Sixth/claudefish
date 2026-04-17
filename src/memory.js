'use strict';

const fs = require('fs');
const path = require('path');

const VALID_TYPES = new Set(['user', 'feedback', 'project', 'reference']);

// Atomic write: write to temp then rename. Guards against partial writes on
// crash/power-loss corrupting a note or the index.
function atomicWrite(file, content) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, file);
}

function safeName(s) {
  return String(s).replace(/[^a-z0-9._-]/gi, '_').slice(0, 80);
}

function parseFrontmatter(raw) {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: raw };
  const meta = {};
  for (const line of m[1].split('\n')) {
    const mm = line.match(/^(\w+):\s*(.*)$/);
    if (mm) meta[mm[1]] = mm[2].trim();
  }
  return { meta, body: m[2] };
}

function stringifyFrontmatter(meta, body) {
  const lines = Object.entries(meta).map(([k, v]) => `${k}: ${v}`).join('\n');
  return `---\n${lines}\n---\n${body}`;
}

class Memory {
  constructor(rootDir, { userId } = {}) {
    this.root = rootDir;
    this.userId = userId ? safeName(userId) : null;
    this.dir = this.userId
      ? path.join(rootDir, 'users', this.userId)
      : rootDir;
    fs.mkdirSync(this.dir, { recursive: true });
  }

  forUser(userId) { return new Memory(this.root, { userId }); }

  _file(key) { return path.join(this.dir, `${safeName(key)}.md`); }

  write(key, { type = 'project', description = '', body = '', name = key } = {}) {
    if (!VALID_TYPES.has(type)) type = 'project';
    const content = stringifyFrontmatter({ name, description, type }, body);
    atomicWrite(this._file(key), content);
    this._rebuildIndex();
    return { key, type, bytes: Buffer.byteLength(content) };
  }

  // Back-compat: accept plain string as body.
  writeSimple(key, content, type = 'project', description = '') {
    return this.write(key, { type, description, body: String(content), name: key });
  }

  get(key) {
    const f = this._file(key);
    if (!fs.existsSync(f)) return null;
    return fs.readFileSync(f, 'utf8');
  }

  getEntry(key) {
    const raw = this.get(key);
    if (!raw) return null;
    const { meta, body } = parseFrontmatter(raw);
    return { key, ...meta, body };
  }

  delete(key) {
    const f = this._file(key);
    if (fs.existsSync(f) && safeName(key) !== 'MEMORY') {
      fs.unlinkSync(f);
      this._rebuildIndex();
      return true;
    }
    return false;
  }

  // Soft delete: move note into _archive/ with timestamp. Recoverable via restore().
  archive(key) {
    const src = this._file(key);
    if (!fs.existsSync(src) || safeName(key) === 'MEMORY') return false;
    const archDir = path.join(this.dir, '_archive');
    fs.mkdirSync(archDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const dst = path.join(archDir, `${safeName(key)}__${ts}.md`);
    fs.renameSync(src, dst);
    this._rebuildIndex();
    return { archived: dst };
  }

  listArchived() {
    const archDir = path.join(this.dir, '_archive');
    if (!fs.existsSync(archDir)) return [];
    return fs.readdirSync(archDir)
      .filter(f => f.endsWith('.md'))
      .map(f => {
        const m = f.match(/^(.+)__([^_]+)\.md$/);
        return m ? { key: m[1], archivedAt: m[2], file: f } : null;
      })
      .filter(Boolean);
  }

  restore(key) {
    const archDir = path.join(this.dir, '_archive');
    if (!fs.existsSync(archDir)) return false;
    const safeKey = safeName(key);
    const matches = fs.readdirSync(archDir).filter(f => f.startsWith(`${safeKey}__`) && f.endsWith('.md'));
    if (!matches.length) return false;
    matches.sort(); // lexicographic on ISO timestamp → last is newest
    const src = path.join(archDir, matches[matches.length - 1]);
    const dst = this._file(key);
    if (fs.existsSync(dst)) return { error: 'note already exists, restore aborted' };
    fs.renameSync(src, dst);
    this._rebuildIndex();
    return { restored: key };
  }

  list() {
    if (!fs.existsSync(this.dir)) return [];
    return fs.readdirSync(this.dir)
      .filter(f => f.endsWith('.md') && f !== 'MEMORY.md')
      .map(f => f.replace(/\.md$/, ''));
  }

  entries() {
    return this.list().map(k => this.getEntry(k)).filter(Boolean);
  }

  // Given a proposed note (key + body), return existing notes with high
  // keyword overlap. Cheap heuristic used to decide whether to spend a
  // Haiku call on contradiction detection.
  findOverlapping(proposedKey, proposedBody, { minOverlap = 0.3, limit = 5 } = {}) {
    const tokenize = s => new Set((String(s || '').toLowerCase().match(/[a-z0-9_]{4,}/g) || []));
    const prop = tokenize(proposedKey + ' ' + proposedBody);
    if (prop.size < 3) return [];
    const candidates = [];
    for (const entry of this.entries()) {
      if (entry.key === proposedKey) continue;
      const tokens = tokenize(entry.key + ' ' + entry.body);
      if (!tokens.size) continue;
      let hits = 0;
      for (const t of prop) if (tokens.has(t)) hits++;
      const overlap = hits / Math.min(prop.size, tokens.size);
      if (overlap >= minOverlap) candidates.push({ key: entry.key, type: entry.type, overlap, bodyPreview: entry.body.slice(0, 400) });
    }
    return candidates.sort((a, b) => b.overlap - a.overlap).slice(0, limit);
  }

  search(query, limit = 10) {
    const q = String(query).toLowerCase();
    const hits = [];
    for (const e of this.entries()) {
      const hay = `${e.key} ${e.name || ''} ${e.description || ''} ${e.body || ''}`.toLowerCase();
      if (hay.includes(q)) {
        hits.push({ key: e.key, type: e.type, description: e.description, snippet: (e.body || '').slice(0, 240) });
      }
    }
    return hits.slice(0, limit);
  }

  _rebuildIndex() {
    const lines = ['# Memory Index', ''];
    const byType = { user: [], feedback: [], project: [], reference: [] };
    for (const e of this.entries()) {
      const t = byType[e.type] ? e.type : 'project';
      byType[t].push(`- [${e.name || e.key}](${e.key}.md) — ${e.description || '(no description)'}`);
    }
    for (const t of ['user', 'feedback', 'project', 'reference']) {
      if (byType[t].length) {
        lines.push(`## ${t}`, '', ...byType[t], '');
      }
    }
    atomicWrite(path.join(this.dir, 'MEMORY.md'), lines.join('\n'));
  }

  indexText() {
    const f = path.join(this.dir, 'MEMORY.md');
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
  }
}

module.exports = { Memory };
