'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { execFile, spawn } = require('child_process');
const { writeSkill } = require('./skills');
const { scrubMessage } = require('./errors');

const PROFILES = {
  chat: { memory: true, fileEdit: false, urlFetch: false, bash: false, subagent: false, skillWrite: true, claudeCode: false },
  coding: { memory: true, fileEdit: true, urlFetch: true, bash: true, subagent: true, skillWrite: true, claudeCode: true },
  research: { memory: true, fileEdit: true, urlFetch: true, bash: false, subagent: true, skillWrite: true, claudeCode: false }
};

// Single source of truth for how much text each tool may return.
// Keeps session logs, session JSONL, and context size predictable.
const TRUNCATION_LIMITS = {
  bash_stdout:     8 * 1024,
  bash_stderr:     4 * 1024,
  url_fetch:      40 * 1024,
  claude_code:    12 * 1024,
  claude_code_stderr: 2 * 1024,
  claude_code_diff:   6 * 1024,
  doc_read:       32 * 1024,
  notes_load:     64 * 1024,
  fork_task:      20 * 1024,
  journal_read:   20 * 1024,
  tool_result_log: 4 * 1024
};

function truncate(str, limit) {
  const s = String(str ?? '');
  return s.length <= limit ? s : s.slice(0, limit) + `\n[truncated ${s.length - limit} bytes, cap=${limit}]`;
}

function httpGet(url, { maxBytes = 200_000, timeoutMs = 15_000, followRedirects = true } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let guard;
    const finish = (fn, val) => { if (!settled) { settled = true; clearTimeout(guard); fn(val); } };
    let u;
    try { u = new URL(url); } catch { return finish(reject, new Error(`bad url: ${url}`)); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return finish(reject, new Error('only http/https'));
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.get(url, { headers: { 'user-agent': 'claudefish/0.1' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const nextUrl = new URL(res.headers.location, url).href;
        if (!followRedirects) {
          return finish(resolve, { status: res.statusCode, headers: res.headers, body: '', redirect: nextUrl });
        }
        return finish(resolve, httpGet(nextUrl, { maxBytes, timeoutMs, followRedirects }));
      }
      const chunks = []; let total = 0;
      res.on('data', c => {
        total += c.length;
        if (total > maxBytes) {
          const keep = c.length - (total - maxBytes);
          if (keep > 0) chunks.push(c.slice(0, keep));
          try { res.destroy(); } catch {}
          try { req.destroy(); } catch {}
          finish(resolve, { status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') + `\n[TRUNCATED at ${maxBytes} bytes]` });
        } else {
          chunks.push(c);
        }
      });
      res.on('end', () => finish(resolve, { status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', e => finish(reject, e));
    });
    req.setTimeout(timeoutMs, () => { try { req.destroy(new Error('timeout')); } catch {} finish(reject, new Error(`httpGet timeout ${timeoutMs}ms`)); });
    req.on('error', e => finish(reject, e));
    guard = setTimeout(() => { try { req.destroy(new Error('wall-clock')); } catch {} finish(reject, new Error(`httpGet wall-clock ${timeoutMs * 2}ms`)); }, timeoutMs * 2);
  });
}

function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function buildTools(cfg, memory, workspaceDir, extras = {}) {
  const { profile = 'coding', requestApproval, spawnSubagent, skillsDir, isTrusted, session } = extras;
  const p = PROFILES[profile] || PROFILES.coding;
  const defs = [];
  const handlers = {};

  if (p.memory) {
    defs.push({
      name: 'notes_find',
      description: 'Search durable notes by keyword. Returns matching keys, types, and snippets.',
      input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }
    });
    handlers.notes_find = ({ query }) => memory.search(query);

    defs.push({
      name: 'notes_load',
      description: 'Fetch a specific note by key.',
      input_schema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] }
    });
    handlers.notes_load = ({ key }) => {
      const v = memory.get(key);
      if (v == null) return `(no note at "${key}")`;
      return truncate(v, TRUNCATION_LIMITS.notes_load);
    };

    defs.push({
      name: 'notes_save',
      description: 'Save a durable note. You MUST classify with type: "user" (facts about the user), "feedback" (corrections/preferences from the user), "project" (ongoing work context, decays after 60d unless refreshed), or "reference" (pointers to external systems). Include a one-line description so the index is scannable.',
      input_schema: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'short slug used as filename' },
          type: { type: 'string', enum: ['user', 'feedback', 'project', 'reference'], description: 'REQUIRED — pick deliberately; miscategorized notes decay wrong.' },
          description: { type: 'string', description: 'one-line summary for the index' },
          body: { type: 'string', description: 'the note content' }
        },
        required: ['key', 'type', 'description', 'body']
      }
    });
    handlers.notes_save = ({ key, type, description, body }) => {
      if (!type || !['user', 'feedback', 'project', 'reference'].includes(type)) {
        return { error: 'notes_save requires `type` ∈ {user, feedback, project, reference}. Pick deliberately — type controls decay and recall.' };
      }
      if (!description || !description.trim()) {
        return { error: 'notes_save requires `description` — one line, used in the MEMORY.md index.' };
      }
      const t = type;
      // Lazy contradiction check: only surface candidates for types where
      // contradictions matter (user/feedback). Haiku judgement is wired in
      // Agent layer; here we just attach the candidates.
      const conflicts = (t === 'user' || t === 'feedback')
        ? memory.findOverlapping(key, body, { minOverlap: 0.35, limit: 3 })
        : [];
      const result = memory.write(key, { type: t, description: description.trim(), body, name: key });
      if (conflicts.length) {
        // Imperative key name: Claude reads tool_result JSON literally; self-describing
        // field makes reconciliation behaviour survive prompt edits.
        result.conflicts_needs_reconciliation = conflicts;
      }
      return result;
    };

    defs.push({
      name: 'notes_delete',
      description: 'Remove a note by key.',
      input_schema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] }
    });
    handlers.notes_delete = ({ key }) => ({ deleted: memory.delete(key) });
  }

  if (p.fileEdit) {
    const wsRoot = path.resolve(workspaceDir);
    // Normalize: strip leading 'data/workspace/' if present, so Claude passing
    // an absolute-looking path doesn't cause double-nesting.
    const normPath = rel => {
      let r = String(rel || '').trim();
      r = r.replace(/^\/+/, '');                        // absolute → relative
      r = r.replace(/^data\/workspace\/+/i, '');        // strip common prefix
      r = r.replace(/^\.\/+/, '');                      // strip leading ./
      return r;
    };
    const safe = rel => {
      const abs = path.resolve(wsRoot, normPath(rel));
      if (!abs.startsWith(wsRoot)) throw new Error('path escapes workspace');
      return abs;
    };
    defs.push({
      name: 'doc_read',
      description: `Read a file from the workspace. Returns up to ${TRUNCATION_LIMITS.doc_read} bytes per call. Use offset to paginate larger files.`,
      input_schema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          offset: { type: 'number', description: 'byte offset to start reading from (default 0)' }
        },
        required: ['path']
      }
    });
    handlers.doc_read = ({ path: rel, offset = 0 }) => {
      const abs = safe(rel);
      if (!fs.existsSync(abs)) return `(no file at ${rel})`;
      const raw = fs.readFileSync(abs, 'utf8');
      const start = Math.max(0, Math.floor(offset) || 0);
      const chunk = raw.slice(start, start + TRUNCATION_LIMITS.doc_read);
      const more = raw.length > start + chunk.length;
      return chunk + (more ? `\n[truncated at ${TRUNCATION_LIMITS.doc_read} bytes; file is ${raw.length}B total. Call again with offset=${start + chunk.length}]` : '');
    };
    defs.push({
      name: 'doc_write',
      description: 'Write a file in the workspace directory. Overwrites.',
      input_schema: {
        type: 'object',
        properties: { path: { type: 'string' }, content: { type: 'string' } },
        required: ['path', 'content']
      }
    });
    handlers.doc_write = async ({ path: rel, content }) => {
      if (requestApproval) {
        const ok = await requestApproval('doc_write', { path: rel, bytes: Buffer.byteLength(content) });
        if (!ok) return 'denied by user';
      }
      const abs = safe(rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content, 'utf8');
      return { path: rel, bytes: Buffer.byteLength(content) };
    };
    defs.push({
      name: 'doc_list',
      description: 'List files in the workspace.',
      input_schema: { type: 'object', properties: { dir: { type: 'string' } } }
    });
    handlers.doc_list = ({ dir = '' } = {}) => {
      const abs = safe(dir);
      if (!fs.existsSync(abs)) return [];
      return fs.readdirSync(abs, { withFileTypes: true }).map(d => ({ name: d.name, dir: d.isDirectory() }));
    };
  }

  if (p.urlFetch) {
    defs.push({
      name: 'url_fetch',
      description: 'Fetch a URL and return text content (HTML stripped). Max 200KB.',
      input_schema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] }
    });
    handlers.url_fetch = async ({ url }) => {
      // Walk redirects one hop at a time so scope gets re-checked on each host change.
      let current = url;
      let lastStatus = 0, lastHeaders = {};
      const visited = new Set();
      for (let hop = 0; hop < 5; hop++) {
        if (visited.has(current)) return { error: `redirect loop at ${current}` };
        visited.add(current);
        // Re-scope on every hop beyond the first. Initial call was already approved upstream.
        if (hop > 0 && requestApproval) {
          const ok = await requestApproval('url_fetch', { url: current, redirect: true });
          if (!ok) return { status: lastStatus, text: '', deniedRedirectTo: current };
        }
        const r = await httpGet(current, { followRedirects: false });
        lastStatus = r.status; lastHeaders = r.headers || {};
        if (r.redirect) { current = r.redirect; continue; }
        const isHtml = (lastHeaders['content-type'] || '').includes('html');
        return {
          status: r.status,
          finalUrl: current,
          text: truncate(isHtml ? htmlToText(r.body) : r.body, TRUNCATION_LIMITS.url_fetch)
        };
      }
      return { error: 'too many redirects', finalUrl: current, status: lastStatus };
    };
  }

  if (p.bash) {
    defs.push({
      name: 'bash_exec',
      description: 'Run a shell command in the workspace directory. Requires user approval.',
      input_schema: {
        type: 'object',
        properties: { cmd: { type: 'string' }, timeoutMs: { type: 'number' } },
        required: ['cmd']
      }
    });
    handlers.bash_exec = async ({ cmd, timeoutMs = 30000 }) => {
      if (requestApproval) {
        const ok = await requestApproval('bash_exec', { cmd });
        if (!ok) return 'denied by user';
      }
      return new Promise(resolve => {
        const proc = execFile('bash', ['-lc', cmd], { cwd: workspaceDir, timeout: timeoutMs, maxBuffer: 500_000 }, (err, stdout, stderr) => {
          if (session) session.activeProc = null;
          resolve({ code: err?.code ?? 0, stdout: truncate(stdout.toString(), TRUNCATION_LIMITS.bash_stdout), stderr: truncate(stderr.toString(), TRUNCATION_LIMITS.bash_stderr) });
        });
        if (session) session.activeProc = proc;
      });
    };
  }

  if (p.subagent && spawnSubagent) {
    defs.push({
      name: 'fork_task',
      description: 'Spawn an isolated subagent with its own context to handle a research or analysis task. Returns only a summary.',
      input_schema: {
        type: 'object',
        properties: { task: { type: 'string' }, context: { type: 'string' } },
        required: ['task']
      }
    });
    handlers.fork_task = async ({ task, context }) => {
      const out = await spawnSubagent({ task, context });
      return typeof out === 'string' ? truncate(out, TRUNCATION_LIMITS.fork_task) : out;
    };
  }

  if (p.memory && extras.journalDir) {
    defs.push({
      name: 'journal_read',
      description: 'Read the journal (one-line-per-turn log) for a specific day. Use to recall what was discussed previously.',
      input_schema: { type: 'object', properties: { date: { type: 'string', description: 'YYYY-MM-DD, or "today" or "yesterday"' } } }
    });
    handlers.journal_read = ({ date = 'today' } = {}) => {
      const d = new Date();
      if (date === 'yesterday') d.setDate(d.getDate() - 1);
      const day = /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : d.toISOString().slice(0, 10);
      const f = path.join(extras.journalDir, `${day}.md`);
      return fs.existsSync(f) ? truncate(fs.readFileSync(f, 'utf8'), TRUNCATION_LIMITS.journal_read) : `(no journal for ${day})`;
    };
  }

  if (p.claudeCode && workspaceDir) {
    const projectsRoot = path.join(workspaceDir, 'projects');
    fs.mkdirSync(projectsRoot, { recursive: true });
    const slugify = s => String(s).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);

    defs.push({
      name: 'claude_code',
      description: 'Delegate a real coding task to Claude Code CLI inside data/workspace/projects/<project>. Modes: read (no edits) | write (edits allowed, approval-gated) | pr (edits on a new branch + gh draft PR; requires gh CLI authed). Use for fixing bugs, writing features, inspecting code.',
      input_schema: {
        type: 'object',
        properties: {
          project: { type: 'string', description: 'Project slug (matches data/workspace/projects/<slug>/)' },
          task: { type: 'string', description: 'Concrete task for Claude Code to carry out. Quote the user verbatim when possible — do not paraphrase.' },
          mode: { type: 'string', enum: ['read', 'write', 'pr'], description: 'read | write | pr' },
          continueSession: { type: 'boolean', description: 'Resume the previous Claude Code session in this project (continues where last call left off). Default true if a session exists for this project, false for first-touch.' },
          background: { type: 'boolean', description: 'return a task ID immediately; deliver result via DeliveryQueue when done' },
          timeoutMs: { type: 'number', description: 'Optional max duration, default 600000 (10min)' }
        },
        required: ['project', 'task']
      }
    });

    // Preflight: verify `claude` CLI has creds available. Checks the keychain
     // entry Claude Code writes on /login. Returns {ok, reason} fast (~20ms)
     // so we don't waste 16s on a subprocess that'll just say "Not logged in".
     const checkClaudeAuth = () => {
       try {
         const { execFileSync } = require('child_process');
         execFileSync('security', ['find-generic-password', '-s', 'Claude Code-credentials'], { stdio: 'ignore', timeout: 2000 });
         return { ok: true };
       } catch {
         return { ok: false, reason: 'Claude Code CLI is not logged in. Open a terminal and run `claude` then `/login` (or `claude /login` directly).' };
       }
     };

    const runClaudeCodeOnce = (cwd, task, permMode, timeoutMs, { continueSession = false } = {}) => new Promise(resolve => {
      const auth = checkClaudeAuth();
      if (!auth.ok) return resolve({ error: auth.reason, authIssue: true });
      // -c = continue last session in this cwd. Claude Code keeps per-directory
      // session state, so -c in the trafi project resumes the trafi session.
      const args = continueSession
        ? ['-c', '-p', task, '--permission-mode', permMode, '--output-format', 'text']
        : ['-p', task, '--permission-mode', permMode, '--output-format', 'text'];
      const gitDiffBefore = safeGitDiff(cwd);
      const proc = spawn('claude', args, { cwd, env: process.env });
      if (session) session.activeProc = proc;
      let out = '', err = '';
      const killer = setTimeout(() => { try { proc.kill('SIGTERM'); } catch {} }, timeoutMs);
      // Stream stdout/stderr to onProgress in real time, so the caller can surface
      // live output to Telegram instead of waiting for process close.
      proc.stdout.on('data', d => {
        const chunk = d.toString();
        out += chunk;
        if (extras.onProgress) { try { extras.onProgress({ kind: 'stdout', chunk, totalSoFar: out }); } catch {} }
      });
      proc.stderr.on('data', d => {
        const chunk = d.toString();
        err += chunk;
        if (extras.onProgress) { try { extras.onProgress({ kind: 'stderr', chunk, totalSoFar: err }); } catch {} }
      });
      proc.on('error', e => {
        clearTimeout(killer);
        if (session) session.activeProc = null;
        resolve({ error: `failed to spawn claude CLI: ${scrubMessage(e)}`, hint: 'is claude installed and on PATH?' });
      });
      proc.on('close', code => {
        clearTimeout(killer);
        if (session) session.activeProc = null;
        const gitDiffAfter = safeGitDiff(cwd);
        const diff = diffBetween(gitDiffBefore, gitDiffAfter);
        resolve({
          exitCode: code,
          output: truncate(out, TRUNCATION_LIMITS.claude_code),
          stderr: truncate(err, TRUNCATION_LIMITS.claude_code_stderr),
          diff: truncate(diff, TRUNCATION_LIMITS.claude_code_diff)
        });
      });
    });

    // Retry wrapper — Anthropic 529 (Overloaded) is transient; exponential backoff
     // 2s → 8s → 20s, max 3 attempts. Other errors pass through unchanged.
    const runClaudeCode = async (cwd, task, permMode, timeoutMs, opts = {}) => {
      const backoffs = [2000, 8000, 20000];
      for (let attempt = 0; attempt <= backoffs.length; attempt++) {
        const r = await runClaudeCodeOnce(cwd, task, permMode, timeoutMs, opts);
        if (r.authIssue) return r; // don't retry auth failures
        const outStr = `${r.output || ''} ${r.error || ''}`;
        if (/Not logged in|Please run \/login/i.test(outStr)) {
          return { ...r, error: 'Claude Code logged out — run `claude /login` in a terminal.', authIssue: true };
        }
        const overloaded = /529|overloaded_error|Overloaded/i.test(outStr);
        if (!overloaded || attempt === backoffs.length) return r;
        console.log(`[claude_code] 529 overloaded, retry ${attempt + 1}/${backoffs.length} after ${backoffs[attempt]}ms`);
        await new Promise(res => setTimeout(res, backoffs[attempt]));
      }
    };

    // DEFAULT OFF: two-phase plan→confirm adds 30-60s latency before real work.
     // Opt in with cfg.tools.twoPhaseClaudeCode: true or mode: 'pr' (always uses two-phase).
    const twoPhaseDefault = cfg.tools?.twoPhaseClaudeCode === true;

    const bgTasks = extras.bgTasks;          // shared BackgroundTasks instance
    const deliver = extras.deliverTaskResult; // (chatId, text) => void

    const doCodeTask = async (slug, cwd, task, mode, timeoutMs, continueSession = false) => {
      const opts = { continueSession };
      if (mode === 'read') {
        const r = await runClaudeCode(cwd, task, 'plan', timeoutMs, opts);
        if (session && !r.error) session.projectSessions = { ...(session.projectSessions || {}), [slug]: { lastRun: Date.now() } };
        return { ...r, mode: 'read', cwd: `data/workspace/projects/${slug}`, continued: continueSession };
      }
      if (mode === 'pr') {
        if (!fs.existsSync(path.join(cwd, '.git'))) {
          return { error: 'pr mode requires the project to be a git repo. `cd data/workspace/projects/' + slug + ' && git init` first.' };
        }
        const { execFileSync } = require('child_process');
        const gitOpts = { cwd, encoding: 'utf8', timeout: 10_000 };
        // Capture original branch so we can restore on any failure path.
        let originalBranch;
        try {
          originalBranch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], gitOpts).trim();
        } catch (e) { return { error: `couldn't read current branch: ${e.message.slice(0, 200)}` }; }
        // Refuse on dirty tree — never silently modify user state.
        try {
          const dirty = execFileSync('git', ['status', '--porcelain'], gitOpts).trim();
          if (dirty) {
            return {
              error: 'project has uncommitted changes; commit or stash them manually before `pr` mode',
              branch: originalBranch,
              dirty: dirty.slice(0, 600)
            };
          }
        } catch (e) { return { error: `couldn't check git status: ${e.message.slice(0, 200)}` }; }

        const branch = `claudefish/${Date.now()}`;
        const restore = () => { try { execFileSync('git', ['checkout', originalBranch], gitOpts); } catch {} };
        try {
          execFileSync('git', ['checkout', '-b', branch], gitOpts);
        } catch (e) { return { error: `failed to create branch: ${e.message.slice(0, 200)}` }; }

        const r = await runClaudeCode(cwd, task, 'acceptEdits', timeoutMs, opts);

        try {
          execFileSync('git', ['add', '-A'], gitOpts);
          execFileSync('git', ['commit', '-m', `claudefish: ${task.slice(0, 120)}`], { ...gitOpts, timeout: 15_000 });
        } catch (e) {
          restore();
          return { ...r, mode: 'pr', branch, prError: `no changes to commit or commit failed: ${scrubMessage(e).slice(0, 200)}` };
        }
        let prUrl = null;
        try {
          execFileSync('git', ['push', '-u', 'origin', branch], { ...gitOpts, timeout: 45_000 });
        } catch (e) {
          restore();
          return { ...r, mode: 'pr', branch, prError: `git push failed: ${scrubMessage(e).slice(0, 300)}`, hint: 'does `origin` remote exist and have push access?' };
        }
        try {
          const body = `Task: ${task}\n\nAuto-generated by claudefish.`;
          prUrl = execFileSync('gh', ['pr', 'create', '--draft', '--title', `claudefish: ${task.slice(0, 80)}`, '--body', body], { ...gitOpts, timeout: 45_000 }).trim();
        } catch (e) {
          restore();
          return { ...r, mode: 'pr', branch, pushed: true, prError: `gh pr create failed: ${scrubMessage(e).slice(0, 300)}`, hint: 'is `gh` installed and authed?' };
        }
        // Success: leave user on original branch so repeated runs branch cleanly off it.
        restore();
        return { ...r, mode: 'pr', branch, prUrl, cwd: `data/workspace/projects/${slug}` };
      }
      // write mode: acceptEdits
      const r = await runClaudeCode(cwd, task, 'acceptEdits', timeoutMs, opts);
      if (session && !r.error) session.projectSessions = { ...(session.projectSessions || {}), [slug]: { lastRun: Date.now() } };
      return { ...r, mode: 'write', cwd: `data/workspace/projects/${slug}`, continued: continueSession };
    };

    handlers.claude_code = async ({ project, task, mode = 'write', timeoutMs = 600_000, background = false, continueSession }) => {
      const slug = slugify(project);
      if (!slug) return { error: 'invalid project slug' };
      const cwd = path.join(projectsRoot, slug);
      // Auto-continue: if we've run claude_code in this project before during this
      // session, default to -c (resume). First-touch starts fresh.
      if (continueSession === undefined) {
        continueSession = !!(session && session.projectSessions && session.projectSessions[slug]);
      }
      if (!fs.existsSync(cwd)) {
        return {
          error: `no project called "${slug}" at data/workspace/projects/${slug}/`,
          hint: `copy it over (cp -r /path/to/project data/workspace/projects/${slug}) or give me a git url to clone`
        };
      }

      // Read mode — just plan, never writes.
      if (mode === 'read') {
        return doCodeTask(slug, cwd, task, 'read', timeoutMs, continueSession);
      }

      // Write / PR mode. Decide: single-phase (trusted) vs two-phase (first-touch/untrusted).
      const alreadyTrusted = typeof isTrusted === 'function' && isTrusted('claude_code', `project=${slug}`);
      const useTwoPhase = twoPhaseDefault && !alreadyTrusted && (mode === 'write' || mode === 'pr');

      const approvalDetails = { project: slug, cwd: `data/workspace/projects/${slug}`, task: task.slice(0, 400), mode };

      const runAfterApproval = async () => {
        if (useTwoPhase) {
          const plan = await runClaudeCode(cwd, task, 'plan', Math.min(timeoutMs, 180_000));
          if (plan.error) return plan;
          if (requestApproval) {
            const ok = await requestApproval('claude_code', { ...approvalDetails, phase: 'plan→confirm', plan: plan.output.slice(0, 1200) });
            if (!ok) return { denied: true, plan: plan.output.slice(0, 2000) };
          }
        }
        return doCodeTask(slug, cwd, task, mode, timeoutMs, continueSession);
      };

      // Background mode: return immediately with task id; deliver on completion.
      if (background && bgTasks) {
        // Still gate approval synchronously before queuing so the user knows what they're trusting.
        if (requestApproval && !useTwoPhase) {
          const ok = await requestApproval('claude_code', approvalDetails);
          if (!ok) return 'denied by user';
        }
        const taskId = bgTasks.spawn(async () => {
          try {
            // For two-phase in background, approval happens between phases as usual.
            const out = useTwoPhase ? await runAfterApproval() : await doCodeTask(slug, cwd, task, mode, timeoutMs, continueSession);
            return out;
          } catch (e) { return { error: e.message }; }
        }, { chatId: extras.chatId, userId: extras.userId, label: `claude_code ${slug}: ${task.slice(0, 60)}` });
        return { backgrounded: true, taskId, hint: `I'll DM you when this finishes. Track it with /tasks.` };
      }

      // Foreground.
      if (!useTwoPhase && requestApproval) {
        const ok = await requestApproval('claude_code', approvalDetails);
        if (!ok) return 'denied by user';
      }
      return runAfterApproval();
    };

    defs.push({
      name: 'project_list',
      description: 'List projects available in data/workspace/projects/.',
      input_schema: { type: 'object', properties: {} }
    });
    handlers.project_list = () => {
      if (!fs.existsSync(projectsRoot)) return [];
      return fs.readdirSync(projectsRoot, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => {
          const abs = path.join(projectsRoot, d.name);
          const hasGit = fs.existsSync(path.join(abs, '.git'));
          const hasPkg = fs.existsSync(path.join(abs, 'package.json'));
          return { name: d.name, git: hasGit, node: hasPkg };
        });
    };
  }

  // Self-diagnose: always available. Read-only, no approval. Use when the user
  // reports the bot is buggy, silent, double-replying, slow, or crashed — or
  // when you want to sanity-check your own runtime state.
  defs.push({
    name: 'self_diagnose',
    description: 'Inspect claudefish\'s own runtime: processes, recent logs, launchd status, recent errors, recent metrics. Use when the user says you\'re misbehaving, or when you want to check your own health before claiming nothing is wrong. Read-only.',
    input_schema: { type: 'object', properties: {
      lines: { type: 'number', description: 'how many log lines to return (default 40, max 200)' }
    } }
  });
  handlers.self_diagnose = async ({ lines: n = 40 } = {}) => {
    const { execFileSync } = require('child_process');
    const lim = Math.max(5, Math.min(200, Number(n) || 40));
    // workspaceDir is data/workspace; its parent is data/.
    const dataRoot = path.resolve(workspaceDir || './data/workspace', '..');
    const safe = (label, fn) => { try { return fn(); } catch (e) { return `${label}: ${e.message.slice(0, 200)}`; } };
    const readTail = (file, k) => safe(file, () => {
      if (!fs.existsSync(file)) return `(no file: ${file})`;
      const txt = fs.readFileSync(file, 'utf8');
      return txt.split('\n').slice(-k).join('\n');
    });
    const ps = safe('ps', () => execFileSync('/bin/ps', ['aux'], { encoding: 'utf8', timeout: 3000 })
      .split('\n').filter(l => /claudefish|src\/index\.js/.test(l) && !/ grep /.test(l)).join('\n') || '(no claudefish process found?!)');
    const launchd = safe('launchctl', () => execFileSync('/bin/launchctl', ['list'], { encoding: 'utf8', timeout: 3000 })
      .split('\n').filter(l => /claudefish/i.test(l)).join('\n') || '(not registered)');
    const stdout = readTail(path.join(dataRoot, 'claudefish.log'), lim);
    const stderr = readTail(path.join(dataRoot, 'claudefish.err.log'), Math.min(20, lim));
    const sessionFile = path.join(dataRoot, 'sessions', new Date().toISOString().slice(0, 10) + '.jsonl');
    const recentErrors = safe('sessions', () => {
      if (!fs.existsSync(sessionFile)) return '(no session file today)';
      const raw = fs.readFileSync(sessionFile, 'utf8').split('\n').filter(Boolean);
      const errors = [];
      for (const line of raw.slice(-500)) {
        try { const j = JSON.parse(line); if (j.type === 'api_error' || j.isError) errors.push(line); } catch {}
      }
      return errors.slice(-10).join('\n') || '(no errors logged today)';
    });
    const metrics = safe('metrics', () => {
      const mf = path.join(dataRoot, 'metrics.jsonl');
      if (!fs.existsSync(mf)) return '(no metrics yet)';
      return fs.readFileSync(mf, 'utf8').split('\n').filter(Boolean).slice(-5).join('\n');
    });
    return {
      processes: ps,
      launchd_registration: launchd,
      stdout_tail: stdout,
      stderr_tail: stderr,
      recent_errors: recentErrors,
      recent_metrics: metrics,
      hint: 'If multiple processes match, duplicate instances are fighting for Telegram updates. Single PID with recent successful turns in stdout = healthy.'
    };
  };

  if (p.skillWrite && skillsDir) {
    defs.push({
      name: 'skill_write',
      description: 'Save a self-written skill: a named approach with trigger keywords; auto-injected when triggers match future user messages.',
      input_schema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          triggers: { type: 'array', items: { type: 'string' } },
          body: { type: 'string' }
        },
        required: ['name', 'body']
      }
    });
    handlers.skill_write = ({ name, triggers = [], body }) => writeSkill(skillsDir, { name, triggers, body });
  }

  return { defs, handlers, profile };
}

function safeGitDiff(cwd) {
  try {
    const { execFileSync } = require('child_process');
    if (!fs.existsSync(path.join(cwd, '.git'))) return '';
    const opts = { cwd, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] };
    let stat = '';
    try { stat = execFileSync('git', ['diff', '--stat', 'HEAD'], opts); } catch {}
    let diff = '';
    try { diff = execFileSync('git', ['diff', 'HEAD'], opts); } catch {}
    // Emulate `head -300` in JS so we don't shell out to a pipeline.
    const diffHead = diff.split('\n').slice(0, 300).join('\n');
    return (stat + '---\n' + diffHead).slice(0, 8000);
  } catch { return ''; }
}

function diffBetween(before, after) {
  if (before === after) return '(no file changes)';
  return after || '(no diff captured)';
}

module.exports = { buildTools, PROFILES, TRUNCATION_LIMITS, truncate, httpGet, htmlToText };
