import { allOperations } from "@galaxyproject/galaxy-ops/browser";
import { describe, expect, it } from "vitest";
import {
  argRefs,
  classifyTool,
  describeDoneCall,
  describeFailedCall,
  describeToolCall,
  inputRefs,
  normalizeToolName,
} from "../app/src/renderer/whats-happening/core/catalog.js";
import { EMPTY_NAMES, learnNames } from "../app/src/renderer/whats-happening/core/names.js";
import { rowsOf } from "../app/src/renderer/whats-happening/core/rows.js";
import {
  failureReason,
  invocationsSeen,
  producedRefs,
  producedSummary,
  startedWork,
} from "../app/src/renderer/whats-happening/core/results.js";
import {
  advance,
  anchorUserMessage,
  currentActivity,
  currentStatus,
  groupsForUserMessage,
  EMPTY_STATE,
  isStalled,
  narrate,
  stallText,
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
  groupId: "m1",
  at,
  args: { tool_id: "__BUILD_LIST__" },
});

const end = (id: string, at = 2000, isError = false): ToolEvent => ({
  id,
  toolName: "galaxy_run_tool",
  phase: "end",
  groupId: "m1",
  at,
  isError,
});

function fold(events: ToolEvent[]): readonly NarrationEntry[] {
  return events.reduce<readonly NarrationEntry[]>((entries, event) => narrate(entries, event), []);
}

describe("narrate", () => {
  it("opens a running entry on start", () => {
    expect(fold([start("a")])).toEqual([
      {
        id: "a",
        toolName: "galaxy_run_tool",
        kind: "change",
        domain: "tools",
        status: "running",
        title: "Running __BUILD_LIST__",
        doneTitle: "Ran __BUILD_LIST__",
        failedTitle: "__BUILD_LIST__ failed",
        galaxyRefs: [
          { kind: "tool", id: "__BUILD_LIST__", label: "__BUILD_LIST__", role: "input" },
        ],
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
      narrate(before, {
        id: "a",
        toolName: "galaxy_run_tool",
        phase: "update",
        groupId: "m1",
        at: 1500,
      }),
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

  it("recognises a bare galaxy-ops operation name as a Galaxy tool", () => {
    expect(normalizeToolName("run_tool")).toEqual({ name: "run_tool", galaxy: true });
    expect(normalizeToolName("get_history_contents")).toEqual({
      name: "get_history_contents",
      galaxy: true,
    });
  });

  it("leaves non-Galaxy names alone", () => {
    expect(normalizeToolName("edit")).toEqual({ name: "edit", galaxy: false });
    expect(normalizeToolName("loom_propose")).toEqual({ name: "loom_propose", galaxy: false });
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

  it("words reads and checks plainly, by galaxy-ops domain", () => {
    expect(describeToolCall("get_history_contents", {})).toBe("Looking at your history");
    expect(describeToolCall("get_histories", {})).toBe("Looking at your history");
    expect(describeToolCall("get_dataset_details", {})).toBe("Checking a dataset");
    expect(describeToolCall("get_collection_details", {})).toBe("Checking a collection");
    expect(describeToolCall("search_tools_by_name", {})).toBe("Finding the right Galaxy tool");
    expect(describeToolCall("recommend_iwc_workflows", {})).toBe("Looking for a workflow");
    expect(describeToolCall("get_job_details", {})).toBe("Checking on a job");
    expect(describeToolCall("get_invocations", {})).toBe("Checking on a workflow run");
    expect(describeToolCall("get_user", {})).toBe("Connecting to Galaxy");
    expect(describeToolCall("get_page", {})).toBe("Reading your Galaxy page");
  });

  it("words Galaxy reads outside galaxy-ops' registry by name", () => {
    expect(describeToolCall("galaxy_search_ena", {})).toBe("Searching public data");
    expect(describeToolCall("mcp__galaxy__get_assemblies", {})).toBe("Searching public data");
    expect(describeToolCall("list_jobs", {})).toBe("Checking on your jobs");
    expect(describeToolCall("get_job_logs", {})).toBe("Reading a job's log");
  });

  it("gives every galaxy-ops read or check plain wording, never its raw summary", () => {
    for (const op of allOperations) {
      const kind = classifyTool(op.name);
      if (kind !== "look" && kind !== "wait") continue;
      expect([op.name, describeToolCall(op.name, {})]).not.toEqual([
        op.name,
        op.summary
          .split(/(?<=\.)\s/)[0]
          .replace(/`/g, "")
          .replace(/\.$/, ""),
      ]);
    }
  });

  it("titles a change without words of its own by the first sentence of its summary", () => {
    expect(describeToolCall("delete_user_tool", {})).not.toMatch(/^Working with Galaxy/);
    expect(describeToolCall("create_page", {})).toBe("Create a markdown page");
  });

  it("falls back to a generic title for tools galaxy-ops does not know", () => {
    expect(describeToolCall("galaxy_something_new", {})).toBe("Working with Galaxy: something_new");
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
  groupId: "m1",
  at,
  args: { tool_id: "random_lines1" },
  isError,
});

describe("advance: groups and the live status line", () => {
  it("opens a group per message and shows a status straight away", () => {
    const state = play([{ kind: "group-start", groupId: "m1", at: 0 }]);
    expect(state.groups).toHaveLength(1);
    expect(state.groups[0].status).toBe("active");
    expect(currentStatus(state)).toEqual({
      text: "Reading your request…",
      since: 0,
      waitingOn: "assistant",
    });
  });

  it("follows the model through thinking, a tool call and its reply", () => {
    const steps: [NarrationEvent, string][] = [
      [{ kind: "group-start", groupId: "m1", at: 0 }, "Reading your request…"],
      [{ kind: "model", groupId: "m1", activity: "thinking", at: 1 }, "Thinking…"],
      [{ kind: "model", groupId: "m1", activity: "tool-call", at: 12 }, "Preparing the next step…"],
      [runTool("t1", "start", 13), "Running random_lines1…"],
      [runTool("t1", "end", 15), "Deciding the next step…"],
      [{ kind: "model", groupId: "m1", activity: "writing", at: 16 }, "Writing a reply…"],
    ];
    let state = EMPTY_STATE;
    for (const [event, expected] of steps) {
      state = advance(state, event);
      expect(currentStatus(state)?.text).toBe(expected);
    }
  });

  it("keeps the same state while the same activity keeps streaming", () => {
    const state = play([
      { kind: "group-start", groupId: "m1", at: 0 },
      { kind: "model", groupId: "m1", activity: "thinking", at: 1 },
    ]);
    expect(advance(state, { kind: "model", groupId: "m1", activity: "thinking", at: 5 })).toBe(
      state,
    );
    expect(currentStatus(state)?.since).toBe(1);
  });

  it("closes the group on group-end, and records why when it stopped", () => {
    const done = play([
      { kind: "group-start", groupId: "m1", at: 0 },
      { kind: "group-end", groupId: "m1", at: 17 },
    ]);
    expect(done.groups[0]).toMatchObject({ status: "done", now: null, endedAt: 17 });
    const stopped = play([
      { kind: "group-start", groupId: "m1", at: 0 },
      { kind: "group-end", groupId: "m1", at: 3, error: "model unavailable" },
    ]);
    expect(stopped.groups[0]).toMatchObject({ status: "stopped", error: "model unavailable" });
  });

  it("keeps a stop reason whole, as the harness gave it", () => {
    const long = `ContextWindowExceededError: ${"x".repeat(300)}\n{"detail": "…"}`;
    const stopped = play([
      { kind: "group-start", groupId: "m1", at: 0 },
      { kind: "group-end", groupId: "m1", at: 3, error: long },
    ]);
    expect(stopped.groups[0].error).toBe(long);
  });

  it("keeps saying Galaxy is working after the group ends, until it reports finished", () => {
    const afterTurn = play([
      { kind: "group-start", groupId: "m1", at: 0 },
      runTool("t1", "start", 13),
      runTool("t1", "end", 15),
      { kind: "group-end", groupId: "m1", at: 17 },
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
      { kind: "group-start", groupId: "m1", at: 0 },
      runTool("t1", "start", 1),
      runTool("t1", "end", 2, true),
      { id: "e1", toolName: "edit", phase: "start", groupId: "m1", at: 3 },
      { id: "e1", toolName: "edit", phase: "end", groupId: "m1", at: 4 },
      { kind: "group-end", groupId: "m1", at: 5 },
    ]);
    expect(state.galaxyRunning).toEqual([]);
    expect(currentStatus(state)).toBeNull();
  });

  it("does not wait on an upload that finished before its call returned", () => {
    const state = play([
      { kind: "group-start", groupId: "m1", at: 0 },
      { id: "u1", toolName: "galaxy_upload_local_file", phase: "start", groupId: "m1", at: 1 },
      { id: "u1", toolName: "galaxy_upload_local_file", phase: "end", groupId: "m1", at: 2 },
      { kind: "group-end", groupId: "m1", at: 3 },
    ]);
    expect(currentStatus(state)).toBeNull();
  });

  it("marks a group the harness started itself as a follow-up", () => {
    const state = play([
      { kind: "group-start", groupId: "m1", at: 36 },
      {
        kind: "group-message",
        groupId: "m1",
        at: 36,
        text: "[auto] check the job",
        followUp: true,
      },
    ]);
    expect(state.groups[0]).toMatchObject({
      followUp: true,
      messages: [{ text: "[auto] check the job", at: 36, by: "harness" }],
    });
    expect(currentStatus(state)?.text).toBe("Checking on your Galaxy work…");
  });

  it("starts a new group for each message, the last one ended by its own group-end", () => {
    const state = play([
      { kind: "group-start", groupId: "m1", at: 0 },
      { kind: "group-end", groupId: "m1", at: 9 },
      { kind: "group-start", groupId: "m2", at: 10 },
    ]);
    expect(state.groups.map((g) => [g.id, g.status])).toEqual([
      ["m1", "done"],
      ["m2", "active"],
    ]);
  });

  it("opens a group for a tool call that arrives outside one", () => {
    const state = play([runTool("t1", "start", 5)]);
    expect(state.groups).toHaveLength(1);
    expect(state.groups[0].entries.map((e) => e.status)).toEqual(["running"]);
  });
});

describe("advance: waiting on the user", () => {
  const asked: NarrationEvent = {
    kind: "awaiting-user",
    groupId: "m1",
    at: 4,
    text: "approve the run",
  };

  it("ends a group that left the user something to do as waiting, not done", () => {
    const state = play([
      { kind: "group-start", groupId: "m1", at: 0 },
      asked,
      { kind: "model", groupId: "m1", activity: "writing", at: 5 },
      { kind: "group-end", groupId: "m1", at: 9 },
    ]);
    expect(state.groups[0]).toMatchObject({
      status: "waiting",
      waitingFor: [{ text: "approve the run", since: 4 }],
    });
    expect(currentStatus(state)).toEqual({ text: "Waiting for you: approve the run", since: 4 });
  });

  it("keeps the live status line while the group is still working", () => {
    const state = play([
      { kind: "group-start", groupId: "m1", at: 0 },
      asked,
      { kind: "model", groupId: "m1", activity: "writing", at: 5 },
    ]);
    expect(currentStatus(state)?.text).toBe("Writing a reply…");
  });

  it("also marks a group that has already ended", () => {
    const state = play([
      { kind: "group-start", groupId: "m1", at: 0 },
      { kind: "group-end", groupId: "m1", at: 3 },
      asked,
    ]);
    expect(state.groups[0].status).toBe("waiting");
  });

  it("puts the user's action ahead of Galaxy work still running", () => {
    const state = play([
      { kind: "group-start", groupId: "m1", at: 0 },
      runTool("t1", "start", 1),
      runTool("t1", "end", 2),
      asked,
      { kind: "group-end", groupId: "m1", at: 9 },
    ]);
    expect(currentStatus(state)?.text).toBe("Waiting for you: approve the run");
  });

  it("clears the wait once the user replies, even without a new group", () => {
    const waiting = play([
      { kind: "group-start", groupId: "m1", at: 0 },
      asked,
      { kind: "group-end", groupId: "m1", at: 9 },
    ]);
    const replied = advance(waiting, { kind: "user-replied", at: 20 });
    expect(replied.groups[0].status).toBe("done");
    expect(replied.groups[0].waitingFor).toBeUndefined();
    expect(currentStatus(replied)).toBeNull();
  });

  it("leaves a group that ended with a request waiting while the next message runs", () => {
    const state = play([
      { kind: "group-start", groupId: "m1", at: 0 },
      asked,
      { kind: "group-end", groupId: "m1", at: 9 },
      { kind: "group-start", groupId: "m2", at: 10 },
    ]);
    expect(state.groups.map((g) => g.status)).toEqual(["waiting", "active"]);
  });

  it("keeps several requests at once and shows the oldest, with a count", () => {
    const state = play([
      { kind: "group-start", groupId: "m1", at: 0 },
      { kind: "awaiting-user", groupId: "m1", at: 4, text: "approve run A", id: "a" },
      { kind: "awaiting-user", groupId: "m1", at: 6, text: "approve run B", id: "b" },
      { kind: "group-end", groupId: "m1", at: 9 },
    ]);
    expect(state.groups[0].waitingFor?.map((r) => r.id)).toEqual(["a", "b"]);
    expect(currentStatus(state)).toEqual({
      text: "Waiting for you: approve run A (+1 more)",
      since: 4,
    });
  });

  it("answers only the request a reply names, and stays waiting for the rest", () => {
    const state = play([
      { kind: "group-start", groupId: "m1", at: 0 },
      { kind: "awaiting-user", groupId: "m1", at: 4, text: "approve run A", id: "a" },
      { kind: "awaiting-user", groupId: "m1", at: 6, text: "approve run B", id: "b" },
      { kind: "group-end", groupId: "m1", at: 9 },
      { kind: "user-replied", at: 12, id: "a" },
    ]);
    expect(state.groups[0].status).toBe("waiting");
    expect(currentStatus(state)).toEqual({ text: "Waiting for you: approve run B", since: 6 });
    const done = advance(state, { kind: "user-replied", at: 15, id: "b" });
    expect(done.groups[0].status).toBe("done");
    expect(done.groups[0].waitingFor).toBeUndefined();
  });

  it("answers everything pending when a reply names no request", () => {
    const state = play([
      { kind: "group-start", groupId: "m1", at: 0 },
      { kind: "awaiting-user", groupId: "m1", at: 4, text: "approve run A", id: "a" },
      { kind: "awaiting-user", groupId: "m1", at: 6, text: "approve run B" },
      { kind: "group-end", groupId: "m1", at: 9 },
      { kind: "user-replied", at: 12 },
    ]);
    expect(state.groups[0].status).toBe("done");
    expect(currentStatus(state)).toBeNull();
  });

  it("ignores a reply to a request that isn't pending", () => {
    const state = play([
      { kind: "group-start", groupId: "m1", at: 0 },
      { kind: "awaiting-user", groupId: "m1", at: 4, text: "approve run A", id: "a" },
      { kind: "group-end", groupId: "m1", at: 9 },
    ]);
    expect(advance(state, { kind: "user-replied", at: 12, id: "zzz" })).toBe(state);
  });

  it("updates a request asked again under the same id, keeping its age", () => {
    const state = play([
      { kind: "group-start", groupId: "m1", at: 0 },
      { kind: "awaiting-user", groupId: "m1", at: 4, text: "approve run A", id: "a" },
      { kind: "awaiting-user", groupId: "m1", at: 7, text: "approve run A (edited)", id: "a" },
      { kind: "group-end", groupId: "m1", at: 9 },
    ]);
    expect(state.groups[0].waitingFor).toEqual([
      { text: "approve run A (edited)", since: 4, id: "a" },
    ]);
  });

  it("collects requests from several messages, oldest first", () => {
    const state = play([
      { kind: "group-start", groupId: "m1", at: 0 },
      { kind: "awaiting-user", groupId: "m1", at: 2, text: "approve run A", id: "a" },
      { kind: "group-end", groupId: "m1", at: 3 },
      { kind: "group-start", groupId: "m2", at: 10 },
      { kind: "awaiting-user", groupId: "m2", at: 12, text: "approve run B", id: "b" },
      { kind: "group-end", groupId: "m2", at: 13 },
    ]);
    expect(currentStatus(state)?.text).toBe("Waiting for you: approve run A (+1 more)");
  });

  it("changes nothing when the user replies with nothing to answer", () => {
    const state = play([
      { kind: "group-start", groupId: "m1", at: 0 },
      { kind: "group-end", groupId: "m1", at: 3 },
    ]);
    expect(advance(state, { kind: "user-replied", at: 5 })).toBe(state);
  });
});

describe("classifyTool", () => {
  it("gives every galaxy-ops operation a kind, under any harness spelling", () => {
    for (const op of allOperations) {
      for (const name of [op.name, `galaxy_${op.name}`, `mcp__galaxy__${op.name}`]) {
        expect(["change", "look", "wait"]).toContain(classifyTool(name));
      }
    }
  });

  it("follows galaxy-ops: an operation that writes is a change, a read is a look", () => {
    for (const op of allOperations) {
      if (["get_job_details", "get_invocations", "download_dataset"].includes(op.name)) continue;
      expect([op.name, classifyTool(op.name)]).toEqual([
        op.name,
        op.readOnly === false ? "change" : "look",
      ]);
    }
  });

  it("overrides what galaxy-ops can't say: checks on running work, and downloads", () => {
    expect(classifyTool("get_job_details")).toBe("wait");
    expect(classifyTool("get_invocations")).toBe("wait");
    expect(classifyTool("download_dataset")).toBe("look");
  });

  it("classifies the bare names Orbit uses today", () => {
    expect(classifyTool("run_tool")).toBe("change");
    expect(classifyTool("get_history_contents")).toBe("look");
    expect(classifyTool("cancel_workflow_invocation")).toBe("change");
  });

  it("treats Orbit's own Galaxy helpers by what they do", () => {
    expect(classifyTool("galaxy_read_output")).toBe("internal");
    expect(classifyTool("galaxy_job_record")).toBe("internal");
    expect(classifyTool("galaxy_invocation_check_one")).toBe("wait");
    expect(classifyTool("list_jobs")).toBe("wait");
    expect(classifyTool("get_job_logs")).toBe("look");
  });

  it("judges a prefixed Galaxy tool galaxy-ops doesn't know by its name, defaulting to a look", () => {
    expect(classifyTool("galaxy_create_workflow")).toBe("change");
    expect(classifyTool("mcp__galaxy__search_ena")).toBe("look");
    expect(classifyTool("galaxy_something_else")).toBe("look");
  });

  it("treats tools that aren't Galaxy's as the harness's own bookkeeping", () => {
    for (const name of ["edit", "read", "write", "bash", "loom_propose"]) {
      expect(classifyTool(name)).toBe("internal");
    }
  });
});

describe("narrate: galaxy-ops facts on entries", () => {
  it("records the operation's domain, and flags destructive ones", () => {
    const entries = fold([
      { id: "c", toolName: "cancel_workflow_invocation", phase: "start", groupId: "m1", at: 1 },
      { id: "h", toolName: "get_history_contents", phase: "start", groupId: "m1", at: 2 },
      { id: "e", toolName: "edit", phase: "start", groupId: "m1", at: 3 },
    ]);
    expect(entries.map((e) => [e.domain, e.destructive])).toEqual([
      ["invocations", true],
      ["histories", undefined],
      [undefined, undefined],
    ]);
  });
});

describe("startedWork: the Galaxy work a result names", () => {
  const envelope = (data: unknown, success = true) => ({ data, success, message: "" });

  it("reads the jobs a tool run submitted, from the envelope object or its JSON text", () => {
    const result = envelope({ jobs: [{ id: "j1", state: "queued" }, { id: "j2" }], outputs: [] });
    const expected = [
      { kind: "job", id: "j1", state: "queued" },
      { kind: "job", id: "j2", state: "new" },
    ];
    expect(startedWork("run_tool", result)).toEqual(expected);
    expect(startedWork("galaxy_run_tool", JSON.stringify(result))).toEqual(expected);
  });

  it("reads the upload job from an upload", () => {
    expect(
      startedWork("upload_file_from_url", envelope({ jobs: [{ id: "j1", state: "queued" }] })),
    ).toEqual([{ kind: "job", id: "j1", state: "queued" }]);
  });

  it("reads one invocation or a batch from invoke_workflow", () => {
    expect(startedWork("invoke_workflow", envelope({ id: "i1", state: "new" }))).toEqual([
      { kind: "invocation", id: "i1", state: "new" },
    ]);
    expect(startedWork("invoke_workflow", envelope([{ id: "i1" }, { id: "i2" }]))).toHaveLength(2);
  });

  it("finds nothing in a failed call, another operation, or something that isn't an envelope", () => {
    expect(startedWork("run_tool", envelope({ jobs: [{ id: "j1" }] }, false))).toEqual([]);
    expect(startedWork("get_job_details", envelope({ jobs: [{ id: "j1" }] }))).toEqual([]);
    expect(startedWork("upload_local_file", envelope({ jobs: [{ id: "j1" }] }))).toEqual([]);
    expect(startedWork("run_tool", "not json")).toEqual([]);
    expect(startedWork("run_tool", { content: [] })).toEqual([]);
  });
});

describe("advance: a workflow run's title", () => {
  const invoked: NarrationEvent[] = [
    { kind: "group-start", groupId: "m1", at: 0 },
    { id: "w", toolName: "invoke_workflow", phase: "start", groupId: "m1", at: 1, args: {} },
    {
      id: "w",
      toolName: "invoke_workflow",
      phase: "end",
      groupId: "m1",
      at: 2,
      result: { success: true, data: { id: "i1", state: "new" } },
    },
    { kind: "group-end", groupId: "m1", at: 2 },
  ];

  it("reads as running once Galaxy has it, and keeps the harness's label beside it", () => {
    const running = play(invoked);
    expect(running.groups[0].entries[0].title).toBe("Running a workflow");
    expect(currentStatus(running)?.text).toBe("Galaxy is still working: Running a workflow");

    const labeled = advance(running, {
      kind: "run-labeled",
      at: 3,
      id: "i1",
      label: "Trim and count",
    });
    expect(labeled.groups[0].entries[0]).toMatchObject({
      title: "Running a workflow",
      startedRuns: [{ id: "i1", label: "Trim and count" }],
    });
    expect(currentStatus(labeled)?.text).toBe(
      'Galaxy is still working: Running a workflow · "Trim and count"',
    );
  });

  it("names the workflow when an earlier read gave its name", () => {
    const state = play([
      { kind: "group-start", groupId: "m1", at: 0 },
      { id: "d", toolName: "get_workflow_details", phase: "start", groupId: "m1", at: 1, args: {} },
      {
        id: "d",
        toolName: "get_workflow_details",
        phase: "end",
        groupId: "m1",
        at: 1,
        result: { success: true, data: { id: "wf1", name: "Duplicate dataset" } },
      },
      ...invoked
        .slice(1)
        .map((e) =>
          "phase" in e && e.phase === "start" ? { ...e, args: { workflow_id: "wf1" } } : e,
        ),
    ]);
    const run = state.groups[0].entries.find((e) => e.toolName === "invoke_workflow");
    expect(run).toMatchObject({
      title: 'Running "Duplicate dataset"',
      doneTitle: 'Ran "Duplicate dataset"',
    });
  });

  it("ignores a label for a run it doesn't know", () => {
    const running = play(invoked);
    expect(advance(running, { kind: "run-labeled", at: 3, id: "i9", label: "Other" })).toBe(
      running,
    );
  });
});

describe("advance: rows follow their Galaxy jobs", () => {
  const submitted = (id: string, jobs: { id: string; state?: string }[], at = 2): ToolEvent => ({
    id,
    toolName: "run_tool",
    phase: "end",
    groupId: "m1",
    at,
    result: { data: { jobs }, success: true },
  });
  const started = (id: string, at = 1): ToolEvent => ({
    id,
    toolName: "run_tool",
    phase: "start",
    groupId: "m1",
    at,
    args: { tool_id: "fasterq_dump" },
  });

  it("keeps a row running after the call returns, until Galaxy finishes the job", () => {
    const state = play([
      { kind: "group-start", groupId: "m1", at: 0 },
      started("t1"),
      submitted("t1", [{ id: "j1", state: "queued" }]),
      { kind: "group-end", groupId: "m1", at: 5 },
    ]);
    const [entry] = state.groups[0].entries;
    expect(entry.status).toBe("running");
    expect(entry.endedAt).toBeUndefined();
    expect(currentStatus(state)).toEqual({
      text: "Galaxy is still working: Running fasterq_dump",
      since: 2,
    });

    const done = advance(state, { kind: "job-state", at: 40, id: "j1", state: "ok" });
    expect(done.groups[0].entries[0]).toMatchObject({ status: "done", endedAt: 40 });
    expect(currentStatus(done)).toBeNull();
  });

  it("marks the row failed when its job fails", () => {
    const state = play([
      { kind: "group-start", groupId: "m1", at: 0 },
      started("t1"),
      submitted("t1", [{ id: "j1", state: "queued" }]),
      { kind: "job-state", at: 30, id: "j1", state: "error" },
    ]);
    expect(state.groups[0].entries[0]).toMatchObject({
      status: "failed",
      failedTitle: "fasterq_dump failed",
      detail: "The Galaxy job failed",
    });
  });

  it("says how many of a call's jobs failed, and when they were cancelled instead", () => {
    const three = [
      { kind: "group-start", groupId: "m1", at: 0 },
      started("t1"),
      submitted("t1", [
        { id: "j1", state: "queued" },
        { id: "j2", state: "queued" },
        { id: "j3", state: "queued" },
      ]),
    ] as const;
    const some = play([
      ...three,
      { kind: "job-state", at: 9, id: "j1", state: "ok" },
      { kind: "job-state", at: 10, id: "j2", state: "error" },
      { kind: "job-state", at: 11, id: "j3", state: "error" },
    ]);
    expect(some.groups[0].entries[0].detail).toBe("2 of 3 Galaxy jobs failed");
    const all = play([
      ...three,
      { kind: "job-state", at: 9, id: "j1", state: "error" },
      { kind: "job-state", at: 10, id: "j2", state: "error" },
      { kind: "job-state", at: 11, id: "j3", state: "error" },
    ]);
    expect(all.groups[0].entries[0].detail).toBe("All 3 Galaxy jobs failed");
    const cancelled = play([
      ...three,
      { kind: "job-state", at: 9, id: "j1", state: "ok" },
      { kind: "job-state", at: 10, id: "j2", state: "deleted" },
      { kind: "job-state", at: 11, id: "j3", state: "ok" },
    ]);
    expect(cancelled.groups[0].entries[0].detail).toBe("1 of 3 Galaxy jobs was cancelled");
  });

  it("says a workflow run failed", () => {
    const state = play([
      { kind: "group-start", groupId: "m1", at: 0 },
      { id: "w1", toolName: "invoke_workflow", phase: "start", groupId: "m1", at: 1 },
      {
        id: "w1",
        toolName: "invoke_workflow",
        phase: "end",
        groupId: "m1",
        at: 2,
        result: { data: { id: "i1", state: "new" }, success: true },
      },
      { kind: "job-state", at: 9, id: "i1", state: "failed" },
    ]);
    expect(state.groups[0].entries[0]).toMatchObject({
      status: "failed",
      failedTitle: "The workflow run failed",
      detail: "The workflow run failed",
    });
  });

  it("waits for every job a call started, and counts the rest", () => {
    const state = play([
      { kind: "group-start", groupId: "m1", at: 0 },
      started("t1"),
      submitted("t1", [
        { id: "j1", state: "queued" },
        { id: "j2", state: "queued" },
      ]),
      { kind: "group-end", groupId: "m1", at: 5 },
      { kind: "job-state", at: 20, id: "j1", state: "ok" },
    ]);
    expect(state.groups[0].entries[0].status).toBe("running");
    expect(currentStatus(state)?.text).toBe("Galaxy is still working: Running fasterq_dump");
    const both = play([
      { kind: "group-start", groupId: "m1", at: 0 },
      started("t1"),
      submitted("t1", [
        { id: "j1", state: "queued" },
        { id: "j2", state: "queued" },
      ]),
      { kind: "group-end", groupId: "m1", at: 5 },
    ]);
    expect(currentStatus(both)?.text).toBe(
      "Galaxy is still working: Running fasterq_dump (+1 more)",
    );
  });

  it("lets go of a job the harness stopped tracking, as untracked rather than done or failed", () => {
    const state = play([
      { kind: "group-start", groupId: "m1", at: 0 },
      started("t1"),
      submitted("t1", [{ id: "j1", state: "queued" }]),
      { kind: "job-state", at: 7, id: "j1", state: "running" },
      { kind: "group-end", groupId: "m1", at: 8 },
      { kind: "job-state", at: 9, id: "j1", state: "untracked" },
    ]);
    const [entry] = state.groups[0].entries;
    expect(entry.status).toBe("untracked");
    expect(entry.endedAt).toBe(9);
    // The last state Galaxy reported is kept, so the view can say "last seen running".
    expect(entry.startedRuns).toEqual([
      { kind: "job", id: "j1", state: "running", untracked: true },
    ]);
    expect(currentStatus(state)).toBeNull();
  });

  it("calls a row failed, not untracked, when another of its jobs failed", () => {
    const state = play([
      { kind: "group-start", groupId: "m1", at: 0 },
      started("t1"),
      submitted("t1", [
        { id: "j1", state: "queued" },
        { id: "j2", state: "queued" },
      ]),
      { kind: "job-state", at: 9, id: "j1", state: "untracked" },
      { kind: "job-state", at: 10, id: "j2", state: "error" },
    ]);
    expect(state.groups[0].entries[0].status).toBe("failed");
  });

  it("keeps a row running while another of its jobs is still going", () => {
    const state = play([
      { kind: "group-start", groupId: "m1", at: 0 },
      started("t1"),
      submitted("t1", [
        { id: "j1", state: "queued" },
        { id: "j2", state: "queued" },
      ]),
      { kind: "group-end", groupId: "m1", at: 5 },
      { kind: "job-state", at: 9, id: "j1", state: "untracked" },
    ]);
    expect(state.groups[0].entries[0].status).toBe("running");
    expect(currentStatus(state)?.text).toBe("Galaxy is still working: Running fasterq_dump");
  });

  it("finishes a row when its workflow invocation completes", () => {
    const state = play([
      { kind: "group-start", groupId: "m1", at: 0 },
      { id: "w1", toolName: "invoke_workflow", phase: "start", groupId: "m1", at: 1 },
      {
        id: "w1",
        toolName: "invoke_workflow",
        phase: "end",
        groupId: "m1",
        at: 2,
        result: { data: { id: "i1", state: "new" }, success: true },
      },
      { kind: "job-state", at: 3, id: "i1", state: "scheduled" },
    ]);
    expect(state.groups[0].entries[0].status).toBe("running");
    const done = advance(state, { kind: "job-state", at: 9, id: "i1", state: "completed" });
    expect(done.groups[0].entries[0].status).toBe("done");
  });

  it("keeps an upload from a URL running until its upload job ends, and fails it if the job fails", () => {
    const upload = (state: string): ToolEvent[] => [
      {
        id: "u1",
        toolName: "upload_file_from_url",
        phase: "start",
        groupId: "m1",
        at: 1,
        args: { url: "https://x.org/a/genome.fna.gz" },
      },
      {
        id: "u1",
        toolName: "upload_file_from_url",
        phase: "end",
        groupId: "m1",
        at: 2,
        result: {
          data: {
            outputs: [{ id: "d1", hid: 48, name: "genome.fna.gz" }],
            jobs: [{ id: "j1", state }],
          },
          success: true,
        },
      },
    ];
    const accepted = play([
      { kind: "group-start", groupId: "m1", at: 0 },
      ...upload("queued"),
      { kind: "group-end", groupId: "m1", at: 3 },
    ]);
    expect(accepted.groups[0].entries[0].status).toBe("running");
    expect(currentStatus(accepted)?.text).toBe("Galaxy is still working: Uploading genome.fna.gz");

    const failed = advance(accepted, { kind: "job-state", at: 20, id: "j1", state: "error" });
    expect(failed.groups[0].entries[0]).toMatchObject({
      status: "failed",
      failedTitle: "Couldn't upload genome.fna.gz",
      detail: "The Galaxy job failed",
    });
    expect(currentStatus(failed)).toBeNull();

    const ok = play([{ kind: "group-start", groupId: "m1", at: 0 }, ...upload("ok")]);
    expect(ok.groups[0].entries[0].status).toBe("done");
  });

  it("marks a job already finished when submitted as done straight away", () => {
    const state = play([
      { kind: "group-start", groupId: "m1", at: 0 },
      started("t1"),
      submitted("t1", [{ id: "j1", state: "ok" }]),
      { kind: "group-end", groupId: "m1", at: 5 },
    ]);
    expect(state.groups[0].entries[0].status).toBe("done");
    expect(currentStatus(state)).toBeNull();
  });

  it("tracks nothing when the call's envelope says it failed", () => {
    const state = play([
      { kind: "group-start", groupId: "m1", at: 0 },
      started("t1"),
      {
        id: "t1",
        toolName: "run_tool",
        phase: "end",
        groupId: "m1",
        at: 2,
        result: { data: null, success: false, message: "bad inputs" },
      },
      { kind: "group-end", groupId: "m1", at: 5 },
    ]);
    expect(state.galaxyRunning).toEqual([]);
  });

  it("ignores a state for a job it doesn't know, and loose reports for jobs it tracks by id", () => {
    const state = play([
      { kind: "group-start", groupId: "m1", at: 0 },
      started("t1"),
      submitted("t1", [{ id: "j1", state: "queued" }]),
      { kind: "group-end", groupId: "m1", at: 5 },
    ]);
    expect(advance(state, { kind: "job-state", at: 9, id: "zzz", state: "ok" })).toBe(state);
    expect(advance(state, { kind: "galaxy-finished", at: 9, label: "fasterq_dump" })).toBe(state);
  });
});

describe("done titles", () => {
  it("tells a finished read or check in the past tense", () => {
    expect(describeDoneCall("get_history_contents")).toBe("Looked at your history");
    expect(describeDoneCall("get_job_details")).toBe("Checked on a job");
    expect(describeDoneCall("galaxy_search_ena")).toBe("Searched public data");
  });

  it("has no separate done title for bookkeeping, or a change without words of its own", () => {
    expect(describeDoneCall("edit")).toBeUndefined();
    expect(describeDoneCall("create_page")).toBeUndefined();
  });

  it("puts the done title on reads and on changes with words of their own", () => {
    const entries = fold([
      { id: "h", toolName: "get_history_contents", phase: "start", groupId: "m1", at: 1 },
      {
        id: "r",
        toolName: "run_tool",
        phase: "start",
        groupId: "m1",
        at: 2,
        args: { tool_id: "cat1" },
      },
    ]);
    expect(entries.map((e) => [e.title, e.doneTitle])).toEqual([
      ["Looking at your history", "Looked at your history"],
      ["Running cat1", "Ran cat1"],
    ]);
  });
});

describe("step 7: titles from a call's arguments", () => {
  it("names the accession a tool run works on, and says it in the past once done", () => {
    const args = {
      tool_id: "toolshed.g2.bx.psu.edu/repos/iuc/sra_tools/fastq_dump/2.11.0+galaxy0",
      inputs: { "input|input_select": "accession_number", "input|accession": "SRR22376031" },
    };
    expect(describeToolCall("run_tool", args)).toBe("Running fastq_dump on SRR22376031");
    expect(describeDoneCall("run_tool", args)).toBe("Ran fastq_dump on SRR22376031");
  });

  it("names the history being created, and copes without a name", () => {
    expect(describeToolCall("create_history", { history_name: "RNA-seq" })).toBe(
      'Creating history "RNA-seq"',
    );
    expect(describeDoneCall("create_history", { history_name: "RNA-seq" })).toBe(
      'Created history "RNA-seq"',
    );
    expect(describeToolCall("create_history", {})).toBe("Creating a history");
  });

  it("names the file being uploaded, from its name or the end of its URL", () => {
    expect(
      describeToolCall("upload_file_from_url", {
        url: "https://zenodo.org/x/reads_1.fastq.gz?download=1",
      }),
    ).toBe("Uploading reads_1.fastq.gz");
    expect(describeDoneCall("upload_file_from_url", { url: "u", file_name: "counts.tsv" })).toBe(
      "Uploaded counts.tsv",
    );
  });
});

describe("failed titles", () => {
  it("says a change failed in its own words, not as still running", () => {
    expect(describeFailedCall("run_tool", { tool_id: "rna_star" })).toBe("rna_star failed");
    expect(
      describeFailedCall("run_tool", {
        tool_id: "fastq_dump",
        inputs: { "input|accession": "SRR22376031" },
      }),
    ).toBe("fastq_dump failed on SRR22376031");
    expect(describeFailedCall("create_history", { history_name: "RNA-seq" })).toBe(
      'Couldn\'t create history "RNA-seq"',
    );
    expect(
      describeFailedCall("upload_file_from_url", { url: "https://x.org/a/genome.fna.gz" }),
    ).toBe("Couldn't upload genome.fna.gz");
  });

  it("has no failed title for reads or changes without words of their own", () => {
    expect(describeFailedCall("get_history_contents")).toBeUndefined();
    expect(describeFailedCall("create_page")).toBeUndefined();
    expect(describeFailedCall("edit")).toBeUndefined();
  });
});

describe("step 7: what a result produced", () => {
  const ok = (data: unknown) => ({ data, success: true, message: "" });

  it("links the datasets, collections and jobs a tool run made", () => {
    const refs = producedRefs(
      "run_tool",
      ok({
        outputs: [
          { id: "d1", hid: 41, name: "forward" },
          { id: "d2", hid: 42, name: "reverse" },
        ],
        output_collections: [{ id: "c1", hid: 43, name: "pairs" }],
        jobs: [{ id: "j1" }],
      }),
    );
    expect(refs).toEqual([
      { kind: "dataset", id: "d1", label: "#41 forward", hid: 41, name: "forward", role: "output" },
      { kind: "dataset", id: "d2", label: "#42 reverse", hid: 42, name: "reverse", role: "output" },
      { kind: "collection", id: "c1", label: "#43 pairs", hid: 43, name: "pairs", role: "output" },
      { kind: "job", id: "j1", label: "j1", role: "output" },
    ]);
    expect(producedSummary(refs)).toBe("2 new datasets (#41, #42), 1 new collection (#43)");
  });

  it("links the history a call created, and the workflow runs it started", () => {
    expect(producedRefs("create_history", ok({ id: "h1", name: "RNA-seq" }))).toEqual([
      { kind: "history", id: "h1", label: "RNA-seq", name: "RNA-seq", role: "output" },
    ]);
    expect(producedRefs("invoke_workflow", ok([{ id: "i1" }, { id: "i2" }]))).toHaveLength(2);
  });

  it("produces nothing for a failed call or a read", () => {
    expect(producedRefs("run_tool", { data: { outputs: [{ id: "d1" }] }, success: false })).toEqual(
      [],
    );
    expect(producedRefs("get_history_contents", ok([{ id: "d1" }]))).toEqual([]);
    expect(producedSummary([{ kind: "job", id: "j1", label: "j1" }])).toBeUndefined();
    // Inputs are not something a call produced.
    expect(
      producedSummary([{ kind: "dataset", id: "d4", label: "#4", hid: 4, role: "input" }]),
    ).toBeUndefined();
  });
});

describe("step 7: why a call failed", () => {
  it("pulls Galaxy's own err_msg out of a long failure message", () => {
    const message =
      "Error: Error calling tool 'run_tool': Run tool failed: Unexpected HTTP status code: 400: " +
      '{"err_msg": "Parameter \'0|input\' has an invalid key structure.", "err_code": 400008}. Context: …';
    expect(failureReason({ data: null, success: false, message })).toBe(
      "Parameter '0|input' has an invalid key structure.",
    );
  });

  it("keeps a plain failure whole, without the wrapper's preamble", () => {
    expect(
      failureReason({
        success: false,
        data: null,
        message: "Error: Error calling tool 'x': History not found\nmore",
      }),
    ).toBe("History not found\nmore");
    expect(failureReason("x".repeat(400))?.length).toBe(400);
  });

  it("reads a failure envelope that has no data, as galaxy-ops sends it", () => {
    const text = JSON.stringify({
      success: false,
      message:
        'Run tool failed: Unexpected HTTP status code: 400: {"err_msg": "Parameter \'lineNum\': the attribute \'value\' must be set for non optional parameters", "err_code": 400008}. Context: …',
    });
    expect(failureReason(text)).toBe(
      "Parameter 'lineNum': the attribute 'value' must be set for non optional parameters",
    );
    expect(failureReason(JSON.parse(text))).toBe(
      "Parameter 'lineNum': the attribute 'value' must be set for non optional parameters",
    );
  });

  it("has no reason for a success", () => {
    expect(failureReason({ data: {}, success: true, message: "ok" })).toBeUndefined();
  });
});

describe("step 7: finished entries carry what happened", () => {
  it("puts refs and a produced line on a successful tool run", () => {
    const entries = play([
      { kind: "group-start", groupId: "m1", at: 0 },
      {
        id: "t",
        toolName: "run_tool",
        phase: "start",
        groupId: "m1",
        at: 1,
        args: { tool_id: "cat1" },
      },
      {
        id: "t",
        toolName: "run_tool",
        phase: "end",
        groupId: "m1",
        at: 2,
        result: { data: { outputs: [{ id: "d1", hid: 7, name: "out" }], jobs: [] }, success: true },
      },
    ]).groups[0].entries;
    expect(entries[0]).toMatchObject({
      status: "done",
      detail: "1 new dataset (#7)",
      galaxyRefs: [
        { kind: "tool", id: "cat1", role: "input" },
        { kind: "dataset", id: "d1", label: "#7 out" },
      ],
    });
  });

  it("marks a call failed when its envelope says so, even if the harness didn't, with the reason", () => {
    const entries = play([
      { kind: "group-start", groupId: "m1", at: 0 },
      {
        id: "t",
        toolName: "run_tool",
        phase: "start",
        groupId: "m1",
        at: 1,
        args: { tool_id: "cat1" },
      },
      {
        id: "t",
        toolName: "run_tool",
        phase: "end",
        groupId: "m1",
        at: 2,
        result: { data: null, success: false, message: "Tool cat1 not found" },
      },
    ]).groups[0].entries;
    expect(entries[0]).toMatchObject({ status: "failed", detail: "Tool cat1 not found" });
  });

  it("keeps a failed call's whole message beside its short reason", () => {
    const message =
      'Error calling tool \'run_tool\': 400: {"err_msg": "Parameter \'input1\' is required", "err_code": 400008}\ntraceback …';
    const entries = play([
      { kind: "group-start", groupId: "m1", at: 0 },
      {
        id: "t",
        toolName: "run_tool",
        phase: "start",
        groupId: "m1",
        at: 1,
        args: { tool_id: "cat1" },
      },
      {
        id: "t",
        toolName: "run_tool",
        phase: "end",
        groupId: "m1",
        at: 2,
        result: { data: null, success: false, message },
      },
    ]).groups[0].entries;
    expect(entries[0]).toMatchObject({
      detail: "Parameter 'input1' is required",
      failureMessage: message,
    });
  });

  it("gives a reason for a call the harness flagged as an error", () => {
    const entries = play([
      { kind: "group-start", groupId: "m1", at: 0 },
      { id: "t", toolName: "run_tool", phase: "start", groupId: "m1", at: 1 },
      {
        id: "t",
        toolName: "run_tool",
        phase: "end",
        groupId: "m1",
        at: 2,
        isError: true,
        result: "Galaxy timed out",
      },
    ]).groups[0].entries;
    expect(entries[0]).toMatchObject({ status: "failed", detail: "Galaxy timed out" });
  });
});

describe("step 8: name memory", () => {
  const ok = (data: unknown) => ({ data, success: true, message: "" });
  const end = (id: string, toolName: string, result: unknown, at = 2): NarrationEvent => ({
    id,
    toolName,
    phase: "end",
    groupId: "m1",
    at,
    result,
  });
  const start = (id: string, toolName: string, args: unknown, at = 1): NarrationEvent => ({
    id,
    toolName,
    phase: "start",
    groupId: "m1",
    at,
    args,
  });

  it("learns tool names from tool lookups and searches", () => {
    let names = learnNames(
      EMPTY_NAMES,
      "get_tool_details",
      ok({ id: "random_lines1", name: "Select random lines" }),
    );
    names = learnNames(
      names,
      "search_tools_by_name",
      ok([{ id: "cat1", name: "Concatenate datasets" }]),
    );
    expect(names.tools).toEqual({
      random_lines1: "Select random lines",
      cat1: "Concatenate datasets",
    });
  });

  it("learns datasets and collections from history contents, and histories from history lookups", () => {
    let names = learnNames(
      EMPTY_NAMES,
      "get_history_contents",
      ok([
        { id: "d4", hid: 4, name: "synthetic_counts.tsv", history_content_type: "dataset" },
        { id: "c9", hid: 9, name: "pairs", history_content_type: "dataset_collection" },
      ]),
    );
    names = learnNames(names, "get_histories", ok([{ id: "h1", name: "RNA-seq" }]));
    expect(names.datasets).toEqual({ d4: { id: "d4", name: "synthetic_counts.tsv", hid: 4 } });
    expect(names.collections).toEqual({ c9: { id: "c9", name: "pairs", hid: 9 } });
    expect(names.histories).toEqual({ h1: "RNA-seq" });
  });

  it("learns a dataset from its details, and new outputs from a tool run", () => {
    let names = learnNames(
      EMPTY_NAMES,
      "get_dataset_details",
      ok({
        dataset: { id: "d4", hid: 4, name: "counts", model_class: "HistoryDatasetAssociation" },
      }),
    );
    names = learnNames(
      names,
      "run_tool",
      ok({
        outputs: [{ id: "d7", hid: 7, name: "picked", history_content_type: "dataset" }],
        jobs: [],
      }),
    );
    expect(Object.keys(names.datasets)).toEqual(["d4", "d7"]);
  });

  it("learns nothing from a failure, and keeps the same memory when nothing is new", () => {
    expect(learnNames(EMPTY_NAMES, "get_tool_details", { data: null, success: false })).toBe(
      EMPTY_NAMES,
    );
    const names = learnNames(EMPTY_NAMES, "get_tool_details", ok({ id: "x", name: "X" }));
    expect(learnNames(names, "get_tool_details", ok({ id: "x", name: "X" }))).toBe(names);
  });

  it("titles a later tool run with the tool's name and its input's name and history item index", () => {
    const state = play([
      { kind: "group-start", groupId: "m1", at: 0 },
      start("a", "get_tool_details", { tool_id: "random_lines1" }),
      end("a", "get_tool_details", ok({ id: "random_lines1", name: "Select random lines" })),
      start("b", "get_history_contents", { history_id: "h1" }),
      end(
        "b",
        "get_history_contents",
        ok([{ id: "d4", hid: 4, name: "synthetic_counts.tsv", history_content_type: "dataset" }]),
      ),
      start("c", "run_tool", {
        tool_id: "random_lines1",
        inputs: { input: { src: "hda", id: "d4" } },
      }),
    ]);
    const run = state.groups[0].entries.find((e) => e.id === "c");
    expect(run?.title).toBe('Running Select random lines on "synthetic_counts.tsv" (#4)');
    expect(run?.doneTitle).toBe('Ran Select random lines on "synthetic_counts.tsv" (#4)');
  });

  it("says how many inputs when there are several, and nothing about an input it can't name", () => {
    const names = learnNames(
      EMPTY_NAMES,
      "get_history_contents",
      ok([{ id: "d4", hid: 4, name: "a", history_content_type: "dataset" }]),
    );
    const several = {
      tool_id: "cat1",
      inputs: { input1: { src: "hda", id: "d4" }, queries_0: { input2: { src: "hda", id: "d5" } } },
    };
    expect(describeToolCall("run_tool", several, names)).toBe("Running cat1 on 2 datasets");
    expect(
      describeToolCall(
        "run_tool",
        { tool_id: "cat1", inputs: { input1: { src: "hda", id: "zz" } } },
        names,
      ),
    ).toBe("Running cat1");
  });

  it("prefers an accession among the inputs over dataset names", () => {
    const names = learnNames(
      EMPTY_NAMES,
      "get_tool_details",
      ok({ id: "fastq_dump", name: "Faster Download" }),
    );
    expect(
      describeToolCall("run_tool", { tool_id: "fastq_dump", inputs: { acc: "SRR1" } }, names),
    ).toBe("Running Faster Download on SRR1");
  });
});

describe("input refs: the id always travels with the history item index", () => {
  const ok = (data: unknown) => ({ data, success: true, message: "" });

  it("lists each dataset and collection a call's inputs point at once, with id, history item index and name when known", () => {
    const names = learnNames(
      EMPTY_NAMES,
      "get_history_contents",
      ok([{ id: "d4", hid: 4, name: "counts", history_content_type: "dataset" }]),
    );
    const refs = inputRefs(
      {
        input1: { src: "hda", id: "d4" },
        repeat_0: {
          input2: {
            values: [
              { src: "hdca", id: "c9" },
              { src: "hda", id: "d4" },
            ],
          },
        },
      },
      names,
    );
    expect(refs).toEqual([
      { kind: "dataset", id: "d4", label: "#4 counts", hid: 4, name: "counts", role: "input" },
      { kind: "collection", id: "c9", label: "c9", role: "input" },
    ]);
  });

  it("puts a tool run's inputs on its entry, then adds what it produced", () => {
    const state = play([
      { kind: "group-start", groupId: "m1", at: 0 },
      {
        id: "t",
        toolName: "run_tool",
        phase: "start",
        groupId: "m1",
        at: 1,
        args: { tool_id: "cat1", inputs: { input1: { src: "hda", id: "d4" } } },
      },
      {
        id: "t",
        toolName: "run_tool",
        phase: "end",
        groupId: "m1",
        at: 2,
        result: ok({ outputs: [{ id: "d7", hid: 7, name: "out" }], jobs: [] }),
      },
    ]);
    const entry = state.groups[0].entries[0];
    expect(entry.galaxyRefs.map((r) => [r.role, r.kind, r.id, r.hid])).toEqual([
      ["input", "dataset", "d4", undefined],
      ["input", "tool", "cat1", undefined],
      ["output", "dataset", "d7", 7],
    ]);
    expect(entry.detail).toBe("1 new dataset (#7)");
  });
});

describe("step 12a: groups side by side", () => {
  const call = (id: string, phase: "start" | "end", at: number, groupId: string): ToolEvent => ({
    id,
    toolName: "get_history_contents",
    phase,
    groupId,
    at,
  });

  it("keeps named groups apart, each ending at its own time, in either order", () => {
    const state = play([
      { kind: "group-start", at: 0, groupId: "msg-1" },
      { kind: "group-start", at: 1, groupId: "check-1" },
      call("a", "start", 2, "msg-1"),
      call("b", "start", 3, "check-1"),
      call("a", "end", 4, "msg-1"),
      { kind: "group-end", at: 5, groupId: "check-1" },
      { kind: "model", at: 6, activity: "thinking", groupId: "msg-1" },
    ]);
    const [msg, check] = state.groups;
    expect(msg).toMatchObject({ id: "msg-1", status: "active", now: { text: "Thinking…" } });
    expect(msg.entries.map((e) => [e.id, e.status])).toEqual([["a", "done"]]);
    expect(check).toMatchObject({ id: "check-1", status: "done", now: null });
    expect(check.entries.map((e) => e.id)).toEqual(["b"]);

    const both = advance(state, { kind: "group-end", at: 7, groupId: "msg-1" });
    expect(both.groups.map((g) => g.status)).toEqual(["done", "done"]);
  });

  it("never ends a group because another one started", () => {
    const state = play([
      { kind: "group-start", at: 0, groupId: "msg-1" },
      { kind: "group-start", at: 1, groupId: "msg-2" },
    ]);
    expect(state.groups.map((g) => [g.id, g.status])).toEqual([
      ["msg-1", "active"],
      ["msg-2", "active"],
    ]);
  });

  it("finishes a call in its own group even after that group ended, without reopening it", () => {
    const state = play([
      { kind: "group-start", at: 0, groupId: "check-1" },
      call("b", "start", 1, "check-1"),
      { kind: "group-end", at: 2, groupId: "check-1" },
      { kind: "group-start", at: 3, groupId: "msg-2" },
      call("b", "end", 4, "check-1"),
    ]);
    expect(state.groups.map((g) => g.id)).toEqual(["check-1", "msg-2"]);
    expect(state.groups[0]).toMatchObject({ status: "done", now: null });
    expect(state.groups[0].entries[0]).toMatchObject({ status: "done", endedAt: 4 });
    expect(state.groups[1].now?.text).toBe("Reading your request…");
  });

  it("opens no group for the end of a call it never saw start", () => {
    expect(play([call("x", "end", 1, "msg-1")]).groups).toEqual([]);
  });

  it("ignores a repeated start for a group already running", () => {
    const once = play([{ kind: "group-start", at: 0, groupId: "msg-1" }]);
    expect(advance(once, { kind: "group-start", at: 1, groupId: "msg-1" })).toBe(once);
  });

  it("puts a wait on its own group, even while another runs", () => {
    const state = play([
      { kind: "group-start", at: 0, groupId: "msg-1" },
      { kind: "group-start", at: 1, groupId: "msg-2" },
      { kind: "awaiting-user", at: 2, text: "approve it", id: "p1", groupId: "msg-1" },
      { kind: "group-end", at: 3, groupId: "msg-1" },
    ]);
    expect(state.groups[0]).toMatchObject({ status: "waiting", waitingFor: [{ id: "p1" }] });
    expect(state.groups[1]).toMatchObject({ status: "active" });
    expect(state.groups[1].waitingFor).toBeUndefined();
  });

  it("puts the newest group still at work in the status line, and the older one once it ends", () => {
    const two = play([
      { kind: "group-start", at: 0, groupId: "msg-1" },
      { kind: "group-start", at: 1, groupId: "msg-2" },
    ]);
    expect(currentStatus(two)?.since).toBe(1);
    const back = advance(two, { kind: "group-end", at: 2, groupId: "msg-2" });
    expect(currentStatus(back)?.since).toBe(0);
    expect(currentStatus(advance(back, { kind: "group-end", at: 3, groupId: "msg-1" }))).toBeNull();
  });
});

describe("calls running side by side in one group", () => {
  const call = (id: string, toolName: string, phase: "start" | "end", at: number): ToolEvent => ({
    id,
    toolName,
    phase,
    groupId: "m1",
    at,
  });

  it("goes back to a call still running when another ends, with its own timer", () => {
    const state = play([
      { kind: "group-start", groupId: "m1", at: 0 },
      call("h", "get_history_contents", "start", 1),
      call("d", "get_dataset_details", "start", 2),
      call("d", "get_dataset_details", "end", 3),
    ]);
    expect(currentStatus(state)).toEqual({
      text: "Looking at your history…",
      since: 1,
      waitingOn: "galaxy",
    });
  });

  it("says it is deciding the next step only once no call is left running", () => {
    const state = play([
      { kind: "group-start", groupId: "m1", at: 0 },
      call("h", "get_history_contents", "start", 1),
      call("d", "get_dataset_details", "start", 2),
      call("d", "get_dataset_details", "end", 3),
      call("h", "get_history_contents", "end", 4),
    ]);
    expect(currentStatus(state)).toEqual({
      text: "Deciding the next step…",
      since: 4,
      waitingOn: "assistant",
    });
  });

  it("doesn't count a call whose Galaxy job is still running as a call still running", () => {
    const state = play([
      { kind: "group-start", groupId: "m1", at: 0 },
      { ...call("r", "run_tool", "start", 1), args: { tool_id: "fastp" } },
      {
        ...call("r", "run_tool", "end", 2),
        result: { data: { jobs: [{ id: "j1", state: "queued" }] }, success: true },
      },
    ]);
    expect(state.groups[0].entries[0].status).toBe("running");
    expect(currentStatus(state)?.text).toBe("Deciding the next step…");
  });
});

describe("everything happening now", () => {
  const submitted = (id: string, groupId: string, jobId: string, at: number): ToolEvent[] => [
    { id, toolName: "run_tool", phase: "start", groupId, at, args: { tool_id: "fastp" } },
    {
      id,
      toolName: "run_tool",
      phase: "end",
      groupId,
      at: at + 1,
      result: { data: { jobs: [{ id: jobId, state: "queued" }] }, success: true },
    },
  ];

  it("shows a paused follow-up and the Galaxy jobs still running, together", () => {
    const state = play([
      { kind: "group-start", groupId: "m1", at: 0 },
      ...submitted("t1", "m1", "j1", 1),
      ...submitted("t2", "m1", "j2", 3),
      { kind: "group-end", groupId: "m1", at: 5 },
      { kind: "awaiting-user", groupId: "m1", at: 6, text: "say continue", id: "follow-up-paused" },
    ]);
    expect(currentActivity(state)).toEqual([
      { kind: "waiting", groupId: "m1", id: "follow-up-paused", text: "say continue", since: 6 },
      { kind: "galaxy", groupId: "m1", galaxyId: "j1", text: "Running fastp", since: 2 },
      { kind: "galaxy", groupId: "m1", galaxyId: "j2", text: "Running fastp", since: 4 },
    ]);
    // With room for one line, the wait still comes first, as before.
    expect(currentStatus(state)?.text).toBe("Waiting for you: say continue");
  });

  it("lists groups at work newest first, then waits oldest first, then Galaxy work", () => {
    const state = play([
      { kind: "group-start", groupId: "m1", at: 0 },
      { kind: "awaiting-user", groupId: "m1", at: 1, text: "approve A", id: "a" },
      { kind: "group-start", groupId: "m2", at: 2 },
      { kind: "awaiting-user", groupId: "m2", at: 3, text: "approve B", id: "b" },
      { kind: "model", groupId: "m1", at: 4, activity: "writing" },
      ...submitted("t1", "m2", "j1", 5),
    ]);
    expect(currentActivity(state).map((l) => [l.kind, l.groupId, l.text])).toEqual([
      ["working", "m2", "Deciding the next step…"],
      ["working", "m1", "Writing a reply…"],
      ["waiting", "m1", "approve A"],
      ["waiting", "m2", "approve B"],
      ["galaxy", "m2", "Running fastp"],
    ]);
    expect(currentStatus(state)).toEqual({
      text: "Deciding the next step…",
      since: 6,
      waitingOn: "assistant",
    });
  });

  it("is empty when nothing is happening", () => {
    const state = play([
      { kind: "group-start", groupId: "m1", at: 0 },
      { kind: "group-end", groupId: "m1", at: 1 },
    ]);
    expect(currentActivity(state)).toEqual([]);
    expect(currentActivity(EMPTY_STATE)).toEqual([]);
  });
});

describe("the message a group serves", () => {
  const ran = (id: string, groupId: string, jobId: string, at: number): ToolEvent[] => [
    { id, toolName: "run_tool", phase: "start", groupId, at, args: { tool_id: "fastp" } },
    {
      id,
      toolName: "run_tool",
      phase: "end",
      groupId,
      at: at + 1,
      result: { data: { jobs: [{ id: jobId, state: "queued" }] }, success: true },
    },
  ];

  it("anchors a group to its first message, and keeps messages added mid-run after it", () => {
    const state = play([
      { kind: "group-start", groupId: "m1", at: 0 },
      {
        kind: "group-message",
        groupId: "m1",
        at: 0,
        text: "Trim the reads",
        followUp: false,
        messageId: "u1",
      },
      {
        kind: "group-message",
        groupId: "m1",
        at: 5,
        text: "Use fastp",
        followUp: false,
        messageId: "u2",
      },
      {
        kind: "group-message",
        groupId: "m1",
        at: 6,
        text: "Use fastp",
        followUp: false,
        messageId: "u2",
      },
    ]);
    const [group] = state.groups;
    expect(group.messages.map((m) => [m.id, m.text, m.by])).toEqual([
      ["u1", "Trim the reads", "user"],
      ["u2", "Use fastp", "user"],
    ]);
    expect(anchorUserMessage(state, group)?.id).toBe("u1");
    // The message added mid-run finds the work done for it too.
    expect(groupsForUserMessage(state, "u2").map((g) => g.id)).toEqual(["m1"]);
  });

  it("points a follow-up at the message whose Galaxy work it checks, and gathers both under it", () => {
    const state = play([
      { kind: "group-start", groupId: "m1", at: 0 },
      {
        kind: "group-message",
        groupId: "m1",
        at: 0,
        text: "Trim the reads",
        followUp: false,
        messageId: "u1",
      },
      ...ran("t1", "m1", "j1", 1),
      { kind: "group-end", groupId: "m1", at: 3 },
      { kind: "group-start", groupId: "m2", at: 4 },
      {
        kind: "group-message",
        groupId: "m2",
        at: 4,
        text: "What histories do I have?",
        followUp: false,
        messageId: "u2",
      },
      { kind: "group-start", groupId: "f1", at: 9 },
      {
        kind: "group-message",
        groupId: "f1",
        at: 9,
        text: "[auto] j1 finished",
        followUp: true,
        about: [{ kind: "job", id: "j1" }],
      },
    ]);
    const followUp = state.groups[2];
    expect(followUp).toMatchObject({
      followUp: true,
      about: [{ kind: "job", id: "j1" }],
      followUpOfIds: ["m1"],
    });
    expect(anchorUserMessage(state, followUp)?.text).toBe("Trim the reads");
    expect(groupsForUserMessage(state, "u1").map((g) => g.id)).toEqual(["m1", "f1"]);
    expect(groupsForUserMessage(state, "u2").map((g) => g.id)).toEqual(["m2"]);
  });

  it("leaves a follow-up unanchored when it names no work it knows, or names it as the wrong kind", () => {
    const state = play([
      { kind: "group-start", groupId: "m1", at: 0 },
      ...ran("t1", "m1", "j1", 1),
      { kind: "group-end", groupId: "m1", at: 3 },
      { kind: "group-start", groupId: "f1", at: 4 },
      {
        kind: "group-message",
        groupId: "f1",
        at: 4,
        text: "[auto] check",
        followUp: true,
        about: [
          { kind: "job", id: "zz" },
          { kind: "invocation", id: "j1" },
        ],
      },
    ]);
    const followUp = state.groups[1];
    expect(followUp.followUpOfIds).toBeUndefined();
    expect(anchorUserMessage(state, followUp)).toBeUndefined();
  });
});

describe("rows: changes with their children", () => {
  const call = (id: string, toolName: string, at: number): ToolEvent[] => [
    { id, toolName, phase: "start", groupId: "m1", at },
    { id, toolName, phase: "end", groupId: "m1", at: at + 1 },
  ];
  const rowsFor = (events: NarrationEvent[]) =>
    rowsOf(play([{ kind: "group-start", groupId: "m1", at: 0 }, ...events]).groups[0]);
  const ids = (entries: readonly NarrationEntry[]) => entries.map((e) => e.id);

  it("puts each read under the change before it, and earlier reads under the first change", () => {
    const { rows, checks, internal } = rowsFor([
      ...call("look1", "get_history_contents", 1),
      ...call("look2", "search_tools_by_name", 3),
      ...call("run1", "run_tool", 5),
      ...call("wait1", "get_job_details", 7),
      ...call("note", "edit", 9),
      ...call("up1", "upload_file_from_url", 11),
      ...call("look3", "get_dataset_details", 13),
    ]);
    expect(rows.map((r) => [r.change.id, ids(r.children)])).toEqual([
      ["run1", ["look1", "look2", "wait1"]],
      ["up1", ["look3"]],
    ]);
    expect(checks).toEqual([]);
    expect(ids(internal)).toEqual(["note"]);
  });

  it("keeps the reads and checks of a group that changed nothing on their own", () => {
    const { rows, checks, internal } = rowsFor([
      ...call("look1", "get_histories", 1),
      ...call("note", "read", 3),
      ...call("look2", "get_history_contents", 5),
    ]);
    expect(rows).toEqual([]);
    expect(ids(checks)).toEqual(["look1", "look2"]);
    expect(ids(internal)).toEqual(["note"]);
  });

  const read = (id: string, toolName: string, args: object, at: number): ToolEvent[] => [
    { id, toolName, phase: "start", groupId: "m1", at, args },
    { id, toolName, phase: "end", groupId: "m1", at: at + 1 },
  ];
  const runOn = (
    id: string,
    dataset: string,
    at: number,
    out: string,
    job: string,
  ): ToolEvent[] => [
    {
      id,
      toolName: "run_tool",
      phase: "start",
      groupId: "m1",
      at,
      args: {
        tool_id: "Show beginning1",
        history_id: "h1",
        inputs: { input: { src: "hda", id: dataset } },
      },
    },
    {
      id,
      toolName: "run_tool",
      phase: "end",
      groupId: "m1",
      at: at + 1,
      result: { data: { outputs: [{ id: out }], jobs: [{ id: job, state: "ok" }] }, success: true },
    },
  ];

  it("puts each check under the run that works on what it checked, whatever the order", () => {
    // The order Orbit used live: both inputs checked, then both runs.
    const { rows } = rowsFor([
      ...read("c3", "get_dataset_details", { dataset_id: "d3" }, 1),
      ...read("c4", "get_dataset_details", { datasetId: "d4" }, 3),
      ...runOn("r3", "d3", 5, "d6", "j3"),
      ...runOn("r4", "d4", 7, "d7", "j4"),
      ...read("v6", "get_dataset_details", { dataset_id: "d6" }, 9),
      ...read("j", "get_job_details", { job_id: "j4" }, 11),
    ]);
    expect(rows.map((r) => [r.change.id, ids(r.children)])).toEqual([
      ["r3", ["c3", "v6"]],
      ["r4", ["c4", "j"]],
    ]);
  });

  it("names what a call targets from any id argument of a known kind, in either spelling", () => {
    expect(
      argRefs({
        dataset_id: "d1",
        historyId: "h1",
        job_id: "j1",
        page_id: "p1",
        constructor_id: "x",
        n: 3,
      }).map((r) => [r.kind, r.id]),
    ).toEqual([
      ["dataset", "d1"],
      ["history", "h1"],
      ["job", "j1"],
    ]);
  });

  it("arranges a group still at work the same way", () => {
    const { rows } = rowsFor([
      ...call("run1", "run_tool", 1),
      { id: "look1", toolName: "get_dataset_details", phase: "start", groupId: "m1", at: 3 },
    ]);
    expect(rows.map((r) => [r.change.id, ids(r.children)])).toEqual([["run1", ["look1"]]]);
  });
});

describe("rows: a failed try and its retry", () => {
  const tryRun = (
    id: string,
    at: number,
    dataset: string,
    failed: boolean,
    tool = "cat1",
  ): ToolEvent[] => [
    {
      id,
      toolName: "run_tool",
      phase: "start",
      groupId: "m1",
      at,
      args: { tool_id: tool, inputs: { input1: { src: "hda", id: dataset } } },
    },
    failed
      ? {
          id,
          toolName: "run_tool",
          phase: "end",
          groupId: "m1",
          at: at + 1,
          isError: true,
          result: "Error: bad parameter",
        }
      : {
          id,
          toolName: "run_tool",
          phase: "end",
          groupId: "m1",
          at: at + 1,
          result: { data: { outputs: [{ id: `out-${id}` }], jobs: [] }, success: true },
        },
  ];
  const upload = (id: string, at: number, file: string, failed: boolean): ToolEvent[] => [
    {
      id,
      toolName: "upload_file_from_url",
      phase: "start",
      groupId: "m1",
      at,
      args: { url: `https://x.org/${file}` },
    },
    {
      id,
      toolName: "upload_file_from_url",
      phase: "end",
      groupId: "m1",
      at: at + 1,
      isError: failed,
    },
  ];
  const look = (id: string, at: number): ToolEvent[] => [
    {
      id,
      toolName: "get_tool_details",
      phase: "start",
      groupId: "m1",
      at,
      args: { tool_id: "cat1" },
    },
    { id, toolName: "get_tool_details", phase: "end", groupId: "m1", at: at + 1 },
  ];
  const rowsFor = (events: NarrationEvent[]) =>
    rowsOf(play([{ kind: "group-start", groupId: "m1", at: 0 }, ...events]).groups[0]).rows;
  const shape = (rows: ReturnType<typeof rowsFor>) =>
    rows.map((r) => [
      r.change.id,
      r.change.status,
      r.attempts.map((a) => a.id),
      r.children.map((c) => c.id),
    ]);

  it("shows a failed run and its retry as one row, with the reads of both", () => {
    const rows = rowsFor([
      ...tryRun("t1", 1, "d4", true),
      ...look("l1", 3),
      ...tryRun("t2", 5, "d4", false),
    ]);
    expect(shape(rows)).toEqual([["t2", "done", ["t1"], ["l1"]]]);
    expect(rows[0].attempts[0].detail).toBe("bad parameter");
  });

  it("keeps every failed try, oldest first, and the row's status is the last try's", () => {
    const rows = rowsFor([
      ...tryRun("t1", 1, "d4", true),
      ...tryRun("t2", 3, "d4", true),
      ...tryRun("t3", 5, "d4", true),
    ]);
    expect(shape(rows)).toEqual([["t3", "failed", ["t1", "t2"], []]]);
  });

  it("keeps a failed change on its own row when what comes next isn't the same change", () => {
    const rows = rowsFor([
      ...tryRun("t1", 1, "d4", true),
      ...tryRun("t2", 3, "d5", false),
      ...tryRun("t3", 5, "d4", false, "sort1"),
      ...upload("u1", 7, "a.bed", true),
      ...upload("u2", 9, "b.bed", false),
    ]);
    expect(shape(rows).map(([id, , attempts]) => [id, attempts])).toEqual([
      ["t1", []],
      ["t2", []],
      ["t3", []],
      ["u1", []],
      ["u2", []],
    ]);
  });

  it("folds a failed upload into the upload of the same file", () => {
    const rows = rowsFor([...upload("u1", 1, "a.bed", true), ...upload("u2", 3, "a.bed", false)]);
    expect(shape(rows)).toEqual([["u2", "done", ["u1"], []]]);
  });
});

describe("workflow runs, step by step", () => {
  const galaxyStep = (index: number, label: string | null, jobs: [string, string][]) => ({
    id: `s${index}`,
    order_index: index,
    workflow_step_label: label,
    state: "scheduled",
    jobs: jobs.map(([id, state]) => ({ id, state })),
  });
  const detail = (jobs3: string, jobs4: string[]) => ({
    data: {
      id: "inv1",
      state: "scheduled",
      steps: [
        galaxyStep(0, "Input File to duplicate", []),
        galaxyStep(1, "How Many Files", []),
        galaxyStep(2, "Duplicate file to collection", [["j3", jobs3]]),
        galaxyStep(
          3,
          "First Select (2)",
          jobs4.map((s, i): [string, string] => [`j4-${i}`, s]),
        ),
        galaxyStep(4, null, []),
      ],
    },
    success: true,
  });
  const invoked: NarrationEvent[] = [
    { kind: "group-start", groupId: "m1", at: 0 },
    { id: "w1", toolName: "invoke_workflow", phase: "start", groupId: "m1", at: 1 },
    {
      id: "w1",
      toolName: "invoke_workflow",
      phase: "end",
      groupId: "m1",
      at: 2,
      result: { data: { id: "inv1", state: "new" }, success: true },
    },
  ];
  const run = (state: NarrationState) => state.groups[0].entries[0].startedRuns?.[0];

  it("reads the steps of a detailed invocation, with each step's jobs", () => {
    const [found] = invocationsSeen(detail("ok", ["running", "queued"]));
    expect(found).toMatchObject({ kind: "invocation", id: "inv1", state: "scheduled" });
    expect(found.steps?.map((s) => [s.index, s.label, s.jobs?.map((j) => j.state)])).toEqual([
      [0, "Input File to duplicate", undefined],
      [1, "How Many Files", undefined],
      [2, "Duplicate file to collection", ["ok"]],
      [3, "First Select (2)", ["running", "queued"]],
      [4, undefined, undefined],
    ]);
    expect(invocationsSeen({ data: { id: "inv1", state: "new" }, success: true })).toEqual([]);
  });

  it("learns a run's steps when the agent reads the invocation, without changing its state", () => {
    const state = play([
      ...invoked,
      { id: "c1", toolName: "get_invocations", phase: "start", groupId: "m1", at: 3 },
      {
        id: "c1",
        toolName: "get_invocations",
        phase: "end",
        groupId: "m1",
        at: 4,
        result: detail("ok", ["running", "queued"]),
      },
    ]);
    expect(run(state)?.state).toBe("new");
    expect(run(state)?.steps?.[3].jobs?.map((j) => j.state)).toEqual(["running", "queued"]);
    expect(state.groups[0].entries[0].status).toBe("running");
  });

  it("keeps what a read saw of a workflow run it never saw start", () => {
    const state = play([
      { kind: "group-start", groupId: "m1", at: 0 },
      { id: "c1", toolName: "get_invocations", phase: "start", groupId: "m1", at: 1 },
      {
        id: "c1",
        toolName: "get_invocations",
        phase: "end",
        groupId: "m1",
        at: 2,
        result: detail("ok", ["ok", "error"]),
      },
    ]);
    const [read] = state.groups[0].entries;
    expect(read.status).toBe("done");
    expect(read.seenRuns?.map((r) => [r.kind, r.id, r.state, r.steps?.length])).toEqual([
      ["invocation", "inv1", "scheduled", 5],
    ]);
  });

  it("takes a run's counted progress from a job-state, while it is still going", () => {
    const progress = {
      totalSteps: 29,
      completedSteps: 4,
      totalJobs: 11,
      completedJobs: 4,
      failedJobs: 0,
      at: 8,
    };
    const state = play([
      ...invoked,
      { kind: "job-state", at: 9, id: "inv1", state: "scheduled", progress },
    ]);
    expect(run(state)).toMatchObject({ state: "scheduled", progress });
    expect(state.groups[0].entries[0].status).toBe("running");
  });

  it("keeps the jobs it knows when a later read lists the steps without them", () => {
    const withJobs = detail("ok", ["ok", "ok"]);
    const withoutJobs = {
      ...withJobs,
      data: { ...withJobs.data, steps: withJobs.data.steps.map((s) => ({ ...s, jobs: [] })) },
    };
    const read = (id: string, at: number, result: unknown): ToolEvent[] => [
      { id, toolName: "get_invocations", phase: "start", groupId: "m1", at },
      { id, toolName: "get_invocations", phase: "end", groupId: "m1", at: at + 1, result },
    ];
    const state = play([...invoked, ...read("c1", 3, withJobs), ...read("c2", 5, withoutJobs)]);
    expect(run(state)?.steps?.map((s) => s.jobs?.length)).toEqual([
      undefined,
      undefined,
      1,
      2,
      undefined,
    ]);
    // What the second read saw on its own: steps without their jobs.
    expect(state.groups[0].entries[2].seenRuns?.[0].steps?.every((s) => s.jobs === undefined)).toBe(
      true,
    );
  });

  it("takes steps from a job-state, and names the step a failed run failed at", () => {
    const steps = invocationsSeen(detail("ok", ["ok", "error"]))[0].steps;
    const state = play([
      ...invoked,
      { kind: "job-state", at: 9, id: "inv1", state: "failed", steps },
    ]);
    expect(run(state)?.steps).toEqual(steps);
    expect(state.groups[0].entries[0]).toMatchObject({
      status: "failed",
      detail: "The workflow run failed at step 4 (First Select (2))",
    });
  });
});

describe("long waits", () => {
  it("tags each status line with what it waits on", () => {
    const at = (events: NarrationEvent[]) =>
      currentStatus(play([{ kind: "group-start", groupId: "m1", at: 0 }, ...events]))?.waitingOn;
    expect(at([])).toBe("assistant");
    expect(at([{ kind: "model", groupId: "m1", at: 1, activity: "thinking" }])).toBe("assistant");
    expect(at([{ id: "a", toolName: "get_histories", phase: "start", groupId: "m1", at: 1 }])).toBe(
      "galaxy",
    );
    expect(at([{ id: "a", toolName: "fetch_content", phase: "start", groupId: "m1", at: 1 }])).toBe(
      "harness",
    );
  });

  it("counts a long wait from the last thing that happened, so a streaming reply never stalls", () => {
    const writing = (at: number): NarrationEvent => ({
      kind: "model",
      groupId: "m1",
      at,
      activity: "writing",
    });
    const streaming = play([
      { kind: "group-start", groupId: "m1", at: 0 },
      ...[1_000, 1_500, 20_000, 39_000].map(writing),
    ]);
    const line = currentStatus(streaming)!;
    expect(line).toMatchObject({ text: "Writing a reply…", since: 1_000, activeAt: 39_000 });
    expect(isStalled(line, 45_000)).toBe(false);
    expect(isStalled(line, 70_000)).toBe(true);
    // Repeats within a second change nothing, so a view needn't redraw on every token.
    expect(advance(streaming, writing(39_500))).toBe(streaming);
  });

  it("calls a Galaxy call that has sent nothing for a while stalled", () => {
    const state = play([
      { kind: "group-start", groupId: "m1", at: 0 },
      { id: "a", toolName: "get_history_contents", phase: "start", groupId: "m1", at: 1_000 },
    ]);
    const line = currentStatus(state)!;
    expect(isStalled(line, 20_000)).toBe(false);
    expect(isStalled(line, 40_000)).toBe(true);
    expect(stallText(line)).toBe("Galaxy is taking a while to answer…");
  });

  it("says who is slow, naming the assistant only when the harness gives a name", () => {
    expect(stallText({ waitingOn: "assistant" })).toBe("Still working on it…");
    expect(stallText({ waitingOn: "harness" }, { assistantName: "Orbit" })).toBe(
      "Orbit is still working on it…",
    );
    expect(stallText({ waitingOn: "galaxy" }, { assistantName: "Orbit" })).toBe(
      "Galaxy is taking a while to answer…",
    );
  });
});
