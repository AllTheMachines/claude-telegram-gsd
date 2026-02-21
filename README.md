# Claude Telegram Bot + GSD

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-18+-green.svg)](https://nodejs.org/)
[![GSD](https://img.shields.io/badge/GSD-workflow-blue.svg)](https://github.com/coleam00/claude-code-gsd)

**Control Claude Code from your phone — with full [GSD workflow](https://github.com/coleam00/claude-code-gsd) integration.**

Send text, voice, photos, documents, audio, and video. Plan and execute GSD phases, pause and resume work safely, switch between projects — all from Telegram with tappable buttons. Zero API cost, runs through your Claude Code subscription.

## How It Works

The bot spawns `claude` CLI as a subprocess, piping your Telegram messages in and streaming responses back. This means:

- **Zero API cost** — uses your Claude Max/Pro subscription, not per-token billing
- **Full Claude Code capabilities** — tools, MCP servers, file access, shell commands
- **Real streaming** — text appears as Claude writes it, not dumped at the end
- **Session persistence** — conversations continue across messages via `--resume`

## GSD Workflow Integration

Deep integration with the [GSD (Get Stuff Done)](https://github.com/coleam00/claude-code-gsd) workflow. Tap `/gsd` to get a button grid with all operations:

| | |
|---|---|
| Progress | Quick Task |
| Plan Phase | Execute Phase |
| Discuss Phase | Research Phase |
| Verify Work | Audit Milestone |
| **Pause Work** | **Resume Work** |
| Check Todos | Add Todo |
| Add Phase | Remove Phase |
| New Project | New Milestone |
| Settings | Debug |
| Help | |

Phase-based operations (Plan, Execute, Discuss, Research, Verify, Remove) show a phase picker from your roadmap.

### Contextual GSD Buttons

When Claude suggests a GSD command in its response (like `/gsd:execute-phase 8`), it automatically appears as a tappable button. No more copy-pasting commands — tap to run.

If Claude suggests clearing context first, a combined "Clear + Command" button appears that handles both in one tap.

### Direct Command Routing

Type any GSD command directly in chat — `/gsd:progress`, `/gsd:execute-phase 8`, `/gsd:plan-phase 3` — and it runs immediately. No need to navigate the menu for commands you already know.

### Action Bar

Every response includes an action bar:

```
[ GSD ] [ Pause ] [ Resume ]
[ Stop ] [ Retry ] [ New    ]
```

Plus contextual GSD suggestion buttons above when relevant.

## Features

### Media Support
- **Text** — ask questions, give instructions, have conversations
- **Voice** — speak naturally, transcribed via OpenAI Whisper
- **Photos** — screenshots, documents, anything visual (supports albums)
- **Documents** — PDFs (via pdftotext), text files, archives (ZIP, TAR)
- **Audio** — mp3, m4a, ogg, wav files transcribed and processed
- **Video** — video messages and video notes

### Session Management
- **Session persistence** — conversations continue across messages
- **Pause/Resume Work** — safely hand off work across sessions using GSD's context handoff
- **Resume picker** — `/resume` shows recent sessions as tappable buttons
- **Project switching** — `/project` switches Claude's working directory between projects
- **Auto-retry** — if Claude Code crashes, the bot retries automatically
- **Context tracking** — see context window usage percentage after each response

### Interactive UX
- **Contextual buttons** — GSD commands Claude suggests become tappable buttons
- **Action bar** — GSD, Pause, Resume, Stop, Retry, New after every response
- **GSD workflow** — `/gsd` shows a button grid for all project management operations
- **ask_user MCP** — Claude can present options as tappable inline buttons
- **Message queuing** — send multiple messages while Claude works, they queue up
- **Interrupt** — prefix with `!` or use `/stop` to interrupt

### Streaming & Notifications
- **Real partial streaming** — text appears progressively
- **Notification bundling** — thinking + tool updates in a single editable message (cleaned up after response)
- **Extended thinking** — trigger Claude's reasoning with words like "think" or "reason"
- **Silent status** — intermediate updates are silent, only the final response notifies

## Quick Start

```bash
git clone https://github.com/AllTheMachines/claude-telegram-gsd.git
cd claude-telegram-gsd

cp .env.example .env
# Edit .env with your credentials

npm install   # or: bun install
npx tsx src/index.ts
```

### Prerequisites

- **Node.js 18+** (or Bun 1.0+)
- **Claude Code CLI** — [install](https://docs.anthropic.com/en/docs/claude-code/overview) and run `claude` once to authenticate
- **Telegram Bot Token** from [@BotFather](https://t.me/BotFather)
- **OpenAI API Key** (optional, for voice/audio transcription)

### Authentication

The bot spawns `claude` CLI as a subprocess, which uses your existing Claude Code authentication. Just ensure you've run `claude` at least once and logged in. This uses your Claude Code subscription (Max or Pro) — no per-token API costs.

The bot runs with `--dangerously-skip-permissions` for a seamless mobile experience. See the [Security Model](SECURITY.md) for details on the protection layers.

## Configuration

### 1. Create Your Bot

1. Open [@BotFather](https://t.me/BotFather) on Telegram
2. Send `/newbot` and follow the prompts
3. Copy the token (looks like `1234567890:ABC-DEF...`)

The bot registers its own command menu automatically at startup.

### 2. Configure Environment

Create `.env` with your settings:

```bash
# Required
TELEGRAM_BOT_TOKEN=1234567890:ABC-DEF...   # From @BotFather
TELEGRAM_ALLOWED_USERS=123456789           # Your Telegram user ID

# Recommended
CLAUDE_WORKING_DIR=/path/to/your/folder    # Where Claude runs (loads CLAUDE.md, skills, MCP)
OPENAI_API_KEY=sk-...                      # For voice/audio transcription
```

**Finding your Telegram user ID:** Message [@userinfobot](https://t.me/userinfobot) on Telegram.

**File access paths:** By default, Claude can access:

- `CLAUDE_WORKING_DIR` (or home directory if not set)
- `~/Documents`, `~/Downloads`, `~/Desktop`
- `~/.claude` (for Claude Code plans and settings)

To customize, set `ALLOWED_PATHS` in `.env` (comma-separated). This **overrides** all defaults, so include `~/.claude` if you want plan mode to work:

```bash
ALLOWED_PATHS=/your/project,/other/path,~/.claude
```

### 3. Configure MCP Servers (Optional)

Copy and edit the MCP config:

```bash
cp mcp-config.example.ts mcp-config.ts
# Edit mcp-config.ts with your MCP servers
```

The bot includes a built-in `ask_user` MCP server that lets Claude present options as tappable inline keyboard buttons. Add your own MCP servers (Things, Notion, Typefully, etc.) to give Claude access to your tools.

## Bot Commands

| Command    | Description                                          |
| ---------- | ---------------------------------------------------- |
| `/start`   | Show status and available commands                   |
| `/new`     | Start a fresh session                                |
| `/clear`   | Clear context and start fresh                        |
| `/stop`    | Interrupt current query                              |
| `/status`  | Session info + context usage + action buttons        |
| `/resume`  | Pick from recent sessions to resume (with recap)     |
| `/retry`   | Retry the last message                               |
| `/project` | Switch working directory between projects            |
| `/gsd`     | GSD workflow operations (plan, execute, progress)    |
| `/search`  | Search the vault (FTS5)                              |
| `/restart` | Restart the bot process                              |

GSD commands can also be typed directly: `/gsd:progress`, `/gsd:execute-phase 8`, etc.

## Running as a Service

### pm2 (Windows/Linux)

```bash
pm2 start ecosystem.config.cjs
pm2 logs telegram-claude
pm2 restart telegram-claude
```

### launchd (macOS)

```bash
cp launchagent/com.claude-telegram-ts.plist.template ~/Library/LaunchAgents/com.claude-telegram-ts.plist
# Edit the plist with your paths and env vars
launchctl load ~/Library/LaunchAgents/com.claude-telegram-ts.plist
```

The bot will start automatically on login and restart if it crashes.

**Logs:**

```bash
tail -f /tmp/claude-telegram-bot-ts.log   # stdout
tail -f /tmp/claude-telegram-bot-ts.err   # stderr
```

## Development

```bash
# Run with auto-reload
npx tsx --watch src/index.ts

# Type check
npx tsc --noEmit
```

## Security

> **This bot runs Claude Code with all permission prompts bypassed.** Claude can read, write, and execute commands without confirmation within the allowed paths. This is intentional for a seamless mobile experience, but you should understand the implications before deploying.

**[Read the full Security Model](SECURITY.md)** for details.

Multiple layers protect against misuse:

1. **User allowlist** — Only your Telegram IDs can use the bot
2. **Intent classification** — AI filter blocks dangerous requests
3. **Path validation** — File access restricted to `ALLOWED_PATHS`
4. **Command safety** — Destructive patterns like `rm -rf /` are blocked
5. **Rate limiting** — Prevents runaway usage
6. **Audit logging** — All interactions logged

## Troubleshooting

**Bot doesn't respond**
- Verify your user ID is in `TELEGRAM_ALLOWED_USERS`
- Check the bot token is correct
- Ensure the bot process is running

**Claude authentication issues**
- Run `claude` in terminal and verify you're logged in
- Check that `claude` is on your PATH

**Voice messages fail**
- Ensure `OPENAI_API_KEY` is set in `.env`
- Verify the key is valid and has credits

**Claude can't access files**
- Check `CLAUDE_WORKING_DIR` points to an existing directory
- Verify `ALLOWED_PATHS` includes directories you want Claude to access

**Context limit reached**
- The bot auto-detects context limit errors and clears the session
- You'll see a message telling you to send your question again

## Credits

Forked from [linuz90/claude-telegram-bot](https://github.com/linuz90/claude-telegram-bot) by [Fabrizio Rinaldi](https://github.com/linuz90). The original project provides the core Telegram-to-Claude bridge, media handling, and security model. This fork adds GSD workflow integration, contextual command buttons, project switching, auto-documentation, vault search, and session management.

## License

MIT
