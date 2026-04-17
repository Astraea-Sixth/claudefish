#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { resolveCreds, buildSystem } = require('./billing');
const { createMessage } = require('./claude');
const { buildTools } = require('./tools');
const { Memory } = require('./memory');

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));
const loc = resolveCreds(null);
const memory = new Memory(path.join(__dirname, '..', 'data', 'memory'));
const tools = buildTools(cfg, memory, path.join(__dirname, '..', 'data', 'workspace'));

const soul = fs.readFileSync(path.join(__dirname, '..', 'data', 'soul.md'), 'utf8');
const agentsMd = fs.readFileSync(path.join(__dirname, '..', 'data', 'agents.md'), 'utf8');

async function probe(label, { system, tools: toolDefs }) {
  try {
    const resp = await createMessage(loc, {
      model: cfg.model.primary,
      maxTokens: 64,
      system,
      messages: [{ role: 'user', content: 'say hi' }],
      tools: toolDefs
    });
    const text = (resp.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    console.log(`✅ ${label}: ${text.slice(0, 80)}`);
  } catch (e) {
    console.log(`❌ ${label}: ${e.message.slice(0, 200)}`);
  }
}

(async () => {
  const sys = buildSystem([]);
  const t1 = [
    { name: 'notes_find', description: 'find', input_schema: { type: 'object', properties: { q: { type: 'string' } } } },
    { name: 'notes_load', description: 'load', input_schema: { type: 'object', properties: { k: { type: 'string' } } } }
  ];
  await probe('rename → notes_find+notes_load', { system: sys, tools: t1 });
  const t2 = [
    { name: 'recall', description: 'recall', input_schema: { type: 'object', properties: { q: { type: 'string' } } } },
    { name: 'remember', description: 'remember', input_schema: { type: 'object', properties: { k: { type: 'string' } } } }
  ];
  await probe('rename → recall+remember', { system: sys, tools: t2 });
  const t3 = [
    { name: 'store_read', description: 'read', input_schema: { type: 'object', properties: { k: { type: 'string' } } } },
    { name: 'store_write', description: 'write', input_schema: { type: 'object', properties: { k: { type: 'string' } } } },
    { name: 'store_search', description: 'search', input_schema: { type: 'object', properties: { q: { type: 'string' } } } },
    { name: 'doc_read', description: 'read', input_schema: { type: 'object', properties: { p: { type: 'string' } } } },
    { name: 'doc_write', description: 'write', input_schema: { type: 'object', properties: { p: { type: 'string' } } } }
  ];
  await probe('rename → store_*+doc_*', { system: sys, tools: t3 });
})();
