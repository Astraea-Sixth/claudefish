'use strict';

const { createMessage } = require('./claude');
const { buildSystem } = require('./billing');

async function spawnSubagent({ credsLoc, model, task, context }) {
  const system = buildSystem([
    'You are an isolated subagent. You have no tools and no memory. Do the task, return a concise (<300 words) summary only. No preamble.'
  ]);
  const userContent = context ? `Context:\n${context}\n\nTask: ${task}` : `Task: ${task}`;
  try {
    const resp = await createMessage(credsLoc, {
      model: model || 'claude-haiku-4-5-20251001',
      maxTokens: 2048,
      system,
      messages: [{ role: 'user', content: userContent.slice(0, 60_000) }]
    });
    return (resp.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim() || '(no output)';
  } catch (e) {
    return `(subagent error: ${e.message.slice(0, 300)})`;
  }
}

module.exports = { spawnSubagent };
