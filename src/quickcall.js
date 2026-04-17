'use strict';

// Thin wrapper over createMessage for one-shot, non-streaming Haiku calls.
// Used by /cron NL parser and skill auto-synthesis. Kept tiny so callers can
// focus on their prompt + parsing.

const { createMessage } = require('./claude');

const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';

async function quickJSON(credsLoc, { system, user, model = DEFAULT_MODEL, maxTokens = 600 }) {
  const resp = await createMessage(credsLoc, {
    model,
    maxTokens,
    system: [{ type: 'text', text: system }],
    messages: [{ role: 'user', content: user }]
  });
  const raw = (resp.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return { ok: false, raw, error: 'no JSON in response' };
  try { return { ok: true, raw, json: JSON.parse(m[0]) }; }
  catch (e) { return { ok: false, raw, error: `parse: ${e.message}` }; }
}

module.exports = { quickJSON };
