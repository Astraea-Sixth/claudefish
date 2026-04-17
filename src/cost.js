'use strict';

// Centralized per-model pricing + estimateCost. Single source of truth
// so index.js and agent.js don't drift.

const MODEL_RATES = {
  opus:   { in: 15.00, out: 75.00 },
  sonnet: { in:  3.00, out: 15.00 },
  haiku:  { in:  0.80, out:  4.00 }
};

function rateFor(modelId) {
  const m = String(modelId || '').toLowerCase();
  if (m.includes('opus'))  return MODEL_RATES.opus;
  if (m.includes('haiku')) return MODEL_RATES.haiku;
  return MODEL_RATES.sonnet;
}

// `summary` shape: { tokens: {in,out,cacheRead,cacheCreate}, tokensByModel: { modelId: {in,out,cacheRead,cacheCreate} } }
function estimateCost(summary) {
  const buckets = summary.tokensByModel || {};
  if (!Object.keys(buckets).length) {
    const r = MODEL_RATES.sonnet;
    const { in: ti, out: to, cacheRead, cacheCreate } = summary.tokens;
    return (ti * r.in + to * r.out + cacheRead * r.in * 0.10 + cacheCreate * r.in * 1.25) / 1_000_000;
  }
  let cost = 0;
  for (const [model, b] of Object.entries(buckets)) {
    const r = rateFor(model);
    cost += (b.in * r.in + b.out * r.out + b.cacheRead * r.in * 0.10 + b.cacheCreate * r.in * 1.25);
  }
  return cost / 1_000_000;
}

module.exports = { MODEL_RATES, rateFor, estimateCost };
