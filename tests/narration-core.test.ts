import { describe, expect, it } from "vitest";
import {
  classifyTool,
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
        kind: "change",
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

describe("advance: waiting on the user", () => {
  const asked: NarrationEvent = { kind: "awaiting-user", at: 4, text: "approve the run" };

  it("ends a group that left the user something to do as waiting, not done", () => {
    const state = play([
      { kind: "group-start", at: 0 },
      asked,
      { kind: "model", activity: "writing", at: 5 },
      { kind: "group-end", at: 9 },
    ]);
    expect(state.groups[0]).toMatchObject({
      status: "waiting",
      waitingFor: [{ text: "approve the run", since: 4 }],
    });
    expect(currentStatus(state)).toEqual({ text: "Waiting for you: approve the run", since: 4 });
  });

  it("keeps the live status line while the group is still working", () => {
    const state = play([
      { kind: "group-start", at: 0 },
      asked,
      { kind: "model", activity: "writing", at: 5 },
    ]);
    expect(currentStatus(state)?.text).toBe("Writing a reply…");
  });

  it("also marks a group that has already ended", () => {
    const state = play([{ kind: "group-start", at: 0 }, { kind: "group-end", at: 3 }, asked]);
    expect(state.groups[0].status).toBe("waiting");
  });

  it("puts the user's action ahead of Galaxy work still running", () => {
    const state = play([
      { kind: "group-start", at: 0 },
      runTool("t1", "start", 1),
      runTool("t1", "end", 2),
      asked,
      { kind: "group-end", at: 9 },
    ]);
    expect(currentStatus(state)?.text).toBe("Waiting for you: approve the run");
  });

  it("clears the wait once the user replies, even without a new group", () => {
    const waiting = play([{ kind: "group-start", at: 0 }, asked, { kind: "group-end", at: 9 }]);
    const replied = advance(waiting, { kind: "user-replied", at: 20 });
    expect(replied.groups[0].status).toBe("done");
    expect(replied.groups[0].waitingFor).toBeUndefined();
    expect(currentStatus(replied)).toBeNull();
  });

  it("closes a waiting group left open by the next message as waiting", () => {
    const state = play([{ kind: "group-start", at: 0 }, asked, { kind: "group-start", at: 10 }]);
    expect(state.groups.map((g) => g.status)).toEqual(["waiting", "active"]);
  });

  it("keeps several requests at once and shows the oldest, with a count", () => {
    const state = play([
      { kind: "group-start", at: 0 },
      { kind: "awaiting-user", at: 4, text: "approve run A", id: "a" },
      { kind: "awaiting-user", at: 6, text: "approve run B", id: "b" },
      { kind: "group-end", at: 9 },
    ]);
    expect(state.groups[0].waitingFor?.map((r) => r.id)).toEqual(["a", "b"]);
    expect(currentStatus(state)).toEqual({
      text: "Waiting for you: approve run A (+1 more)",
      since: 4,
    });
  });

  it("answers only the request a reply names, and stays waiting for the rest", () => {
    const state = play([
      { kind: "group-start", at: 0 },
      { kind: "awaiting-user", at: 4, text: "approve run A", id: "a" },
      { kind: "awaiting-user", at: 6, text: "approve run B", id: "b" },
      { kind: "group-end", at: 9 },
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
      { kind: "group-start", at: 0 },
      { kind: "awaiting-user", at: 4, text: "approve run A", id: "a" },
      { kind: "awaiting-user", at: 6, text: "approve run B" },
      { kind: "group-end", at: 9 },
      { kind: "user-replied", at: 12 },
    ]);
    expect(state.groups[0].status).toBe("done");
    expect(currentStatus(state)).toBeNull();
  });

  it("ignores a reply to a request that isn't pending", () => {
    const state = play([
      { kind: "group-start", at: 0 },
      { kind: "awaiting-user", at: 4, text: "approve run A", id: "a" },
      { kind: "group-end", at: 9 },
    ]);
    expect(advance(state, { kind: "user-replied", at: 12, id: "zzz" })).toBe(state);
  });

  it("updates a request asked again under the same id, keeping its age", () => {
    const state = play([
      { kind: "group-start", at: 0 },
      { kind: "awaiting-user", at: 4, text: "approve run A", id: "a" },
      { kind: "awaiting-user", at: 7, text: "approve run A (edited)", id: "a" },
      { kind: "group-end", at: 9 },
    ]);
    expect(state.groups[0].waitingFor).toEqual([
      { text: "approve run A (edited)", since: 4, id: "a" },
    ]);
  });

  it("collects requests from several messages, oldest first", () => {
    const state = play([
      { kind: "group-start", at: 0 },
      { kind: "awaiting-user", at: 2, text: "approve run A", id: "a" },
      { kind: "group-end", at: 3 },
      { kind: "group-start", at: 10 },
      { kind: "awaiting-user", at: 12, text: "approve run B", id: "b" },
      { kind: "group-end", at: 13 },
    ]);
    expect(currentStatus(state)?.text).toBe("Waiting for you: approve run A (+1 more)");
  });

  it("changes nothing when the user replies with nothing to answer", () => {
    const state = play([
      { kind: "group-start", at: 0 },
      { kind: "group-end", at: 3 },
    ]);
    expect(advance(state, { kind: "user-replied", at: 5 })).toBe(state);
  });
});

describe("classifyTool", () => {
  // Every tool galaxy-mcp >= 1.9 offers, by the kind the user should see it as.
  const MCP_TOOLS: Record<string, string[]> = {
    change: [
      "run_tool",
      "run_user_tool",
      "invoke_workflow",
      "upload_file",
      "upload_file_from_url",
      "create_history",
      "update_history",
      "import_workflow_from_iwc",
      "cancel_workflow_invocation",
      "create_user_tool",
      "delete_user_tool",
      "create_page",
      "update_page",
      "revert_page_revision",
    ],
    wait: ["get_job_details", "get_invocations"],
    look: [
      "check_compatibility",
      "connect",
      "download_dataset",
      "get_assemblies",
      "get_assembly_details",
      "get_collection_details",
      "get_compatible_workflows",
      "get_dataset_details",
      "get_histories",
      "get_history_contents",
      "get_history_details",
      "get_iwc_workflow_details",
      "get_iwc_workflows",
      "get_organism",
      "get_page",
      "get_page_revision",
      "get_server_info",
      "get_tool_citations",
      "get_tool_details",
      "get_tool_input_template",
      "get_tool_panel",
      "get_tool_run_examples",
      "get_user",
      "get_workflow_details",
      "get_workflow_input_template",
      "get_workflows_in_category",
      "list_history_ids",
      "list_page_revisions",
      "list_pages",
      "list_user_tools",
      "list_workflow_categories",
      "list_workflows",
      "recommend_iwc_workflows",
      "resolve_workflow_inputs",
      "search_ena",
      "search_ena_keywords",
      "search_iwc_workflows",
      "search_organisms",
      "search_tools_by_keywords",
      "search_tools_by_name",
    ],
  };

  for (const [kind, tools] of Object.entries(MCP_TOOLS)) {
    it(`classifies every known ${kind} tool, whatever the harness prefix`, () => {
      for (const tool of tools) {
        for (const name of [`galaxy_${tool}`, `mcp__galaxy__${tool}`]) {
          expect([name, classifyTool(name)]).toEqual([name, kind]);
        }
      }
    });
  }

  it("treats the harness's own Galaxy tools by what they do", () => {
    expect(classifyTool("galaxy_upload_local_file")).toBe("change");
    expect(classifyTool("galaxy_invocation_check_one")).toBe("wait");
    expect(classifyTool("galaxy_job_record")).toBe("internal");
  });

  it("judges an unknown Galaxy tool by its name, defaulting to a look", () => {
    expect(classifyTool("galaxy_create_workflow")).toBe("change");
    expect(classifyTool("galaxy_delete_dataset")).toBe("change");
    expect(classifyTool("galaxy_get_new_thing")).toBe("look");
    expect(classifyTool("galaxy_something_else")).toBe("look");
  });

  it("treats non-Galaxy tools as the harness's own bookkeeping", () => {
    for (const name of ["edit", "read", "write", "bash"]) {
      expect(classifyTool(name)).toBe("internal");
    }
  });

  it("still knows bare Galaxy names from the map", () => {
    expect(classifyTool("run_tool")).toBe("change");
    expect(classifyTool("get_job_details")).toBe("wait");
  });
});
