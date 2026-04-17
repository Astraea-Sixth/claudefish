'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const { execFileSync } = require('child_process');

const BILLING_BLOCK_TEXT = 'x-anthropic-billing-header: cc_version=2.1.97; cc_entrypoint=cli; cch=00000;';

const REQUIRED_BETAS = [
  'claude-code-20250219',
  'oauth-2025-04-20',
  'interleaved-thinking-2025-05-14',
  'context-management-2025-06-27',
  'prompt-caching-scope-2026-01-05',
  'effort-2025-11-24'
];

const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const OAUTH_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const OAUTH_SCOPES = 'user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload';
const REFRESH_MARGIN_MS = 30 * 60 * 1000;

const TRIGGER_REPLACEMENTS = [
  ['running inside', 'running on']
];

let cachedCreds = null;
let cachedAt = 0;
const CACHE_TTL = 60 * 1000;
let refreshInFlight = null;

function resolveCreds(userPath) {
  const home = os.homedir();
  const expand = p => p && (p.startsWith('~') ? path.join(home, p.slice(1)) : p);
  const candidates = [expand(userPath), path.join(home, '.claude/.credentials.json'), path.join(home, '.claude/credentials.json')].filter(Boolean);
  for (const p of candidates) if (fs.existsSync(p)) return { source: 'file', path: p };
  try {
    const raw = execFileSync('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (raw) { JSON.parse(raw); return { source: 'keychain', path: null }; }
  } catch {}
  throw new Error('No Claude credentials found. Run `claude auth login` first.');
}

function readCreds(loc) {
  const now = Date.now();
  if (cachedCreds && now - cachedAt < CACHE_TTL) return cachedCreds;
  const raw = loc.source === 'keychain'
    ? execFileSync('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], { encoding: 'utf8' }).trim()
    : fs.readFileSync(loc.path, 'utf8');
  cachedCreds = JSON.parse(raw);
  cachedAt = now;
  return cachedCreds;
}

function writeCreds(loc, creds) {
  cachedCreds = creds;
  cachedAt = Date.now();
  if (loc.source === 'keychain') {
    const json = JSON.stringify(creds);
    // execFileSync — no shell, no interpolation. JSON can contain any bytes;
    // passing as a positional argv value is the only safe option.
    try { execFileSync('security', ['delete-generic-password', '-s', 'Claude Code-credentials'], { stdio: 'ignore' }); } catch {}
    execFileSync('security', ['add-generic-password', '-s', 'Claude Code-credentials', '-a', '', '-w', json]);
  } else {
    fs.writeFileSync(loc.path, JSON.stringify(creds, null, 2), 'utf8');
  }
}

function refreshOAuth(refreshTok) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: refreshTok,
      client_id: OAUTH_CLIENT_ID,
      scope: OAUTH_SCOPES
    });
    const req = https.request(OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString();
        if (res.statusCode !== 200) return reject(new Error(`refresh failed ${res.statusCode}: ${raw}`));
        resolve(JSON.parse(raw));
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function getAccessToken(loc) {
  const creds = readCreds(loc);
  const oauth = creds.claudeAiOauth;
  if (!oauth?.accessToken) throw new Error('No OAuth token. Run `claude auth login`.');
  const timeLeft = (oauth.expiresAt || Infinity) - Date.now();
  if (timeLeft < REFRESH_MARGIN_MS && oauth.refreshToken) {
    if (!refreshInFlight) {
      refreshInFlight = refreshOAuth(oauth.refreshToken).then(t => {
        const updated = {
          ...oauth,
          accessToken: t.access_token,
          refreshToken: t.refresh_token || oauth.refreshToken,
          expiresAt: Date.now() + t.expires_in * 1000
        };
        creds.claudeAiOauth = updated;
        writeCreds(loc, creds);
        console.log(`[billing] token refreshed (${(t.expires_in/3600).toFixed(1)}h)`);
        return updated;
      }).catch(e => {
        if (timeLeft > 0) { console.warn(`[billing] refresh failed, using existing: ${e.message}`); return oauth; }
        throw e;
      }).finally(() => { refreshInFlight = null; });
    }
    return (await refreshInFlight).accessToken;
  }
  if (timeLeft <= 0) throw new Error('Token expired. Run `claude auth login`.');
  return oauth.accessToken;
}

function sanitize(str) {
  let out = str;
  for (const [find, rep] of TRIGGER_REPLACEMENTS) out = out.split(find).join(rep);
  return out;
}

// Parts may be plain strings OR { text, cache: 'prelude'|'short'|'none' }.
// - 'prelude': 1h ephemeral (stable identity layer)
// - 'short':   default 5min ephemeral (memory index, skills, project dossiers)
// - 'none':    no cache (volatile, e.g. recent journal)
// Plain strings keep legacy behavior: first and last parts cached at 1h.
function buildSystem(parts, { cacheTtl = '1h' } = {}) {
  const blocks = [{ type: 'text', text: BILLING_BLOCK_TEXT }];
  const clean = parts.filter(p => p && (typeof p === 'string' ? p.trim() : (p.text && p.text.trim())));
  const allStrings = clean.every(p => typeof p === 'string');
  clean.forEach((p, i) => {
    const text = typeof p === 'string' ? p : p.text;
    const block = { type: 'text', text: sanitize(text) };
    const cacheMode = typeof p === 'object' ? p.cache : null;
    if (cacheMode === 'prelude') block.cache_control = { type: 'ephemeral', ttl: cacheTtl };
    else if (cacheMode === 'short') block.cache_control = { type: 'ephemeral' };
    else if (cacheMode === 'none') { /* no cache */ }
    else if (allStrings) {
      const isLast = i === clean.length - 1;
      const isPrelude = i === 1;
      if (isLast || isPrelude) block.cache_control = { type: 'ephemeral', ttl: cacheTtl };
    }
    blocks.push(block);
  });
  // Anthropic caps cache_control markers at 4 per request.
  // Priority: prelude (1h) > short (default ttl). Within each tier, keep the
  // LATEST occurrences so each kept marker caches the widest prefix.
  const MAX_CACHE = 4;
  const marked = blocks.filter(b => b.cache_control);
  if (marked.length > MAX_CACHE) {
    const isPrelude = b => b.cache_control && b.cache_control.ttl === cacheTtl;
    const preludes = marked.filter(isPrelude);
    const shorts = marked.filter(b => !isPrelude(b));
    const keepPrelude = preludes.slice(-Math.min(MAX_CACHE, preludes.length));
    const remaining = MAX_CACHE - keepPrelude.length;
    const keepShort = remaining > 0 ? shorts.slice(-remaining) : [];
    const keep = new Set([...keepPrelude, ...keepShort]);
    for (const b of marked) if (!keep.has(b)) delete b.cache_control;
  }
  return blocks;
}

function betasHeader() { return REQUIRED_BETAS.join(','); }

module.exports = { resolveCreds, getAccessToken, sanitize, buildSystem, betasHeader };
