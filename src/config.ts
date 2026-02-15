/**
 * Configuration for Claude Telegram Bot.
 *
 * All environment variables, paths, constants, and safety settings.
 * Adapted for Node.js on Windows.
 */

import "dotenv/config";
import { homedir, tmpdir } from "os";
import { resolve, dirname } from "path";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "fs";
import { execSync } from "child_process";
import type { McpServerConfig } from "./types";

// ============== Core Configuration ==============

export const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
export const ALLOWED_USERS: number[] = (
  process.env.TELEGRAM_ALLOWED_USERS || ""
)
  .split(",")
  .filter((x) => x.trim())
  .map((x) => parseInt(x.trim(), 10))
  .filter((x) => !isNaN(x));

const HOME = homedir();
export const WORKING_DIR = process.env.CLAUDE_WORKING_DIR || HOME;
export const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";

// ============== Claude CLI Path ==============

function findClaudeCli(): string {
  const envPath = process.env.CLAUDE_CLI_PATH;
  if (envPath) return envPath;

  // Try to find claude in PATH
  try {
    const result = execSync("where claude", { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
    const firstLine = result.trim().split(/\r?\n/)[0];
    if (firstLine) return firstLine;
  } catch {
    // Not found in PATH
  }

  // Fallback — common Windows location
  const npmGlobal = resolve(process.env.APPDATA || "", "npm", "claude.cmd");
  if (existsSync(npmGlobal)) return npmGlobal;

  return "claude";
}

export const CLAUDE_CLI_PATH = findClaudeCli();

// ============== MCP Configuration ==============

let MCP_SERVERS: Record<string, McpServerConfig> = {};

try {
  const mcpConfigPath = resolve(
    dirname(import.meta.dirname || "."),
    "mcp-config.ts"
  );
  if (existsSync(mcpConfigPath)) {
    const mcpModule = await import(mcpConfigPath).catch(() => null);
    if (mcpModule?.MCP_SERVERS) {
      MCP_SERVERS = mcpModule.MCP_SERVERS;
      console.log(
        `Loaded ${Object.keys(MCP_SERVERS).length} MCP servers from mcp-config.ts`
      );
    }
  }
} catch {
  console.log("No mcp-config.ts found - running without MCPs");
}

export { MCP_SERVERS };

// ============== Security Configuration ==============

const defaultAllowedPaths = [
  WORKING_DIR,
  resolve(HOME, "Documents"),
  resolve(HOME, "Downloads"),
  resolve(HOME, "Desktop"),
  resolve(HOME, ".claude"),
];

const allowedPathsStr = process.env.ALLOWED_PATHS || "";
export const ALLOWED_PATHS: string[] = allowedPathsStr
  ? allowedPathsStr
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean)
  : defaultAllowedPaths;

function buildSafetyPrompt(allowedPaths: string[]): string {
  const pathsList = allowedPaths
    .map((p) => `   - ${p} (and subdirectories)`)
    .join("\n");

  return `
CRITICAL SAFETY RULES FOR TELEGRAM BOT:

1. NEVER delete, remove, or overwrite files without EXPLICIT confirmation from the user.
   - If user asks to delete something, respond: "Are you sure you want to delete [file]? Reply 'yes delete it' to confirm."
   - Only proceed with deletion if user replies with explicit confirmation like "yes delete it", "confirm delete"
   - This applies to: rm, trash, unlink, shred, or any file deletion

2. You can ONLY access files in these directories:
${pathsList}
   - REFUSE any file operations outside these paths

3. NEVER run dangerous commands like:
   - rm -rf (recursive force delete)
   - Any command that affects files outside allowed directories
   - Commands that could damage the system

4. For any destructive or irreversible action, ALWAYS ask for confirmation first.

You are running via Telegram, so the user cannot easily undo mistakes. Be extra careful!
`;
}

export const SAFETY_PROMPT = buildSafetyPrompt(ALLOWED_PATHS);

export const BLOCKED_PATTERNS = [
  "rm -rf /",
  "rm -rf ~",
  "rm -rf $HOME",
  "rm -rf %USERPROFILE%",
  "sudo rm",
  ":(){ :|:& };:",
  "> /dev/sd",
  "mkfs.",
  "dd if=",
  "format c:",
  "del /s /q c:",
];

export const QUERY_TIMEOUT_MS = 180_000;

// ============== Voice Transcription ==============

const BASE_TRANSCRIPTION_PROMPT = `Transcribe this voice message accurately.
The speaker may use multiple languages (English, and possibly others).
Focus on accuracy for proper nouns, technical terms, and commands.`;

let TRANSCRIPTION_CONTEXT = "";
if (process.env.TRANSCRIPTION_CONTEXT_FILE) {
  try {
    if (existsSync(process.env.TRANSCRIPTION_CONTEXT_FILE)) {
      TRANSCRIPTION_CONTEXT = readFileSync(
        process.env.TRANSCRIPTION_CONTEXT_FILE,
        "utf-8"
      ).trim();
    }
  } catch {
    // File not found or unreadable
  }
}

export const TRANSCRIPTION_PROMPT = TRANSCRIPTION_CONTEXT
  ? `${BASE_TRANSCRIPTION_PROMPT}\n\nAdditional context:\n${TRANSCRIPTION_CONTEXT}`
  : BASE_TRANSCRIPTION_PROMPT;

export const TRANSCRIPTION_AVAILABLE = !!OPENAI_API_KEY;

// ============== Thinking Keywords ==============

const thinkingKeywordsStr =
  process.env.THINKING_KEYWORDS || "think,reason,analyze";
const thinkingDeepKeywordsStr =
  process.env.THINKING_DEEP_KEYWORDS || "ultrathink,think hard,think deeply";

export const THINKING_KEYWORDS = thinkingKeywordsStr
  .split(",")
  .map((k) => k.trim().toLowerCase());
export const THINKING_DEEP_KEYWORDS = thinkingDeepKeywordsStr
  .split(",")
  .map((k) => k.trim().toLowerCase());

// ============== Media Group Settings ==============

export const MEDIA_GROUP_TIMEOUT = 1000;

// ============== Telegram Message Limits ==============

export const TELEGRAM_MESSAGE_LIMIT = 4096;
export const TELEGRAM_SAFE_LIMIT = 4000;
export const STREAMING_THROTTLE_MS = 500;
export const BUTTON_LABEL_MAX_LENGTH = 30;

// ============== Audit Logging ==============

export const AUDIT_LOG_PATH =
  process.env.AUDIT_LOG_PATH || resolve(tmpdir(), "claude-telegram-audit.log");
export const AUDIT_LOG_JSON =
  (process.env.AUDIT_LOG_JSON || "false").toLowerCase() === "true";

// ============== Rate Limiting ==============

export const RATE_LIMIT_ENABLED =
  (process.env.RATE_LIMIT_ENABLED || "true").toLowerCase() === "true";
export const RATE_LIMIT_REQUESTS = parseInt(
  process.env.RATE_LIMIT_REQUESTS || "20",
  10
);
export const RATE_LIMIT_WINDOW = parseInt(
  process.env.RATE_LIMIT_WINDOW || "60",
  10
);

// ============== File Paths ==============

const TMP = tmpdir();
export const SESSION_FILE = resolve(TMP, "claude-telegram-session.json");
export const RESTART_FILE = resolve(TMP, "claude-telegram-restart.json");
export const TEMP_DIR = resolve(TMP, "telegram-bot");

// Temp paths that are always allowed for bot operations
export const TEMP_PATHS = [TMP, resolve(TMP)];

// Ensure temp directory exists
mkdirSync(TEMP_DIR, { recursive: true });

// ============== Validation ==============

if (!TELEGRAM_TOKEN) {
  console.error("ERROR: TELEGRAM_BOT_TOKEN environment variable is required");
  process.exit(1);
}

if (ALLOWED_USERS.length === 0) {
  console.error(
    "ERROR: TELEGRAM_ALLOWED_USERS environment variable is required"
  );
  process.exit(1);
}

console.log(
  `Config loaded: ${ALLOWED_USERS.length} allowed users, working dir: ${WORKING_DIR}`
);
