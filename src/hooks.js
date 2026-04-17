'use strict';

// Hook loader. Each file in data/hooks/ exports an object with lifecycle handlers:
//   { preMessage, postMessage, preTool, postTool }
// Each handler is async; may mutate the passed context.

const fs = require('fs');
const path = require('path');

function loadHooks(dir) {
  if (!fs.existsSync(dir)) return [];
  const hooks = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.js')) continue;
    try {
      const mod = require(path.resolve(dir, f));
      hooks.push({ name: f, ...mod });
    } catch (e) {
      console.error(`[hooks] failed to load ${f}: ${e.message}`);
    }
  }
  return hooks;
}

async function runHook(hooks, phase, ctx) {
  for (const h of hooks) {
    const fn = h[phase];
    if (typeof fn === 'function') {
      try { await fn(ctx); } catch (e) {
        console.error(`[hooks] ${h.name}.${phase} threw: ${e.message}`);
      }
    }
  }
}

module.exports = { loadHooks, runHook };
