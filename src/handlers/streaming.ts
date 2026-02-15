/**
 * Shared streaming callback for Claude Telegram Bot handlers.
 *
 * Provides a reusable status callback for streaming Claude responses.
 */

import type { Context } from "grammy";
import type { Message } from "grammy/types";
import { InlineKeyboard } from "grammy";
import { readdirSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { resolve } from "path";
import type { StatusCallback } from "../types";
import { convertMarkdownToHtml, escapeHtml } from "../formatting";
import {
  TELEGRAM_MESSAGE_LIMIT,
  TELEGRAM_SAFE_LIMIT,
  STREAMING_THROTTLE_MS,
  BUTTON_LABEL_MAX_LENGTH,
} from "../config";

/**
 * Create inline keyboard for ask_user options.
 */
export function createAskUserKeyboard(
  requestId: string,
  options: string[]
): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (let idx = 0; idx < options.length; idx++) {
    const option = options[idx]!;
    // Truncate long options for button display
    const display =
      option.length > BUTTON_LABEL_MAX_LENGTH
        ? option.slice(0, BUTTON_LABEL_MAX_LENGTH) + "..."
        : option;
    const callbackData = `askuser:${requestId}:${idx}`;
    keyboard.text(display, callbackData).row();
  }
  return keyboard;
}

/**
 * Check for pending ask-user requests and send inline keyboards.
 */
export async function checkPendingAskUserRequests(
  ctx: Context,
  chatId: number
): Promise<boolean> {
  const tmp = tmpdir();
  let buttonsSent = false;
  const files = readdirSync(tmp).filter(
    (f) => f.startsWith("ask-user-") && f.endsWith(".json")
  );

  for (const filename of files) {
    const filepath = resolve(tmp, filename);
    try {
      const text = readFileSync(filepath, "utf-8");
      const data = JSON.parse(text);

      // Only process pending requests for this chat
      if (data.status !== "pending") continue;
      if (String(data.chat_id) !== String(chatId)) continue;

      const question = data.question || "Please choose:";
      const options = data.options || [];
      const requestId = data.request_id || "";

      if (options.length > 0 && requestId) {
        const keyboard = createAskUserKeyboard(requestId, options);
        await ctx.reply(`❓ ${question}`, { reply_markup: keyboard });
        buttonsSent = true;

        // Mark as sent
        data.status = "sent";
        writeFileSync(filepath, JSON.stringify(data));
      }
    } catch (error) {
      console.warn(`Failed to process ask-user file ${filepath}:`, error);
    }
  }

  return buttonsSent;
}

/**
 * Tracks state for streaming message updates.
 */
export class StreamingState {
  textMessages = new Map<number, Message>(); // segment_id -> telegram message
  toolMessages: Message[] = []; // ephemeral tool status messages
  statusMsg: Message | null = null; // single reusable status message (thinking/tools)
  lastEditTimes = new Map<number, number>(); // segment_id -> last edit time
  lastContent = new Map<number, string>(); // segment_id -> last sent content
}

/**
 * Format content for Telegram, ensuring it fits within the message limit.
 * Truncates raw content and re-converts if HTML output exceeds the limit.
 */
function formatWithinLimit(
  content: string,
  safeLimit: number = TELEGRAM_SAFE_LIMIT
): string {
  let display =
    content.length > safeLimit ? content.slice(0, safeLimit) + "..." : content;
  let formatted = convertMarkdownToHtml(display);

  // HTML tags can inflate content beyond the limit - shrink until it fits
  if (formatted.length > TELEGRAM_MESSAGE_LIMIT) {
    const ratio = TELEGRAM_MESSAGE_LIMIT / formatted.length;
    display = content.slice(0, Math.floor(safeLimit * ratio * 0.95)) + "...";
    formatted = convertMarkdownToHtml(display);
  }

  return formatted;
}

/**
 * Split long formatted content into chunks and send as separate messages.
 */
async function sendChunkedMessages(
  ctx: Context,
  content: string
): Promise<void> {
  // Split on markdown content first, then format each chunk
  for (let i = 0; i < content.length; i += TELEGRAM_SAFE_LIMIT) {
    const chunk = content.slice(i, i + TELEGRAM_SAFE_LIMIT);
    try {
      await ctx.reply(chunk, { parse_mode: "HTML" });
    } catch {
      // HTML failed (possibly broken tags from split) - try plain text
      try {
        await ctx.reply(chunk);
      } catch (plainError) {
        console.debug("Failed to send chunk:", plainError);
      }
    }
  }
}

/**
 * Create a status callback for streaming updates.
 */
export function createStatusCallback(
  ctx: Context,
  state: StreamingState
): StatusCallback {
  return async (statusType: string, content: string, segmentId?: number) => {
    try {
      if (statusType === "thinking") {
        // Show thinking in the single status message (compact)
        const preview =
          content.length > 300 ? content.slice(0, 300) + "..." : content;
        const escaped = escapeHtml(preview);
        const text = `🧠 <i>${escaped}</i>`;

        if (state.statusMsg) {
          try {
            await ctx.api.editMessageText(
              state.statusMsg.chat.id,
              state.statusMsg.message_id,
              text,
              { parse_mode: "HTML" }
            );
          } catch {
            // Edit failed — send new
            state.statusMsg = await ctx.reply(text, {
              parse_mode: "HTML",
              disable_notification: true,
            });
            state.toolMessages.push(state.statusMsg);
          }
        } else {
          state.statusMsg = await ctx.reply(text, {
            parse_mode: "HTML",
            disable_notification: true,
          });
          state.toolMessages.push(state.statusMsg);
        }
      } else if (statusType === "tool") {
        // Edit the single status message with tool info
        if (state.statusMsg) {
          try {
            await ctx.api.editMessageText(
              state.statusMsg.chat.id,
              state.statusMsg.message_id,
              content,
              { parse_mode: "HTML" }
            );
          } catch {
            // Edit failed — send new
            state.statusMsg = await ctx.reply(content, {
              parse_mode: "HTML",
              disable_notification: true,
            });
            state.toolMessages.push(state.statusMsg);
          }
        } else {
          state.statusMsg = await ctx.reply(content, {
            parse_mode: "HTML",
            disable_notification: true,
          });
          state.toolMessages.push(state.statusMsg);
        }
      } else if (statusType === "text" && segmentId !== undefined) {
        const now = Date.now();
        const lastEdit = state.lastEditTimes.get(segmentId) || 0;

        if (!state.textMessages.has(segmentId)) {
          // New segment - create message (silent — final segment_end will notify)
          const formatted = formatWithinLimit(content);
          try {
            const msg = await ctx.reply(formatted, {
              parse_mode: "HTML",
              disable_notification: true,
            });
            state.textMessages.set(segmentId, msg);
            state.lastContent.set(segmentId, formatted);
          } catch (htmlError) {
            // HTML parse failed, fall back to plain text
            console.debug("HTML reply failed, using plain text:", htmlError);
            const msg = await ctx.reply(formatted, {
              disable_notification: true,
            });
            state.textMessages.set(segmentId, msg);
            state.lastContent.set(segmentId, formatted);
          }
          state.lastEditTimes.set(segmentId, now);
        } else if (now - lastEdit > STREAMING_THROTTLE_MS) {
          // Update existing segment message (throttled)
          const msg = state.textMessages.get(segmentId)!;
          const formatted = formatWithinLimit(content);
          // Skip if content unchanged
          if (formatted === state.lastContent.get(segmentId)) {
            return;
          }
          try {
            await ctx.api.editMessageText(
              msg.chat.id,
              msg.message_id,
              formatted,
              {
                parse_mode: "HTML",
              }
            );
            state.lastContent.set(segmentId, formatted);
          } catch (error) {
            const errorStr = String(error);
            if (errorStr.includes("MESSAGE_TOO_LONG")) {
              // Skip this intermediate update - segment_end will chunk properly
              console.debug(
                "Streaming edit too long, deferring to segment_end"
              );
            } else {
              console.debug("HTML edit failed, trying plain text:", error);
              try {
                await ctx.api.editMessageText(
                  msg.chat.id,
                  msg.message_id,
                  formatted
                );
                state.lastContent.set(segmentId, formatted);
              } catch (editError) {
                console.debug("Edit message failed:", editError);
              }
            }
          }
          state.lastEditTimes.set(segmentId, now);
        }
      } else if (statusType === "segment_end" && segmentId !== undefined) {
        if (content) {
          const formatted = convertMarkdownToHtml(content);

          if (!state.textMessages.has(segmentId)) {
            // No message was created during streaming (short response) - send new
            if (formatted.length <= TELEGRAM_MESSAGE_LIMIT) {
              try {
                await ctx.reply(formatted, { parse_mode: "HTML" });
              } catch {
                try {
                  await ctx.reply(formatted);
                } catch (plainError) {
                  console.debug("Failed to send final message:", plainError);
                }
              }
            } else {
              await sendChunkedMessages(ctx, formatted);
            }
          } else {
            const msg = state.textMessages.get(segmentId)!;

            // Skip if content unchanged
            if (formatted === state.lastContent.get(segmentId)) {
              return;
            }

            if (formatted.length <= TELEGRAM_MESSAGE_LIMIT) {
              try {
                await ctx.api.editMessageText(
                  msg.chat.id,
                  msg.message_id,
                  formatted,
                  {
                    parse_mode: "HTML",
                  }
                );
              } catch (error) {
                const errorStr = String(error);
                if (errorStr.includes("MESSAGE_TOO_LONG")) {
                  // HTML overhead pushed it over - delete and chunk
                  try {
                    await ctx.api.deleteMessage(msg.chat.id, msg.message_id);
                  } catch (delError) {
                    console.debug("Failed to delete for chunking:", delError);
                  }
                  await sendChunkedMessages(ctx, formatted);
                } else {
                  console.debug("Failed to edit final message:", error);
                }
              }
            } else {
              // Too long - delete and split
              try {
                await ctx.api.deleteMessage(msg.chat.id, msg.message_id);
              } catch (error) {
                console.debug("Failed to delete message for splitting:", error);
              }
              await sendChunkedMessages(ctx, formatted);
            }
          }
        }
      } else if (statusType === "done") {
        // Delete tool messages - text messages stay
        for (const toolMsg of state.toolMessages) {
          try {
            await ctx.api.deleteMessage(toolMsg.chat.id, toolMsg.message_id);
          } catch (error) {
            console.debug("Failed to delete tool message:", error);
          }
        }
      }
    } catch (error) {
      console.error("Status callback error:", error);
    }
  };
}
