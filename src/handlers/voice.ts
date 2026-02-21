/**
 * Voice message handler for Claude Telegram Bot.
 */

import type { Context } from "grammy";
import { unlinkSync, writeFileSync } from "fs";
import { session } from "../session";
import { ALLOWED_USERS, TEMP_DIR, TRANSCRIPTION_AVAILABLE } from "../config";
import { isAuthorized, rateLimiter } from "../security";
import {
  auditLog,
  auditLogRateLimit,
  transcribeVoice,
  startTypingIndicator,
} from "../utils";
import { StreamingState, createStatusCallback } from "./streaming";
import { autoDocument, formatDocReply } from "../autodoc";
import { escapeHtml } from "../formatting";

/**
 * Handle incoming voice messages.
 */
export async function handleVoice(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  const username = ctx.from?.username || "unknown";
  const chatId = ctx.chat?.id;
  const voice = ctx.message?.voice;

  if (!userId || !voice || !chatId) {
    return;
  }

  // 1. Authorization check
  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized. Contact the bot owner for access.");
    return;
  }

  // 2. Check if transcription is available
  if (!TRANSCRIPTION_AVAILABLE) {
    await ctx.reply(
      "Voice transcription is not configured. Set OPENAI_API_KEY in .env"
    );
    return;
  }

  // 3. Rate limit check
  const [allowed, retryAfter] = rateLimiter.check(userId);
  if (!allowed) {
    await auditLogRateLimit(userId, username, retryAfter!);
    await ctx.reply(
      `⏳ Rate limited. Please wait ${retryAfter!.toFixed(1)} seconds.`
    );
    return;
  }

  // 4. Mark processing started (allows /stop to work during transcription/classification)
  const stopProcessing = session.startProcessing();

  // 5. Start typing indicator for transcription
  const typing = startTypingIndicator(ctx);

  let voicePath: string | null = null;

  try {
    // 6. Download voice file
    const file = await ctx.getFile();
    const timestamp = Date.now();
    voicePath = `${TEMP_DIR}/voice_${timestamp}.ogg`;

    // Download the file
    const downloadRes = await fetch(
      `https://api.telegram.org/file/bot${ctx.api.token}/${file.file_path}`
    );
    const buffer = await downloadRes.arrayBuffer();
    writeFileSync(voicePath, Buffer.from(buffer));

    // 7. Transcribe
    const statusMsg = await ctx.reply("🎤 Transcribing...");

    const transcript = await transcribeVoice(voicePath);
    if (!transcript) {
      await ctx.api.editMessageText(
        chatId,
        statusMsg.message_id,
        "❌ Transcription failed."
      );
      stopProcessing();
      return;
    }

    // 8. Show transcript (truncate display if needed - full transcript still sent to Claude)
    const maxDisplay = 4000; // Leave room for 🎤 "" wrapper within 4096 limit
    const displayTranscript =
      transcript.length > maxDisplay
        ? transcript.slice(0, maxDisplay) + "…"
        : transcript;
    await ctx.api.editMessageText(
      chatId,
      statusMsg.message_id,
      `🎤 "${displayTranscript}"`
    );

    // 9. Set conversation title from transcript (if new session)
    if (!session.isActive) {
      const title =
        transcript.length > 50 ? transcript.slice(0, 47) + "..." : transcript;
      session.conversationTitle = title;
    }

    // 10. Create streaming state and callback
    const state = new StreamingState();
    const statusCallback = createStatusCallback(ctx, state);

    // 10b. Send "Processing..." message before Claude call
    const processingMsg = await ctx.reply("Processing...", { disable_notification: true });

    // 11. Send to Claude
    const claudeResponse = await session.sendMessageStreaming(
      transcript,
      username,
      userId,
      statusCallback,
      chatId,
      ctx
    );

    // Delete processing message after response
    try {
      await ctx.api.deleteMessage(chatId, processingMsg.message_id);
    } catch { /* already deleted */ }

    // 12. Auto-document the response
    try {
      const docResult = await autoDocument(transcript, claudeResponse);
      if (docResult) {
        await ctx.reply(formatDocReply(docResult, escapeHtml), {
          parse_mode: 'HTML',
          disable_notification: true,
        });
      }
    } catch (err) {
      console.error("Auto-documentation failed:", err);
    }

    // 13. Audit log
    await auditLog(userId, username, "VOICE", transcript, claudeResponse);
  } catch (error) {
    console.error("Error processing voice:", error);

    if (String(error).includes("abort") || String(error).includes("cancel")) {
      // Only show "Query stopped" if it was an explicit stop, not an interrupt from a new message
      const wasInterrupt = session.consumeInterruptFlag();
      if (!wasInterrupt) {
        await ctx.reply("🛑 Query stopped.");
      }
    } else {
      await ctx.reply("Something went wrong. Try again or /new for a fresh session.");
    }
  } finally {
    stopProcessing();
    typing.stop();

    // Clean up voice file
    if (voicePath) {
      try {
        unlinkSync(voicePath);
      } catch (error) {
        console.debug("Failed to delete voice file:", error);
      }
    }
  }
}
