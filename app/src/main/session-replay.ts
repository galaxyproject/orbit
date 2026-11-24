import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface ReplayTool {
  id: string;
  name: string;
  /** The arguments the model called it with. */
  arguments?: unknown;
  resultText?: string;
  isError?: boolean;
  /** When the call started and ended, in epoch milliseconds, when the session says. */
  startedAt?: number;
  endedAt?: number;
}

export interface ReplaySegment {
  role: "user" | "assistant";
  text: string;
  tools?: ReplayTool[];
  /** pi's timestamp for the message, in epoch milliseconds; for a user message, its id. */
  timestamp?: number;
}

type ContentBlock = {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  arguments?: unknown;
  toolCallId?: string;
  output?: { content?: Array<{ text?: string }> };
  isError?: boolean;
};

// Mirror pi-coding-agent's on-disk encoding: strip leading slash, then replace
// remaining path separators / drive colons with `-`, wrap in `--`.
// See session-manager.js:213 in @earendil-works/pi-coding-agent.
function sessionsDir(cwd: string): string {
  const encoded = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return path.join(os.homedir(), ".pi", "agent", "sessions", encoded);
}

export function newestSessionFile(cwd: string): string | null {
  const dir = sessionsDir(cwd);
  if (!fs.existsSync(dir)) return null;
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => {
      const p = path.join(dir, f);
      return { path: p, mtime: fs.statSync(p).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
  return files[0]?.path ?? null;
}

// The shell (Orbit) injects a synthetic "Session started. Current directory: ..."
// user turn at session start. Don't replay it.
function isBootstrapPrompt(text: string): boolean {
  return /^Session started\. Current directory:/.test(text);
}

/**
 * Read a session file and turn it into a compact replay. Caller picks the
 * file (AgentManager pins one on spawn) -- newest-by-mtime is wrong on a
 * fresh /new with old sessions still on disk.
 *
 * Returns up to the last `maxSegments` user/assistant turns.
 */
export function loadSessionHistory(
  file: string,
  options: { maxSegments?: number } = {},
): ReplaySegment[] {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }

  const results = new Map<
    string,
    { text: string; isError: boolean; endedAt?: number; ms?: number }
  >();
  const pending: Array<{
    role: "user" | "assistant";
    text: string;
    tools: ReplayTool[];
    timestamp?: number;
  }> = [];

  for (const line of raw.split("\n")) {
    if (!line) continue;
    let evt: Record<string, unknown>;
    try {
      evt = JSON.parse(line);
    } catch {
      continue;
    }
    if (evt.type !== "message") continue;
    const msg = evt.message as
      | {
          role?: string;
          content?: unknown;
          timestamp?: unknown;
          toolCallId?: string;
          isError?: boolean;
          durationMs?: unknown;
        }
      | undefined;
    const role = msg?.role;
    const blocks: ContentBlock[] = Array.isArray(msg?.content)
      ? (msg!.content as ContentBlock[])
      : [];
    const timestamp = typeof msg?.timestamp === "number" ? msg.timestamp : undefined;

    // pi records a tool's result as its own message.
    if (role === "toolResult" && msg?.toolCallId) {
      results.set(msg.toolCallId, {
        text: blocks.map((b) => (b.type === "text" ? (b.text ?? "") : "")).join(""),
        isError: Boolean(msg.isError),
        endedAt: timestamp,
        ms: typeof msg.durationMs === "number" ? msg.durationMs : undefined,
      });
      continue;
    }
    if (role !== "user" && role !== "assistant") continue;

    // Tool results travel in role=user messages; stash them for attachment.
    if (role === "user") {
      for (const b of blocks) {
        if (b.type === "toolResult" && b.toolCallId) {
          const text = b.output?.content?.map((c) => c.text ?? "").join("") ?? "";
          results.set(b.toolCallId, { text, isError: Boolean(b.isError) });
        }
      }
      const hasText = blocks.some((b) => b.type === "text");
      if (!hasText) continue;
    }

    let text = "";
    const tools: ReplayTool[] = [];
    for (const b of blocks) {
      if (b.type === "text") text += b.text ?? "";
      else if (b.type === "toolCall" && b.id && b.name) {
        tools.push({ id: b.id, name: b.name, arguments: b.arguments });
      }
    }

    if (role === "user") {
      if (!text.trim() || isBootstrapPrompt(text)) continue;
      pending.push({ role, text, tools, timestamp });
    } else {
      if (!text.trim() && tools.length === 0) continue;
      pending.push({ role, text, tools, timestamp });
    }
  }

  for (const seg of pending) {
    for (const t of seg.tools) {
      const r = results.get(t.id);
      if (r) {
        t.resultText = r.text;
        t.isError = r.isError;
        t.endedAt = r.endedAt;
        if (r.endedAt !== undefined && r.ms !== undefined) t.startedAt = r.endedAt - r.ms;
      }
    }
  }

  const max = options.maxSegments ?? 200;
  return pending.slice(-max).map((p) => ({
    role: p.role,
    text: p.text,
    tools: p.tools.length ? p.tools : undefined,
    ...(p.timestamp !== undefined ? { timestamp: p.timestamp } : {}),
  }));
}
