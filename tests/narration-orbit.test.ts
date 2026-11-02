import { describe, expect, it } from "vitest";

import {
  createOrbitNarration,
  followUpRuns,
  invocationProgress,
  planTitle,
  type OrbitNarrationHost,
} from "../app/src/renderer/whats-happening-orbit.js";
import {
  currentActivity,
  groupsForUserMessage,
} from "../app/src/renderer/whats-happening/core/narrator.js";

/** A narration over fake Orbit files, its clock one second further on each call. */
function narration(files: Record<string, string> = {}) {
  let clock = 0;
  const host: OrbitNarrationHost = {
    readFile: async (path) =>
      path in files ? { ok: true, bytes: new TextEncoder().encode(files[path]) } : { ok: false },
    describeModelError: (message) => message,
    now: () => (clock += 1000),
    syncEveryMs: 0,
  };
  return createOrbitNarration(host);
}

const asked = (text: string, timestamp: number) => ({
  type: "message_start",
  message: { role: "user", content: [{ type: "text", text }], timestamp },
});
const proposed = {
  type: "tool_execution_end",
  toolCallId: "p",
  toolName: "loom_propose",
  result: {
    content: [{ type: "text", text: "Proposed prop-ab12\n| Label | Upload 1.bed |\n" }],
  },
};
const waits = (n: ReturnType<typeof narration>) =>
  currentActivity(n.state)
    .filter((l) => l.kind === "waiting")
    .map((l) => l.text);

describe("What's Happening's Orbit wiring", () => {
  it("keeps a proposal waiting through other messages, until Orbit says it was approved", () => {
    const n = narration();
    n.onAgentEvent({ type: "agent_start" });
    n.onAgentEvent(asked("Propose the upload", 1));
    n.onAgentEvent(proposed);
    n.onAgentEvent({ type: "agent_end" });
    expect(waits(n)).toEqual(['approve "Upload 1.bed" (type /approve prop-ab12)']);

    // Asking something else, or a failed /approve, answers nothing.
    n.onUserText("How many histories do I have?");
    n.onUserText("/approve prop-ab12");
    expect(waits(n)).toHaveLength(1);

    n.onNotify("Approved prop-ab12 (attempt 01X, spec_revision bda8)");
    expect(waits(n)).toEqual([]);
  });

  it("keeps the run Orbit starts after /approve, and its follow-ups, with the message that asked", () => {
    const n = narration();
    n.onAgentEvent({ type: "agent_start" });
    n.onAgentEvent(asked("Run my workflow on simple data", 1));
    n.onAgentEvent(proposed);
    n.onAgentEvent({ type: "agent_end" });
    n.onUserText("/approve prop-ab12");
    n.onNotify("Approved prop-ab12 (attempt 01X, spec_revision bda8)");

    // Orbit's own run of the approved proposal starts a Galaxy job.
    n.onAgentEvent({ type: "agent_start" });
    n.onAgentEvent(
      asked("[Orbit approval] The user approved prop-ab12. Submit exactly that run now.", 2),
    );
    n.onAgentEvent({ type: "tool_execution_start", toolCallId: "r", toolName: "run_tool" });
    n.onAgentEvent({
      type: "tool_execution_end",
      toolCallId: "r",
      toolName: "run_tool",
      result: { structuredContent: { success: true, data: { jobs: [{ id: "j1" }] } } },
    });
    n.onAgentEvent({ type: "agent_end" });
    // Later, Orbit's poller follows up on that job.
    n.onAgentEvent({ type: "agent_start" });
    n.onAgentEvent(asked('[Orbit automatic Galaxy follow-up]\n[\n{"kind":"job","id":"j1"}\n]', 3));
    n.onAgentEvent({ type: "agent_end" });

    expect(n.state.groups.map((g) => g.id)).toEqual(["run-1", "run-2", "run-3"]);
    expect(groupsForUserMessage(n.state, "1").map((g) => g.id)).toEqual([
      "run-1",
      "run-2",
      "run-3",
    ]);
  });

  it("lets a chat message answer a plan draft or a paused follow-up, but not a slash command", () => {
    const n = narration();
    n.onAgentEvent({ type: "agent_start" });
    n.onAgentEvent({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "```plan\n# Trim the reads [draft]\n1. fastp\n```" }],
      },
    });
    n.onAgentEvent({ type: "agent_end" });
    n.onNotify("Galaxy results are waiting -- automatic follow-up paused after 3 turns.");
    expect(waits(n)).toEqual([
      'approve the plan "Trim the reads" (Approve, Edit or Reject in the chat)',
      'say "continue" so Orbit checks the Galaxy results that came in',
    ]);

    n.onUserText("/pending");
    expect(waits(n)).toHaveLength(2);
    n.onUserText("continue");
    expect(waits(n)).toEqual([]);
  });

  it("files Orbit's own follow-ups as follow-ups on the runs they name", () => {
    const n = narration();
    n.onAgentEvent({ type: "agent_start" });
    n.onAgentEvent(
      asked('[Orbit automatic Galaxy follow-up]\n[\n{"kind":"job","id":"j1","state":"ok"}\n]', 2),
    );
    expect(n.state.groups[0]).toMatchObject({ followUp: true, about: [{ kind: "job", id: "j1" }] });
    expect(followUpRuns("no list here")).toEqual([]);
  });

  it("reads Galaxy job states from activity.jsonl, each row once", async () => {
    const row = JSON.stringify({
      timestamp: "2026-11-01T00:00:10Z",
      kind: "poll.transition",
      payload: { id: "j1", to: "completed", galaxyState: "ok" },
    });
    const n = narration({ "activity.jsonl": `${row}\n${row}\n` });
    n.onAgentEvent({ type: "agent_start" });
    n.onAgentEvent({ type: "tool_execution_start", toolCallId: "r", toolName: "run_tool" });
    n.onAgentEvent({
      type: "tool_execution_end",
      toolCallId: "r",
      toolName: "run_tool",
      result: { structuredContent: { success: true, data: { jobs: [{ id: "j1" }] } } },
    });
    expect(n.state.galaxyRunning).toHaveLength(1);

    const seen: unknown[] = [];
    const stop = n.subscribe((state) => seen.push(state));
    await n.syncJobs();
    stop();
    expect(n.state.galaxyRunning).toEqual([]);
    expect(n.state.groups[0].entries[0].status).toBe("done");
    expect(seen).toHaveLength(1);
  });

  it("rebuilds from a resumed session: a card per message, jobs from the whole activity log", async () => {
    const finished = JSON.stringify({
      timestamp: "2026-11-01T00:00:10Z",
      kind: "poll.transition",
      payload: { id: "j1", to: "completed", galaxyState: "ok" },
    });
    const n = narration({ "activity.jsonl": finished });
    const restored = n.restore([
      { role: "user", text: "Run cat on my reads", timestamp: 100 },
      {
        role: "assistant",
        text: "",
        timestamp: 200,
        tools: [
          {
            id: "c1",
            name: "run_tool",
            arguments: { tool_id: "cat1" },
            resultText: '{"success":true,"data":{"jobs":[{"id":"j1"}]}}',
            startedAt: 300,
            endedAt: 400,
          },
          {
            id: "c2",
            name: "loom_propose",
            resultText: "Proposed prop-ab12\n| Label | Next step |",
            endedAt: 500,
          },
        ],
      },
      { role: "user", text: "How many histories?", timestamp: 900 },
    ]);
    expect(n.state.groups.map((g) => [g.messages[0].id, g.startedAt, g.endedAt])).toEqual([
      ["100", 100, 500],
      ["900", 900, 900],
    ]);
    // A proposal from before can't be known to still be waiting.
    expect(waits(n)).toEqual([]);

    expect(n.state.galaxyRunning).toHaveLength(1);
    await restored;
    expect(n.state.groups[0].entries[0].status).toBe("done");

    // Live work carries on in new groups; a second restore changes nothing.
    n.onAgentEvent({ type: "agent_start" });
    expect(n.state.groups.map((g) => g.id)).toEqual(["run-1", "run-2", "run-3"]);
    await n.restore([{ role: "user", text: "again", timestamp: 1 }]);
    expect(n.state.groups).toHaveLength(3);
  });

  it("reads a workflow run's counts from its notebook block", () => {
    const notebook = [
      "```orbit-invocation",
      "invocation_id: i1",
      "status: scheduled",
      "total_steps: 5",
      "completed_steps: 2",
      "total_jobs: 4",
      "completed_jobs: 1",
      "last_polled_at: 2026-11-01T00:00:10Z",
      "```",
    ].join("\n");
    expect(invocationProgress(notebook, 0)).toEqual([
      {
        kind: "job-state",
        at: Date.parse("2026-11-01T00:00:10Z"),
        id: "i1",
        state: "scheduled",
        progress: {
          totalSteps: 5,
          completedSteps: 2,
          totalJobs: 4,
          completedJobs: 1,
          failedJobs: 0,
          at: Date.parse("2026-11-01T00:00:10Z"),
        },
      },
    ]);
    expect(planTitle("no plan")).toBeUndefined();
  });
});
