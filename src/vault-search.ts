/**
 * Vault search module for Claude Telegram Bot.
 *
 * Provides direct FTS5 search against Basic Memory database (~/.basic-memory/memory.db).
 * Uses the same SQL and sanitization logic as the dashboard server.
 * Readonly connection -- never modifies the vault database.
 */

import { createRequire } from "module";
import { homedir } from "os";
import { join } from "path";
import { existsSync } from "fs";
import { escapeHtml } from "./formatting";
import { TELEGRAM_SAFE_LIMIT } from "./config";

// CJS interop for better-sqlite3 (native module, CommonJS only)
const require = createRequire(import.meta.url);

// ============== DB Path ==============

const DEFAULT_DB_PATH = join(homedir(), ".basic-memory", "memory.db");
const DB_PATH = process.env.BASIC_MEMORY_DB || DEFAULT_DB_PATH;

// ============== Types ==============

export interface VaultResult {
  id: number;
  title: string;
  excerpt: string;
  file_path: string;
}

// ============== DB Connection (lazy singleton) ==============

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let searchStmt: any = null;
let dbInitialized = false;

function initDb(): boolean {
  if (dbInitialized) return db !== null;

  dbInitialized = true;

  if (!existsSync(DB_PATH)) {
    console.warn(`[vault-search] DB not found at ${DB_PATH}`);
    return false;
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Database = require("better-sqlite3");
    db = new Database(DB_PATH, { readonly: true });

    searchStmt = db.prepare(`
      SELECT si.id, e.title,
        SUBSTR(COALESCE(si.content_snippet, e.title, ''), 1, 250) as excerpt,
        e.file_path
      FROM search_index si
      JOIN entity e ON si.entity_id = e.id
      WHERE search_index MATCH ?
      AND si.type = 'entity'
      ORDER BY si.rank
      LIMIT ?
    `);

    console.log(`[vault-search] Connected to ${DB_PATH}`);
    return true;
  } catch (err) {
    console.warn("[vault-search] Failed to connect:", err);
    db = null;
    searchStmt = null;
    return false;
  }
}

// ============== Query Sanitization ==============

/**
 * Strip FTS5 special characters and operators from user query.
 * Returns null if nothing useful remains after cleaning.
 */
export function sanitizeQuery(query: string): string | null {
  if (!query || !query.trim()) return null;

  const clean = query
    .replace(/[^\w\s\-]/g, " ")
    .replace(/\b(OR|AND|NOT|NEAR)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

  return clean || null;
}

// ============== Search ==============

/**
 * Search the vault using FTS5.
 * Returns up to `limit` results (default 10).
 * Never throws -- returns empty array on any error.
 */
export function searchVault(query: string, limit = 10): VaultResult[] {
  try {
    if (!initDb()) return [];

    const sanitized = sanitizeQuery(query);
    if (!sanitized) return [];

    const rows = searchStmt.all(sanitized, limit) as VaultResult[];
    return rows;
  } catch (err) {
    console.error("[vault-search] Query error:", err);
    return [];
  }
}

// ============== Formatting ==============

/**
 * Format vault search results as Telegram HTML messages.
 *
 * Splits into multiple messages when results would exceed TELEGRAM_SAFE_LIMIT.
 * Never splits a result across message boundaries.
 * Returns an array of message strings (usually 1, may be multiple for large result sets).
 */
export function formatResults(query: string, results: VaultResult[]): string[] {
  const escapedQuery = escapeHtml(query);

  if (results.length === 0) {
    return [`No vault notes found for: <code>${escapedQuery}</code>`];
  }

  const header = `<b>Vault search:</b> <code>${escapedQuery}</code> -- ${results.length} result(s)\n\n`;

  // Build individual result blocks
  const blocks: string[] = results.map((r, i) => {
    const title = escapeHtml(r.title || "Untitled");

    // Strip newlines, truncate to 120 chars
    const rawExcerpt = (r.excerpt || "").replace(/\n/g, " ").trim();
    const excerpt =
      rawExcerpt.length > 120
        ? escapeHtml(rawExcerpt.slice(0, 120)) + "..."
        : escapeHtml(rawExcerpt);

    // Take last segment of file_path as filename
    const parts = (r.file_path || "").split("/");
    const filename = escapeHtml(parts[parts.length - 1] || r.file_path || "");

    return `${i + 1}. <b>${title}</b>\n${excerpt}\n<code>${filename}</code>`;
  });

  // Split into messages at result boundaries, keeping under TELEGRAM_SAFE_LIMIT
  const messages: string[] = [];
  let buffer = header;

  for (const block of blocks) {
    const separator = buffer === header ? "" : "\n\n";
    const candidate = buffer + separator + block;

    if (candidate.length > TELEGRAM_SAFE_LIMIT && buffer !== header) {
      // Current buffer is full -- push it and start a new one
      messages.push(buffer);
      buffer = block;
    } else {
      buffer = candidate;
    }
  }

  // Push remaining buffer
  if (buffer) {
    messages.push(buffer);
  }

  return messages;
}
