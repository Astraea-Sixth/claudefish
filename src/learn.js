'use strict';

// Auto-detect corrections in user messages and save them as `feedback` memories.
// Two-layer filter: regex trigger (cheap) + Haiku judge (accurate).
// Saves with auto: true frontmatter so user can review via /notes and delete.

const { createMessage } = require('./claude');

// Strong correction signals. Not exhaustive — prefers precision over recall.
const TRIGGERS = [
  /\bstop (doing|calling|using|trying|asking)\b/i,
  /\bdon'?t (do|call|use|try|ask|keep|ever|just)\b/i,
  /\bdo not (do|call|use|try|ask|keep|ever)\b/i,
  /\bnever\s+\w+\s+(this|that|again|anymore)\b/i,
  /\byou did (it|that) again\b/i,
  /\byou (keep|always|still) (doing|calling|using|saying)\b/i,
  /\bi (told|said|asked) you\b/i,
  /\bfor the (second|third|fourth|nth|last) time\b/i,
  /\bplease stop\b/i,
  /\bthat'?s (wrong|not right|incorrect)\b/i,
  /\byou'?re supposed to\b/i,
  /\bhow many times\b/i,
  /\bi already told you\b/i,
  /\bdidn'?t i (tell|say|ask)\b/i
];

function looksLikeCorrection(text) {
  if (!text || text.length < 5 || text.length > 2000) return false;
  return TRIGGERS.some(rx => rx.test(text));
}

// Ask Haiku to confirm it's a correction and extract the rule.
// Returns null if not a correction, else { key, description, body }.
async function extractCorrection(credsLoc, { userText, priorAssistantReply }) {
  const system = [{
    type: 'text',
    text: 'You analyze messages to detect when a user is correcting an AI assistant. If the message is clearly a correction (user telling the assistant to stop, change, or remember something), extract a durable rule. Output strict JSON: {"is_correction": true, "rule": "<short imperative rule, <200 chars>", "description": "<one-line summary for memory index>", "key": "<slug for filename, lowercase_underscores>"} OR {"is_correction": false}. No prose, only JSON.'
  }];
  const msg = [
    priorAssistantReply ? `ASSISTANT JUST SAID:\n${priorAssistantReply.slice(0, 1500)}\n\n` : '',
    `USER REPLIED:\n${userText.slice(0, 1500)}`
  ].join('');
  try {
    const resp = await createMessage(credsLoc, {
      model: 'claude-haiku-4-5-20251001',
      maxTokens: 400,
      system,
      messages: [{ role: 'user', content: msg }]
    });
    const raw = (resp.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    const parsed = JSON.parse(jsonMatch[0]);
    if (!parsed.is_correction) return null;
    if (!parsed.rule || !parsed.key) return null;
    return {
      key: `auto_feedback_${parsed.key.replace(/[^a-z0-9_]/g, '').slice(0, 40)}_${Date.now().toString(36).slice(-6)}`,
      description: (parsed.description || parsed.rule).slice(0, 200),
      body: parsed.rule
    };
  } catch (e) {
    console.error(`[learn] extract: ${e.message}`);
    return null;
  }
}

// Save as feedback memory with auto: true frontmatter.
function saveAutoFeedback(memory, entry) {
  const body = `${entry.body}\n\n**Why:** Auto-detected from a user correction on ${new Date().toISOString()}.\n**How to apply:** Follow this rule unless the user explicitly overrides it. Review via \`/notes\`; delete if noise.`;
  memory.write(entry.key, {
    type: 'feedback',
    description: entry.description,
    body,
    name: entry.key
  });
}

// Top-level: run the full detect→extract→save pipeline. Returns the saved
// entry (so caller can surface it) or null.
async function maybeLearnFromCorrection({ credsLoc, memory, userText, priorAssistantReply }) {
  if (!looksLikeCorrection(userText)) return null;
  const extracted = await extractCorrection(credsLoc, { userText, priorAssistantReply });
  if (!extracted) return null;
  try {
    saveAutoFeedback(memory, extracted);
    console.log(`[learn] auto-saved feedback: ${extracted.key}`);
    return extracted;
  } catch (e) {
    console.error(`[learn] save: ${e.message}`);
    return null;
  }
}

module.exports = { maybeLearnFromCorrection, looksLikeCorrection, extractCorrection };
