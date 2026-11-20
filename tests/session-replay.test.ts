import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { loadSessionHistory } from "../app/src/main/session-replay.js";

/** Writes pi session entries to a temporary file and returns its path. */
function sessionFile(entries: unknown[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-replay-"));
  const file = path.join(dir, "session.jsonl");
  fs.writeFileSync(file, entries.map((e) => JSON.stringify(e)).join("\n"));
  return file;
}

const message = (message: Record<string, unknown>) => ({ type: "message", message });

describe("loadSessionHistory", () => {
  it("keeps each message's timestamp, and each tool call's arguments, result and times", () => {
    const file = sessionFile([
      { type: "session", cwd: "/x" },
      message({ role: "user", content: [{ type: "text", text: "Run cat" }], timestamp: 100 }),
      message({
        role: "assistant",
        content: [
          { type: "thinking", thinking: "…" },
          { type: "toolCall", id: "c1", name: "run_tool", arguments: { tool_id: "cat1" } },
        ],
        timestamp: 200,
      }),
      message({
        role: "toolResult",
        toolCallId: "c1",
        toolName: "run_tool",
        content: [{ type: "text", text: '{"success":true}' }],
        isError: false,
        durationMs: 150,
        timestamp: 400,
      }),
      message({ role: "assistant", content: [{ type: "text", text: "Done." }], timestamp: 500 }),
    ]);
    expect(loadSessionHistory(file)).toEqual([
      { role: "user", text: "Run cat", timestamp: 100 },
      {
        role: "assistant",
        text: "",
        timestamp: 200,
        tools: [
          {
            id: "c1",
            name: "run_tool",
            arguments: { tool_id: "cat1" },
            resultText: '{"success":true}',
            isError: false,
            startedAt: 250,
            endedAt: 400,
          },
        ],
      },
      { role: "assistant", text: "Done.", timestamp: 500 },
    ]);
  });

  it("leaves out the session-start prompt and messages with no text", () => {
    const file = sessionFile([
      message({
        role: "user",
        content: [{ type: "text", text: "Session started. Current directory: /x" }],
      }),
      message({ role: "assistant", content: [{ type: "thinking", thinking: "…" }] }),
    ]);
    expect(loadSessionHistory(file)).toEqual([]);
  });
});
