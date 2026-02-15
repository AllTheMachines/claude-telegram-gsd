# Claude Telegram Bot

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-18+-green.svg)](https://nodejs.org/)

**Turn [Claude Code](https://claude.com/product/claude-code) into your personal assistant, accessible from anywhere via Telegram.**

Send text, voice, photos, documents, audio, and video. See responses and tool usage streaming in real-time. Zero API cost — runs through your Claude Code subscription.

![Demo](assets/demo.gif)

## How It Works

The bot spawns `claude` CLI as a subprocess, piping your Telegram messages in and streaming responses back. This means:

- **Zero API cost** — uses your Claude Max/Pro subscription, not per-token billing
- **Full Claude Code capabilities** — tools, MCP servers, file access, shell commands
- **Real streaming** — text appears as Claude writes it, not dumped at the end
- **Session persistence** — conversations continue across messages via `--resume`

## Claude Code as a Personal Assistant

While Claude Code is described as a powerful AI **coding agent**, it's actually a very capable **general-purpose agent** too when given the right instructions, context, and tools.

Set up a folder with a CLAUDE.md that teaches Claude about you (your preferences, where your notes live, your workflows), add tools and scripts based on your needs, and point this bot at that folder.

> **[See the Personal Assistant Guide](docs/personal-assistant-guide.md)** for detailed setup and examples.

## Features

### Media Support
- **Text** — Ask questions, give instructions, have conversations
- **Voice** — Speak naturally, transcribed via OpenAI Whisper
- **Photos** — Screenshots, documents, anything visual (supports albums)
- **Documents** — PDFs (via pdftotext), text files, archives (ZIP, TAR)
- **Audio** — mp3, m4a, ogg, wav files transcribed and processed
- **Video** — Video messages and video notes

### Session Management
- **Session persistence** — conversations continue across messages
- **Resume picker** — `/resume` shows recent sessions as tappable buttons with date/time
- **Project switching** — `/project` switches Claude's working directory between projects
- **Auto-retry** — if Claude Code crashes, the bot retries automatically
- **Context tracking** — see context window usage percentage after each response

### Interactive UX
- **Action buttons** — after each response: `[Stop] [Retry] [New] [GSD]`
- **Status with actions** — `/status` shows session info with `[New] [Switch Project] [GSD] [Retry]`
- **GSD workflow** — `/gsd` shows a button grid for project management operations
- **ask_user MCP** — Claude can present options as tappable inline buttons
- **Message queuing** — send multiple messages while Claude works, they queue up. Prefix with `!` or `/stop` to interrupt

### Streaming & Notifications
- **Real partial streaming** — text appears progressively via `--include-partial-messages`
- **Notification bundling** — thinking + tool updates in a single editable message (cleaned up after response)
- **Extended thinking** — trigger Claude's reasoning with words like "think" or "reason"
- **Silent status** — intermediate updates are silent, only the final response notifies

## Quick Start

```bash
git clone https://github.com/linuz90/claude-telegram-bot.git
cd claude-telegram-bot

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
| `/start`   | Show status and your user ID                         |
| `/new`     | Start a fresh session                                |
| `/stop`    | Interrupt current query                              |
| `/status`  | Session info + context usage + action buttons        |
| `/resume`  | Pick from recent sessions to resume (with recap)     |
| `/retry`   | Retry the last message                               |
| `/project` | Switch working directory between projects            |
| `/gsd`     | GSD workflow operations (plan, execute, progress)    |
| `/restart` | Restart the bot process                              |

## Running as a Service (macOS)

```bash
cp launchagent/com.claude-telegram-ts.plist.template ~/Library/LaunchAgents/com.claude-telegram-ts.plist
# Edit the plist with your paths and env vars
launchctl load ~/Library/LaunchAgents/com.claude-telegram-ts.plist
```

The bot will start automatically on login and restart if it crashes.

**Prevent sleep:** To keep the bot running when your Mac is idle, go to **System Settings > Battery > Options** and enable **"Prevent automatic sleeping when the display is off"** (when on power adapter).

**Logs:**

```bash
tail -f /tmp/claude-telegram-bot-ts.log   # stdout
tail -f /tmp/claude-telegram-bot-ts.err   # stderr
```

**Shell aliases:**

```bash
alias cbot='launchctl list | grep com.claude-telegram-ts'
alias cbot-stop='launchctl bootout gui/$(id -u)/com.claude-telegram-ts 2>/dev/null && echo "Stopped"'
alias cbot-start='launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.claude-telegram-ts.plist 2>/dev/null && echo "Started"'
alias cbot-restart='launchctl kickstart -k gui/$(id -u)/com.claude-telegram-ts && echo "Restarted"'
alias cbot-logs='tail -f /tmp/claude-telegram-bot-ts.log'
```

## Running on Windows

```bash
cd claude-telegram-bot
npx tsx src/index.ts
```

The bot works on Windows with Node.js. Process management uses `taskkill /T /F` instead of Unix signals. You can set it up as a Windows service or run it in a terminal.

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

## License

MIT
