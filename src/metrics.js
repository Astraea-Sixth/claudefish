'use strict';

const fs = require('fs');
const path = require('path');

// Append-only per-turn metrics. One JSON line per API call.
// Schema:
//   ts, userId, model, profile, latencyMs, toolCount, turns,
//   inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens,
//   cacheHitRatio, imageCount, isError
class Metrics {
  constructor(file) {
    this.file = file;
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  append(entry) {
    try { fs.appendFileSync(this.file, JSON.stringify({ ts: Date.now(), ...entry }) + '\n', 'utf8'); }
    catch (e) { console.error(`[metrics] ${e.message}`); }
  }
  // Read back the last `sinceMs` worth of entries. Cheap for now; swap to
  // FTS5/SQLite once #7 lands.
  readSince(sinceMs) {
    if (!fs.existsSync(this.file)) return [];
    const cutoff = Date.now() - sinceMs;
    const out = [];
    const raw = fs.readFileSync(this.file, 'utf8').split('\n');
    for (const line of raw) {
      if (!line) continue;
      try {
        const j = JSON.parse(line);
        if (j.ts >= cutoff) out.push(j);
      } catch {}
    }
    return out;
  }
}

// Anthropic usage fields → our normalized shape.
function extractUsage(usage = {}) {
  const inp = usage.input_tokens || 0;
  const out = usage.output_tokens || 0;
  const cacheRead = usage.cache_read_input_tokens || 0;
  const cacheCreate = usage.cache_creation_input_tokens || 0;
  const totalCached = cacheRead + cacheCreate;
  const cacheHitRatio = (inp + cacheRead) > 0 ? cacheRead / (inp + cacheRead) : 0;
  return {
    inputTokens: inp,
    outputTokens: out,
    cacheReadTokens: cacheRead,
    cacheCreationTokens: cacheCreate,
    totalCachedTokens: totalCached,
    cacheHitRatio: Number(cacheHitRatio.toFixed(3))
  };
}

function summarize(entries) {
  if (!entries.length) return null;
  const byTool = {};
  const byModel = {};
  // Per-model token buckets — used by callers to price-correctly.
  const tokensByModel = {};
  let tokensIn = 0, tokensOut = 0, cacheRead = 0, cacheCreate = 0, toolCalls = 0, errors = 0;
  const lats = [];
  for (const e of entries) {
    tokensIn += e.inputTokens || 0;
    tokensOut += e.outputTokens || 0;
    cacheRead += e.cacheReadTokens || 0;
    cacheCreate += e.cacheCreationTokens || 0;
    toolCalls += e.toolCount || 0;
    if (e.isError) errors++;
    if (e.latencyMs) lats.push(e.latencyMs);
    if (e.model) {
      byModel[e.model] = (byModel[e.model] || 0) + 1;
      const b = tokensByModel[e.model] || (tokensByModel[e.model] = { in: 0, out: 0, cacheRead: 0, cacheCreate: 0 });
      b.in += e.inputTokens || 0;
      b.out += e.outputTokens || 0;
      b.cacheRead += e.cacheReadTokens || 0;
      b.cacheCreate += e.cacheCreationTokens || 0;
    }
    for (const [name, n] of Object.entries(e.toolNames || {})) byTool[name] = (byTool[name] || 0) + n;
  }
  lats.sort((a, b) => a - b);
  const p = q => lats.length ? lats[Math.min(lats.length - 1, Math.floor(q * lats.length))] : 0;
  const totalInput = tokensIn + cacheRead;
  const cacheHitRatio = totalInput > 0 ? cacheRead / totalInput : 0;
  return {
    turns: entries.length,
    errors,
    tokens: { in: tokensIn, out: tokensOut, cacheRead, cacheCreate },
    tokensByModel,
    cacheHitRatio: Number(cacheHitRatio.toFixed(3)),
    toolCalls,
    topTools: Object.entries(byTool).sort((a, b) => b[1] - a[1]).slice(0, 10),
    byModel,
    latency: { p50: p(0.5), p95: p(0.95), max: lats[lats.length - 1] || 0 }
  };
}

module.exports = { Metrics, extractUsage, summarize };
