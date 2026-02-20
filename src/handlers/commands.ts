/**
 * Command handlers for Claude Telegram Bot.
 *
 * /start, /new, /stop, /status, /resume, /restart
 */

import type { Context } from "grammy";
import { writeFileSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { session } from "../session";
import { ALLOWED_USERS, RESTART_FILE } from "../config";
import { isAuthorized } from "../security";
import { sleep } from "../utils";
import { parseRegistry } from "../registry";
import { searchVault, formatResults } from "../vault-search";

/**
 * Parsed phase from ROADMAP.md.
 */
export interface RoadmapPhase {
  number: string;
  name: string;
  description: string;
  status: "done" | "pending" | "skipped";
}

/**
 * Parse ROADMAP.md from a project directory.
 * Format: - [x] **Phase 2: Name** - Description
 */
export function parseRoadmap(workingDir: string): RoadmapPhase[] {
  const roadmapPath = join(workingDir, ".planning", "ROADMAP.md");
  if (!existsSync(roadmapPath)) return [];

  try {
    const content = readFileSync(roadmapPath, "utf-8");
    const phases: RoadmapPhase[] = [];
    const regex = /^- \[(.)\] \*\*Phase ([\d.]+): ([^*]+)\*\* - (.+)$/gm;
    let match;

    while ((match = regex.exec(content)) !== null) {
      const statusChar = match[1]!;
      phases.push({
        number: match[2]!,
        name: match[3]!.trim(),
        description: match[4]!.trim(),
        status:
          statusChar === "x" ? "done" : statusChar === "~" ? "skipped" : "pending",
      });
    }

    return phases;
  } catch {
    return [];
  }
}


/**
 * /start - Show welcome message and status.
 */
export async function handleStart(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  const username = ctx.from?.username || "unknown";

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized. Contact the bot owner for access.");
    return;
  }

  const status = session.isActive ? "Active session" : "No active session";
  const workDir = session.currentWorkingDir;

  await ctx.reply(
    `🤖 <b>Claude Telegram Bot</b>\n\n` +
      `Status: ${status}\n` +
      `Working directory: <code>${workDir}</code>\n\n` +
      `<b>Commands:</b>\n` +
      `/new - Start fresh session\n` +
      `/stop - Stop current query\n` +
      `/status - Show detailed status\n` +
      `/project - Switch project\n` +
      `/gsd - GSD operations\n` +
      `/resume - Resume last session\n` +
      `/retry - Retry last message\n` +
      `/restart - Restart the bot\n\n` +
      `<b>Tips:</b>\n` +
      `• Prefix with <code>!</code> to interrupt current query\n` +
      `• Use "think" keyword for extended reasoning\n` +
      `• Send photos, voice, or documents`,
    { parse_mode: "HTML" }
  );
}

/**
 * /new - Start a fresh session.
 */
export async function handleNew(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  // Stop any running query
  if (session.isRunning) {
    const result = await session.stop();
    if (result) {
      await sleep(100);
      session.clearStopRequested();
    }
  }

  // Clear session
  await session.kill();

  await ctx.reply("🆕 Session cleared. Next message starts fresh.");
}

/**
 * /stop - Stop the current query (silently).
 */
export async function handleStop(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  if (session.isRunning) {
    const result = await session.stop();
    if (result) {
      // Wait for the abort to be processed, then clear stopRequested so next message can proceed
      await sleep(100);
      session.clearStopRequested();
    }
    // Silent stop - no message shown
  }
  // If nothing running, also stay silent
}

/**
 * /status - Show detailed status.
 */
export async function handleStatus(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  const lines: string[] = ["📊 <b>Bot Status</b>\n"];

  // Session status
  if (session.isActive) {
    lines.push(`✅ Session: Active (${session.sessionId?.slice(0, 8)}...)`);
  } else {
    lines.push("⚪ Session: None");
  }

  // Query status
  if (session.isRunning) {
    const elapsed = session.queryStarted
      ? Math.floor((Date.now() - session.queryStarted.getTime()) / 1000)
      : 0;
    lines.push(`🔄 Query: Running (${elapsed}s)`);
    if (session.currentTool) {
      lines.push(`   └─ ${session.currentTool}`);
    }
  } else {
    lines.push("⚪ Query: Idle");
    if (session.lastTool) {
      lines.push(`   └─ Last: ${session.lastTool}`);
    }
  }

  // Last activity
  if (session.lastActivity) {
    const ago = Math.floor(
      (Date.now() - session.lastActivity.getTime()) / 1000
    );
    lines.push(`\n⏱️ Last activity: ${ago}s ago`);
  }

  // Usage stats
  if (session.lastUsage) {
    const usage = session.lastUsage;
    lines.push(
      `\n📈 Last query usage:`,
      `   Input: ${usage.input_tokens?.toLocaleString() || "?"} tokens`,
      `   Output: ${usage.output_tokens?.toLocaleString() || "?"} tokens`
    );
    if (usage.cache_read_input_tokens) {
      lines.push(
        `   Cache read: ${usage.cache_read_input_tokens.toLocaleString()}`
      );
    }
  }

  // Error status
  if (session.lastError) {
    const ago = session.lastErrorTime
      ? Math.floor((Date.now() - session.lastErrorTime.getTime()) / 1000)
      : "?";
    lines.push(`\n⚠️ Last error (${ago}s ago):`, `   ${session.lastError}`);
  }

  // Working directory
  lines.push(`\n📁 Working dir: <code>${session.currentWorkingDir}</code>`);

  // Context percentage
  if (session.contextPercent !== null) {
    const pct = Math.min(session.contextPercent, 100);
    const filled = Math.min(Math.round(pct / 10), 10);
    const bar = "█".repeat(filled) + "░".repeat(10 - filled);
    lines.push(`\n${bar} ${pct}%`);
  }

  // Action buttons
  const buttons: { text: string; callback_data: string }[][] = [];
  if (session.isActive) {
    buttons.push([
      { text: "🆕 New Session", callback_data: "action:new" },
      { text: "📂 Switch Project", callback_data: "action:project" },
    ]);
    buttons.push([
      { text: "📋 GSD", callback_data: "action:gsd" },
      { text: "🔄 Retry Last", callback_data: "action:retry" },
    ]);
  } else {
    buttons.push([
      { text: "📂 Switch Project", callback_data: "action:project" },
      { text: "🔁 Resume", callback_data: "action:resume" },
    ]);
  }

  await ctx.reply(lines.join("\n"), {
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: buttons },
  });
}

/**
 * /resume - Show list of sessions to resume with inline keyboard.
 */
export async function handleResume(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  if (session.isActive) {
    await ctx.reply("Session already active. Use /new to start fresh.");
    return;
  }

  // Get saved sessions
  const sessions = session.getSessionList();

  if (sessions.length === 0) {
    await ctx.reply("❌ No saved sessions.");
    return;
  }

  // Build inline keyboard with session list
  const buttons = sessions.map((s) => {
    // Format date: "18/01 10:30"
    const date = new Date(s.saved_at);
    const dateStr = date.toLocaleDateString("en-US", {
      day: "2-digit",
      month: "2-digit",
    });
    const timeStr = date.toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
    });

    // Truncate title for button (max ~40 chars to fit)
    const titlePreview =
      s.title.length > 35 ? s.title.slice(0, 32) + "..." : s.title;

    return [
      {
        text: `📅 ${dateStr} ${timeStr} - "${titlePreview}"`,
        callback_data: `resume:${s.session_id}`,
      },
    ];
  });

  await ctx.reply("📋 <b>Saved Sessions</b>\n\nSelect a session to resume:", {
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: buttons,
    },
  });
}

/**
 * /restart - Restart the bot process.
 */
export async function handleRestart(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  const chatId = ctx.chat?.id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  const msg = await ctx.reply("🔄 Restarting bot...");

  // Save message info so we can update it after restart
  if (chatId && msg.message_id) {
    try {
      writeFileSync(
        RESTART_FILE,
        JSON.stringify({
          chat_id: chatId,
          message_id: msg.message_id,
          timestamp: Date.now(),
        })
      );
    } catch (e) {
      console.warn("Failed to save restart info:", e);
    }
  }

  // Give time for the message to send
  await sleep(500);

  // Exit - launchd will restart us
  process.exit(0);
}

/**
 * /project - Show project picker with inline keyboard.
 */
export async function handleProject(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  const projects = parseRegistry();
  if (projects.length === 0) {
    await ctx.reply("❌ Could not load project registry.");
    return;
  }

  // Find current project name
  const currentDir = session.currentWorkingDir.replace(/\\/g, "/");
  const currentProject = projects.find(
    (p) => p.location.replace(/\\/g, "/") === currentDir
  );
  const currentLabel = currentProject
    ? currentProject.name
    : currentDir.split("/").pop() || currentDir;

  // Build inline keyboard: one button per row
  // Active projects get a star prefix, current project gets a checkmark
  const buttons = projects.map((p, index) => {
    const isCurrent =
      p.location.replace(/\\/g, "/") === currentDir;
    const isActive = p.status === "Active";

    let label = p.name;
    if (isCurrent) label = `>> ${label}`;
    else if (isActive) label = `* ${label}`;

    return [
      {
        text: label,
        callback_data: `project:${index}`,
      },
    ];
  });

  await ctx.reply(
    `📂 <b>Switch Project</b>\n\n` +
      `Current: <b>${currentLabel}</b>\n` +
      `<code>${currentDir}</code>\n\n` +
      `<code>*</code> = Active  <code>>></code> = Current`,
    {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: buttons,
      },
    }
  );
}

/**
 * GSD operations for the inline keyboard.
 * Maps callback data suffix to [label, slash command].
 */
export const GSD_OPERATIONS: [string, string, string][] = [
  // Row 1: Most used
  ["progress", "Progress", "/gsd:progress"],
  ["quick", "Quick Task", "/gsd:quick"],
  // Row 2: Phase workflow
  ["plan", "Plan Phase", "/gsd:plan-phase"],
  ["execute", "Execute Phase", "/gsd:execute-phase"],
  // Row 3: Phase tools
  ["discuss", "Discuss Phase", "/gsd:discuss-phase"],
  ["research", "Research Phase", "/gsd:research-phase"],
  // Row 4: Verification
  ["verify", "Verify Work", "/gsd:verify-work"],
  ["audit", "Audit Milestone", "/gsd:audit-milestone"],
  // Row 5: Todos
  ["todos", "Check Todos", "/gsd:check-todos"],
  ["todo", "Add Todo", "/gsd:add-todo"],
  // Row 6: Phase management
  ["add-phase", "Add Phase", "/gsd:add-phase"],
  ["remove-phase", "Remove Phase", "/gsd:remove-phase"],
  // Row 7: Project management
  ["new-project", "New Project", "/gsd:new-project"],
  ["new-milestone", "New Milestone", "/gsd:new-milestone"],
  ["settings", "Settings", "/gsd:settings"],
  // Row 8: Debug & help
  ["debug", "Debug", "/gsd:debug"],
  ["help", "Help", "/gsd:help"],
];

/**
 * /gsd - Show GSD operations with inline keyboard and project context.
 */
export async function handleGsd(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  const workDir = session.currentWorkingDir;
  const projectName = workDir.replace(/\\/g, "/").split("/").pop() || workDir;

  // Parse roadmap for context
  const phases = parseRoadmap(workDir);

  // Build status summary
  let statusText = "";
  if (phases.length > 0) {
    const done = phases.filter((p) => p.status === "done").length;
    const total = phases.filter((p) => p.status !== "skipped").length;
    const nextPhase = phases.find((p) => p.status === "pending");

    statusText = `\n${done}/${total} phases complete`;
    if (nextPhase) {
      statusText += `\n\n<b>Next:</b> Phase ${nextPhase.number}: ${nextPhase.name}\n<i>${nextPhase.description}</i>`;
    }
  } else {
    statusText = "\n<i>No ROADMAP.md found</i>";
  }

  // Build inline keyboard: 2 buttons per row
  const buttons: { text: string; callback_data: string }[][] = [];
  for (let i = 0; i < GSD_OPERATIONS.length; i += 2) {
    const row: { text: string; callback_data: string }[] = [];
    row.push({
      text: GSD_OPERATIONS[i]![1],
      callback_data: `gsd:${GSD_OPERATIONS[i]![0]}`,
    });
    if (i + 1 < GSD_OPERATIONS.length) {
      row.push({
        text: GSD_OPERATIONS[i + 1]![1],
        callback_data: `gsd:${GSD_OPERATIONS[i + 1]![0]}`,
      });
    }
    buttons.push(row);
  }

  await ctx.reply(
    `<b>GSD</b> — <code>${projectName}</code>${statusText}`,
    {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: buttons,
      },
    }
  );
}

/**
 * /retry - Retry the last message (resume session and re-send).
 */
export async function handleRetry(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  // Check if there's a message to retry
  if (!session.lastMessage) {
    await ctx.reply("❌ No message to retry.");
    return;
  }

  // Check if something is already running
  if (session.isRunning) {
    await ctx.reply("⏳ A query is already running. Use /stop first.");
    return;
  }

  const message = session.lastMessage;
  await ctx.reply(`🔄 Retrying: "${message.slice(0, 50)}${message.length > 50 ? "..." : ""}"`);

  // Simulate sending the message again by emitting a fake text message event
  // We do this by directly calling the text handler logic
  const { handleText } = await import("./text");

  // Create a modified context with the last message
  const fakeCtx = {
    ...ctx,
    message: {
      ...ctx.message,
      text: message,
    },
  } as Context;

  await handleText(fakeCtx);
}

/**
 * /search - Search vault notes via Basic Memory FTS5.
 */
export async function handleSearch(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  const query = ctx.message?.text?.replace(/^\/search\s*/i, "").trim() || "";

  if (!query) {
    await ctx.reply(
      "Usage: /search &lt;query&gt;\nExample: /search juce plugin",
      { parse_mode: "HTML" }
    );
    return;
  }

  const results = searchVault(query, 10);
  const messages = formatResults(query, results);

  for (const msg of messages) {
    await ctx.reply(msg, { parse_mode: "HTML" });
  }
}
