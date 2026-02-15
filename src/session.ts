/**
 * Session management for Claude Telegram Bot.
 *
 * ClaudeSession class manages Claude Code sessions using the CLI subprocess.
 * Spawns `claude -p` with `--output-format stream-json` for streaming responses.
 * No API costs — everything runs on the user's Claude MAX subscription via CLI.
 */

import { spawn, execSync, type ChildProcess } from "child_process";
import { createInterface } from "readline";
import { readFileSync, writeFileSync, existsSync, statSync } from "fs";
import type { Context } from "grammy";

import {
  ALLOWED_PATHS,
  CLAUDE_CLI_PATH,
  SESSION_FILE,
  STREAMING_THROTTLE_MS,
  WORKING_DIR,
} from "./config";
import { formatToolStatus } from "./formatting";
import { checkPendingAskUserRequests } from "./handlers/streaming";
import type {
  SavedSession,
  SessionHistory,
  StatusCallback,
  TokenUsage,
} from "./types";

/**
 * Kill a process tree. On Windows, `taskkill /T` kills child processes too
 * (needed because shell:true spawns cmd.exe which spawns the actual CLI).
 * On Unix, tries graceful SIGTERM first, then SIGKILL after timeout.
 */
function killProcessTree(pid: number): void {
  try {
    if (process.platform === "win32") {
      // Windows: taskkill /T /F is the only reliable method
      execSync(`taskkill /pid ${pid} /T /F`, { stdio: "ignore" });
    } else {
      // Unix: graceful SIGTERM, then force SIGKILL after 5s
      process.kill(-pid, "SIGTERM");
      setTimeout(() => {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          // Already dead
        }
      }, 5000);
    }
  } catch {
    // Process might already be dead
  }
}

/**
 * Detect "prompt too long" / context limit errors from CLI output.
 */
const PROMPT_TOO_LONG_PATTERNS = [
  /input length and max_tokens exceed context limit/i,
  /exceed context limit/i,
  /context limit.*exceeded/i,
  /prompt.*too.*long/i,
  /conversation is too long/i,
];

function isPromptTooLong(text: string): boolean {
  return PROMPT_TOO_LONG_PATTERNS.some((p) => p.test(text));
}

/**
 * Manages Claude Code sessions using the CLI subprocess.
 */
const MAX_SESSIONS = 5;

class ClaudeSession {
  sessionId: string | null = null;
  lastActivity: Date | null = null;
  queryStarted: Date | null = null;
  currentTool: string | null = null;
  lastTool: string | null = null;
  lastError: string | null = null;
  lastErrorTime: Date | null = null;
  lastUsage: TokenUsage | null = null;
  lastMessage: string | null = null;
  conversationTitle: string | null = null;
  contextPercent: number | null = null;
  private _workingDir: string = WORKING_DIR;

  private childProcess: ChildProcess | null = null;
  private isQueryRunning = false;
  private stopRequested = false;
  private _isProcessing = false;
  private _wasInterruptedByNewMessage = false;

  get currentWorkingDir(): string {
    return this._workingDir;
  }

  setWorkingDir(path: string): void {
    if (!existsSync(path)) {
      throw new Error(`Directory does not exist: ${path}`);
    }
    this._workingDir = path;
    console.log(`Working directory changed to: ${path}`);
  }

  get isActive(): boolean {
    return this.sessionId !== null;
  }

  get isRunning(): boolean {
    return this.isQueryRunning || this._isProcessing;
  }

  /**
   * Check if the last stop was triggered by a new message interrupt (! prefix).
   * Resets the flag when called. Also clears stopRequested so new messages can proceed.
   */
  consumeInterruptFlag(): boolean {
    const was = this._wasInterruptedByNewMessage;
    this._wasInterruptedByNewMessage = false;
    if (was) {
      this.stopRequested = false;
    }
    return was;
  }

  /**
   * Mark that this stop is from a new message interrupt.
   */
  markInterrupt(): void {
    this._wasInterruptedByNewMessage = true;
  }

  /**
   * Clear the stopRequested flag (used after interrupt to allow new message to proceed).
   */
  clearStopRequested(): void {
    this.stopRequested = false;
  }

  /**
   * Mark processing as started.
   * Returns a cleanup function to call when done.
   */
  startProcessing(): () => void {
    this._isProcessing = true;
    return () => {
      this._isProcessing = false;
    };
  }

  /**
   * Stop the currently running query by killing the CLI subprocess.
   * Returns: "stopped" if process was killed, "pending" if will be cancelled, false if nothing running
   */
  async stop(): Promise<"stopped" | "pending" | false> {
    if (this.isQueryRunning && this.childProcess?.pid) {
      this.stopRequested = true;
      killProcessTree(this.childProcess.pid);
      console.log("Stop requested - killing CLI process");
      return "stopped";
    }

    if (this._isProcessing) {
      this.stopRequested = true;
      console.log("Stop requested - will cancel before query starts");
      return "pending";
    }

    return false;
  }

  /**
   * Send a message to Claude via CLI subprocess with streaming updates.
   *
   * Spawns `claude -p --output-format stream-json` and parses NDJSON events.
   * Prompt is piped via stdin to avoid command-line escaping issues.
   *
   * @param ctx - grammY context for ask_user button display
   */
  async sendMessageStreaming(
    message: string,
    username: string,
    userId: number,
    statusCallback: StatusCallback,
    chatId?: number,
    ctx?: Context
  ): Promise<string> {
    // Set chat context for ask_user MCP tool
    if (chatId) {
      process.env.TELEGRAM_CHAT_ID = String(chatId);
    }

    const isNewSession = !this.isActive;

    // Inject current date/time at session start so Claude doesn't need to call a tool for it
    let messageToSend = message;
    if (isNewSession) {
      const now = new Date();
      const datePrefix = `[Current date/time: ${now.toLocaleDateString(
        "en-US",
        {
          weekday: "long",
          year: "numeric",
          month: "long",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
          timeZoneName: "short",
        }
      )}]\n\n`;
      messageToSend = datePrefix + message;
    }

    // Build CLI args — prompt goes to stdin, not on command line
    const args: string[] = [
      "-p",
      "--verbose",
      "--output-format",
      "stream-json",
      "--include-partial-messages",
      "--dangerously-skip-permissions",
    ];

    // Additional directories
    if (ALLOWED_PATHS.length > 0) {
      args.push("--add-dir", ...ALLOWED_PATHS);
    }

    // Resume existing session
    if (this.sessionId) {
      args.push("--resume", this.sessionId);
    }

    // Optional model override (env var)
    const model = process.env.CLAUDE_MODEL;
    if (model) {
      args.push("--model", model);
    }

    // Optional system prompt (env var)
    const systemPrompt = process.env.CLAUDE_SYSTEM_PROMPT;
    if (systemPrompt) {
      args.push("--append-system-prompt", systemPrompt);
    }

    if (isNewSession) {
      console.log("STARTING new Claude CLI session");
    } else {
      console.log(`RESUMING session ${this.sessionId!.slice(0, 8)}...`);
    }

    // Check if stop was requested during processing phase
    if (this.stopRequested) {
      console.log(
        "Query cancelled before starting (stop was requested during processing)"
      );
      this.stopRequested = false;
      throw new Error("Query cancelled");
    }

    // Spawn CLI process
    const env = { ...process.env };
    delete env.CLAUDECODE; // Prevent "nested session" error

    this.childProcess = spawn(CLAUDE_CLI_PATH, args, {
      cwd: this._workingDir,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: process.platform === "win32",
    });

    // Pipe prompt via stdin (avoids command-line escaping issues on Windows)
    this.childProcess.stdin!.write(messageToSend);
    this.childProcess.stdin!.end();

    this.isQueryRunning = true;
    this.stopRequested = false;
    this.queryStarted = new Date();
    this.currentTool = null;

    // Response tracking
    const responseParts: string[] = [];
    let currentSegmentId = 0;
    let currentSegmentText = "";
    let lastTextUpdate = 0;
    let askUserTriggered = false;
    let resultText: string | null = null;
    let promptTooLong = false;

    // Per-message tracking for partial message deduplication
    let currentMsgId: string | null = null;
    let processedBlockLengths: number[] = [];
    const processedToolIds = new Set<string>();

    // Collect stderr for error reporting
    const stderrChunks: string[] = [];
    this.childProcess.stderr!.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderrChunks.push(text);
      if (text.trim()) {
        console.error(`CLI stderr: ${text.trim()}`);
      }
      if (isPromptTooLong(text)) {
        promptTooLong = true;
      }
    });

    try {
      const rl = createInterface({ input: this.childProcess.stdout! });

      for await (const line of rl) {
        // Check for abort
        if (this.stopRequested) {
          console.log("Query aborted by user");
          break;
        }

        // Parse NDJSON line
        let event: any;
        try {
          event = JSON.parse(line);
        } catch {
          continue; // Skip non-JSON lines (e.g. debug output)
        }

        // Capture session_id from the first event that has one
        if (event.session_id && !this.sessionId) {
          this.sessionId = event.session_id;
          console.log(`GOT session_id: ${this.sessionId!.slice(0, 8)}...`);
          this.saveSession();
        }

        // ── Assistant messages (text, tools, thinking) ──
        if (event.type === "assistant" && event.message?.content) {
          const msgId = event.message.id;

          // New message ID = new assistant turn (reset per-message tracking)
          if (msgId !== currentMsgId) {
            currentMsgId = msgId;
            processedBlockLengths = [];
          }

          const content = event.message.content as any[];

          for (let i = 0; i < content.length; i++) {
            const block = content[i];
            const prevLen = processedBlockLengths[i] || 0;

            // ── Thinking blocks ──
            if (block.type === "thinking" && block.thinking) {
              const thinking = block.thinking as string;
              if (thinking.length > prevLen) {
                processedBlockLengths[i] = thinking.length;
                console.log(`THINKING: ${thinking.slice(0, 100)}...`);
                await statusCallback("thinking", thinking);
              }
            }

            // ── Text blocks ──
            if (block.type === "text" && block.text) {
              const text = block.text as string;
              if (text.length > prevLen) {
                const delta = text.slice(prevLen);
                processedBlockLengths[i] = text.length;

                responseParts.push(delta);
                currentSegmentText += delta;

                // Stream text updates (throttled)
                const now = Date.now();
                if (
                  now - lastTextUpdate > STREAMING_THROTTLE_MS &&
                  currentSegmentText.length > 20
                ) {
                  await statusCallback(
                    "text",
                    currentSegmentText,
                    currentSegmentId
                  );
                  lastTextUpdate = now;
                }
              }
            }

            // ── Tool use blocks ──
            if (block.type === "tool_use" && block.id) {
              if (!processedToolIds.has(block.id)) {
                processedToolIds.add(block.id);
                processedBlockLengths[i] = 1; // Mark as processed

                // End current text segment
                if (currentSegmentText) {
                  await statusCallback(
                    "segment_end",
                    currentSegmentText,
                    currentSegmentId
                  );
                  currentSegmentId++;
                  currentSegmentText = "";
                }

                // Format and show tool status
                const toolInput = (block.input || {}) as Record<
                  string,
                  unknown
                >;
                const toolDisplay = formatToolStatus(block.name, toolInput);
                this.currentTool = toolDisplay;
                this.lastTool = toolDisplay;
                console.log(`Tool: ${toolDisplay}`);

                // Don't show tool status for ask_user - the buttons are self-explanatory
                if (!block.name.startsWith("mcp__ask-user")) {
                  await statusCallback("tool", toolDisplay);
                }

                // Check for pending ask_user requests after ask-user MCP tool
                if (block.name.startsWith("mcp__ask-user") && ctx && chatId) {
                  await new Promise((r) => setTimeout(r, 200));
                  for (let attempt = 0; attempt < 3; attempt++) {
                    const buttonsSent = await checkPendingAskUserRequests(
                      ctx,
                      chatId
                    );
                    if (buttonsSent) {
                      askUserTriggered = true;
                      break;
                    }
                    if (attempt < 2) {
                      await new Promise((r) => setTimeout(r, 100));
                    }
                  }
                }
              }
            }
          }

          // Break out of event loop if ask_user was triggered
          if (askUserTriggered) {
            break;
          }
        }

        // ── Result event — query complete ──
        if (event.type === "result") {
          console.log("Response complete");
          resultText = event.result || null;

          // Capture usage
          if (event.usage) {
            this.lastUsage = {
              input_tokens: event.usage.input_tokens || 0,
              output_tokens: event.usage.output_tokens || 0,
              cache_read_input_tokens:
                event.usage.cache_read_input_tokens || 0,
              cache_creation_input_tokens:
                event.usage.cache_creation_input_tokens || 0,
            };
            const u = this.lastUsage;
            console.log(
              `Usage: in=${u.input_tokens} out=${u.output_tokens} cache_read=${
                u.cache_read_input_tokens || 0
              } cache_create=${u.cache_creation_input_tokens || 0}`
            );
          }

          // Calculate context window percentage from modelUsage
          if (event.modelUsage) {
            const models = Object.values(event.modelUsage) as any[];
            if (models.length > 0) {
              const m = models[0];
              const totalTokens =
                (m.inputTokens || 0) +
                (m.outputTokens || 0) +
                (m.cacheReadInputTokens || 0) +
                (m.cacheCreationInputTokens || 0);
              const contextWindow = m.contextWindow || 200000;
              this.contextPercent = Math.round(
                (totalTokens / contextWindow) * 100
              );
              console.log(
                `Context: ${this.contextPercent}% (${totalTokens}/${contextWindow})`
              );
            }
          }

          // Check for prompt-too-long in result text
          if (event.result && isPromptTooLong(event.result)) {
            promptTooLong = true;
          }

          // Check for error result
          if (event.is_error || event.subtype === "error") {
            const errorMsg = event.error || event.result || "Unknown CLI error";
            if (isPromptTooLong(errorMsg)) {
              promptTooLong = true;
            }
            throw new Error(`CLI error: ${errorMsg}`);
          }
        }
      }

      // Wait for process to close (if not already)
      await new Promise<void>((resolve) => {
        if (!this.childProcess || this.childProcess.exitCode !== null) {
          resolve();
        } else {
          this.childProcess.on("close", () => resolve());
        }
      });

      // Check exit code — non-zero means error (unless user-initiated stop)
      const exitCode = this.childProcess?.exitCode;
      if (
        exitCode &&
        exitCode !== 0 &&
        !this.stopRequested &&
        !askUserTriggered
      ) {
        const stderr = stderrChunks.join("");
        throw new Error(
          `exited with code ${exitCode}: ${stderr.slice(0, 200)}`
        );
      }
    } catch (error) {
      const errorStr = String(error).toLowerCase();
      const isCleanupError =
        errorStr.includes("cancel") || errorStr.includes("abort");

      if (isCleanupError && (this.stopRequested || askUserTriggered)) {
        console.warn(`Suppressed post-stop error: ${error}`);
      } else {
        console.error(`Error in CLI query: ${error}`);
        this.lastError = String(error).slice(0, 100);
        this.lastErrorTime = new Date();
        throw error;
      }
    } finally {
      this.isQueryRunning = false;
      this.childProcess = null;
      this.queryStarted = null;
      this.currentTool = null;
    }

    this.lastActivity = new Date();
    this.lastError = null;
    this.lastErrorTime = null;

    // Auto-clear session on prompt-too-long
    if (promptTooLong) {
      console.log("Prompt too long detected - auto-clearing session");
      await this.kill();
      await statusCallback("done", "");
      return "⚠️ Context limit reached — session auto-cleared. Send a new message to start fresh.";
    }

    // If ask_user was triggered, return early - user will respond via button
    if (askUserTriggered) {
      await statusCallback("done", "");
      return "[Waiting for user selection]";
    }

    // Emit final segment
    if (currentSegmentText) {
      await statusCallback(
        "segment_end",
        currentSegmentText,
        currentSegmentId
      );
    }

    await statusCallback("done", "");

    // Prefer result text from CLI (most reliable), fall back to collected parts
    return resultText || responseParts.join("") || "No response from Claude.";
  }

  /**
   * Kill the current session (clear session_id).
   */
  async kill(): Promise<void> {
    this.sessionId = null;
    this.lastActivity = null;
    this.conversationTitle = null;
    console.log("Session cleared");
  }

  /**
   * Save session to disk for resume after restart.
   * Saves to multi-session history format.
   */
  saveSession(): void {
    if (!this.sessionId) return;

    try {
      // Load existing session history
      const history = this.loadSessionHistory();

      // Create new session entry
      const newSession: SavedSession = {
        session_id: this.sessionId,
        saved_at: new Date().toISOString(),
        working_dir: this._workingDir,
        title: this.conversationTitle || "Untitled session",
      };

      // Remove any existing entry with same session_id (update in place)
      const existingIndex = history.sessions.findIndex(
        (s) => s.session_id === this.sessionId
      );
      if (existingIndex !== -1) {
        history.sessions[existingIndex] = newSession;
      } else {
        // Add new session at the beginning
        history.sessions.unshift(newSession);
      }

      // Keep only the last MAX_SESSIONS
      history.sessions = history.sessions.slice(0, MAX_SESSIONS);

      // Save
      writeFileSync(SESSION_FILE, JSON.stringify(history, null, 2));
      console.log(`Session saved to ${SESSION_FILE}`);
    } catch (error) {
      console.warn(`Failed to save session: ${error}`);
    }
  }

  /**
   * Load session history from disk.
   */
  private loadSessionHistory(): SessionHistory {
    try {
      if (!existsSync(SESSION_FILE)) {
        return { sessions: [] };
      }
      const stat = statSync(SESSION_FILE);
      if (!stat.size) {
        return { sessions: [] };
      }

      const text = readFileSync(SESSION_FILE, "utf-8");
      return JSON.parse(text) as SessionHistory;
    } catch {
      return { sessions: [] };
    }
  }

  /**
   * Get list of saved sessions for display.
   */
  getSessionList(): SavedSession[] {
    const history = this.loadSessionHistory();
    // Filter to only sessions for current working directory
    return history.sessions.filter(
      (s) => !s.working_dir || s.working_dir === this._workingDir
    );
  }

  /**
   * Resume a specific session by ID.
   */
  resumeSession(sessionId: string): [success: boolean, message: string] {
    const history = this.loadSessionHistory();
    const sessionData = history.sessions.find(
      (s) => s.session_id === sessionId
    );

    if (!sessionData) {
      return [false, "Session not found"];
    }

    if (
      sessionData.working_dir &&
      sessionData.working_dir !== this._workingDir
    ) {
      return [
        false,
        `Session is for a different directory: ${sessionData.working_dir}`,
      ];
    }

    this.sessionId = sessionData.session_id;
    this.conversationTitle = sessionData.title;
    this.lastActivity = new Date();

    console.log(
      `Resumed session ${sessionData.session_id.slice(0, 8)}... - "${sessionData.title}"`
    );

    return [true, `Resumed session: "${sessionData.title}"`];
  }

  /**
   * Resume the last persisted session (legacy method, now resumes most recent).
   */
  resumeLast(): [success: boolean, message: string] {
    const sessions = this.getSessionList();
    if (sessions.length === 0) {
      return [false, "No saved sessions"];
    }

    return this.resumeSession(sessions[0]!.session_id);
  }
}

// Global session instance
export const session = new ClaudeSession();
