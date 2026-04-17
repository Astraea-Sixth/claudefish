'use strict';

const fs = require('fs');
const path = require('path');
const { createMessage } = require('./claude');

// Weekly auto-digest: on Sundays, summarize the last 7 days of journal into
// data/memory/<userId>/week_<YYYY-MM-DD>.md (marked as `auto`).

function isoDate(d) { return d.toISOString().slice(0, 10); }

function collectWeek(journalDir) {
  if (!fs.existsSync(journalDir)) return '';
  const chunks = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    const f = path.join(journalDir, `${isoDate(d)}.md`);
    if (fs.existsSync(f)) chunks.push(`## ${isoDate(d)}\n${fs.readFileSync(f, 'utf8')}`);
  }
  return chunks.join('\n\n');
}

async function runDigestForUser({ credsLoc, journalDir, memoryDir, userId }) {
  const journal = collectWeek(journalDir);
  if (!journal.trim()) return { skipped: 'empty journal' };

  const today = isoDate(new Date());
  const memFile = path.join(memoryDir, 'users', String(userId), `week_${today}.md`);
  if (fs.existsSync(memFile)) return { skipped: 'already ran today' };

  // Part 1: summary of the week.
  const summaryResp = await createMessage(credsLoc, {
    model: 'claude-haiku-4-5-20251001',
    maxTokens: 1500,
    system: [{ type: 'text', text: 'Summarize the last week of conversations in <=300 words. Capture: recurring themes, decisions made, open questions, new projects/people mentioned. Plain text, no preamble.' }],
    messages: [{ role: 'user', content: journal.slice(0, 60_000) }]
  });
  const summary = (summaryResp.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  if (!summary) return { skipped: 'empty summary' };

  fs.mkdirSync(path.dirname(memFile), { recursive: true });
  fs.writeFileSync(memFile, [
    `---`,
    `name: week_${today}`,
    `description: Auto-generated weekly digest`,
    `type: project`,
    `auto: true`,
    `generated_at: ${new Date().toISOString()}`,
    `---`,
    ``,
    summary
  ].join('\n'), 'utf8');

  // Part 2: reflection pass — extract durable feedback rules from the week.
  let feedbacksSaved = 0;
  try {
    const reflectResp = await createMessage(credsLoc, {
      model: 'claude-haiku-4-5-20251001',
      maxTokens: 1500,
      system: [{ type: 'text', text: 'You are reviewing a week of conversations between a user and an AI assistant. Find up to 5 durable rules the assistant should remember going forward — things the user corrected, preferences the user expressed, mistakes that recurred. Output strict JSON array: [{"key": "slug_for_filename", "rule": "imperative rule text <200 chars>", "description": "one-line summary"}]. If no notable patterns: return []. No prose, only JSON.' }],
      messages: [{ role: 'user', content: journal.slice(0, 60_000) }]
    });
    const raw = (reflectResp.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
    const jsonMatch = raw.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      const items = JSON.parse(jsonMatch[0]);
      for (const item of items.slice(0, 5)) {
        if (!item.key || !item.rule) continue;
        const cleanKey = `weekly_feedback_${today}_${String(item.key).replace(/[^a-z0-9_]/gi, '').slice(0, 30)}`;
        const fbFile = path.join(memoryDir, 'users', String(userId), `${cleanKey}.md`);
        if (fs.existsSync(fbFile)) continue;
        const body = [
          `---`,
          `name: ${cleanKey}`,
          `description: ${(item.description || item.rule).slice(0, 200)}`,
          `type: feedback`,
          `auto: true`,
          `pending_review: true`,
          `generated_at: ${new Date().toISOString()}`,
          `---`,
          ``,
          item.rule,
          ``,
          `**Source:** Weekly reflection pass on ${today}. Proposed automatically; review and delete if noise.`
        ].join('\n');
        fs.writeFileSync(fbFile, body, 'utf8');
        feedbacksSaved++;
      }
    }
  } catch (e) { console.error(`[digest] reflection: ${e.message}`); }

  return { wrote: memFile, bytes: summary.length, feedbacksSaved };
}

// Check once a day whether it's Sunday & no digest written yet, and run per user.
// Intended to be called from a daily tick in index.js.
async function maybeRunDigest({ credsLoc, dataDir, userIds }) {
  const today = new Date();
  if (today.getDay() !== 0) return; // 0 = Sunday
  const journalDir = path.join(dataDir, 'journal');
  const memoryDir = path.join(dataDir, 'memory');
  for (const u of userIds) {
    try {
      const r = await runDigestForUser({ credsLoc, journalDir, memoryDir, userId: u });
      console.log(`[digest] ${u}: ${JSON.stringify(r)}`);
    } catch (e) { console.error(`[digest] ${u}: ${e.message}`); }
  }
}

module.exports = { runDigestForUser, maybeRunDigest };
