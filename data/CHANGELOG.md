# Claudefish changelog

## 2026-04-16 — Full-audit fixes (S1/S3/S4/A9/A10/C10 + polish)
- **S1 (bash scope was effectively global)**: `scopeFor('bash_exec')` now tokenizes `argv[0]` (`cmd0=npm`) and refuses scope entirely (returns `null` → fresh prompt every time) on any shell metacharacter `;|&><$()`\\\n` or `&&`/`||`. No more prefix-trust footgun.
- **S3 (doc_write zero-prefix blanket trust)**: refuses scope for paths without a directory separator → per-file approval instead of match-all via `startsWith('')`.
- **S4 (url_fetch redirect bypass)**: httpGet now has `followRedirects: false`; handler walks hops manually and re-requests approval on every redirect past hop 0. Loop detection at 5 hops.
- **A9 (persona hot-reload)**: `soul.md`, `overlay.md`, `agents.md` now stat'd each turn inside `_systemBlocks`. Content re-read only on mtime change; deletion handled as empty-content (no crash). No `/reload` needed — edits take effect on the next turn. Anthropic prompt cache invalidates automatically on content hash change.
- **A10 (background task persistence)**: `data/background.jsonl` now records spawn and finish transitions. Boot-time recovery marks any `running` records as `interrupted` and queues a user notification.
- **C10 (cost estimate blended by turn share)**: `summarize()` now emits `tokensByModel`; `estimateCost()` prices each model's tokens at its own rate → no more under-reporting when an Opus turn sits alongside Haiku turns.
- **§6 HELP gap**: `/trusts` and `/forget` now listed.
- **A14/A15 (debug log spam)**: `[claude]` and `[agent]` diagnostic prints gated behind `CLAUDEFISH_DEBUG=1` env var. Prod log now only shows credential/hooks/FTS/bot-lifecycle lines.

## 2026-04-16 — claude-code-telegram feature port
Ported the best ideas from `github.com/RichardAtCT/claude-code-telegram` (2.4K⭐ Python bot) into claudefish without breaking the agent's persona or zero-dep rule.

### Phase 1 — core reliability
- **Preflight auth check**: `claude_code` now checks keychain for Claude Code creds (via `security find-generic-password -s "Claude Code-credentials"`) before spawning. Fast-fails with clear "run `claude /login`" error instead of 16s of silence.
- **`Not logged in` detection**: post-spawn, scans output for auth failure strings and bails with `authIssue: true` flag (skips retry wrapper).
- **Two-phase default OFF**: `cfg.tools.twoPhaseClaudeCode` now defaults `false`. Opt in with `true` or use `mode: 'pr'` (always two-phase). Cuts ~30-60s latency per write.
- **Quote-user-verbatim rule** in `agents.md`: the agent must include the user's literal words in the `claude_code` task prompt, not paraphrase.

### Phase 2 — classic mode (terminal-style, no LLM in loop)
- `/cd <project>` — sets `sess.projectSlug`, all subsequent classic-mode commands run in that project
- `/pwd` — show cwd
- `/ls [dir]` — direct `fs.readdirSync`, no LLM
- `/cat <file>` — direct read
- `/git <args>` — runs git in cwd
- `/cc <task>` — direct Claude Code passthrough, bypasses agent loop. Live-streams output (edits single Telegram message every 2s). Uses `-c` if a project session exists, fresh otherwise.

### Phase 3 — per-project session map
- `sess.projectSessions[slug] = { lastRun }` tracks which projects have live Claude Code sessions
- `claude_code` tool auto-continues (`-c` flag) when session exists; first-touch starts fresh
- `/continue`, `/end`, `/sessions` commands

### Phase 4 — budget enforcement
- `cfg.tools.userDailyBudgetUsd` hard cap; checked at the top of every `respond()`
- Computes today's spend from `metrics.jsonl` via per-model token buckets (Opus/Sonnet/Haiku rates + cache ×0.1/×1.25)
- Over-budget requests reply: `💸 daily budget exceeded: spent $X of $Y. resets at UTC midnight.`
- `/budget` priority command shows spent + remaining

### Phase 6 — webhooks
- `/hook add <url>`, `/hook list`, `/hook del <n>` manage webhook registry at `data/webhooks.json`
- On background task completion, POSTs JSON payload `{type:'bg_task_complete', id, status, label, startedAt, finishedAt, result}` to all registered hooks (5s timeout, fire-and-forget)

### Phase 5 — SDK migration (PARKED)
- Verified `@anthropic-ai/claude-code@2.1.110` exists on npm. Not wired yet — would break zero-dep rule. Revisit if shell-out `claude -p` proves insufficient after Phases 1-4 settle.

### Also
- `capabilities.js` rewrote command list + added architecture notes for the agent's own self-understanding
- All new commands added to HELP string, Telegram `setCommands`, and priority-command router

## 2026-04-16 — Tier 3/4 audit fixes
- B1 (scheduler bypassing receipts): extracted `makeGateApproval({userId, chatId})` factory; both onMessage path and scheduler path use it. Scope derived internally via `scopeFor` — no caller can pass a stale pre-computed scope. Every approval (auto/trusted/approve/deny) now appends to receipts chain from both paths.
- B2 (shell injection in PR mode): swapped `execSync` string interpolation for `execFileSync` with argv arrays throughout PR path. Task strings flow as arguments to git/gh, not through a shell.
- B3 (PR bypassed two-phase): `useTwoPhase` now includes `mode === 'pr'`. First-touch untrusted PRs require plan→confirm before branch/commit/push/create.
- B5+B6 (PR branch hygiene): capture `originalBranch` up front; refuse (don't stash) if working tree is dirty — preserves principle of never silently modifying user state; restore to `originalBranch` on every error path AND on success so repeated PR runs branch cleanly.
- B4 (receipts.verify dead code): deleted unused `recomputed` line.
- N1 (auto-think budget): clamp `budget_tokens` to `maxTokens - 500` with floor of 1500 so API never rejects.
- N2 (`/tasks` result preview): completed/errored tasks show first 120 chars of result.
- N5 (`/receipts verify` wording): clarifies chain is global, not per-user.

## 2026-04-16 — Tier 3+4 ship
- **#13 background `claude_code`**: pass `background: true` → returns task ID immediately; result delivered via Telegram when done. `/tasks` lists active+recent. In-memory only (not persisted across restart).
- **#14 `/projects`**: lists `data/workspace/projects/*` with git branch/dirty status, last-touched date, open PR count (via `gh` if available).
- **#15 auto-thinking on research profile**: when `profile=research` and prompt > 80 chars, extended thinking auto-enables with budget scaled to prompt length (2K–8K). `/think on` still wins.
- **#17 `claude_code` PR mode** (`mode: 'pr'`): creates `claudefish/<ts>` branch, commits the diff, pushes, opens a draft PR via `gh`. Requires project to be a git repo with an `origin` remote.
- **#19 typed-memory enforcement**: `notes_save` now *requires* `type` (user|feedback|project|reference) AND `description`. Schema rejects missing fields; handler also double-checks.
- **#20 `/receipts` hash-chain**: every approval (approve/deny/trusted/auto) appends a SHA256-chained entry to `data/receipts.jsonl`. `/receipts` tails last 20; `/receipts verify` re-walks the chain and reports any tampering. Verified working with tamper test.

## 2026-04-16 — Tier 1 audit fixes
- B1: `archive.js` + `searchArchive` grep fallback now scan `memory/users/<userId>/` (FTS5 was silently missing all memory notes).
- B2/B3/B4: `url_fetch`, `bash_exec.stdout`/`stderr`, `journal_read`, `claude_code.{output,stderr,diff}` all routed through `TRUNCATION_LIMITS` + `truncate()`.
- B5: HELP text clarifies `/audit` shows "result preview".
- B6: scheduler's approval path now uses `scopeFor()`, honors `tools.autoApprove`, passes `isTrusted` — scheduled tool runs no longer re-prompt when trusted.
- B7: `digestUsers` unions `allowFrom` + `Object.values(aliases)`.
- I3: `MODEL_RATES` table (Opus/Sonnet/Haiku) + turn-weighted cost estimate.
- I4: `/search` no longer rebuilds FTS index per query; trusts the 15-minute interval.
- I8: `conflicts_needs_reconciliation` field name + `agents.md` paragraph instructing the agent to surface conflicts on the next turn.

## 2026-04-16 — top-20 ship day
- **#0 preflight**: blanket `.gitignore` for runtime `data/*` with scaffolding whitelist; added `TRUNCATION_LIMITS` const in `tools.js` so every tool has an explicit cap. Engines bumped to `>=22.5` for `node:sqlite`.
- **#5 cache telemetry**: every API response's `usage.{input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens}` is captured; `/status` now shows tokens in/out, cache read/create, hit rate.
- **#2 metrics log**: per-turn append to `data/metrics.jsonl` (latency, tokens, tools, model, profile).
- **#1 tool-result capture**: session JSONL now logs truncated tool results alongside args, plus tool latency and size.
- **#3 `/insights` [days]**: ranked analytics — tokens, latency p50/p95, top tools, models, cost estimate.
- **#9 `/audit <tool> [days]`**: every invocation of a tool with args + result preview + error flag.
- **#6 weekly auto-digest**: Sunday sweep writes `week_YYYY-MM-DD.md` per user as an `auto` project memory (generated by Haiku).
- **#10 scope-narrow approvals**: bash has `cwd=` scope, doc_write has `path=` prefix, url_fetch has `domain=` (subdomain-aware), claude_code has `project=`. Trust prefixes compose.
- **#4 voice input**: Groq Whisper transcription wired into Telegram voice/audio messages. Add `stt.provider="groq"` + `stt.apiKey` to `config.json` to enable; gracefully stubs if missing.
- **#7 FTS5 ranked `/search`** via built-in `node:sqlite`. Journal + sessions + memory ingested into `data/archive.sqlite`, incrementally refreshed. Falls back to grep if `node:sqlite` unavailable.
- **#8 contradiction detection (lazy)**: `notes_save` with type `user`/`feedback` flags overlapping existing notes via keyword-token check (no Haiku unless really needed).
- **#11 soft-delete memory decay**: `project` notes older than 60 days move to `_archive/` (not deleted). `/memory` lists, `/memory restore <key>` un-archives. `user`/`feedback`/`reference`/`auto` are permanent.
- **#12 two-phase `claude_code` (opt-in default)**: on first touch of a project (or untrusted), runs plan mode → requests approval with plan text → runs acceptEdits. Trusted projects (via `ApprovalStore.isTrusted`) skip the plan phase. Disable globally with `tools.twoPhaseClaudeCode: false`.
- **#18 per-user token metering**: `/usage` shows lifetime tokens in/out, cache stats, rough $ cost per user, from `metrics.jsonl`.

### Also this session (root-cause fixes)
- Double-launch: on Telegram `Conflict: terminated by other getUpdates`, bot `exit(1)` so only one survives. Atomic pidfile lock via `O_EXCL`.
- `httpGet` abandoned-promise bug: would hang forever on responses exceeding `maxBytes`. Now resolves with truncated content + wall-clock guard.
- `createMessage`/`streamMessage`: socket-idle timeout + wall-clock timeout + `settled` guard.
- Cache marker overflow: `buildSystem` now enforces Anthropic's 4-marker `cache_control` cap, preserving preludes first, latest within tier.
- Approval auto-approve via `tools.autoApprove: true` config flag (bypasses gate entirely).

## 2026-04-16 — input expansion + self-awareness
- **Image input**: photos and image-mime documents are now downloaded and passed to the model as vision content. (telegram.js, agent.js)
- **Text attachments**: non-image documents with text mime or text-like extension (`.md`, `.json`, `.csv`, source code, up to 200KB) are inlined into the message. (telegram.js)
- **Voice/audio stub**: voice messages are acknowledged with a "not configured yet" note instead of being silently dropped.
- **`/capabilities`** command and **auto-injected capability digest** in the system prompt (`capabilities.js`). The agent now reads its real feature list every turn instead of inferring from training data.
- **`/search <query>`** grep over journal + memory + session logs.
- **Double-launch fix**: on Telegram `Conflict: terminated by other getUpdates`, bot now exits(1) so only one instance remains. Atomic pidfile lock (O_EXCL) replaces the old TOCTOU check.

## Known gaps
- No voice/audio transcription (needs Whisper/STT config slot)
- No PDF or spreadsheet parsing
- No free-form web search (only `url_fetch` for known URLs)
- No group-chat mention handling beyond reply/quote
- No message edit/delete sync
