'use strict';

// Skill auto-synthesis. Fires detached (never awaited) at the end of a
// successful multi-step turn. Analyzes the session, asks Haiku to extract a
// reusable skill, and writes it to data/skills/<name>.md on success.

const { quickJSON } = require('./quickcall');
const { writeSkill, skillExists, sanitizeSkillName } = require('./skills');
const { looksLikeCorrection } = require('./learn');

const SYSTEM_PROMPT = `You analyze a completed task session and extract a reusable skill.
A skill is a short markdown document describing when to use it and the steps to follow.

Input: the sequence of user messages, assistant messages, and tool calls from the session.
Output: STRICTLY a JSON object: {
  "useful": true|false,
  "name": "kebab-case-name",
  "triggers": ["short phrase 1", "short phrase 2"],
  "body": "markdown body in <200 words: ## When to use ... ## Steps ... ## Example"
}
If the session was trivial, conversational, or too specific to generalize, return {"useful": false}.
Return only the JSON.`;

// Render a compact transcript of the session for the Haiku call.
function _renderTranscript(history, maxChars = 6000) {
  const lines = [];
  for (const m of history) {
    if (m.role === 'user') {
      if (typeof m.content === 'string') {
        lines.push(`USER: ${m.content.slice(0, 500)}`);
      } else if (Array.isArray(m.content)) {
        const tr = m.content.filter(b => b.type === 'tool_result');
        if (tr.length) {
          for (const b of tr) {
            const r = typeof b.content === 'string' ? b.content : JSON.stringify(b.content);
            lines.push(`TOOL_RESULT${b.is_error ? ' (ERR)' : ''}: ${r.slice(0, 300)}`);
          }
        } else {
          const txt = m.content.filter(b => b.type === 'text').map(b => b.text).join(' ');
          if (txt) lines.push(`USER: ${txt.slice(0, 500)}`);
        }
      }
    } else if (m.role === 'assistant') {
      if (typeof m.content === 'string') {
        lines.push(`ASSISTANT: ${m.content.slice(0, 500)}`);
      } else if (Array.isArray(m.content)) {
        for (const b of m.content) {
          if (b.type === 'text' && b.text) lines.push(`ASSISTANT: ${b.text.slice(0, 500)}`);
          else if (b.type === 'tool_use') lines.push(`TOOL_USE: ${b.name}(${JSON.stringify(b.input || {}).slice(0, 200)})`);
        }
      }
    }
  }
  const joined = lines.join('\n');
  return joined.length > maxChars ? '…(truncated)…\n' + joined.slice(-maxChars) : joined;
}

// Eligibility check: encapsulated so callers can pre-gate before firing.
// Returns { eligible: bool, reason: string }.
function checkEligible({ totalToolCalls, hadApiError, hadToolError, userText, autoSynthesize }) {
  if (autoSynthesize === false) return { eligible: false, reason: 'disabled' };
  if (totalToolCalls < 3) return { eligible: false, reason: 'fewer than 3 tool calls' };
  if (hadApiError) return { eligible: false, reason: 'api error' };
  if (hadToolError) return { eligible: false, reason: 'tool error' };
  if (userText && looksLikeCorrection(userText)) return { eligible: false, reason: 'user-turn looked like a correction' };
  if (userText && /^synth|auto-?synth|\/skill\s/i.test(userText)) return { eligible: false, reason: 'session was itself a skill synthesis' };
  return { eligible: true, reason: 'ok' };
}

async function synthesize({ credsLoc, skillsDir, history, notifyUser = null }) {
  const transcript = _renderTranscript(history);
  if (!transcript.trim()) return { wrote: false, reason: 'empty transcript' };
  let res;
  try {
    res = await quickJSON(credsLoc, { system: SYSTEM_PROMPT, user: transcript, maxTokens: 800 });
  } catch (e) {
    return { wrote: false, reason: `quickcall: ${e.message}` };
  }
  if (!res.ok) return { wrote: false, reason: `parse: ${res.error}` };
  const j = res.json || {};
  if (!j.useful) return { wrote: false, reason: 'not useful' };
  if (!j.name || typeof j.name !== 'string') return { wrote: false, reason: 'no name' };
  const safeName = sanitizeSkillName(j.name);
  if (skillExists(skillsDir, safeName)) return { wrote: false, reason: 'already exists' };
  const triggers = Array.isArray(j.triggers) ? j.triggers.filter(t => typeof t === 'string') : [];
  const body = typeof j.body === 'string' ? j.body : '';
  if (!body.trim()) return { wrote: false, reason: 'empty body' };
  try {
    writeSkill(skillsDir, {
      name: safeName,
      triggers,
      body,
      extra: {
        source: '"auto-synthesized"',
        created_at: new Date().toISOString()
      }
    });
  } catch (e) {
    return { wrote: false, reason: `write: ${e.message}` };
  }
  if (notifyUser) {
    const trigPreview = triggers.slice(0, 4).join(', ') || '(none)';
    try { await notifyUser(`💡 Saved new skill \`${safeName}\`. Triggers: ${trigPreview}. Invoke with \`/skill ${safeName}\` or just mention: ${triggers[0] || safeName}.`); } catch {}
  }
  return { wrote: true, name: safeName, triggers };
}

module.exports = { synthesize, checkEligible };
