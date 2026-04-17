'use strict';

// Memory decay: soft-delete `project` notes not touched in 60 days.
// `user` and `feedback` notes are permanent. `reference` notes are permanent.
// `auto` notes (e.g. weekly digests) are also excluded.
// Touches = mtime on the memory file.

const fs = require('fs');
const path = require('path');

const DECAY_DAYS = 60;

function sweepMemory(memoryRootDir) {
  const out = { archived: [], kept: 0 };
  if (!fs.existsSync(memoryRootDir)) return out;
  const cutoff = Date.now() - DECAY_DAYS * 86_400_000;
  // Per-user subdirs.
  const userRoot = path.join(memoryRootDir, 'users');
  const userDirs = fs.existsSync(userRoot)
    ? fs.readdirSync(userRoot).map(u => path.join(userRoot, u))
    : [];
  for (const dir of userDirs) sweepOne(dir, cutoff, out);
  // Root-level memory (no userId partition)
  sweepOne(memoryRootDir, cutoff, out);
  return out;
}

function sweepOne(dir, cutoff, out) {
  let names; try { names = fs.readdirSync(dir); } catch { return; }
  for (const name of names) {
    if (!name.endsWith('.md')) continue;
    if (name === 'MEMORY.md') continue;
    const full = path.join(dir, name);
    let st; try { st = fs.statSync(full); } catch { continue; }
    if (!st.isFile()) continue;
    if (st.mtimeMs >= cutoff) { out.kept++; continue; }
    let raw; try { raw = fs.readFileSync(full, 'utf8'); } catch { continue; }
    const meta = parseFrontmatter(raw);
    if (!meta) { out.kept++; continue; }
    if (meta.type !== 'project') { out.kept++; continue; }
    if (meta.auto) { out.kept++; continue; }
    // Archive
    const archDir = path.join(dir, '_archive');
    fs.mkdirSync(archDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const dst = path.join(archDir, name.replace(/\.md$/, `__${ts}.md`));
    try {
      fs.renameSync(full, dst);
      out.archived.push({ from: full, to: dst });
    } catch (e) {
      console.error(`[decay] archive ${full}: ${e.message}`);
      out.kept++;
    }
  }
}

function parseFrontmatter(raw) {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return null;
  const meta = {};
  for (const line of m[1].split('\n')) {
    const mm = line.match(/^(\w+):\s*(.+)$/);
    if (mm) meta[mm[1]] = mm[2].trim();
  }
  // normalize booleans
  if (meta.auto === 'true') meta.auto = true;
  return meta;
}

module.exports = { sweepMemory, DECAY_DAYS };
