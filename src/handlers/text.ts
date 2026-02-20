/**
 * Text message handler for Claude Telegram Bot.
 *
 * Plain-text messages (no / prefix) route to vault search.
 * Claude is accessible via /new, /resume, /retry commands.
 */

import type { Context } from "grammy";
import { ALLOWED_USERS } from "../config";
import { isAuthorized, rateLimiter } from "../security";
import { auditLogRateLimit, checkInterrupt } from "../utils";
import { searchVault, formatResults } from "../vault-search";

/**
 * Handle incoming text messages — routes to vault search.
 */
export async function handleText(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  const username = ctx.from?.username || "unknown";
  const chatId = ctx.chat?.id;
  let message = ctx.message?.text;

  if (!userId || !message || !chatId) {
    return;
  }

  // 1. Authorization check
  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized. Contact the bot owner for access.");
    return;
  }

  // 2. Check for interrupt prefix (pass-through, strip prefix if present)
  message = await checkInterrupt(message);
  if (!message.trim()) {
    return;
  }

  // 3. Rate limit check
  const [allowed, retryAfter] = rateLimiter.check(userId);
  if (!allowed) {
    await auditLogRateLimit(userId, username, retryAfter!);
    await ctx.reply(
      `Rate limited. Please wait ${retryAfter!.toFixed(1)} seconds.`
    );
    return;
  }

  // 4. Route to vault search
  const results = searchVault(message.trim(), 10);
  const messages = formatResults(message.trim(), results);

  for (const msg of messages) {
    await ctx.reply(msg, { parse_mode: "HTML" });
  }
}
