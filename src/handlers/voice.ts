/**
 * Voice message handler for Claude Telegram Bot.
 */

import type { Context } from "grammy";
import { unlinkSync } from "fs";
import { session } from "../session";
import { ALLOWED_USERS, INTENT_BLOCK_THRESHOLD, TEMP_DIR, TRANSCRIPTION_AVAILABLE } from "../config";
import { isAuthorized, rateLimiter, classifyIntent } from "../security";
import {
  auditLog,
  auditLogBlocked,
  auditLogRateLimit,
  transcribeVoice,
  startTypingIndicator,
} from "../utils";
import { StreamingState, createStatusCallback } from "./streaming";

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
    await ctx.reply("Voice transcription is not configured. Set OPENAI_API_KEY in .env");
    return;
  }

  // 3. Rate limit check
  const [allowed, retryAfter] = rateLimiter.check(userId);
  if (!allowed) {
    await auditLogRateLimit(userId, username, retryAfter!);
    await ctx.reply(`⏳ Rate limited. Please wait ${retryAfter!.toFixed(1)} seconds.`);
    return;
  }

  // 4. Start typing indicator for transcription
  const typing = startTypingIndicator(ctx);

  let voicePath: string | null = null;

  try {
    // 5. Download voice file
    const file = await ctx.getFile();
    const timestamp = Date.now();
    voicePath = `${TEMP_DIR}/voice_${timestamp}.ogg`;

    // Download the file
    const downloadRes = await fetch(
      `https://api.telegram.org/file/bot${ctx.api.token}/${file.file_path}`
    );
    const buffer = await downloadRes.arrayBuffer();
    await Bun.write(voicePath, buffer);

    // 6. Transcribe
    const statusMsg = await ctx.reply("🎤 Transcribing...");

    const transcript = await transcribeVoice(voicePath);
    if (!transcript) {
      await ctx.api.editMessageText(chatId, statusMsg.message_id, "❌ Transcription failed.");
      return;
    }

    // 7. Show transcript
    await ctx.api.editMessageText(chatId, statusMsg.message_id, `🎤 "${transcript}"`);

    // 8. Intent classification
    const intent = await classifyIntent(transcript);
    if (!intent.safe && intent.confidence > INTENT_BLOCK_THRESHOLD) {
      console.warn(`Blocked voice from ${username}: ${intent.reason}`);
      await auditLogBlocked(userId, username, transcript, intent.reason, intent.confidence);
      await ctx.reply("I can't help with that request.");
      return;
    }

    // 9. Create streaming state and callback
    const state = new StreamingState();
    const statusCallback = createStatusCallback(ctx, state);

    // 10. Send to Claude
    const claudeResponse = await session.sendMessageStreaming(
      transcript,
      username,
      userId,
      statusCallback,
      chatId,
      ctx
    );

    // 11. Audit log
    await auditLog(userId, username, "VOICE", transcript, claudeResponse);
  } catch (error) {
    console.error("Error processing voice:", error);

    if (String(error).includes("abort") || String(error).includes("cancel")) {
      await ctx.reply("🛑 Query stopped.");
    } else {
      await ctx.reply(`❌ Error: ${String(error).slice(0, 200)}`);
    }
  } finally {
    typing.stop();

    // Clean up voice file
    if (voicePath) {
      try {
        unlinkSync(voicePath);
      } catch {
        // Ignore cleanup errors
      }
    }
  }
}
