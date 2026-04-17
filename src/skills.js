'use strict';

// Self-written skills. Each file: data/skills/<name>.md with frontmatter:
//   --- name: ... triggers: word1, word2 ---
//   (body is injected into system prompt when triggered)

const fs = require('fs');
const path = require('path');

function parseSkill(raw, filename) {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  let meta = { name: filename.replace(/\.md$/, ''), triggers: '' };
  let body = raw;
  if (m) {
    body = m[2];
    for (const line of m[1].split('\n')) {
      const mm = line.match(/^(\w+):\s*(.*)$/);
      if (mm) meta[mm[1]] = mm[2].trim();
    }
  }
  const triggers = (meta.triggers || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  return { name: meta.name, triggers, body };
}

function loadSkills(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.md'))
    .map(f => parseSkill(fs.readFileSync(path.join(dir, f), 'utf8'), f));
}

function matchSkills(skills, text) {
  const t = String(text).toLowerCase();
  return skills.filter(s => s.triggers.length && s.triggers.some(tr => t.includes(tr)));
}

function sanitizeSkillName(name) {
  return String(name || '').replace(/[^a-z0-9._-]/gi, '_').slice(0, 60) || 'skill';
}

function skillExists(dir, name) {
  return fs.existsSync(path.join(dir, `${sanitizeSkillName(name)}.md`));
}

function loadSkillByName(dir, name) {
  const safe = sanitizeSkillName(name);
  const f = path.join(dir, `${safe}.md`);
  if (!fs.existsSync(f)) return null;
  return parseSkill(fs.readFileSync(f, 'utf8'), `${safe}.md`);
}

function writeSkill(dir, { name, triggers = [], body = '', extra = {} }) {
  fs.mkdirSync(dir, { recursive: true });
  const safe = sanitizeSkillName(name);
  // Strip anything that could break frontmatter: newlines, YAML fence markers.
  const safeName = String(name).replace(/[\r\n]+/g, ' ').replace(/^---+|---+$/g, '').slice(0, 200);
  const safeTriggers = triggers
    .map(t => String(t).replace(/[\r\n,]+/g, ' ').trim())
    .filter(Boolean);
  const extraLines = Object.entries(extra || {})
    .map(([k, v]) => {
      const safeKey = String(k).replace(/[^a-z0-9_]/gi, '');
      const safeVal = String(v).replace(/[\r\n]+/g, ' ').slice(0, 200);
      return safeKey ? `${safeKey}: ${safeVal}` : '';
    })
    .filter(Boolean);
  const fmLines = [`name: ${safeName}`, `triggers: ${safeTriggers.join(', ')}`, ...extraLines];
  const fm = `---\n${fmLines.join('\n')}\n---\n${body}`;
  fs.writeFileSync(path.join(dir, `${safe}.md`), fm, 'utf8');
  return { name: safe };
}

module.exports = { loadSkills, matchSkills, writeSkill, sanitizeSkillName, skillExists, loadSkillByName };
