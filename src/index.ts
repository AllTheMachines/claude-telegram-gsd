/**
 * Claude Telegram Bot - Node.js Edition
 *
 * Control Claude Code from your phone via Telegram.
 * Adapted from linuz90/claude-telegram-bot (Bun/TypeScript).
 */

import { Bot } from "grammy";
import { autoRetry } from "@grammyjs/auto-retry";
import { run, sequentialize } from "@grammyjs/runner";
import { TELEGRAM_TOKEN, ALLOWED_USERS, RESTART_FILE } from "./config";
import { session } from "./session";
import { unlinkSync, readFileSync, existsSync } from "fs";
import {
  handleStart,
  handleNew,
  handleStop,
  handleStatus,
  handleResume,
  handleRestart,
  handleRetry,
  handleProject,
  handleGsd,
  handleSearch,
  handleText,
  handleVoice,
  handlePhoto,
  handleDocument,
  handleAudio,
  handleVideo,
  handleCallback,
} from "./handlers";

// Create bot instance
const bot = new Bot(TELEGRAM_TOKEN);

// Auto-retry outbound API calls on rate limits and server errors
bot.api.config.use(autoRetry());

// Sequentialize non-command messages per user (prevents race conditions)
// Commands bypass sequentialization so they work immediately
bot.use(
  sequentialize((ctx) => {
    // Commands are not sequentialized - they work immediately
    if (ctx.message?.text?.startsWith("/")) {
      return undefined;
    }
    // Messages with ! prefix bypass queue (interrupt)
    if (ctx.message?.text?.startsWith("!")) {
      return undefined;
    }
    // Callback queries (button clicks) are not sequentialized
    if (ctx.callbackQuery) {
      return undefined;
    }
    // Other messages are sequentialized per chat
    return ctx.chat?.id.toString();
  })
);

// ============== Command Handlers ==============

bot.command("start", handleStart);
bot.command("new", handleNew);
bot.command("stop", handleStop);
bot.command("status", handleStatus);
bot.command("resume", handleResume);
bot.command("restart", handleRestart);
bot.command("retry", handleRetry);
bot.command("project", handleProject);
bot.command("gsd", handleGsd);
bot.command("search", handleSearch);

// ============== Message Handlers ==============

bot.on("message:text", handleText);
bot.on("message:voice", handleVoice);
bot.on("message:photo", handlePhoto);
bot.on("message:document", handleDocument);
bot.on("message:audio", handleAudio);
bot.on("message:video", handleVideo);
bot.on("message:video_note", handleVideo);

// ============== Callback Queries ==============

bot.on("callback_query:data", handleCallback);

// ============== Error Handler ==============

bot.catch((err) => {
  console.error("Bot error:", err);
});

// ============== Startup ==============

console.log("=".repeat(50));
console.log("Claude Telegram Bot - Node.js Edition");
console.log("=".repeat(50));
console.log(`Working directory: ${session.currentWorkingDir}`);
console.log(`Allowed users: ${ALLOWED_USERS.length}`);
console.log("Starting bot...");

// Get bot info and register command menu
const botInfo = await bot.api.getMe();
console.log(`Bot started: @${botInfo.username}`);

await bot.api.setMyCommands([
  { command: "search", description: "Search vault notes" },
  { command: "new", description: "Start a new conversation" },
  { command: "stop", description: "Stop current query" },
  { command: "status", description: "Show session status" },
  { command: "resume", description: "Resume a saved session" },
  { command: "project", description: "Switch working directory" },
  { command: "gsd", description: "GSD workflow operations" },
  { command: "retry", description: "Retry last message" },
  { command: "restart", description: "Restart the bot process" },
]);
console.log("Command menu registered");

// Check for pending restart message to update
if (existsSync(RESTART_FILE)) {
  try {
    const data = JSON.parse(readFileSync(RESTART_FILE, "utf-8"));
    const age = Date.now() - data.timestamp;

    // Only update if restart was recent (within 30 seconds)
    if (age < 30000 && data.chat_id && data.message_id) {
      await bot.api.editMessageText(
        data.chat_id,
        data.message_id,
        "✅ Bot restarted"
      );
    }
    unlinkSync(RESTART_FILE);
  } catch (e) {
    console.warn("Failed to update restart message:", e);
    try { unlinkSync(RESTART_FILE); } catch {}
  }
}

// Start with concurrent runner (commands work immediately)
const runner = run(bot);

// Graceful shutdown
const stopRunner = () => {
  if (runner.isRunning()) {
    console.log("Stopping bot...");
    runner.stop();
  }
};

process.on("SIGINT", () => {
  console.log("Received SIGINT");
  stopRunner();
  process.exit(0);
});

process.on("SIGTERM", () => {
  console.log("Received SIGTERM");
  stopRunner();
  process.exit(0);
});
