'use strict';

const fs = require('fs');
const path = require('path');
const { PROFILES } = require('./tools');

function listDir(dir, pred = () => true) {
  try { return fs.readdirSync(dir).filter(pred); } catch { return []; }
}

function buildCapabilitiesText({ cfg, dataDir, hooks = [], scheduler = null, queue = null }) {
  const skillsDir = path.join(dataDir, 'skills');
  const ctxDir = path.join(dataDir, 'context');
  const hooksDir = path.join(dataDir, 'hooks');
  const projectsDir = path.join(dataDir, 'projects');

  const profileNames = Object.keys(PROFILES);
  const currentProfileTools = (name) => PROFILES[name] ? Object.keys(PROFILES[name]).filter(k => PROFILES[name][k]).join(', ') : '';

  const skills = listDir(skillsDir, f => f.endsWith('.md'));
  const contextFiles = listDir(ctxDir, f => f.endsWith('.md'));
  const projectFiles = listDir(projectsDir, f => f.endsWith('.md'));
  const hookNames = hooks.map(h => h.name);

  const model = cfg.model || {};
  const toolFlags = cfg.tools || {};

  const lines = [];
  lines.push('# Capabilities (auto-generated)');
  lines.push('');
  lines.push('## Inputs you can receive');
  lines.push('- Text messages (with reply/quote context extracted)');
  lines.push('- Image attachments (photos + image-mime documents) — vision-capable');
  lines.push('- Text-file attachments (.md, .json, .csv, .txt, source code, etc, up to 200KB) — inlined');
  const sttConfigured = !!(cfg.stt?.apiKey);
  lines.push(`- Voice/audio — ${sttConfigured ? '✅ transcribed via Groq Whisper' : '❌ not configured (add cfg.stt.provider+apiKey)'}`);
  lines.push('');
  lines.push('## Tool profiles');
  for (const p of profileNames) {
    lines.push(`- **${p}**: ${currentProfileTools(p) || '(none)'}`);
  }
  lines.push('');
  lines.push('## Core tools available (by profile)');
  lines.push('- `notes_find/load/save/delete` — persistent per-user memory');
  lines.push('- `doc_read/write/list` — workspace file access');
  lines.push('- `url_fetch` — fetch a known URL (no free-form web search)');
  lines.push('- `bash_exec` — shell in workspace (approval-gated)');
  lines.push('- `fork_task` — spawn isolated subagent for heavy research');
  lines.push('- `claude_code` — delegate real code tasks to Claude Code in a project folder');
  lines.push('- `journal_read` — read journal by date');
  lines.push('- `self_diagnose` — inspect own process, logs, launchd, recent errors/metrics (always available; use when user says you\'re misbehaving)');
  lines.push('');
  lines.push('## Runtime state');
  lines.push(`- Model: primary=${model.primary || '?'}, fallback=${model.fallback || '?'}, maxTokens=${model.maxTokens || '?'}`);
  lines.push(`- Config flags: ${Object.entries(toolFlags).map(([k, v]) => `${k}=${v}`).join(', ') || '(none)'}`);
  lines.push(`- Hooks active: ${hookNames.length ? hookNames.join(', ') : '(none)'}`);
  lines.push(`- Scheduler: ${scheduler ? 'on' : 'off'} | Queue: ${queue ? 'on' : 'off'}`);
  lines.push(`- Skills loaded (${skills.length}): ${skills.slice(0, 20).join(', ') || '(none)'}`);
  lines.push(`- Context files (${contextFiles.length}): ${contextFiles.slice(0, 20).join(', ') || '(none)'}`);
  lines.push(`- Project dossiers (${projectFiles.length}): ${projectFiles.slice(0, 20).join(', ') || '(none)'}`);
  lines.push('');
  lines.push('## Commands — core');
  lines.push('- `/help /ping /reset /compact /status /capabilities`');
  lines.push('- `/model /models /profile /think /stream`');
  lines.push('- `/remind /reminders /cancel /cron`');
  lines.push('- `/skill list` · `/skill <name>` — browse + prime saved skills');
  lines.push('- `/notes /memory /skills /context /hooks /journal`');
  lines.push('- `/search <query>` — ranked FTS5 over journal+memory+sessions');
  lines.push('- `/insights [days]` — usage analytics · `/audit <tool>` · `/usage`');
  lines.push('- `/trusts /forget /receipts [verify]`');
  lines.push('- `/projects /tasks /filesstructure (/fs)`');
  lines.push('');
  lines.push('## Commands — priority (work mid-chain, bypass turn loop)');
  lines.push('- `/stop` — kill running tool (SIGTERM child proc, abort loop)');
  lines.push('- `/busy` — show what\'s running + elapsed time');
  lines.push('- `/errors` — last 10 tool errors today');
  lines.push('- `/btw <msg>` — quick Haiku side-chat while busy');
  lines.push('');
  lines.push('## Commands — classic mode (terminal-style, no LLM)');
  lines.push('- `/cd <project>` — set cwd to a project dir');
  lines.push('- `/pwd` — show current cwd');
  lines.push('- `/ls [dir]` — list files in cwd');
  lines.push('- `/cat <file>` — read file in cwd');
  lines.push('- `/git <args>` — run git in cwd');
  lines.push('- `/cc <task>` — direct Claude Code passthrough with live streaming (bypasses agent loop)');
  lines.push('- `/continue` — resume last Claude Code session in current project');
  lines.push('- `/end` — end Claude Code session in current project');
  lines.push('- `/sessions` — list active per-project Claude Code sessions');
  lines.push('- `/budget` — today\'s spend vs daily cap');
  lines.push('- `/hook add|list|del` — webhooks for bg-task completion events');
  lines.push('');
  const assistantName = cfg.persona?.name || 'the assistant';
  const userLabel = cfg.persona?.userLabel || 'the user';
  lines.push(`## Architecture notes (for ${assistantName} to understand)`);
  lines.push('- `MAX_TURNS = 50`. Context accumulates every tool_use + tool_result. If work will take >5 tool calls, **delegate to claude_code with background: true** — don\'t grind it in your session.');
  lines.push(`- ${userLabel} has \`/cc\` as a direct passthrough. If they use it, they want Claude Code direct, not your layer. Don't take offense.`);
  lines.push('- Session state: `sess.projectSlug` (current cwd project), `sess.projectSessions[slug]` (per-project Claude Code session map for `-c` resume).');
  lines.push(`- When \`claude_code\` returns \`{ authIssue: true }\` — tell ${userLabel} to run \`claude /login\`. Don't retry silently.`);
  lines.push('- `notes_save` now REQUIRES `type` + `description`. Schema will reject you if missing.');
  lines.push(`- Auto-learning: if ${userLabel} corrects you, the system may auto-save the correction as \`feedback\` memory in the background. Don't re-save what's already auto-captured.`);
  const autoSynth = cfg.skills?.autoSynthesize !== false;
  lines.push(`- Auto-synthesized skills: after a clean multi-step session (≥3 tool calls, no errors), a background Haiku may write a reusable skill file to \`data/skills/\`. Currently ${autoSynth ? 'ENABLED' : 'disabled'} (\`skills.autoSynthesize\`).`);
  lines.push('- Natural-language cron: `/cron <description>` → Haiku parses to a 5-field crontab, confirms via Yes/No, then persists to `data/cron.json` and recurs forever.');
  lines.push('');
  lines.push('## Security posture (what\'s guarded)');
  lines.push('- `bash_exec` always prompts if the command contains shell metacharacters; blanket-trust covers only exact `argv[0]` with no special chars.');
  lines.push('- `doc_write` approvals are exact-path, never prefix-match with empty prefix.');
  lines.push('- Webhooks + `url_fetch` go through SSRF guard (`isPublicUrl`): blocks loopback/RFC1918/link-local/CGNAT/`::1` and resolves hostnames before allowing.');
  lines.push('- `/cc` subprocess inherits only a whitelisted env (`PATH/HOME/USER/SHELL/LANG/LC_*/TERM`) so parent secrets don\'t leak.');
  lines.push('- `tools.autoApprove` is fail-closed: only the literal boolean `true` bypasses every gate; any other value falls through to the prompt.');
  lines.push('- Every approval (auto, trusted, approved, denied) appends to the SHA256-chained `data/receipts.jsonl`; `/receipts verify` re-walks the chain.');
  lines.push('');
  lines.push('## Known limitations (today)');
  lines.push('- PDF/spreadsheet parsing: text docs only');
  lines.push('- `url_fetch` requires a URL — no free-form web search');
  lines.push('- No group-chat mention handling beyond reply/quote');
  lines.push('- No message edit/delete sync');
  lines.push('- `@anthropic-ai/claude-code` npm SDK exists (v2.1.110) but not yet wired — still shell-out to `claude -p`');
  return lines.join('\n');
}

module.exports = { buildCapabilitiesText };
