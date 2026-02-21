/**
 * Callback query handler for Claude Telegram Bot.
 *
 * Handles inline keyboard button presses (ask_user MCP integration).
 */

import type { Context } from "grammy";
import { unlinkSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { resolve } from "path";
import { session } from "../session";
import { ALLOWED_USERS } from "../config";
import { isAuthorized } from "../security";
import { auditLog, sleep, startTypingIndicator } from "../utils";
import { StreamingState, createStatusCallback } from "./streaming";
import { parseRegistry } from "../registry";
import { GSD_OPERATIONS, parseRoadmap, handleGsd, handleProject, handleResume, handleRetry, sendGsdCommand } from "./commands";

/**
 * Handle callback queries from inline keyboards.
 */
export async function handleCallback(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  const username = ctx.from?.username || "unknown";
  const chatId = ctx.chat?.id;
  const callbackData = ctx.callbackQuery?.data;

  if (!userId || !chatId || !callbackData) {
    await ctx.answerCallbackQuery();
    return;
  }

  // 1. Authorization check
  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.answerCallbackQuery({ text: "Unauthorized" });
    return;
  }

  // 2. Handle resume callbacks: resume:{session_id}
  if (callbackData.startsWith("resume:")) {
    await handleResumeCallback(ctx, callbackData);
    return;
  }

  // 2b. Handle project callbacks: project:{index}
  if (callbackData.startsWith("project:")) {
    await handleProjectCallback(ctx, callbackData);
    return;
  }

  // 2c. Handle quick action callbacks: action:{name}
  if (callbackData.startsWith("action:")) {
    await handleActionCallback(ctx, callbackData, chatId);
    return;
  }

  // 2d. Handle gsd-run: — Run a GSD command in the current session
  if (callbackData.startsWith("gsd-run:")) {
    const command = callbackData.replace("gsd-run:", "");
    try { await ctx.deleteMessage(); } catch {}
    await ctx.answerCallbackQuery();
    await sendGsdCommand(ctx, command, command, username, userId, chatId);
    return;
  }

  // 2e. Handle gsd-fresh: — Clear session, then run GSD command
  if (callbackData.startsWith("gsd-fresh:")) {
    const command = callbackData.replace("gsd-fresh:", "");
    try { await ctx.deleteMessage(); } catch {}
    await ctx.answerCallbackQuery();
    // Kill session first
    if (session.isRunning) {
      await session.stop();
      await sleep(100);
      session.clearStopRequested();
    }
    await session.kill();
    await sendGsdCommand(ctx, command, command, username, userId, chatId);
    return;
  }

  // 2f. Handle GSD callbacks: gsd:{operation}
  if (callbackData.startsWith("gsd:")) {
    await handleGsdCallback(ctx, callbackData, chatId);
    return;
  }

  // 2g. Handle GSD phase picker: gsd-{op}:{phase}
  const gsdPhasePrefixes = ["gsd-exec:", "gsd-plan:", "gsd-discuss:", "gsd-research:", "gsd-verify:", "gsd-remove:"];
  if (gsdPhasePrefixes.some((p) => callbackData.startsWith(p))) {
    await handleGsdPhaseCallback(ctx, callbackData, chatId);
    return;
  }

  // 3. Parse callback data: askuser:{request_id}:{option_index}
  if (!callbackData.startsWith("askuser:")) {
    await ctx.answerCallbackQuery();
    return;
  }

  const parts = callbackData.split(":");
  if (parts.length !== 3) {
    await ctx.answerCallbackQuery({ text: "Invalid callback data" });
    return;
  }

  const requestId = parts[1]!;
  const optionIndex = parseInt(parts[2]!, 10);

  // 3. Load request file
  const requestFile = resolve(tmpdir(), `ask-user-${requestId}.json`);
  let requestData: {
    question: string;
    options: string[];
    status: string;
  };

  try {
    const text = readFileSync(requestFile, "utf-8");
    requestData = JSON.parse(text);
  } catch (error) {
    console.error(`Failed to load ask-user request ${requestId}:`, error);
    await ctx.answerCallbackQuery({ text: "Request expired or invalid" });
    return;
  }

  // 4. Get selected option
  if (optionIndex < 0 || optionIndex >= requestData.options.length) {
    await ctx.answerCallbackQuery({ text: "Invalid option" });
    return;
  }

  const selectedOption = requestData.options[optionIndex]!;

  // 5. Update the message to show selection
  try {
    await ctx.editMessageText(`✓ ${selectedOption}`);
  } catch (error) {
    console.debug("Failed to edit callback message:", error);
  }

  // 6. Answer the callback
  await ctx.answerCallbackQuery({
    text: `Selected: ${selectedOption.slice(0, 50)}`,
  });

  // 7. Delete request file
  try {
    unlinkSync(requestFile);
  } catch (error) {
    console.debug("Failed to delete request file:", error);
  }

  // 8. Send the choice to Claude as a message
  const message = selectedOption;

  // Interrupt any running query - button responses are always immediate
  if (session.isRunning) {
    console.log("Interrupting current query for button response");
    await session.stop();
    // Small delay to ensure clean interruption
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  // Start typing
  const typing = startTypingIndicator(ctx);

  // Create streaming state
  const state = new StreamingState();
  const statusCallback = createStatusCallback(ctx, state);

  try {
    const response = await session.sendMessageStreaming(
      message,
      username,
      userId,
      statusCallback,
      chatId,
      ctx
    );

    await auditLog(userId, username, "CALLBACK", message, response);
  } catch (error) {
    console.error("Error processing callback:", error);

    for (const toolMsg of state.toolMessages) {
      try {
        await ctx.api.deleteMessage(toolMsg.chat.id, toolMsg.message_id);
      } catch (error) {
        console.debug("Failed to delete tool message:", error);
      }
    }

    if (String(error).includes("abort") || String(error).includes("cancel")) {
      // Only show "Query stopped" if it was an explicit stop, not an interrupt from a new message
      const wasInterrupt = session.consumeInterruptFlag();
      if (!wasInterrupt) {
        await ctx.reply("🛑 Query stopped.");
      }
    } else {
      await ctx.reply(`❌ Error: ${String(error).slice(0, 200)}`);
    }
  } finally {
    typing.stop();
  }
}

/**
 * Handle quick action button callbacks (action:{name}).
 * Dismisses the button row and delegates to the corresponding command handler.
 */
async function handleActionCallback(
  ctx: Context,
  callbackData: string,
  chatId: number
): Promise<void> {
  const action = callbackData.replace("action:", "");

  // Remove the button row message
  try {
    await ctx.deleteMessage();
  } catch {
    // May already be deleted
  }
  await ctx.answerCallbackQuery();

  switch (action) {
    case "stop":
      if (session.isRunning) {
        const result = await session.stop();
        if (result) {
          await sleep(100);
          session.clearStopRequested();
        }
        await ctx.reply("🛑 Stopped.");
      } else {
        await ctx.reply("Nothing running.");
      }
      break;

    case "retry":
      await handleRetry(ctx);
      break;

    case "new":
      if (session.isRunning) {
        await session.stop();
        await sleep(100);
        session.clearStopRequested();
      }
      await session.kill();
      await ctx.reply("🆕 Session cleared. Next message starts fresh.");
      break;

    case "gsd":
      await handleGsd(ctx);
      break;

    case "project":
      await handleProject(ctx);
      break;

    case "resume":
      await handleResume(ctx);
      break;

    default:
      await ctx.reply(`Unknown action: ${action}`);
  }
}

/**
 * Handle resume session callback (resume:{session_id}).
 */
async function handleResumeCallback(
  ctx: Context,
  callbackData: string
): Promise<void> {
  const userId = ctx.from?.id;
  const username = ctx.from?.username || "unknown";
  const chatId = ctx.chat?.id;
  const sessionId = callbackData.replace("resume:", "");

  if (!sessionId || !userId || !chatId) {
    await ctx.answerCallbackQuery({ text: "Invalid session ID" });
    return;
  }

  // Check if session is already active
  if (session.isActive) {
    await ctx.answerCallbackQuery({ text: "Session already active" });
    return;
  }

  // Resume the selected session
  const [success, message] = session.resumeSession(sessionId);

  if (!success) {
    await ctx.answerCallbackQuery({ text: message, show_alert: true });
    return;
  }

  // Update the original message to show selection
  try {
    await ctx.editMessageText(`✅ ${message}`);
  } catch (error) {
    console.debug("Failed to edit resume message:", error);
  }
  await ctx.answerCallbackQuery({ text: "Session resumed!" });

  // Send a hidden recap prompt to Claude
  const recapPrompt =
    "Please write a very concise recap of where we are in this conversation, to refresh my memory. Max 2-3 sentences.";

  const typing = startTypingIndicator(ctx);
  const state = new StreamingState();
  const statusCallback = createStatusCallback(ctx, state);

  try {
    await session.sendMessageStreaming(
      recapPrompt,
      username,
      userId,
      statusCallback,
      chatId,
      ctx
    );
  } catch (error) {
    console.error("Error getting recap:", error);
    // Don't show error to user - session is still resumed, recap just failed
  } finally {
    typing.stop();
  }
}

/**
 * Handle project switch callback (project:{index}).
 */
async function handleProjectCallback(
  ctx: Context,
  callbackData: string
): Promise<void> {
  const index = parseInt(callbackData.replace("project:", ""), 10);

  // Re-parse registry with same sort order
  const projects = parseRegistry();

  if (isNaN(index) || index < 0 || index >= projects.length) {
    await ctx.answerCallbackQuery({ text: "Invalid project selection" });
    return;
  }

  const project = projects[index]!;

  // Normalize path for Windows (registry uses backslashes)
  const projectPath = project.location.replace(/\//g, "\\");

  // Validate directory exists
  if (!existsSync(projectPath)) {
    await ctx.answerCallbackQuery({
      text: `Directory not found: ${projectPath}`,
      show_alert: true,
    });
    return;
  }

  // Kill active session if any
  if (session.isRunning) {
    await session.stop();
    await new Promise((r) => setTimeout(r, 100));
    session.clearStopRequested();
  }
  if (session.isActive) {
    await session.kill();
  }

  // Switch working directory
  try {
    session.setWorkingDir(projectPath);
  } catch (error) {
    await ctx.answerCallbackQuery({
      text: `Failed: ${String(error).slice(0, 100)}`,
      show_alert: true,
    });
    return;
  }

  // Update message to show confirmation
  try {
    await ctx.editMessageText(
      `📂 Switched to <b>${project.name}</b>\n<code>${projectPath}</code>`,
      { parse_mode: "HTML" }
    );
  } catch (error) {
    console.debug("Failed to edit project message:", error);
  }

  await ctx.answerCallbackQuery({ text: `Switched to ${project.name}` });
}

/**
 * Operations that show a phase picker instead of sending immediately.
 */
const PHASE_PICKER_OPS: Record<string, string> = {
  execute: "gsd-exec",
  plan: "gsd-plan",
  discuss: "gsd-discuss",
  research: "gsd-research",
  verify: "gsd-verify",
  "remove-phase": "gsd-remove",
};

/**
 * Handle GSD operation callback (gsd:{operation}).
 * Some operations show a phase picker, others send immediately.
 */
async function handleGsdCallback(
  ctx: Context,
  callbackData: string,
  chatId: number
): Promise<void> {
  const username = ctx.from?.username || "unknown";
  const userId = ctx.from?.id!;
  const operation = callbackData.replace("gsd:", "");

  // Find the matching operation
  const entry = GSD_OPERATIONS.find((op) => op[0] === operation);
  if (!entry) {
    await ctx.answerCallbackQuery({ text: "Unknown GSD operation" });
    return;
  }

  const [, label, command] = entry;

  // Check if this operation needs a phase picker
  const pickerPrefix = PHASE_PICKER_OPS[operation];
  if (pickerPrefix) {
    const phases = parseRoadmap(session.currentWorkingDir);
    // Verify shows all phases (done + pending), others show only pending
    const showDone = operation === "verify";
    const filteredPhases = showDone
      ? phases.filter((p) => p.status !== "skipped")
      : phases.filter((p) => p.status === "pending");

    if (filteredPhases.length === 0) {
      await ctx.answerCallbackQuery({
        text: showDone ? "No phases found" : "No pending phases found",
        show_alert: true,
      });
      return;
    }

    // Build phase picker keyboard: one button per row
    const buttons = filteredPhases.map((p) => [
      {
        text: `Phase ${p.number}: ${p.name}`,
        callback_data: `${pickerPrefix}:${p.number}`,
      },
    ]);

    try {
      await ctx.editMessageText(
        `<b>GSD</b> → ${label}\n\nSelect a phase:`,
        {
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: buttons },
        }
      );
    } catch (error) {
      console.debug("Failed to edit GSD message:", error);
    }

    await ctx.answerCallbackQuery();
    return;
  }

  // Direct operations: send command immediately
  try {
    await ctx.editMessageText(`<b>GSD</b> → ${label}`, {
      parse_mode: "HTML",
    });
  } catch (error) {
    console.debug("Failed to edit GSD message:", error);
  }

  await ctx.answerCallbackQuery({ text: label });

  await sendGsdCommand(ctx, command, label, username, userId, chatId);
}

/**
 * Map gsd phase callback prefix to slash command and label.
 */
const PHASE_CALLBACK_MAP: Record<string, [string, string]> = {
  "gsd-exec": ["/gsd:execute-phase", "Execute Phase"],
  "gsd-plan": ["/gsd:plan-phase", "Plan Phase"],
  "gsd-discuss": ["/gsd:discuss-phase", "Discuss Phase"],
  "gsd-research": ["/gsd:research-phase", "Research Phase"],
  "gsd-verify": ["/gsd:verify-work", "Verify Phase"],
  "gsd-remove": ["/gsd:remove-phase", "Remove Phase"],
};

/**
 * Handle GSD phase picker callback (gsd-{op}:{phase}).
 */
async function handleGsdPhaseCallback(
  ctx: Context,
  callbackData: string,
  chatId: number
): Promise<void> {
  const username = ctx.from?.username || "unknown";
  const userId = ctx.from?.id!;

  const [prefix, phaseNum] = callbackData.split(":");
  const mapping = PHASE_CALLBACK_MAP[prefix!];
  if (!mapping || !phaseNum) {
    await ctx.answerCallbackQuery({ text: "Unknown phase operation" });
    return;
  }
  const [slashCmd, labelPrefix] = mapping;
  const command = `${slashCmd} ${phaseNum}`;
  const label = `${labelPrefix} ${phaseNum}`;

  // Update message to show selection
  try {
    await ctx.editMessageText(`<b>GSD</b> → ${label}`, {
      parse_mode: "HTML",
    });
  } catch (error) {
    console.debug("Failed to edit GSD phase message:", error);
  }

  await ctx.answerCallbackQuery({ text: label });

  await sendGsdCommand(ctx, command, label, username, userId, chatId);
}

