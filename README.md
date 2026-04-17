# claudefish 🐠

> A persistent Telegram agent powered by Claude — no separate API key needed.

```
        ___
    .-'   `'.
   /         \      🫧 🫧
   |  o   o  |    ~~~~  ~~~~
   |    ‿    |  ~~~~ claudefish ~~~~
    \  ___  /      ~~~~  ~~~~
     `-----'
    /|     |\
   / |     | \
  /__|_____|__\
```

<div align="center">

<!-- CSS Nemo fish because why not -->
<style>
  .nemo {
    display: inline-block;
    font-size: 3em;
    animation: swim 3s ease-in-out infinite;
  }
  @keyframes swim {
    0%   { transform: translateX(0px) rotate(0deg); }
    25%  { transform: translateX(10px) rotate(3deg); }
    50%  { transform: translateX(0px) rotate(0deg); }
    75%  { transform: translateX(-10px) rotate(-3deg); }
    100% { transform: translateX(0px) rotate(0deg); }
  }
</style>

<span class="nemo">🐠</span>

*built by [Astraea](https://github.com/astraea-ai)*

</div>

---

claudefish turns a Telegram bot into your personal Claude assistant. It runs as a
background daemon on your own machine, remembers things between conversations, and
uses your existing Claude Code credentials — so there's no separate Anthropic API
key to manage.

It's an **agent harness**, not just a message router: persistent memory, scheduled
tasks, tool use, a journal of what it's done, and a full approval/receipts system.

## Status

Early / pre-1.0. Single-user by design — runs on your machine, talks to your Telegram.

## Requirements

- Node.js **>= 22.5**
- macOS (LaunchAgent-based process control; Linux support is on the roadmap)
- A Claude subscription with Claude Code installed (for credentials)
- A Telegram bot token (create one via [@BotFather](https://t.me/BotFather))

## Install

```bash
git clone https://github.com/astraea-ai/claudefish.git
cd claudefish
cp config.example.json config.json
```

Edit `config.json`:
- `telegram.botToken` — from @BotFather
- `telegram.allowFrom` — your numeric Telegram user ID (get it from [@userinfobot](https://t.me/userinfobot))

Then:

```bash
node src/index.js
```

Or install the CLI for background control:

```bash
ln -s "$PWD/bin/claudefish" /usr/local/bin/claudefish
claudefish start     # starts via LaunchAgent (see com.claudefish.plist.example)
claudefish status
claudefish logs
```

### macOS LaunchAgent notes

The example plist (`com.claudefish.plist.example`) invokes `/bin/bash -lc` so
your login shell profile resolves `node` correctly on both Apple Silicon
(`/opt/homebrew/bin`) and Intel (`/usr/local/bin`) Macs. Replace `REPO_DIR`
placeholders with absolute paths before loading it — launchd does not expand
`$VAR` or `$(…)`.

On first run, macOS may prompt for keychain access (claudefish reads your
Claude Code credentials from Keychain). You must approve the prompt on the
desktop. If the LaunchAgent is already loaded when the prompt appears and you
can't click it, unload the agent, run `node src/index.js` once from a
terminal, approve the prompt, then reload.

## Personalization

A fresh clone ships with neutral defaults — the bot calls you "You" and
refers to itself as "claudefish". To personalize:

**Option 1 — config only (lightweight):**

Add a `persona` block to `config.json`:

```json
"persona": {
  "name": "Fred",
  "userLabel": "Alex",
  "assistantLabel": "Fred"
}
```

`name` and `assistantLabel` are how the bot refers to itself; `userLabel` is
how the system prompt refers to you.

**Option 2 — edit the soul (for voice/register):**

`data/soul.md` is the identity scaffold the bot receives every turn. Edit it
to shape tone, preferences, and character. `data/agents.md` governs
operational rules (how to use tools, when to delegate). `data/overlay.md` is
an optional register layer for extra voice tuning — delete it if you don't
want one. All three hot-reload on file change; no restart needed.

## Features

- **Persistent memory** — per-user typed notes (user/feedback/project/reference), decay, summaries
- **Telegram-native** — text, voice (STT), inline approval buttons
- **Tools** — file edit, URL fetch, bash (opt-in), subagents, Claude Code delegation
- **Scheduled tasks** — cron-style recurring work with approval gating
- **Journal** — daily markdown log of everything the agent did
- **Archive** — full conversation history in SQLite with FTS5 search
- **Budget enforcement** — daily spend cap with per-model cost tracking
- **Receipt chain** — SHA256-chained approval log; tamper-detectable
- **Webhooks** — POST to external URLs on background task completion
- **PR mode** — Claude Code can create draft PRs via `gh`
- **Classic mode** — `/cd`, `/ls`, `/cat`, `/git`, `/cc` for terminal-style control

## Commands

```
/help          Show all commands
/ping          Health check
/status        Runtime status
/memory        List saved notes
/notes         Alias for /memory
/journal       Today's journal
/search        Full-text search over journal + memory
/budget        Today's spend vs daily cap
/tasks         Active + recent background tasks
/projects      List workspace projects
/trusts        Show trusted tool approvals
/receipts      Show + verify approval chain
/remind        Set a reminder
/stop          Kill running tool
/busy          Show what's running
/cc <task>     Direct Claude Code passthrough (bypasses agent loop)
```

## Configuration

See `config.example.json`. Main knobs:

| Key | What it does |
|---|---|
| `telegram.allowFrom` | Allowlist of Telegram user IDs (anyone else is ignored) |
| `model.primary` / `fallback` | Claude model IDs |
| `credentials.source` | `auto` uses your Claude Code credentials |
| `tools.bash` | Enable bash execution (off by default) |
| `tools.autoApprove` | Tool patterns to approve without prompting |
| `tools.userDailyBudgetUsd` | Hard daily spend cap |
| `persona.*` | Name and labels |

## Security notes

- Never commit `config.json` — it contains your bot token
- The allowlist (`telegram.allowFrom`) is the only access control; set it correctly
- Bot tokens can be rotated any time via @BotFather
- All data stays on your machine; nothing is uploaded except Claude API calls
- `tools.bash` is **off by default** — enable only if you trust the setup
- **Voice messages:** if you enable STT (`cfg.stt` with a Groq API key), audio bytes are uploaded to `api.groq.com`. Omit `cfg.stt` to keep voice local-only.

## Architecture

```
Telegram ──► index.js (bot loop)
                 │
                 ├── agent.js       (turn orchestration, system prompt assembly)
                 ├── tools.js       (tool dispatch + approval gating)
                 ├── memory.js      (typed notes, decay, FTS)
                 ├── archive.js     (SQLite conversation history)
                 ├── background.js  (async task queue + recovery)
                 ├── approvals.js   (inline button + receipt chain)
                 ├── cron.js        (scheduled tasks)
                 └── claude.js      (Anthropic API + Claude Code subprocess)
```

## License

MIT — see [LICENSE](LICENSE).

Built with 🐠 by Astraea.

## Contributing

Issues and PRs welcome. Open an issue before sending a significant PR.
