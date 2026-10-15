import { describe, expect, it } from "vitest";
import {
  describeToolCall,
  normalizeToolName,
} from "../app/src/renderer/whats-happening/core/catalog.js";
import {
  advance,
  currentStatus,
  EMPTY_STATE,
  narrate,
} from "../app/src/renderer/whats-happening/core/narrator.js";
import type {
  NarrationEntry,
  NarrationEvent,
  NarrationState,
  ToolEvent,
} from "../app/src/renderer/whats-happening/core/types.js";

const start = (id: string, at = 1000): ToolEvent => ({
  id,
  toolName: "galaxy_run_tool",
  phase: "start",
  at,
  args: { tool_id: "__BUILD_LIST__" },
});

const end = (id: string, at = 2000, isError = false): ToolEvent => ({
  id,
  toolName: "galaxy_run_tool",
  phase: "end",
  at,
  isError,
});

function fold(events: ToolEvent[]): readonly NarrationEntry[] {
  return events.reduce<readonly NarrationEntry[]>(narrate, []);
}

describe("narrate", () => {
  it("opens a running entry on start", () => {
    expect(fold([start("a")])).toEqual([
      {
        id: "a",
        toolName: "galaxy_run_tool",
        status: "running",
        title: "Running __BUILD_LIST__",
        links: [],
        startedAt: 1000,
      },
    ]);
  });

  it("marks the entry done on a successful end", () => {
    const [entry] = fold([start("a"), end("a", 2500)]);
    expect(entry.status).toBe("done");
    expect(entry.endedAt).toBe(2500);
  });

  it("marks the entry failed on an end with isError", () => {
    const [entry] = fold([start("a"), end("a", 2000, true)]);
    expect(entry.status).toBe("failed");
  });

  it("keeps entries in start order and closes the right one", () => {
    const entries = fold([start("a"), start("b", 1100), end("b")]);
    expect(entries.map((e) => [e.id, e.status])).toEqual([
      ["a", "running"],
      ["b", "done"],
    ]);
  });

  it("ignores an end for an id it never saw start", () => {
    const before = fold([start("a")]);
    expect(narrate(before, end("zzz"))).toBe(before);
  });

  it("ignores a repeated start for the same id", () => {
    const before = fold([start("a")]);
    expect(narrate(before, start("a", 5000))).toBe(before);
  });

  it("returns the same list for update events", () => {
    const before = fold([start("a")]);
    expect(
      narrate(before, { id: "a", toolName: "galaxy_run_tool", phase: "update", at: 1500 }),
    ).toBe(before);
  });

  it("does not mutate the list it is given", () => {
    const before = fold([start("a")]);
    const snapshot = structuredClone(before);
    narrate(before, end("a"));
    expect(before).toEqual(snapshot);
  });
});

describe("normalizeToolName", () => {
  it("strips the Galaxy prefix each harness uses", () => {
    expect(normalizeToolName("galaxy_run_tool")).toEqual({ name: "run_tool", galaxy: true });
    expect(normalizeToolName("mcp__galaxy__run_tool")).toEqual({ name: "run_tool", galaxy: true });
  });

  it("leaves bare and non-Galaxy names alone", () => {
    expect(normalizeToolName("run_tool")).toEqual({ name: "run_tool", galaxy: false });
    expect(normalizeToolName("edit")).toEqual({ name: "edit", galaxy: false });
  });
});

describe("describeToolCall", () => {
  it("names the Galaxy tool being run, whatever the harness prefix", () => {
    for (const name of ["galaxy_run_tool", "mcp__galaxy__run_tool", "run_tool"]) {
      expect(describeToolCall(name, { tool_id: "__BUILD_LIST__" })).toBe("Running __BUILD_LIST__");
    }
  });

  it("shortens a Tool Shed id to the tool's own name", () => {
    expect(
      describeToolCall("galaxy_run_tool", {
        tool_id: "toolshed.g2.bx.psu.edu/repos/iuc/deseq2/deseq2/2.11.40.8+galaxy1",
      }),
    ).toBe("Running deseq2");
  });

  it("still reads sensibly when the tool id is missing", () => {
    expect(describeToolCall("galaxy_run_tool", undefined)).toBe("Running a Galaxy tool");
  });

  it("falls back to a generic title for tools it does not know", () => {
    expect(describeToolCall("galaxy_get_dataset_details", {})).toBe(
      "Working with Galaxy: get_dataset_details",
    );
    expect(describeToolCall("edit", {})).toBe("Using edit");
  });
});

function play(events: NarrationEvent[]): NarrationState {
  return events.reduce<NarrationState>(advance, EMPTY_STATE);
}

const runTool = (id: string, phase: "start" | "end", at: number, isError = false): ToolEvent => ({
  id,
  toolName: "mcp__galaxy__run_tool",
  phase,
  at,
  args: { tool_id: "random_lines1" },
  isError,
});

describe("advance: groups and the live status line", () => {
  it("opens a group per message and shows a status straight away", () => {
    const state = play([{ kind: "group-start", at: 0 }]);
    expect(state.groups).toHaveLength(1);
    expect(state.groups[0].status).toBe("active");
    expect(currentStatus(state)).toEqual({ text: "Reading your request…", since: 0 });
  });

  it("follows the model through thinking, a tool call and its reply", () => {
    const steps: [NarrationEvent, string][] = [
      [{ kind: "group-start", at: 0 }, "Reading your request…"],
      [{ kind: "model", activity: "thinking", at: 1 }, "Thinking…"],
      [{ kind: "model", activity: "tool-call", at: 12 }, "Preparing the next step…"],
      [runTool("t1", "start", 13), "Running random_lines1…"],
      [runTool("t1", "end", 15), "Deciding the next step…"],
      [{ kind: "model", activity: "writing", at: 16 }, "Writing a reply…"],
    ];
    let state = EMPTY_STATE;
    for (const [event, expected] of steps) {
      state = advance(state, event);
      expect(currentStatus(state)?.text).toBe(expected);
    }
  });

  it("keeps the same state while the same activity keeps streaming", () => {
    const state = play([
      { kind: "group-start", at: 0 },
      { kind: "model", activity: "thinking", at: 1 },
    ]);
    expect(advance(state, { kind: "model", activity: "thinking", at: 5 })).toBe(state);
    expect(currentStatus(state)?.since).toBe(1);
  });

  it("closes the group on group-end, and records why when it stopped", () => {
    const done = play([
      { kind: "group-start", at: 0 },
      { kind: "group-end", at: 17 },
    ]);
    expect(done.groups[0]).toMatchObject({ status: "done", now: null, endedAt: 17 });
    const stopped = play([
      { kind: "group-start", at: 0 },
      { kind: "group-end", at: 3, error: "model unavailable" },
    ]);
    expect(stopped.groups[0]).toMatchObject({ status: "stopped", error: "model unavailable" });
  });

  it("keeps saying Galaxy is working after the group ends, until it reports finished", () => {
    const afterTurn = play([
      { kind: "group-start", at: 0 },
      runTool("t1", "start", 13),
      runTool("t1", "end", 15),
      { kind: "group-end", at: 17 },
    ]);
    expect(currentStatus(afterTurn)).toEqual({
      text: "Galaxy is still working: Running random_lines1",
      since: 15,
    });
    const finished = advance(afterTurn, {
      kind: "galaxy-finished",
      at: 36,
      label: "random_lines1",
    });
    expect(currentStatus(finished)).toBeNull();
  });

  it("does not count failed or non-Galaxy calls as running Galaxy work", () => {
    const state = play([
      { kind: "group-start", at: 0 },
      runTool("t1", "start", 1),
      runTool("t1", "end", 2, true),
      { id: "e1", toolName: "edit", phase: "start", at: 3 },
      { id: "e1", toolName: "edit", phase: "end", at: 4 },
      { kind: "group-end", at: 5 },
    ]);
    expect(state.galaxyRunning).toEqual([]);
    expect(currentStatus(state)).toBeNull();
  });

  it("does not wait on uploads, whose finish is never reported", () => {
    const state = play([
      { kind: "group-start", at: 0 },
      { id: "u1", toolName: "galaxy_upload_local_file", phase: "start", at: 1 },
      { id: "u1", toolName: "galaxy_upload_local_file", phase: "end", at: 2 },
      { kind: "group-end", at: 3 },
    ]);
    expect(currentStatus(state)).toBeNull();
  });

  it("marks a group the harness started itself as a follow-up", () => {
    const state = play([
      { kind: "group-start", at: 36 },
      { kind: "group-info", at: 36, text: "[auto] check the job", followUp: true },
    ]);
    expect(state.groups[0]).toMatchObject({ followUp: true, text: "[auto] check the job" });
    expect(currentStatus(state)?.text).toBe("Checking on your Galaxy work…");
  });

  it("starts a new group for each message and closes one left open", () => {
    const state = play([
      { kind: "group-start", at: 0 },
      { kind: "group-start", at: 10 },
    ]);
    expect(state.groups.map((g) => g.status)).toEqual(["done", "active"]);
  });

  it("opens a group for a tool call that arrives outside one", () => {
    const state = play([runTool("t1", "start", 5)]);
    expect(state.groups).toHaveLength(1);
    expect(state.groups[0].entries.map((e) => e.status)).toEqual(["running"]);
  });
});
