#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { resolveCreds } = require('./billing');
const { createMessage } = require('./claude');
const { Memory } = require('./memory');
const { Agent } = require('./agent');
const { TelegramBot } = require('./telegram');
const { DeliveryQueue } = require('./queue');
const { loadHooks } = require('./hooks');
const { Scheduler, cronValid, cronNext, cronToHuman } = require('./cron');
const { spawnSubagent } = require('./subagent');
const { PROFILES } = require('./tools');
const { loadSkills, loadSkillByName, sanitizeSkillName } = require('./skills');
const { quickJSON } = require('./quickcall');
const { ApprovalStore, scopeFor } = require('./approvals');
const { Receipts } = require('./receipts');
const { BackgroundTasks } = require('./background');
const { buildCapabilitiesText } = require('./capabilities');
const { Metrics, summarize } = require('./metrics');
const { maybeRunDigest } = require('./digest');
const { transcribe: sttTranscribe } = require('./stt');
const { Archive } = require('./archive');
const { sweepMemory, DECAY_DAYS } = require('./decay');
const { isPublicUrl } = require('./net');
const { scrubMessage } = require('./errors');
const { estimateCost } = require('./cost');

function loadConfig() {
  const root = path.resolve(__dirname, '..');
  const cfgPath = path.join(root, 'config.json');
  if (!fs.existsSync(cfgPath)) {
    console.error('[claudefish] config.json missing. Copy config.example.json.');
    process.exit(1);
  }
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  cfg._root = root;
  cfg._dataDir = path.resolve(root, cfg.workspace || './data');
  return cfg;
}

const HELP = `commands:
/help — this help
/ping — liveness check
/stop — kill current work immediately (SIGTERM child procs + abort loop)
/busy — am I working on something right now? (priority cmd, works mid-chain)
/errors — last 10 tool errors today (priority cmd, works mid-chain)
/btw <msg> — quick side message while she's busy (fast Haiku reply, no tools)

— CLASSIC MODE (terminal-style, no LLM in loop) —
/cd <project> — set cwd to a project in data/workspace/projects/
/pwd — show current project cwd
/ls [dir] — list files in cwd
/cat <file> — read file in cwd
/git <args> — run git in cwd
/cc <task> — direct Claude Code passthrough in current project (live stream)
/continue — resume last Claude Code session in current project
/end — end Claude Code session in current project
/sessions — list active project sessions
/budget — show today's spend + daily cap
/hook add <url> — register webhook for background task events
/hook list — list registered webhooks
/hook del <n> — remove webhook by index
/reset — clear your conversation (memory kept)
/compact — summarize old turns now (saves to memory)
/models — list available models
/model <name> — switch model (opus | sonnet | haiku, or full model id)
/profile <name> — switch tool profile (${Object.keys(PROFILES).join(' | ')})
/think on|off [budget] — toggle extended thinking
/stream on|off — toggle streaming replies (default on)
/status — show your session state
/remind <minutes> <prompt> — schedule a nudge
/reminders — list pending
/cancel <id> — cancel reminder
/cron <natural-language> — schedule a recurring task (e.g. "every Friday at 5pm summarize my week")
/skill list — list available skills
/skill <name> — inject a saved skill into the next turn
/notes — list your memory keys
/skills — list loaded skills
/context — list loaded context files
/hooks — list active hooks
/journal [today|yesterday|YYYY-MM-DD] — read a day's journal
/capabilities — what i can and can't do today
/search <query> — ranked search over journal + memory + session logs
/insights [days] — usage analytics (tokens, latency, tools, cache)
/audit <tool> [days] — every invocation of a tool with args + result preview
/usage — lifetime per-user token usage + rough cost
/memory [list] — show active + archived notes
/memory restore <key> — un-archive a decayed note
/filesstructure (/fs) — show workspace layout + rules + live tree
/projects — list projects w/ git status
/tasks — background task log
/receipts [verify] — approval receipts (hash-chained, tamper-evident)
/trusts — list trusted tools/projects
/forget <key> — revoke a trust entry`;

function parseMinutes(s) { const n = parseFloat(s); return isFinite(n) ? n * 60_000 : null; }

// Cost estimation moved to ./cost.js — shared with agent.js budget enforcement.

function auditTool(dataDir, userId, toolName, days) {
  const cutoff = Date.now() - days * 86_400_000;
  const out = [];
  const sessionsDir = path.join(dataDir, 'sessions');
  if (!fs.existsSync(sessionsDir)) return '';
  for (const f of fs.readdirSync(sessionsDir).sort()) {
    if (!f.endsWith('.jsonl')) continue;
    let data; try { data = fs.readFileSync(path.join(sessionsDir, f), 'utf8'); } catch { continue; }
    for (const line of data.split('\n')) {
      if (!line) continue;
      let j; try { j = JSON.parse(line); } catch { continue; }
      if (j.type !== 'tool' || j.name !== toolName) continue;
      if (String(j.userId) !== String(userId)) continue;
      if (j.ts < cutoff) continue;
      const when = new Date(j.ts).toISOString().slice(5, 16).replace('T', ' ');
      const args = JSON.stringify(j.input).slice(0, 200);
      const flag = j.isError ? ' ❌' : '';
      const preview = (j.result || '').slice(0, 160).replace(/\n/g, ' ');
      out.push(`${when}${flag}  ${args}\n  → ${preview}${j.resultBytes > 160 ? ` (+${j.resultBytes - 160}B)` : ''}`);
    }
  }
  if (!out.length) return '';
  return out.slice(-20).join('\n\n').slice(0, 3900);
}

function renderFileStructure(dataDir) {
  const wsRoot = path.join(dataDir, 'workspace');
  const lines = [];
  lines.push('# Workspace file structure');
  lines.push('');
  lines.push('All `doc_write` paths are relative to `data/workspace/`.');
  lines.push('Do NOT prefix paths with `data/workspace/` — it gets auto-stripped, but avoid confusion.');
  lines.push('');
  lines.push('## Rules — where things go');
  lines.push('- `projects/<slug>/` — code projects (`claude_code` operates here)');
  lines.push('- `reports/` — research outputs, analysis, dossiers (.md)');
  lines.push('- `exports/` — user-requested file exports');
  lines.push('- `scratch/` — temporary working files, drafts');
  lines.push('- NEVER create files at `data/workspace/` root directly');
  lines.push('- Memory notes go through `notes_save`, not `doc_write`');
  lines.push('');
  lines.push('## Current tree');
  lines.push('```');
  lines.push('data/workspace/');
  const walk = (dir, prefix = '', depth = 0) => {
    if (depth > 3) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    entries = entries.filter(e => !e.name.startsWith('.') && e.name !== 'node_modules' && e.name !== '__pycache__');
    entries.sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name));
    entries.forEach((e, i) => {
      const isLast = i === entries.length - 1;
      const branch = isLast ? '└── ' : '├── ';
      lines.push(`${prefix}${branch}${e.name}${e.isDirectory() ? '/' : ''}`);
      if (e.isDirectory()) {
        const childPrefix = prefix + (isLast ? '    ' : '│   ');
        walk(path.join(dir, e.name), childPrefix, depth + 1);
      }
    });
  };
  walk(wsRoot);
  lines.push('```');
  return lines.join('\n').slice(0, 3900);
}

function listProjects(dataDir, { full = false } = {}) {
  const root = path.join(dataDir, 'workspace', 'projects');
  if (!fs.existsSync(root)) return '';
  const { execFileSync } = require('child_process');
  const lines = [];
  for (const name of fs.readdirSync(root)) {
    const abs = path.join(root, name);
    let st; try { st = fs.statSync(abs); } catch { continue; }
    if (!st.isDirectory()) continue;
    const mtime = new Date(st.mtimeMs).toISOString().slice(0, 10);
    let status = '';
    if (fs.existsSync(path.join(abs, '.git'))) {
      try {
        const porcelain = execFileSync('git', ['status', '--porcelain'], { cwd: abs, encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] });
        const n = porcelain.split('\n').filter(Boolean).length;
        const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: abs, encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
        status = `git:${branch}${n > 0 ? ` ⚠ ${n} dirty` : ' clean'}`;
      } catch { status = 'git:?'; }
    } else {
      status = 'no-git';
    }
    // Open PR count via gh — only with /projects full because it adds ~seconds per repo.
    let prCount = '';
    if (full) {
      try {
        const gh = execFileSync('gh', ['pr', 'list', '--state', 'open', '--json', 'number'], { cwd: abs, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
        if (gh) {
          const arr = JSON.parse(gh);
          if (arr.length) prCount = ` ${arr.length} open PRs`;
        }
      } catch {}
    }
    lines.push(`${name.padEnd(24)} ${mtime}  ${status}${prCount}`);
  }
  return lines.join('\n').slice(0, 3800);
}

function searchArchive(dataDir, query, userId) {
  const q = query.toLowerCase();
  const results = [];
  const scan = (dir, pred) => {
    try {
      for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name);
        let stat; try { stat = fs.statSync(full); } catch { continue; }
        if (stat.isDirectory()) { scan(full, pred); continue; }
        if (!pred(name)) continue;
        let data; try { data = fs.readFileSync(full, 'utf8'); } catch { continue; }
        const lines = data.split(/\n/);
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].toLowerCase().includes(q)) {
            results.push({ file: full.replace(dataDir + '/', ''), line: i + 1, text: lines[i].slice(0, 200) });
            if (results.length >= 30) return;
          }
        }
      }
    } catch {}
  };
  scan(path.join(dataDir, 'journal'), n => n.endsWith('.md'));
  scan(path.join(dataDir, 'memory', 'users', String(userId)), n => n.endsWith('.md'));
  scan(path.join(dataDir, 'sessions'), n => n.endsWith('.jsonl'));
  if (!results.length) return '';
  return results.slice(0, 20).map(r => `${r.file}:${r.line}  ${r.text}`).join('\n').slice(0, 3800);
}

async function acquireLock(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const pidFile = path.join(dataDir, 'claudefish.pid');
  const writePid = () => {
    const fd = fs.openSync(pidFile, 'wx');
    fs.writeSync(fd, String(process.pid));
    fs.closeSync(fd);
  };
  try {
    writePid();
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    let old = NaN;
    try { old = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10); } catch {}
    if (Number.isFinite(old) && old !== process.pid) {
      try {
        process.kill(old, 0);
        console.error(`[claudefish] another instance is already running as pid ${old} — refusing to start. Stop it first: kill ${old}`);
        process.exit(1);
      } catch {
        console.log(`[claudefish] stale pid file (${old} not alive) — removing`);
      }
    }
    // Stale cleanup with TOCTOU protection: unlink + retry wx. If wx still
    // fails with EEXIST, a concurrent starter won the race — back off, re-read,
    // and decide again; don't blindly overwrite.
    try { fs.unlinkSync(pidFile); } catch {}
    let acquired = false;
    for (let attempt = 0; attempt < 3 && !acquired; attempt++) {
      try { writePid(); acquired = true; break; }
      catch (e2) {
        if (e2.code !== 'EEXIST') {
          console.error(`[claudefish] failed to acquire lock: ${e2.message}`);
          process.exit(1);
        }
        // Back off briefly so the concurrent starter has a chance to settle.
        const waitMs = 100 * (attempt + 1);
        await new Promise(r => setTimeout(r, waitMs));
        // Re-read: if the new pid is alive and not us, the other starter won.
        let pid2 = NaN;
        try { pid2 = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10); } catch {}
        if (Number.isFinite(pid2) && pid2 !== process.pid) {
          try {
            process.kill(pid2, 0);
            console.error(`[claudefish] lost startup race to pid ${pid2} — exiting`);
            process.exit(1);
          } catch { /* pid not alive, loop will retry */ }
        }
      }
    }
    if (!acquired) {
      console.error(`[claudefish] failed to acquire lock after stale cleanup + retries`);
      process.exit(1);
    }
  }
  const release = () => { try { if (fs.readFileSync(pidFile, 'utf8').trim() === String(process.pid)) fs.unlinkSync(pidFile); } catch {} };
  process.on('exit', release);
  process.on('SIGINT', () => { release(); process.exit(0); });
  process.on('SIGTERM', () => { release(); process.exit(0); });
}

async function main() {
  const cfg = loadConfig();
  await acquireLock(path.resolve(cfg._root, cfg.workspace || './data'));
  const credsLoc = resolveCreds(cfg.credentials?.path);
  console.log(`[claudefish] credentials: ${credsLoc.source}${credsLoc.path ? ' ' + credsLoc.path : ''}`);

  const memDir = path.join(cfg._dataDir, 'memory');
  const wsDir = path.join(cfg._dataDir, 'workspace');
  const skillsDir = path.join(cfg._dataDir, 'skills');
  const ctxDir = path.join(cfg._dataDir, 'context');
  const hooksDir = path.join(cfg._dataDir, 'hooks');
  const projectsDir = path.join(cfg._dataDir, 'projects');
  const journalDir = path.join(cfg._dataDir, 'journal');
  for (const d of [memDir, wsDir, skillsDir, ctxDir, hooksDir, projectsDir, journalDir]) fs.mkdirSync(d, { recursive: true });

  const hooks = loadHooks(hooksDir);
  if (hooks.length) console.log(`[claudefish] hooks: ${hooks.map(h => h.name).join(', ')}`);

  const queue = new DeliveryQueue(path.join(cfg._dataDir, 'queue.jsonl'));
  const approvals = new ApprovalStore(path.join(cfg._dataDir, 'approvals.json'));
  const receipts = new Receipts(path.join(cfg._dataDir, 'receipts.jsonl'));
  let botRefForBg = null;
  const bgTasks = new BackgroundTasks({
    file: path.join(cfg._dataDir, 'background.jsonl'),
    deliver: async (rec) => {
      if (botRefForBg && rec.chatId) {
        const ms = (rec.finishedAt || Date.now()) - rec.startedAt;
        const tag = rec.status === 'done' ? '✅' : (rec.status === 'interrupted' ? '⚠️' : '❌');
        const body = typeof rec.result === 'string' ? rec.result : JSON.stringify(rec.result, null, 2).slice(0, 3600);
        await botRefForBg.send(rec.chatId, `${tag} ${rec.label} (${(ms/1000).toFixed(1)}s) [${rec.id}]\n\n${body}`);
      }
      // Fan-out to registered webhooks. Fire-and-forget; failures logged.
      try {
        const hooksFile = path.join(cfg._dataDir, 'webhooks.json');
        if (!fs.existsSync(hooksFile)) return;
        const hooks = JSON.parse(fs.readFileSync(hooksFile, 'utf8'));
        const payload = JSON.stringify({
          type: 'bg_task_complete',
          id: rec.id,
          status: rec.status,
          label: rec.label,
          startedAt: rec.startedAt,
          finishedAt: rec.finishedAt,
          result: rec.result
        });
        const https = require('https');
        const httpp = require('http');
        for (const url of hooks) {
          try {
            // Re-validate on every outbound POST — DNS may have changed since
            // the URL was registered (rebind attacks).
            if (!(await isPublicUrl(url))) {
              console.error(`[hook] ${url}: rejected — resolves to private/loopback`);
              continue;
            }
            const u = new URL(url);
            const lib = u.protocol === 'https:' ? https : httpp;
            const req = lib.request({ hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: u.pathname + u.search, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } });
            req.on('error', e => console.error(`[hook] ${url}: ${e.message}`));
            req.setTimeout(5000, () => { try { req.destroy(new Error('timeout')); } catch {} });
            req.end(payload);
          } catch (e) { console.error(`[hook] ${url}: ${e.message}`); }
        }
      } catch (e) { console.error(`[hook] fan-out: ${e.message}`); }
    }
  });
  // Replay prior state: `running` tasks → interrupted; `done/error` without a
  // delivery ack → need re-delivery (restart killed the deliver mid-flight).
  const { interrupted: interruptedTasks, undelivered: undeliveredTasks } = bgTasks.recoverOnBoot();
  if (interruptedTasks.length) console.log(`[bg] ${interruptedTasks.length} tasks interrupted by restart`);
  if (undeliveredTasks.length) console.log(`[bg] ${undeliveredTasks.length} tasks completed but never delivered — will retry`);
  const archive = new Archive(cfg._dataDir);
  try { archive.rebuild(); if (archive.available()) console.log('[archive] FTS5 index ready'); else console.log('[archive] node:sqlite unavailable — using grep fallback'); }
  catch (e) { console.error(`[archive] rebuild: ${e.message}`); }
  const _archiveInt = setInterval(() => { try { archive.rebuild(); } catch {} }, 15 * 60 * 1000);

  const buildUserMemory = (userId) => new Memory(memDir, { userId });

  const agent = new Agent({
    credsLoc,
    config: cfg,
    memoryRoot: memDir,
    dataDir: cfg._dataDir,
    hooks,
    queue,
    buildUserMemory
  });

  let botRef = null;
  // Single source of truth for "should this tool call be approved?" Used by
  // both the onMessage path and the scheduler path so receipts, trust, and
  // scope logic can't diverge between the two.
  const makeGateApproval = ({ userId, chatId }) => async (toolName, details = {}) => {
    const scope = scopeFor(toolName, details);
    const autoApprove = cfg.tools?.autoApprove === true;
    if (autoApprove) {
      receipts.append({ userId, tool: toolName, scope, details, decision: 'auto' });
      return true;
    }
    if (approvals.isTrusted(toolName, scope)) {
      receipts.append({ userId, tool: toolName, scope, details, decision: 'trusted' });
      return true;
    }
    if (!botRef) return false;
    const ok = await botRef.requestApproval(chatId, toolName, details);
    receipts.append({ userId, tool: toolName, scope, details, decision: ok ? 'approve' : 'deny' });
    if (ok) approvals.trust(toolName, scope);
    return ok;
  };

  const scheduler = new Scheduler(path.join(cfg._dataDir, 'cron.json'), async (entry) => {
    if (!botRef) return;
    try {
      const reply = await agent.respond(`[scheduled] ${entry.prompt}`, {
        userId: entry.fromId,
        chatId: entry.chatId,
        requestApproval: makeGateApproval({ userId: entry.fromId, chatId: entry.chatId }),
        isTrusted: (tool, scope) => approvals.isTrusted(tool, scope),
        bgTasks,
        spawnSubagent: ({ task, context }) => spawnSubagent({ credsLoc, task, context })
      });
      await botRef.send(entry.chatId, `⏰ ${reply}`);
    } catch (e) {
      queue.enqueue('tg_send', { chatId: entry.chatId, text: `⏰ scheduler error: ${scrubMessage(e)}` });
    }
  });

  const streamPref = new Map(); // userId → bool, default true
  const aliases = cfg.telegram?.userAliases || {};
  const aliasOf = id => aliases[String(id)] || String(id);

  const onMessage = async ({ chatId, fromId, text, images, replyTo, replyFrom, quote, bot }) => {
    fromId = aliasOf(fromId);
    images = images || [];

    // Enrich the message with reply/quote context so the assistant sees what the user is referring to.
    // Only prepend for non-command messages (commands start with /).
    const isCommand = /^\/\w/.test(text);
    if (!isCommand && (replyTo || quote)) {
      const parts = [];
      if (quote) parts.push(`[${cfg.persona?.userLabel || 'user'} quoted: "${quote.slice(0, 500)}"]`);
      const myUsername = cfg.telegram?.botUsername || botRef?.username || null;
      const repliedToSelf = myUsername && replyFrom === myUsername;
      if (replyTo) parts.push(`[${cfg.persona?.userLabel || 'user'} replied to ${repliedToSelf ? 'you' : (replyFrom || 'someone')}: "${replyTo.slice(0, 500)}"]`);
      text = parts.join('\n') + '\n\n' + text;
    }
    if (text === '/help') return bot.send(chatId, HELP);
    if (text === '/ping') return bot.send(chatId, 'pong');
    // /stop and /btw are handled as priority commands in the poll loop — they
    // never reach this handler. See onPriorityCommand above.
    if (text === '/reset') { agent.reset(fromId); return bot.send(chatId, 'conversation reset. memory kept.'); }
    if (text === '/compact') {
      const r = await agent.compactNow(fromId);
      return bot.send(chatId, `compacted: ${r.before} → ${r.after} turns. summary saved to memory.`);
    }
    if (text === '/status') {
      const s = agent.session(fromId);
      const u = s.usage || {};
      const totalInput = (u.inputTokens || 0) + (u.cacheReadTokens || 0);
      const hit = totalInput > 0 ? (u.cacheReadTokens / totalInput) * 100 : 0;
      const lines = [
        `model: ${s.model}`,
        `profile: ${s.profile}`,
        `think: ${s.think ? `on (${s.thinkBudget})` : 'off'}`,
        `turns in session: ${s.history.length}`,
        `api calls: ${u.turns || 0}`,
        `tokens in/out: ${u.inputTokens || 0} / ${u.outputTokens || 0}`,
        `cache read/create: ${u.cacheReadTokens || 0} / ${u.cacheCreationTokens || 0}`,
        `cache hit rate: ${hit.toFixed(1)}%`
      ];
      return bot.send(chatId, lines.join('\n'));
    }
    if (text === '/models' || text === '/model') {
      const current = agent.session(fromId).model;
      const lines = [
        '*available models*',
        '',
        '• `opus`    → claude-opus-4-6           (most capable, slowest, priciest)',
        '• `sonnet`  → claude-sonnet-4-6         (balanced — default)',
        '• `haiku`   → claude-haiku-4-5-20251001 (fastest, cheapest)',
        '',
        `current: *${current}*`,
        '',
        'switch with: `/model <alias|full-id>`',
        'examples: `/model opus`, `/model haiku`, `/model claude-sonnet-4-6`'
      ];
      return bot.send(chatId, lines.join('\n'));
    }
    const mModel = text.match(/^\/model\s+(\S+)$/);
    if (mModel) {
      const MODEL_ALIASES = {
        opus:   'claude-opus-4-6',
        sonnet: 'claude-sonnet-4-6',
        haiku:  'claude-haiku-4-5-20251001'
      };
      const resolved = MODEL_ALIASES[mModel[1].toLowerCase()] || mModel[1];
      agent.setModel(fromId, resolved);
      return bot.send(chatId, `model → ${resolved}`);
    }
    const mProfile = text.match(/^\/profile\s+(\S+)$/);
    if (mProfile) {
      const ok = agent.setProfile(fromId, mProfile[1]);
      return bot.send(chatId, ok ? `profile → ${mProfile[1]}` : `unknown profile. choices: ${Object.keys(PROFILES).join(', ')}`);
    }
    const mThink = text.match(/^\/think\s+(on|off)(?:\s+(\d+))?$/);
    if (mThink) { agent.setThink(fromId, mThink[1] === 'on', mThink[2] ? parseInt(mThink[2], 10) : undefined); return bot.send(chatId, `think ${mThink[1]}`); }
    const mRemind = text.match(/^\/remind\s+(\S+)\s+([\s\S]+)$/);
    if (mRemind) {
      const ms = parseMinutes(mRemind[1]);
      if (!ms) return bot.send(chatId, 'usage: /remind <minutes> <prompt>');
      const e = scheduler.add({ whenTs: Date.now() + ms, prompt: mRemind[2], chatId, fromId });
      return bot.send(chatId, `scheduled ${e.id} in ${mRemind[1]}min`);
    }
    if (text === '/reminders') {
      const list = scheduler.list().filter(e => String(e.fromId) === String(fromId));
      return bot.send(chatId, list.length ? list.map(e => `${e.id} @ ${new Date(e.whenTs).toISOString()} — ${e.prompt.slice(0, 60)}`).join('\n') : '(none)');
    }
    const mCancel = text.match(/^\/cancel\s+(\S+)$/);
    if (mCancel) { scheduler.remove(mCancel[1]); return bot.send(chatId, `cancelled ${mCancel[1]}`); }

    const mCron = text.match(/^\/cron(?:\s+([\s\S]+))?$/);
    if (mCron) {
      const desc = (mCron[1] || '').trim();
      if (!desc) return bot.send(chatId, 'usage: /cron <description>  (e.g. `/cron every Friday at 5pm summarize my week`)');
      const system = [
        'You convert natural-language schedule descriptions into crontab expressions.',
        'Output STRICTLY a JSON object: {"cron": "<m h dom mon dow>", "task": "<cleaned task text>", "confidence": "high"|"medium"|"low"}.',
        'Use 5-field crontab (minute hour day-of-month month day-of-week).',
        'If the description is ambiguous, pick the most reasonable interpretation and set confidence: "low".',
        'Return only the JSON, no commentary.'
      ].join('\n');
      let parsed;
      try {
        const r = await quickJSON(credsLoc, { system, user: desc, maxTokens: 400 });
        if (!r.ok) return bot.send(chatId, `couldn't parse, try rephrasing.\n\nraw response:\n\`\`\`\n${(r.raw || '').slice(0, 500)}\n\`\`\``);
        parsed = r.json;
      } catch (e) {
        return bot.send(chatId, `cron parse error: ${scrubMessage(e).slice(0, 300)}`);
      }
      const cronStr = String(parsed.cron || '').trim();
      const task = String(parsed.task || desc).trim();
      const confidence = String(parsed.confidence || 'medium').toLowerCase();
      if (!cronValid(cronStr)) {
        return bot.send(chatId, `couldn't parse, try rephrasing.\n\nraw response:\n\`\`\`\n${JSON.stringify(parsed).slice(0, 500)}\n\`\`\``);
      }
      const human = cronToHuman(cronStr);
      const nextTs = cronNext(cronStr, Date.now());
      const nextStr = nextTs ? new Date(nextTs).toLocaleString() : '(none within 4y)';
      const warn = confidence === 'low' ? '\n\n⚠️ *low confidence* — double-check this is what you meant.' : '';
      const promptBody = [
        `📅 Parsed: \`${cronStr}\`  →  ${human}`,
        `task: ${task}`,
        `next fire: ${nextStr} (server time)${warn}`
      ].join('\n');
      // Send the human-readable summary first, then reuse the existing
      // inline-keyboard approval for Yes/No. `cron_schedule` is a pseudo tool name.
      await bot.send(chatId, promptBody);
      const ok = await bot.requestApproval(chatId, 'cron_schedule', { cron: cronStr, task });
      if (!ok) return; // silent cancel on No or timeout
      const entry = scheduler.add({ whenTs: nextTs, prompt: task, chatId, fromId, cronExpr: cronStr });
      return bot.send(chatId, `✅ scheduled ${entry.id} — ${human}\ntask: ${task}\nnext fire: ${nextStr} (server time)`);
    }

    const mSkillList = text.match(/^\/skill\s+list$/);
    if (mSkillList || text === '/skill') {
      const s = loadSkills(skillsDir);
      if (!s.length) return bot.send(chatId, '(no skills yet — they appear automatically after productive multi-step sessions, or write markdown files to data/skills/)');
      return bot.send(chatId, s.map(x => `• \`${x.name}\`  triggers: ${x.triggers.join(', ') || '(none)'}`).join('\n'));
    }
    const mSkill = text.match(/^\/skill\s+(\S+)$/);
    if (mSkill && mSkill[1] !== 'list') {
      const safe = sanitizeSkillName(mSkill[1]);
      const sk = loadSkillByName(skillsDir, safe);
      if (!sk) return bot.send(chatId, `no skill \`${safe}\`. try /skill list`);
      // Inject skill body into the session as a user-invisible system-style primer by
      // prepending a [skill primer] note to the next user turn. Simpler than mutating
      // system blocks and survives the existing respond() flow.
      const sess = agent.session(fromId);
      sess.history.push({
        role: 'user',
        content: `[skill primer: ${sk.name}]\n${sk.body}\n\n(You have been primed with the skill above. Apply it to my next message.)`
      });
      sess.history.push({ role: 'assistant', content: `Loaded skill: ${sk.name}.` });
      return bot.send(chatId, `🧠 primed with skill \`${sk.name}\`. your next message will use it.`);
    }
    if (text === '/notes') {
      const mem = buildUserMemory(fromId);
      return bot.send(chatId, mem.list().join('\n') || '(no notes)');
    }
    if (text === '/memory' || text === '/memory list') {
      const mem = buildUserMemory(fromId);
      const archived = mem.listArchived();
      const lines = [`active notes: ${mem.list().length}`];
      if (archived.length) {
        lines.push(`\narchived (use /memory restore <key>):`);
        for (const a of archived.slice(-20)) lines.push(`  ${a.key}  (${a.archivedAt})`);
      } else {
        lines.push(`\n(no archived notes)`);
      }
      return bot.send(chatId, lines.join('\n'));
    }
    const mRestore = text.match(/^\/memory\s+restore\s+(\S+)$/);
    if (mRestore) {
      const mem = buildUserMemory(fromId);
      const r = mem.restore(mRestore[1]);
      return bot.send(chatId, r ? `restored: ${JSON.stringify(r)}` : `no archived note matches "${mRestore[1]}"`);
    }
    if (text === '/skills') {
      const s = loadSkills(skillsDir);
      return bot.send(chatId, s.length ? s.map(x => `- ${x.name} [${x.triggers.join(',')}]`).join('\n') : '(no skills)');
    }
    if (text === '/context') {
      const files = fs.existsSync(ctxDir) ? fs.readdirSync(ctxDir).filter(f => f.endsWith('.md')) : [];
      return bot.send(chatId, files.length ? files.join('\n') : '(no context files)');
    }
    if (text === '/hooks') {
      return bot.send(chatId, hooks.length ? hooks.map(h => h.name).join('\n') : '(no hooks)');
    }
    const mJournal = text.match(/^\/journal(?:\s+(today|yesterday|\d{4}-\d{2}-\d{2}))?$/);
    if (mJournal) {
      const arg = mJournal[1] || 'today';
      const d = new Date();
      if (arg === 'yesterday') d.setDate(d.getDate() - 1);
      const day = arg.match(/^\d{4}/) ? arg : d.toISOString().slice(0, 10);
      const f = path.join(cfg._dataDir, 'journal', `${day}.md`);
      const body = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : `(no journal for ${day})`;
      return bot.send(chatId, body.slice(0, 4000));
    }
    const mStream = text.match(/^\/stream\s+(on|off)$/);
    if (mStream) { streamPref.set(fromId, mStream[1] === 'on'); return bot.send(chatId, `stream ${mStream[1]}`); }

    if (text === '/capabilities') {
      const caps = buildCapabilitiesText({ cfg, dataDir: cfg._dataDir, hooks, scheduler, queue });
      return bot.send(chatId, caps);
    }
    const mSearch = text.match(/^\/search\s+([\s\S]+)$/);
    if (mSearch) {
      const q = mSearch[1].trim();
      let out = '';
      if (archive.available()) {
        try { const hits = archive.search(q, { userId: fromId, limit: 20 }); out = archive.formatHits(hits, cfg._dataDir); }
        catch (e) { console.error(`[search] fts: ${e.message}`); }
      }
      if (!out) out = searchArchive(cfg._dataDir, q, fromId);
      return bot.send(chatId, out || `(no hits for "${q}")`);
    }
    if (text === '/tasks') {
      const list = bgTasks.list({ userId: fromId });
      if (!list.length) return bot.send(chatId, '(no background tasks)');
      const lines = list.slice(-20).map(t => {
        const s = t.status === 'running' ? '⏳' : (t.status === 'done' ? '✅' : '❌');
        const dur = t.finishedAt ? ((t.finishedAt - t.startedAt) / 1000).toFixed(1) + 's' : `${((Date.now() - t.startedAt)/1000).toFixed(0)}s elapsed`;
        const base = `${s} ${t.id}  ${dur}  ${t.label}`;
        if (t.status === 'running' || !t.result) return base;
        const preview = typeof t.result === 'string'
          ? t.result
          : JSON.stringify(t.result);
        return `${base}\n    → ${preview.slice(0, 120).replace(/\n/g, ' ')}${preview.length > 120 ? '…' : ''}`;
      });
      return bot.send(chatId, lines.join('\n'));
    }
    if (text === '/filesstructure' || text === '/fs') {
      const out = renderFileStructure(cfg._dataDir);
      return bot.send(chatId, out);
    }
    if (text === '/projects' || text === '/projects full') {
      const out = listProjects(cfg._dataDir, { full: text === '/projects full' });
      return bot.send(chatId, out || '(no projects under data/workspace/projects/)');
    }
    if (text === '/receipts' || text === '/receipts verify') {
      if (text === '/receipts verify') {
        const v = receipts.verify();
        return bot.send(chatId, v.ok
          ? `✅ chain intact — ${v.entries} entries across all users (chain is global, not per-user)`
          : `❌ tampered at entry ${v.at}: ${v.reason}`);
      }
      const last = receipts.tail(20, { userId: fromId });
      if (!last.length) return bot.send(chatId, '(no receipts)');
      const lines = last.map(e => {
        const when = new Date(e.ts).toISOString().slice(5, 16).replace('T', ' ');
        const scope = e.scope ? ` [${e.scope}]` : '';
        return `${when}  ${e.decision.padEnd(7)} ${e.tool}${scope}`;
      });
      return bot.send(chatId, lines.join('\n'));
    }
    if (text === '/usage') {
      const m = new Metrics(path.join(cfg._dataDir, 'metrics.jsonl'));
      const all = m.readSince(365 * 86_400_000).filter(e => String(e.userId) === String(fromId));
      const s = summarize(all);
      if (!s) return bot.send(chatId, 'no usage yet');
      const cost = estimateCost(s);
      return bot.send(chatId, [
        `*lifetime usage — you (${fromId})*`,
        `api calls: ${s.turns}  errors: ${s.errors}`,
        `input tokens: ${s.tokens.in}`,
        `output tokens: ${s.tokens.out}`,
        `cache read: ${s.tokens.cacheRead}   write: ${s.tokens.cacheCreate}`,
        `cache hit: ${(s.cacheHitRatio * 100).toFixed(1)}%`,
        `rough spend: $${cost.toFixed(4)}`
      ].join('\n'));
    }
    const mInsights = text.match(/^\/insights(?:\s+(\d+))?$/);
    if (mInsights) {
      const days = parseInt(mInsights[1] || '7', 10);
      const sinceMs = days * 86_400_000;
      const m = new Metrics(path.join(cfg._dataDir, 'metrics.jsonl'));
      const all = m.readSince(sinceMs).filter(e => String(e.userId) === String(fromId));
      const s = summarize(all);
      if (!s) return bot.send(chatId, `no activity in last ${days}d`);
      const costEstimate = estimateCost(s);
      const lines = [
        `*last ${days}d — ${s.turns} api turns, ${s.errors} errors*`,
        ``,
        `tokens: ${s.tokens.in} in / ${s.tokens.out} out`,
        `cache: ${s.tokens.cacheRead} read + ${s.tokens.cacheCreate} create  → hit ${(s.cacheHitRatio * 100).toFixed(1)}%`,
        `cost estimate: $${costEstimate.toFixed(4)} (rough)`,
        `latency p50/p95/max: ${s.latency.p50}ms / ${s.latency.p95}ms / ${s.latency.max}ms`,
        `tool calls: ${s.toolCalls}`,
        ``,
        `top tools:`,
        ...s.topTools.map(([name, n]) => `  ${name}: ${n}`),
        ``,
        `by model:`,
        ...Object.entries(s.byModel).map(([m, n]) => `  ${m}: ${n}`)
      ];
      return bot.send(chatId, lines.join('\n'));
    }
    const mAudit = text.match(/^\/audit\s+(\S+)(?:\s+(\d+))?$/);
    if (mAudit) {
      const toolName = mAudit[1];
      const days = parseInt(mAudit[2] || '2', 10);
      const out = auditTool(cfg._dataDir, fromId, toolName, days);
      return bot.send(chatId, out || `(no ${toolName} calls in last ${days}d)`);
    }

    if (text === '/trusts') {
      const list = approvals.list();
      return bot.send(chatId, list.length ? list.join('\n') : '(none trusted yet)');
    }
    const mForget = text.match(/^\/forget\s+(\S+)$/);
    if (mForget) { approvals.forget(mForget[1]); return bot.send(chatId, `forgot ${mForget[1]}`); }

    const t0 = Date.now();
    const ts = new Date().toTimeString().slice(0, 8);
    console.log(`${ts} [msg] u=${fromId} → "${text.slice(0, 80).replace(/\n/g, ' ')}${text.length > 80 ? '…' : ''}"${images.length ? ` +${images.length} img` : ''}`);
    await bot.typing(chatId);
    // Telegram typing indicator expires after ~5s. Re-fire every 4s while the
    // assistant is working so the user sees "typing..." throughout long tool chains.
    const typingHeartbeat = setInterval(() => { bot.typing(chatId).catch(() => {}); }, 4000);
    const streamingOn = streamPref.get(fromId) !== false;

    // Trust-on-first-use wrapper around approval.
    // `tools.autoApprove: true` in config bypasses the prompt entirely.
    const gateApproval = makeGateApproval({ userId: fromId, chatId });
    const MIN_FIRST_CHARS = 40;   // wait for real content before sending anything
    const MIN_EDIT_MS = 1500;     // throttle edits for Telegram rate limit
    let placeholder = null;
    let placeholderPromise = null;   // in-flight bot.send promise (or null if not started)
    let lastEdit = 0;
    let lastText = '';
    const onStream = streamingOn ? ({ textSoFar }) => {
      if (!textSoFar || textSoFar.length < MIN_FIRST_CHARS) return;
      const now = Date.now();
      if (!placeholder) {
        if (placeholderPromise) return; // already in flight
        const initial = textSoFar.slice(0, 3900);
        placeholderPromise = bot.send(chatId, initial)
          .then(m => { placeholder = m; lastEdit = Date.now(); lastText = initial; return m; })
          .catch(e => { console.error(`[tg] placeholder send: ${e.message}`); return null; });
        return;
      }
      if (now - lastEdit < MIN_EDIT_MS) return;
      const trimmed = textSoFar.slice(-3900);
      if (trimmed === lastText) return;
      lastEdit = now;
      lastText = trimmed;
      bot.editText(chatId, placeholder.message_id, trimmed).catch(() => {});
    } : null;

    // Live subprocess progress: edit a single Telegram message in place as
    // claude_code/bash_exec output streams in. Creates the message on first
    // chunk, edits (throttled to 2s) on subsequent chunks, clears on tool end.
    let progressMsg = null;
    let progressPending = false;
    let progressLastEdit = 0;
    let progressLastText = '';
    const progressCreating = { v: false };
    const MAX_TG = 3800;
    const PROGRESS_MIN_EDIT_MS = 2000;
    const onLiveProgress = ({ kind, totalSoFar }) => {
      if (!totalSoFar || totalSoFar.length < 30) return;
      // Latest slice — we show the tail so the user sees newest output.
      const tail = `🔧 *claude_code live* (${kind})\n\n\`\`\`\n${totalSoFar.slice(-MAX_TG).trimEnd()}\n\`\`\``;
      if (tail === progressLastText) return;
      if (!progressMsg) {
        if (progressCreating.v) return;
        progressCreating.v = true;
        bot.send(chatId, tail)
          .then(m => { progressMsg = m; progressLastEdit = Date.now(); progressLastText = tail; })
          .catch(e => console.error(`[live] send: ${e.message}`))
          .finally(() => { progressCreating.v = false; });
        return;
      }
      const now = Date.now();
      if (now - progressLastEdit < PROGRESS_MIN_EDIT_MS) return;
      if (progressPending) return;
      progressPending = true;
      progressLastEdit = now;
      progressLastText = tail;
      bot.editText(chatId, progressMsg.message_id, tail)
        .catch(e => { if (!/not modified/i.test(e.message)) console.error(`[live] edit: ${e.message}`); })
        .finally(() => { progressPending = false; });
    };
    const reply = await agent.respond(text, {
      userId: fromId,
      chatId,
      images,
      requestApproval: gateApproval,
      spawnSubagent: ({ task, context }) => spawnSubagent({ credsLoc, task, context }),
      isTrusted: (tool, scope) => approvals.isTrusted(tool, scope),
      bgTasks,
      sendAlert: async (msg) => { try { await bot.send(chatId, msg); } catch {} },
      onLiveProgress,
      onStream
    });
    // When the turn is done, finalize the progress message so the user doesn't see
    // a stale "live" chunk hanging around above the real reply.
    if (progressMsg) {
      try { await bot.editText(chatId, progressMsg.message_id, `✅ *claude_code done* — see final reply below.`); } catch {}
    }

    clearInterval(typingHeartbeat);
    // Critical: wait for any in-flight placeholder send before deciding edit-vs-send.
    // Otherwise a fast reply plus a slow placeholder network call = two messages.
    if (placeholderPromise) {
      try { await placeholderPromise; } catch {}
    }

    if (streamingOn && placeholder && reply.length <= 4000) {
      // lastText previously held a TAIL slice of partial output, so the old
      // equality check `lastText === reply` never hit. Telegram rejects
      // "not modified" edits cheaply enough to just try and catch it.
      try { await bot.editText(chatId, placeholder.message_id, reply); }
      catch (e) {
        if (!/not modified/i.test(e.message)) await bot.send(chatId, reply);
      }
    } else if (streamingOn && placeholder) {
      // final reply exceeds single-message cap: keep placeholder as head, send remainder
      await bot.send(chatId, reply.slice(4000));
    } else {
      await bot.send(chatId, reply);
    }
    console.log(`${new Date().toTimeString().slice(0, 8)} [reply] u=${fromId} ${reply.length}ch ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  };

  const transcribe = cfg.stt?.apiKey
    ? (buf, mime, name) => sttTranscribe(cfg, buf, mime, name)
    : null;
  // Priority command handler — runs in the poll loop without waiting for
  // onMessage to finish. This is how /stop and /btw work mid-chain.
  const onPriorityCommand = async ({ chatId, fromId: rawFromId, text, bot: b }) => {
    const uid = aliasOf(rawFromId);
    if (text === '/errors') {
      // Read today's session jsonl, return last 10 errored tool calls.
      const sessionFile = path.join(cfg._dataDir, 'sessions', new Date().toISOString().slice(0, 10) + '.jsonl');
      if (!fs.existsSync(sessionFile)) return b.send(chatId, '(no session log today)');
      const errors = [];
      for (const line of fs.readFileSync(sessionFile, 'utf8').split('\n').filter(Boolean)) {
        try {
          const j = JSON.parse(line);
          if ((j.type === 'tool' && j.isError) || j.type === 'api_error') {
            const when = new Date(j.ts).toTimeString().slice(0, 8);
            if (j.type === 'api_error') {
              errors.push(`${when} 🔴 API: ${String(j.error).slice(0, 200)}`);
            } else {
              const resultPreview = String(j.result || '').slice(0, 180).replace(/\n/g, ' ');
              errors.push(`${when} 🔴 ${j.name}: ${resultPreview}`);
            }
          }
        } catch {}
      }
      if (!errors.length) return b.send(chatId, '✅ no errors today');
      return b.send(chatId, `*last ${Math.min(10, errors.length)} errors today (${errors.length} total)*\n\n` + errors.slice(-10).join('\n\n'));
    }
    if (text === '/busy' || text === '/status') {
      const s = agent.session(uid);
      if (!s.busy) return b.send(chatId, '💤 idle. not running anything right now.');
      const elapsedMs = Date.now() - (s.busyStart || Date.now());
      const elapsedS = (elapsedMs / 1000).toFixed(1);
      const toolLine = s.currentTool
        ? `🔧 running tool: *${s.currentTool}* (${((Date.now() - (s.currentToolStart || Date.now())) / 1000).toFixed(1)}s)`
        : `💭 thinking (Claude API call)`;
      return b.send(chatId, [
        `⏳ busy — turn ${s.currentTurn || '?'}/50, ${elapsedS}s total`,
        toolLine,
        '',
        '`/stop` to interrupt · `/btw <msg>` to side-chat'
      ].join('\n'));
    }
    if (text === '/stop') {
      const r = agent.stop(uid);
      return b.send(chatId, r.killed ? '🛑 stopped. killed active process and aborted turn loop.' : '🛑 stopped. no active process was running.');
    }
    const mBtw = text.match(/^\/btw\s+([\s\S]+)$/);
    if (mBtw) {
      const soul = agent.personaFiles.soul.content || '';
      b.typing(chatId).catch(() => {});
      try {
        const resp = await createMessage(credsLoc, {
          model: 'claude-haiku-4-5-20251001',
          maxTokens: 1024,
          system: [{ type: 'text', text: (soul ? soul + '\n\n' : '') + 'This is a quick side message from the user while you are busy with another task. Reply briefly and naturally. Do not reference tools or your current work.' }],
          messages: [{ role: 'user', content: mBtw[1].trim() }]
        });
        const reply = (resp.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim() || '(empty)';
        return b.send(chatId, reply);
      } catch (e) {
        return b.send(chatId, `(btw error: ${scrubMessage(e).slice(0, 200)})`);
      }
    }

    // ─── Classic mode: direct terminal-style commands, no LLM in the loop ───
    const sess = agent.session(uid);
    const projectsRoot = path.join(cfg._dataDir, 'workspace', 'projects');
    const resolveCwd = () => sess.projectSlug
      ? path.join(projectsRoot, sess.projectSlug)
      : path.join(cfg._dataDir, 'workspace');

    if (text === '/pwd') {
      const cwd = resolveCwd();
      const rel = cwd.replace(cfg._dataDir + '/', '');
      return b.send(chatId, `\`${rel}\`${sess.projectSlug ? ` (project: ${sess.projectSlug})` : ' (workspace root)'}`);
    }

    const mCd = text.match(/^\/cd(?:\s+(\S.*))?$/);
    if (mCd) {
      const target = (mCd[1] || '').trim();
      if (!target || target === '..' || target === '/' || target === '~') {
        sess.projectSlug = null;
        return b.send(chatId, `📂 cwd → workspace root`);
      }
      const slug = target.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
      const candidate = path.join(projectsRoot, slug);
      if (!fs.existsSync(candidate)) {
        const available = fs.existsSync(projectsRoot) ? fs.readdirSync(projectsRoot).filter(n => !n.startsWith('.')).join(', ') : '(none)';
        return b.send(chatId, `❌ no project "${slug}". available: ${available}`);
      }
      sess.projectSlug = slug;
      return b.send(chatId, `📂 cwd → ${slug}`);
    }

    const mLs = text.match(/^\/ls(?:\s+(\S.*))?$/);
    if (mLs) {
      const sub = (mLs[1] || '').trim();
      const cwd = resolveCwd();
      const target = sub ? path.resolve(cwd, sub) : cwd;
      if (!target.startsWith(cfg._dataDir)) return b.send(chatId, `❌ path escapes workspace`);
      if (!fs.existsSync(target)) return b.send(chatId, `❌ no such path: ${sub || '.'}`);
      try {
        const entries = fs.readdirSync(target, { withFileTypes: true })
          .filter(e => !e.name.startsWith('.'))
          .sort((a, z) => (z.isDirectory() - a.isDirectory()) || a.name.localeCompare(z.name))
          .map(e => {
            const full = path.join(target, e.name);
            let size = '';
            try { if (e.isFile()) size = ` ${fs.statSync(full).size}B`; } catch {}
            return `${e.isDirectory() ? '📁' : '📄'} ${e.name}${size}`;
          });
        if (!entries.length) return b.send(chatId, `(empty)`);
        return b.send(chatId, `\`\`\`\n${entries.join('\n').slice(0, 3800)}\n\`\`\``);
      } catch (e) { return b.send(chatId, `❌ ls error: ${scrubMessage(e)}`); }
    }

    const mCat = text.match(/^\/cat\s+(\S+)$/);
    if (mCat) {
      const cwd = resolveCwd();
      const target = path.resolve(cwd, mCat[1]);
      if (!target.startsWith(cfg._dataDir)) return b.send(chatId, `❌ path escapes workspace`);
      if (!fs.existsSync(target)) return b.send(chatId, `❌ no such file`);
      try {
        const body = fs.readFileSync(target, 'utf8');
        const ext = path.extname(target).slice(1) || '';
        return b.send(chatId, `\`\`\`${ext}\n${body.slice(0, 3700)}${body.length > 3700 ? '\n... [truncated]' : ''}\n\`\`\``);
      } catch (e) { return b.send(chatId, `❌ cat error: ${scrubMessage(e)}`); }
    }

    const mGit = text.match(/^\/git(?:\s+(.+))?$/);
    if (mGit) {
      const cwd = resolveCwd();
      if (!fs.existsSync(path.join(cwd, '.git'))) return b.send(chatId, `❌ not a git repo: ${sess.projectSlug || 'workspace'}`);
      const args = (mGit[1] || 'status').split(/\s+/).filter(Boolean);
      try {
        const { execFileSync } = require('child_process');
        const out = execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 10_000 });
        return b.send(chatId, `\`\`\`\n${out.slice(0, 3800) || '(no output)'}\n\`\`\``);
      } catch (e) {
        const msg = e.stdout?.toString() || e.stderr?.toString() || e.message;
        return b.send(chatId, `\`\`\`\ngit error:\n${scrubMessage(msg).slice(0, 3700)}\n\`\`\``);
      }
    }

    const mCc = text.match(/^\/cc\s+([\s\S]+)$/);
    if (mCc) {
      // Direct Claude Code passthrough. Bypasses agent loop entirely.
      // Uses -c (continue) if a session exists for the current project.
      if (!sess.projectSlug) return b.send(chatId, `❌ /cc needs a project. run \`/cd <project>\` first.`);
      const cwd = resolveCwd();
      if (!fs.existsSync(cwd)) return b.send(chatId, `❌ project dir missing: ${cwd}`);
      const task = mCc[1].trim();
      const continueSession = !!(sess.projectSessions && sess.projectSessions[sess.projectSlug]);
      await b.send(chatId, `🔧 \`/cc\` ${continueSession ? '(continuing)' : '(new session)'} → ${sess.projectSlug}\n\n> ${task.slice(0, 200)}`);
      b.typing(chatId).catch(() => {});
      // Declared outside try so the catch branch's clearInterval(hb) doesn't
      // throw a ReferenceError if setInterval itself fails.
      let hb;
      try {
        hb = setInterval(() => b.typing(chatId).catch(() => {}), 4000);
        const { spawn } = require('child_process');
        const args = continueSession
          ? ['-c', '-p', task, '--permission-mode', 'acceptEdits', '--output-format', 'text']
          : ['-p', task, '--permission-mode', 'acceptEdits', '--output-format', 'text'];
        // Build a clean env: inherit only benign shell/locale vars. Do NOT
        // forward api-key-style secrets — `claude` CLI uses its own keychain
        // creds, so leaking them into the subprocess env is pure liability.
        const SAFE_ENV_KEYS = new Set(['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TERM', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'TZ', 'PWD']);
        const cleanEnv = {};
        for (const [k, v] of Object.entries(process.env)) {
          if (!SAFE_ENV_KEYS.has(k)) continue;
          if (/_API_KEY$|_TOKEN$|_SECRET$/i.test(k)) continue;
          cleanEnv[k] = v;
        }
        const proc = spawn('claude', args, { cwd, env: cleanEnv });
        sess.activeProc = proc;
        let out = '', err = '';
        let liveMsg = null;
        let lastEdit = 0;
        const MAX = 3800;
        proc.stdout.on('data', d => {
          out += d.toString();
          const now = Date.now();
          if (now - lastEdit < 2000) return;
          lastEdit = now;
          const tail = `🔧 claude_code live\n\n\`\`\`\n${out.slice(-MAX).trimEnd()}\n\`\`\``;
          if (!liveMsg) b.send(chatId, tail).then(m => { liveMsg = m; }).catch(() => {});
          else b.editText(chatId, liveMsg.message_id, tail).catch(() => {});
        });
        proc.stderr.on('data', d => { err += d.toString(); });
        await new Promise(resolve => {
          proc.on('close', code => { clearInterval(hb); sess.activeProc = null; resolve(code); });
          proc.on('error', e => { clearInterval(hb); sess.activeProc = null; err = e.message; resolve(-1); });
        });
        sess.projectSessions = { ...(sess.projectSessions || {}), [sess.projectSlug]: { lastRun: Date.now() } };
        const finalMsg = out.trim() || err.trim() || '(no output)';
        if (liveMsg) { try { await b.editText(chatId, liveMsg.message_id, `✅ /cc done — result below.`); } catch {} }
        return b.send(chatId, finalMsg.slice(0, 3800));
      } catch (e) {
        clearInterval(hb);
        return b.send(chatId, `❌ /cc error: ${scrubMessage(e)}`);
      }
    }

    if (text === '/continue') {
      if (!sess.projectSlug) return b.send(chatId, `❌ no current project. use \`/cd <project>\` first.`);
      const hasSession = !!(sess.projectSessions && sess.projectSessions[sess.projectSlug]);
      if (!hasSession) return b.send(chatId, `❌ no prior session in ${sess.projectSlug}. use \`/cc <task>\` to start one.`);
      return b.send(chatId, `▶️ ok — next \`/cc\` in \`${sess.projectSlug}\` will resume. or just send \`/cc <task>\` with any prompt.`);
    }

    if (text === '/end') {
      if (!sess.projectSlug) return b.send(chatId, `(no current project)`);
      if (sess.projectSessions) delete sess.projectSessions[sess.projectSlug];
      return b.send(chatId, `🔚 session in \`${sess.projectSlug}\` ended. next /cc will start fresh.`);
    }

    if (text === '/sessions') {
      const ps = sess.projectSessions || {};
      const active = Object.entries(ps);
      if (!active.length) return b.send(chatId, `(no active project sessions)`);
      const lines = active.map(([slug, s]) => {
        const age = Math.floor((Date.now() - s.lastRun) / 60000);
        return `• \`${slug}\` — last active ${age}m ago`;
      });
      return b.send(chatId, lines.join('\n'));
    }

    const mHookAdd = text.match(/^\/hook\s+add\s+(https?:\/\/\S+)$/);
    if (mHookAdd) {
      const candidate = mHookAdd[1];
      // SSRF guard: reject private/loopback/link-local targets before persisting.
      if (!(await isPublicUrl(candidate))) {
        return b.send(chatId, `❌ refusing to add webhook — hostname resolves to a private/loopback/link-local range.`);
      }
      const hooksFile = path.join(cfg._dataDir, 'webhooks.json');
      let list = [];
      try { list = JSON.parse(fs.readFileSync(hooksFile, 'utf8')); } catch {}
      if (!list.includes(candidate)) list.push(candidate);
      fs.writeFileSync(hooksFile, JSON.stringify(list, null, 2));
      return b.send(chatId, `🪝 webhook added: ${candidate}  (${list.length} total)`);
    }
    if (text === '/hook list' || text === '/hooks list') {
      const hooksFile = path.join(cfg._dataDir, 'webhooks.json');
      let list = [];
      try { list = JSON.parse(fs.readFileSync(hooksFile, 'utf8')); } catch {}
      if (!list.length) return b.send(chatId, '(no webhooks registered)');
      return b.send(chatId, list.map((u, i) => `${i + 1}. ${u}`).join('\n'));
    }
    const mHookDel = text.match(/^\/hook\s+(?:del|remove)\s+(\d+)$/);
    if (mHookDel) {
      const hooksFile = path.join(cfg._dataDir, 'webhooks.json');
      let list = [];
      try { list = JSON.parse(fs.readFileSync(hooksFile, 'utf8')); } catch {}
      const idx = parseInt(mHookDel[1], 10) - 1;
      if (idx < 0 || idx >= list.length) return b.send(chatId, `bad index`);
      const removed = list.splice(idx, 1);
      fs.writeFileSync(hooksFile, JSON.stringify(list, null, 2));
      return b.send(chatId, `🗑 removed: ${removed[0]}`);
    }

    if (text === '/budget') {
      const capUsd = cfg.tools?.userDailyBudgetUsd;
      const m = new Metrics(path.join(cfg._dataDir, 'metrics.jsonl'));
      const dayStart = new Date(); dayStart.setUTCHours(0, 0, 0, 0);
      const entries = m.readSince(Date.now() - dayStart.getTime()).filter(e => String(e.userId) === String(uid));
      const sum = summarize(entries);
      const spent = sum ? estimateCost(sum) : 0;
      const lines = [
        `*today's spend (${uid})*`,
        `$${spent.toFixed(4)} over ${sum?.turns || 0} turns`,
        capUsd ? `daily cap: $${capUsd.toFixed(2)} (remaining: $${Math.max(0, capUsd - spent).toFixed(4)})` : `daily cap: not set (see \`cfg.tools.userDailyBudgetUsd\`)`
      ];
      return b.send(chatId, lines.join('\n'));
    }
  };

  const bot = new TelegramBot({
    token: cfg.telegram.botToken,
    allowFrom: cfg.telegram.allowFrom,
    onMessage,
    onPriorityCommand,
    transcribe
  });
  botRef = bot;
  botRefForBg = bot;
  // Interrupted: notify via queue (survives fast re-crash).
  for (const rec of interruptedTasks) {
    if (rec.chatId) {
      queue.enqueue('tg_send', { chatId: rec.chatId, text: `⚠️ background task interrupted by restart: ${rec.label} [${rec.id}]` });
    }
  }
  // Undelivered: re-deliver now that the bot is up, then mark delivered.
  (async () => {
    for (const rec of undeliveredTasks) {
      if (!rec.chatId) continue;
      try {
        const ms = (rec.finishedAt || Date.now()) - rec.startedAt;
        const tag = rec.status === 'done' ? '✅' : '❌';
        const body = typeof rec.result === 'string' ? rec.result : JSON.stringify(rec.result, null, 2).slice(0, 3600);
        await bot.send(rec.chatId, `${tag} (re-delivered after restart) ${rec.label} (${(ms/1000).toFixed(1)}s) [${rec.id}]\n\n${body}`);
        bgTasks.markDelivered(rec.id);
      } catch (e) { console.error(`[bg] re-deliver ${rec.id}: ${e.message}`); }
    }
  })();

  // Drain any pending messages from previous crash.
  await queue.drain(async (kind, payload) => {
    if (kind === 'tg_send') await bot.send(payload.chatId, payload.text);
  });
  queue.compact();

  scheduler.start();

  // Weekly digest: check every 6h; runs only on Sundays and writes once per day.
  const digestUsers = [...new Set([
    ...(cfg.telegram.allowFrom || []).map(String),
    ...Object.values(aliases).map(String)
  ])];
  const digestTick = async () => {
    try { await maybeRunDigest({ credsLoc, dataDir: cfg._dataDir, userIds: digestUsers }); }
    catch (e) { console.error(`[digest] tick: ${e.message}`); }
  };
  const _digestInt = setInterval(digestTick, 6 * 60 * 60 * 1000);
  const _digestTO = setTimeout(digestTick, 60_000);

  // Memory decay: sweep stale `project` notes daily into _archive/.
  const decayTick = () => {
    try {
      const r = sweepMemory(memDir);
      if (r.archived.length) console.log(`[decay] archived ${r.archived.length} stale project notes (cutoff ${DECAY_DAYS}d)`);
    } catch (e) { console.error(`[decay] ${e.message}`); }
  };
  const _decayInt = setInterval(decayTick, 24 * 60 * 60 * 1000);
  const _decayTO = setTimeout(decayTick, 5 * 60_000);

  // Clean up long-lived timers on shutdown so an embedding process isn't
  // leaking handles. The existing SIGINT/SIGTERM handlers inside acquireLock
  // exit() immediately, so clearing here is belt-and-suspenders for future use.
  const _shutdown = () => {
    try { clearInterval(_archiveInt); } catch {}
    try { clearInterval(_digestInt); clearTimeout(_digestTO); } catch {}
    try { clearInterval(_decayInt); clearTimeout(_decayTO); } catch {}
  };
  process.on('SIGINT', _shutdown);
  process.on('SIGTERM', _shutdown);

  await bot.setCommands([
    { command: 'help',      description: 'list commands' },
    { command: 'ping',      description: 'liveness check' },
    { command: 'status',    description: 'show session state' },
    { command: 'stop',      description: 'interrupt current tool chain' },
    { command: 'btw',       description: 'quick side message while busy: /btw <msg>' },
    { command: 'busy',      description: 'am i working right now? shows current tool + elapsed time' },
    { command: 'errors',    description: 'last 10 tool errors today' },
    { command: 'cd',        description: 'set current project: /cd <slug>' },
    { command: 'pwd',       description: 'show current project cwd' },
    { command: 'ls',        description: 'list files in cwd: /ls [dir]' },
    { command: 'cat',       description: 'show file in cwd: /cat <file>' },
    { command: 'git',       description: 'run git in cwd: /git <args>' },
    { command: 'cc',        description: 'direct claude code passthrough: /cc <task>' },
    { command: 'continue',  description: 'resume claude code session in current project' },
    { command: 'end',       description: 'end claude code session in current project' },
    { command: 'sessions',  description: 'list active project sessions' },
    { command: 'budget',    description: 'today spend vs daily cap' },
    { command: 'hook',      description: 'webhooks: /hook add|list|del' },
    { command: 'reset',     description: 'clear conversation (memory kept)' },
    { command: 'compact',   description: 'summarize old turns now' },
    { command: 'model',     description: 'switch model (opus|sonnet|haiku or full id)' },
    { command: 'models',    description: 'list available models' },
    { command: 'profile',   description: 'switch profile (chat|coding|research)' },
    { command: 'think',     description: 'toggle extended thinking: on|off [budget]' },
    { command: 'stream',    description: 'toggle streaming: on|off' },
    { command: 'remind',    description: 'schedule a nudge: <minutes> <prompt>' },
    { command: 'reminders', description: 'list pending reminders' },
    { command: 'cancel',    description: 'cancel a reminder by id' },
    { command: 'cron',      description: 'natural-language cron: /cron <description>' },
    { command: 'skill',     description: 'skills: /skill list | /skill <name>' },
    { command: 'notes',     description: 'list memory keys' },
    { command: 'journal',   description: 'read journal: [today|yesterday|YYYY-MM-DD]' },
    { command: 'skills',    description: 'list loaded skills' },
    { command: 'context',   description: 'list context files' },
    { command: 'hooks',     description: 'list active hooks' },
    { command: 'trusts',    description: 'list trusted tools/projects' },
    { command: 'forget',    description: 'revoke trust: /forget <key>' },
    { command: 'capabilities', description: 'what i can and cant do' },
    { command: 'search',    description: 'search journal+memory+sessions: /search <q>' },
    { command: 'insights',  description: 'usage analytics: /insights [days]' },
    { command: 'audit',     description: 'tool audit log: /audit <tool> [days]' },
    { command: 'usage',     description: 'your lifetime token usage + rough cost' },
    { command: 'memory',    description: 'list/restore memory: /memory [restore <key>]' },
    { command: 'projects',  description: 'list projects w/ git status' },
    { command: 'tasks',     description: 'background task log' },
    { command: 'receipts',  description: 'approval receipts (/receipts verify for chain check)' }
  ]);

  console.log(`[claudefish] profiles=${Object.keys(PROFILES).join(',')} scheduler=on queue=on`);
  await bot.start();
}

main().catch(e => { console.error(e); process.exit(1); });
