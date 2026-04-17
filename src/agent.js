'use strict';

const fs = require('fs');
const path = require('path');
const { createMessage, streamMessage } = require('./claude');
const { buildSystem } = require('./billing');
const { buildTools, PROFILES, TRUNCATION_LIMITS, truncate } = require('./tools');
const { loadSkills, matchSkills } = require('./skills');
const { runHook } = require('./hooks');
const { buildCapabilitiesText } = require('./capabilities');
const { Metrics } = require('./metrics');
const { maybeLearnFromCorrection } = require('./learn');
const { synthesize, checkEligible } = require('./synth');
const { estimateCost } = require('./cost');

const DEBUG = process.env.CLAUDEFISH_DEBUG === '1';
function dbg(...args) { if (DEBUG) console.log(...args); }

const MAX_TURNS = 50;
const COMPACT_THRESHOLD = 32;   // turns
const COMPACT_KEEP = 14;        // turns to keep after compaction

// Returns true if `msg` is a user message whose content is a tool_result (or contains one).
function _isToolResultUser(msg) {
  return msg && msg.role === 'user' && Array.isArray(msg.content)
    && msg.content.some(b => b && b.type === 'tool_result');
}
// Returns true if `msg` is an assistant message with any tool_use block.
function _hasToolUse(msg) {
  return msg && msg.role === 'assistant' && Array.isArray(msg.content)
    && msg.content.some(b => b && b.type === 'tool_use');
}
// Scan from `start` forward, return first index that is safe to cut at — i.e. the
// tool_use/tool_result pair there is complete. Guarantees we never orphan a
// tool_result by putting it at the head of kept history.
function _safeKeepStart(history, start) {
  let i = Math.max(0, start);
  while (i < history.length) {
    if (_isToolResultUser(history[i])) { i++; continue; }        // orphan tool_result
    if (_hasToolUse(history[i]) && (i + 1 >= history.length || !_isToolResultUser(history[i + 1]))) {
      // tool_use with no following tool_result — also unsafe to keep at boundary
      i++; continue;
    }
    return i;
  }
  return history.length;
}
// Strip leading orphan tool_result blocks (repair existing sessions).
function _healHistory(history) {
  while (history.length && _isToolResultUser(history[0])) history.shift();
  // Also drop a trailing dangling assistant(tool_use) with no matching tool_result after it.
  while (history.length && _hasToolUse(history[history.length - 1])) history.pop();
  return history;
}
// After a splice/compaction, walk the kept history and drop any user message
// whose only content is tool_result blocks that don't match a tool_use id in
// the immediately preceding assistant message. Otherwise Anthropic rejects the
// next turn with "tool_use_id not found".
function _validateToolPairs(history) {
  const kept = [];
  for (let i = 0; i < history.length; i++) {
    const m = history[i];
    if (!_isToolResultUser(m)) { kept.push(m); continue; }
    const prev = kept[kept.length - 1];
    if (!prev || prev.role !== 'assistant' || !Array.isArray(prev.content)) {
      console.warn(`[agent] dropping orphan tool_result at history[${i}] (no preceding assistant tool_use)`);
      continue;
    }
    const toolUseIds = new Set(prev.content.filter(b => b && b.type === 'tool_use').map(b => b.id));
    const resultIds = m.content.filter(b => b && b.type === 'tool_result').map(b => b.tool_use_id);
    const allMatch = resultIds.length && resultIds.every(id => toolUseIds.has(id));
    if (!allMatch) {
      console.warn(`[agent] dropping tool_result user-message at history[${i}] — tool_use ids ${resultIds.join(',')} not in preceding assistant`);
      continue;
    }
    kept.push(m);
  }
  return kept;
}

function readIfExists(p) { return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : ''; }

function loadContextFiles(dir, text) {
  if (!fs.existsSync(dir)) return [];
  const t = String(text).toLowerCase();
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.md')) continue;
    const raw = fs.readFileSync(path.join(dir, f), 'utf8');
    const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
    let triggers = [], body = raw;
    if (m) {
      body = m[2];
      for (const line of m[1].split('\n')) {
        const mm = line.match(/^triggers:\s*(.*)$/);
        if (mm) triggers = mm[1].split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
      }
    }
    if (!triggers.length || triggers.some(tr => t.includes(tr))) out.push(body);
  }
  return out;
}

class Agent {
  constructor({ credsLoc, config, memoryRoot, dataDir, hooks = [], queue = null, scheduler = null, buildUserMemory, onStream }) {
    this.credsLoc = credsLoc;
    this.config = config;
    this.memoryRoot = memoryRoot;
    this.dataDir = dataDir;
    this.hooks = hooks;
    this.queue = queue;
    this.scheduler = scheduler;
    this.buildUserMemory = buildUserMemory;
    this.onStream = onStream;
    this.metrics = new Metrics(path.join(dataDir, 'metrics.jsonl'));
    this.sessions = new Map(); // keyed by userId
    // Persona files are hot-reloaded: stat each turn, re-read only on mtime change.
    // Deletion is treated as empty content, no crash.
    this.personaFiles = {
      soul:    { path: path.join(dataDir, 'soul.md'),    content: '', mtime: 0 },
      overlay: { path: path.join(dataDir, 'overlay.md'), content: '', mtime: 0 },
      agents:  { path: path.join(dataDir, 'agents.md'),  content: '', mtime: 0 }
    };
    this._refreshPersonas();
    this.skillsDir = path.join(dataDir, 'skills');
    this.contextDir = path.join(dataDir, 'context');
    this.projectsDir = path.join(dataDir, 'projects');
    this.journalDir = path.join(dataDir, 'journal');
    this.sessionsLogDir = path.join(dataDir, 'sessions');
    fs.mkdirSync(this.sessionsLogDir, { recursive: true });
    fs.mkdirSync(this.journalDir, { recursive: true });
  }

  session(userId) {
    const key = String(userId || 'default');
    if (!this.sessions.has(key)) {
      this.sessions.set(key, {
        userId: key,
        history: [],
        model: this.config.model.primary,
        profile: 'coding',
        think: false,
        thinkBudget: 4000,
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, turns: 0 }
      });
    }
    return this.sessions.get(key);
  }

  reset(userId) { this.sessions.delete(String(userId || 'default')); }
  stop(userId) {
    const s = this.sessions.get(String(userId || 'default'));
    if (!s) return { stopped: false };
    s.stop = true;
    // Kill any in-flight child process (claude_code, bash_exec, fork_task subagent).
    if (s.activeProc) {
      try { s.activeProc.kill('SIGTERM'); } catch {}
      // SIGKILL after 2s if still alive
      setTimeout(() => { try { if (s.activeProc && !s.activeProc.killed) s.activeProc.kill('SIGKILL'); } catch {} }, 2000);
    }
    // Abort any in-flight API request.
    if (s.activeReq) { try { s.activeReq.destroy(new Error('stopped by user')); } catch {} }
    return { stopped: true, killed: !!(s.activeProc || s.activeReq) };
  }

  setModel(userId, model) { this.session(userId).model = model; }
  setProfile(userId, profile) { if (PROFILES[profile]) this.session(userId).profile = profile; return !!PROFILES[profile]; }
  setThink(userId, on, budget) {
    const s = this.session(userId);
    s.think = !!on;
    if (budget) s.thinkBudget = budget;
  }

  _recentJournal(days = 2, maxChars = 4500) {
    const chunks = [];
    for (let i = 0; i < days; i++) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const day = d.toISOString().slice(0, 10);
      const f = path.join(this.journalDir, `${day}.md`);
      if (!fs.existsSync(f)) continue;
      const raw = fs.readFileSync(f, 'utf8').slice(-2500);
      chunks.push(`## ${day}\n${raw}`);
    }
    return chunks.join('\n\n').slice(-maxChars);
  }

  _refreshPersonas() {
    for (const slot of Object.values(this.personaFiles)) {
      try {
        const st = fs.statSync(slot.path);
        if (st.mtimeMs > slot.mtime) {
          slot.content = fs.readFileSync(slot.path, 'utf8');
          slot.mtime = st.mtimeMs;
        }
      } catch {
        // Missing file: treat as empty. Next time it reappears, mtime jump re-reads.
        if (slot.mtime !== 0) { slot.content = ''; slot.mtime = 0; }
      }
    }
  }

  _systemBlocks(userId, userText) {
    this._refreshPersonas();
    const mem = this.buildUserMemory ? this.buildUserMemory(userId) : null;
    const index = mem ? mem.indexText() : '';
    const skills = matchSkills(loadSkills(this.skillsDir), userText);
    const ctxFiles = loadContextFiles(this.contextDir, userText);
    const projectFiles = loadContextFiles(this.projectsDir, userText);
    const recent = this._recentJournal();

    const parts = [];
    const soul = this.personaFiles.soul.content;
    const overlay = this.personaFiles.overlay.content;
    const agentsMd = this.personaFiles.agents.content;
    if (soul)    parts.push({ text: soul,    cache: 'prelude' });
    if (overlay) parts.push({ text: overlay, cache: 'prelude' });
    if (agentsMd)parts.push({ text: agentsMd,cache: 'prelude' });
    try {
      const caps = buildCapabilitiesText({ cfg: this.config, dataDir: this.dataDir, hooks: this.hooks, scheduler: this.scheduler, queue: this.queue });
      parts.push({ text: caps, cache: 'prelude' });
    } catch {}
    if (index) parts.push({ text: '# Memory Index (lazy-load details via notes_load)\n\n' + index, cache: 'short' });
    for (const s of skills) parts.push({ text: `# Skill: ${s.name}\n\n${s.body}`, cache: 'short' });
    for (const c of ctxFiles) parts.push({ text: c, cache: 'short' });
    for (const p of projectFiles) parts.push({ text: `# Project dossier\n\n${p}`, cache: 'short' });
    if (recent) parts.push({ text: `# Recent journal (last 2 days — what we've been talking about)\n\n${recent}`, cache: 'none' });
    return buildSystem(parts);
  }

  async compactNow(userId) {
    const sess = this.session(userId);
    const before = sess.history.length;
    await this._compact(sess, { force: true });
    return { before, after: sess.history.length };
  }

  async _compact(sess, { force = false } = {}) {
    if (!force && sess.history.length < COMPACT_THRESHOLD) return;
    if (sess.history.length < 4) return;
    // Find a boundary that doesn't orphan tool_result/tool_use pairs.
    const rawCut = sess.history.length - COMPACT_KEEP;
    const cut = _safeKeepStart(sess.history, rawCut);
    const drop = sess.history.slice(0, cut);
    try {
      const resp = await createMessage(this.credsLoc, {
        model: 'claude-haiku-4-5-20251001',
        maxTokens: 1024,
        system: [{ type: 'text', text: 'Summarize the conversation below in <=200 words capturing facts, decisions, and open questions. Output plain text only.' }],
        messages: [{ role: 'user', content: JSON.stringify(drop).slice(0, 40000) }]
      });
      const summary = (resp.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
      const kept = sess.history.slice(cut);
      sess.history = _validateToolPairs(_healHistory([
        { role: 'user', content: `[Prior conversation summary]\n${summary}` },
        { role: 'assistant', content: 'Acknowledged. Continuing.' },
        ...kept
      ]));
      if (this.buildUserMemory) {
        const mem = this.buildUserMemory(sess.userId);
        mem.write(`session_summary_${Date.now()}`, { type: 'project', description: 'Compacted session summary', body: summary, name: 'session_summary' });
      }
    } catch (e) {
      console.error(`[agent] compaction failed: ${e.message}`);
    }
  }

  _logTurn(userId, entry) {
    const f = path.join(this.sessionsLogDir, `${new Date().toISOString().slice(0, 10)}.jsonl`);
    try { fs.appendFileSync(f, JSON.stringify({ ts: Date.now(), userId, ...entry }) + '\n', 'utf8'); }
    catch (e) { console.error(`[agent] log: ${e.message}`); }
  }

  async respond(userText, { userId, chatId, images = [], requestApproval, spawnSubagent, isTrusted, bgTasks, sendAlert, onStream, onLiveProgress } = {}) {
    const sess = this.session(userId);
    const mem = this.buildUserMemory ? this.buildUserMemory(userId) : null;
    const hookCtx = { userId, chatId, userText, session: sess, memory: mem };
    await runHook(this.hooks, 'preMessage', hookCtx);

    // Budget enforcement: if cfg.tools.userDailyBudgetUsd is set, check today's
    // spend from metrics.jsonl before proceeding. Hard-block if exceeded.
    const budgetCap = this.config.tools?.userDailyBudgetUsd;
    if (budgetCap && typeof budgetCap === 'number' && budgetCap > 0) {
      try {
        const { summarize } = require('./metrics');
        const dayStart = new Date(); dayStart.setUTCHours(0, 0, 0, 0);
        const today = this.metrics.readSince(Date.now() - dayStart.getTime())
          .filter(e => String(e.userId) === String(userId));
        const s = summarize(today);
        if (s) {
          const spent = estimateCost(s);
          if (spent >= budgetCap) {
            return `💸 daily budget exceeded: spent $${spent.toFixed(4)} of $${budgetCap.toFixed(2)}. resets at UTC midnight. use /budget to check.`;
          }
        }
      } catch (e) { console.error(`[budget] check: ${e.message}`); }
    }

    // Heal any orphan tool_result at history head or dangling tool_use at tail —
    // can happen after (turn limit reached) or an API error mid-chain.
    sess.history = _healHistory(sess.history);

    if (images.length) {
      const blocks = [];
      const caption = userText && userText.trim() ? userText : '(image)';
      blocks.push({ type: 'text', text: caption });
      for (const img of images) {
        blocks.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } });
      }
      sess.history.push({ role: 'user', content: blocks });
    } else {
      sess.history.push({ role: 'user', content: userText });
    }
    await this._compact(sess);

    const tools = buildTools(this.config, mem, path.join(this.dataDir, 'workspace'), {
      profile: sess.profile,
      requestApproval,
      spawnSubagent,
      isTrusted,
      bgTasks,
      chatId,
      userId,
      session: sess,
      skillsDir: this.skillsDir,
      journalDir: this.journalDir,
      onProgress: onLiveProgress || null
    });

    let finalText = '';
    const perTurnToolNames = {};
    let turnTokensIn = 0, turnTokensOut = 0, turnCacheRead = 0, turnCacheCreate = 0;
    const tStart = Date.now();
    let totalToolCalls = 0;
    let hadApiError = false;
    let hadToolError = false;
    sess.busy = true;
    sess.busyStart = tStart;
    sess.currentTurn = 0;
    sess.currentTool = null;
    sess.currentToolStart = 0;
    // Track consecutive errors so we can surface to the user if stuck in a retry loop.
    let consecutiveErrors = 0;
    let lastErrorMsg = '';
    let erroredOnce = false;
    try {
      for (let turn = 0; turn < MAX_TURNS; turn++) {
        sess.currentTurn = turn + 1;
        if (sess.stop) { sess.stop = false; finalText = '(stopped by user)'; break; }
        const system = this._systemBlocks(userId, userText);
        const reqBody = {
          model: sess.model,
          maxTokens: this.config.model.maxTokens,
          system,
          messages: sess.history,
          tools: tools.defs
        };
        // Auto-thinking for research profile: budget scales with prompt length.
        // Explicit /think on still wins over profile defaults.
        let thinkOn = sess.think;
        let thinkBudget = sess.thinkBudget;
        if (!thinkOn && sess.profile === 'research') {
          const ut = String(userText || '');
          if (ut.length > 80) {
            thinkOn = true;
            // Scale budget: floor 2000, ceiling 8000; ~25 tokens per user character.
            thinkBudget = Math.max(2000, Math.min(8000, Math.floor(ut.length * 25)));
          }
        }
        if (thinkOn) {
          // API rejects budget_tokens >= max_tokens. Keep headroom for output.
          const cap = Math.max(1500, (this.config.model.maxTokens || 8192) - 500);
          reqBody.thinking = { type: 'enabled', budget_tokens: Math.min(thinkBudget, cap) };
        }

        let resp;
        try {
          resp = onStream
            ? await streamMessage(this.credsLoc, reqBody, onStream)
            : await createMessage(this.credsLoc, reqBody);
        }
        catch (e) {
          this._logTurn(userId, { type: 'api_error', error: e.message });
          hadApiError = true;
          sess.busy = false;
          sess.currentTool = null;
          // Heal rather than blind-pop: popping only the last message can leave
          // orphan tool_result / tool_use blocks if the error hit mid-chain.
          sess.history = _healHistory(sess.history);
          finalText = `(API error: ${e.message.slice(0, 300)})`;
          break;
        }

        // Capture usage from this API call (#5 cache telemetry).
        if (resp.usage) {
          turnTokensIn += resp.usage.input_tokens || 0;
          turnTokensOut += resp.usage.output_tokens || 0;
          turnCacheRead += resp.usage.cache_read_input_tokens || 0;
          turnCacheCreate += resp.usage.cache_creation_input_tokens || 0;
        }

        // Strip any internal fields (e.g. _inputJson from partial stream assembly)
        // before persisting to history — Anthropic rejects unknown fields on next turn.
        const cleanContent = (resp.content || []).map(b => {
          if (!b || !b._inputJson) return b;
          const c = { ...b };
          delete c._inputJson;
          return c;
        });
        sess.history.push({ role: 'assistant', content: cleanContent });
        const toolUses = resp.content.filter(b => b.type === 'tool_use');
        dbg(`[agent] turn=${turn} blocks=${resp.content.length} toolUses=${toolUses.length} types=${resp.content.map(b => b.type).join(',')}`);

        if (!toolUses.length) {
          finalText = resp.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim() || '(no response)';
          dbg(`[agent] finalText length=${finalText.length}`);
          break;
        }

        const toolResults = [];
        for (const tu of toolUses) {
          const hCtx = { name: tu.name, input: tu.input || {}, userId, chatId };
          console.log(`${new Date().toTimeString().slice(0, 8)} [tool] ${tu.name} ${JSON.stringify(tu.input).slice(0, 120).replace(/\n/g, ' ')}`);
          sess.currentTool = tu.name;
          sess.currentToolStart = Date.now();
          await runHook(this.hooks, 'preTool', hCtx);
          const handler = tools.handlers[tu.name];
          let result, isError = false;
          const tTool = Date.now();
          try { result = handler ? await handler(hCtx.input) : `(unknown tool ${tu.name})`; }
          catch (e) { result = `error: ${e.message}`; isError = true; }
          const toolMs = Date.now() - tTool;
          sess.currentTool = null;
          console.log(`${new Date().toTimeString().slice(0, 8)} [tool] ${tu.name} done (${toolMs}ms)${isError ? ' ERR' : ''}`);
          // Track consecutive errors so we can auto-surface to the user if stuck.
          if (isError) {
            consecutiveErrors++;
            erroredOnce = true;
            hadToolError = true;
            lastErrorMsg = `${tu.name}: ${String(result).slice(0, 200)}`;
            if (consecutiveErrors >= 3 && sendAlert) {
              const assistantName = this.config?.persona?.name || 'the assistant';
              sendAlert(`⚠️ ${assistantName} is hitting repeated tool errors (${consecutiveErrors}×). last: \`${tu.name}\`\n\n${String(result).slice(0, 400)}\n\nmay be stuck. consider \`/stop\` if this looks like a loop.`).catch(() => {});
              consecutiveErrors = 0;
            }
          } else {
            consecutiveErrors = 0;
          }
          await runHook(this.hooks, 'postTool', { ...hCtx, result, isError });
          // #1 tool-result capture: log the input AND a truncated result so /audit works.
          const resultStr = typeof result === 'string' ? result : JSON.stringify(result);
          const loggedResult = truncate(resultStr, TRUNCATION_LIMITS.tool_result_log);
          this._logTurn(userId, { type: 'tool', name: tu.name, input: tu.input, result: loggedResult, resultBytes: resultStr.length, isError, ms: toolMs });
          perTurnToolNames[tu.name] = (perTurnToolNames[tu.name] || 0) + 1;
          totalToolCalls += 1;
          toolResults.push({
            type: 'tool_result',
            tool_use_id: tu.id,
            content: typeof result === 'string' ? result : JSON.stringify(result).slice(0, 100_000),
            ...(isError ? { is_error: true } : {})
          });
        }
        sess.history.push({ role: 'user', content: toolResults });
      }
      if (!finalText) {
        finalText = erroredOnce
          ? `(turn limit reached) last error was: ${lastErrorMsg || 'unknown'}`
          : '(turn limit reached)';
      }
    } catch (e) {
      finalText = `(error: ${e.message})`;
    }

    const latencyMs = Date.now() - tStart;
    sess.busy = false;
    sess.currentTool = null;
    dbg(`[agent] respond: exiting loop, finalText=${finalText.length}ch ${latencyMs}ms`);

    // Background learning pass — detect if this was a correction, auto-save
    // as feedback memory. Runs detached; never blocks the reply.
    // Skip if the user is over daily budget: auto-learn triggers a Haiku call
    // that otherwise bypasses `cfg.tools.userDailyBudgetUsd`.
    let learnAllowed = true;
    if (budgetCap && typeof budgetCap === 'number' && budgetCap > 0) {
      try {
        const { summarize } = require('./metrics');
        const dayStart = new Date(); dayStart.setUTCHours(0, 0, 0, 0);
        const today = this.metrics.readSince(Date.now() - dayStart.getTime())
          .filter(e => String(e.userId) === String(userId));
        const s = summarize(today);
        if (s && estimateCost(s) >= budgetCap) learnAllowed = false;
      } catch {}
    }
    if (mem && userText && learnAllowed) {
      const priorAssistant = (() => {
        // Find the last assistant message before this user turn for context.
        for (let i = sess.history.length - 2; i >= 0; i--) {
          const m = sess.history[i];
          if (m.role === 'assistant' && typeof m.content === 'string') return m.content;
          if (m.role === 'assistant' && Array.isArray(m.content)) {
            const txt = m.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
            if (txt) return txt;
          }
        }
        return '';
      })();
      (async () => {
        try { await maybeLearnFromCorrection({ credsLoc: this.credsLoc, memory: mem, userText, priorAssistantReply: priorAssistant }); }
        catch (e) { console.error(`[learn] bg: ${e.message}`); }
      })();
    }

    // Skill auto-synthesis — detached, fire-and-forget. Same budget gate as
    // auto-learn: skip if user is over daily budget.
    const autoSynthesize = this.config.skills?.autoSynthesize !== false;
    const elig = checkEligible({
      totalToolCalls,
      hadApiError,
      hadToolError,
      userText,
      autoSynthesize
    });
    if (elig.eligible && learnAllowed) {
      const historySnapshot = sess.history.slice(-40); // cap context
      const credsLoc = this.credsLoc;
      const skillsDir = this.skillsDir;
      const notify = sendAlert || null;
      (async () => {
        try {
          const r = await synthesize({ credsLoc, skillsDir, history: historySnapshot, notifyUser: notify });
          if (r.wrote) console.log(`[synth] wrote skill: ${r.name}`);
          else if (r.reason !== 'not useful' && r.reason !== 'already exists') console.log(`[synth] skipped: ${r.reason}`);
        } catch (e) { console.error(`[synth] bg: ${e.message}`); }
      })();
    }

    await runHook(this.hooks, 'postMessage', { ...hookCtx, reply: finalText });
    this._logTurn(userId, { type: 'reply', chars: finalText.length, model: sess.model, profile: sess.profile, latencyMs });
    // Accumulate onto the session for /status display (#5 cache telemetry).
    sess.usage.inputTokens += turnTokensIn;
    sess.usage.outputTokens += turnTokensOut;
    sess.usage.cacheReadTokens += turnCacheRead;
    sess.usage.cacheCreationTokens += turnCacheCreate;
    sess.usage.turns += 1;
    // Emit one metric entry per user turn (#2).
    this.metrics.append({
      userId: String(userId || 'default'),
      model: sess.model,
      profile: sess.profile,
      latencyMs,
      toolCount: totalToolCalls,
      toolNames: perTurnToolNames,
      turns: 1,
      replyChars: finalText.length,
      imageCount: images.length,
      inputTokens: turnTokensIn,
      outputTokens: turnTokensOut,
      cacheReadTokens: turnCacheRead,
      cacheCreationTokens: turnCacheCreate,
      cacheHitRatio: (turnTokensIn + turnCacheRead) > 0 ? Number((turnCacheRead / (turnTokensIn + turnCacheRead)).toFixed(3)) : 0,
      isError: hadApiError
    });
    dbg(`[agent] respond: logged, returning`);
    const journalText = userText && userText.trim() ? userText : (images.length ? `(image ×${images.length})` : '');
    this._appendJournal(userId, journalText, finalText);
    return finalText;
  }

  _appendJournal(userId, userText, reply) {
    try {
      const day = new Date().toISOString().slice(0, 10);
      const f = path.join(this.journalDir, `${day}.md`);
      const t = new Date().toTimeString().slice(0, 5);
      const userLabel = this.config.persona?.userLabel || 'You';
      const assistantLabel = this.config.persona?.assistantLabel || 'Assistant';
      const line = `\n## ${t} — ${String(userId)}\n**${userLabel}:** ${userText.slice(0, 300).replace(/\n/g, ' ')}\n**${assistantLabel}:** ${reply.slice(0, 400).replace(/\n/g, ' ')}\n`;
      fs.appendFileSync(f, line, 'utf8');
    } catch (e) { console.error(`[agent] journal: ${e.message}`); }
  }
}

module.exports = { Agent };
