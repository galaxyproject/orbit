import { describe, expect, it } from "vitest";

import {
  fromPiEvent,
  messageText,
  PI_ADAPTER_START,
  resultOf,
  type PiAdapterOptions,
  type PiAdapterState,
} from "../app/src/renderer/whats-happening/adapters/pi.js";
import { advance, EMPTY_STATE } from "../app/src/renderer/whats-happening/core/narrator.js";
import type {
  NarrationEvent,
  NarrationState,
} from "../app/src/renderer/whats-happening/core/types.js";

/** Runs pi events through the adapter, one second apart; returns what it emitted and where it ended. */
function run(
  piEvents: Record<string, unknown>[],
  options?: PiAdapterOptions,
): { events: NarrationEvent[]; state: PiAdapterState } {
  let state = PI_ADAPTER_START;
  const events: NarrationEvent[] = [];
  piEvents.forEach((event, i) => {
    const step = fromPiEvent(state, event, (i + 1) * 1000, options);
    state = step.state;
    events.push(...step.events);
  });
  return { events, state };
}

const userMessage = (text: string, timestamp = 111) => ({
  type: "message_start",
  message: { role: "user", content: [{ type: "text", text }], timestamp },
});

describe("pi adapter", () => {
  it("opens a group per agent run and ends it on agent_end", () => {
    const { events } = run([
      { type: "agent_start" },
      { type: "agent_end" },
      { type: "agent_start" },
    ]);
    expect(events).toEqual([
      { kind: "group-start", groupId: "run-1", at: 1000 },
      { kind: "group-end", groupId: "run-1", at: 2000 },
      { kind: "group-start", groupId: "run-2", at: 3000 },
    ]);
  });

  it("keeps a run that pi retries after a model error in one group, and says the error when it ends", () => {
    const errorReply = {
      type: "message_end",
      message: { role: "assistant", stopReason: "error", errorMessage: "context window exceeded" },
    };
    const { events } = run(
      [
        { type: "agent_start" },
        errorReply,
        { type: "agent_end", willRetry: true },
        { type: "agent_start" },
        errorReply,
        { type: "agent_end", willRetry: false },
      ],
      { describeModelError: (m) => `Too long: ${m}` },
    );
    expect(events).toEqual([
      { kind: "group-start", groupId: "run-1", at: 1000 },
      { kind: "group-end", groupId: "run-1", at: 6000, error: "Too long: context window exceeded" },
    ]);
  });

  it("passes tool calls on with their group, reading the envelope from structured content or text", () => {
    const { events } = run([
      { type: "agent_start" },
      {
        type: "tool_execution_start",
        toolCallId: "c1",
        toolName: "run_tool",
        args: { tool_id: "cat1" },
      },
      {
        type: "tool_execution_end",
        toolCallId: "c1",
        toolName: "run_tool",
        isError: false,
        result: {
          structuredContent: { success: true, data: {} },
          content: [{ type: "text", text: "x" }],
        },
      },
    ]);
    expect(events.slice(1)).toEqual([
      {
        id: "c1",
        toolName: "run_tool",
        phase: "start",
        groupId: "run-1",
        at: 2000,
        args: { tool_id: "cat1" },
        result: undefined,
        isError: false,
      },
      {
        id: "c1",
        toolName: "run_tool",
        phase: "end",
        groupId: "run-1",
        at: 3000,
        args: undefined,
        result: { success: true, data: {} },
        isError: false,
      },
    ]);
    expect(resultOf({ content: [{ type: "text", text: '{"success":false}' }] })).toBe(
      '{"success":false}',
    );
  });

  it("turns the model's streaming into what it is doing, and ignores what it can't place", () => {
    const update = (sub: string) => ({
      type: "message_update",
      assistantMessageEvent: { type: sub },
    });
    const { events } = run([
      { type: "agent_start" },
      update("thinking_delta"),
      update("text_start"),
      update("toolcall_delta"),
      update("done"),
    ]);
    expect(events.slice(1).map((e) => ("activity" in e ? e.activity : e))).toEqual([
      "thinking",
      "writing",
      "tool-call",
    ]);
  });

  it("gives each user message its timestamp as an id, and lets the harness mark its own messages", () => {
    const { events } = run(
      [
        { type: "agent_start" },
        userMessage("Trim the reads", 111),
        { type: "agent_end" },
        { type: "agent_start" },
        userMessage("[Orbit automatic Galaxy follow-up] …", 222),
      ],
      {
        harnessMessage: (text) =>
          text.startsWith("[Orbit ") ? { about: [{ kind: "job", id: "j1" }] } : undefined,
      },
    );
    expect(events.filter((e) => "kind" in e && e.kind === "group-message")).toEqual([
      {
        kind: "group-message",
        groupId: "run-1",
        at: 2000,
        text: "Trim the reads",
        followUp: false,
        messageId: "111",
      },
      {
        kind: "group-message",
        groupId: "run-2",
        at: 5000,
        text: "[Orbit automatic Galaxy follow-up] …",
        followUp: true,
        messageId: "222",
        about: [{ kind: "job", id: "j1" }],
      },
    ]);
  });

  it("gives a message the run takes in mid-way its own group, and leaves Galaxy jobs where they started", () => {
    const { events } = run([
      { type: "agent_start" },
      userMessage("Run cat on my reads", 111),
      { type: "tool_execution_start", toolCallId: "c1", toolName: "run_tool", args: {} },
      {
        type: "tool_execution_end",
        toolCallId: "c1",
        toolName: "run_tool",
        result: { structuredContent: { success: true, data: { jobs: [{ id: "j1" }] } } },
      },
      userMessage("How many histories do I have?", 222),
      // The same message reported again stays in its group.
      userMessage("How many histories do I have?", 222),
      { type: "tool_execution_start", toolCallId: "c2", toolName: "get_histories", args: {} },
      { type: "tool_execution_end", toolCallId: "c2", toolName: "get_histories", result: {} },
      { type: "agent_end" },
    ]);
    const ended = events.reduce<NarrationState>(advance, EMPTY_STATE);
    expect(ended.groups[0].entries[0].status).toBe("running");
    const state = advance(ended, { kind: "job-state", at: 99_000, id: "j1", state: "ok" });

    expect(state.groups.map((g) => [g.id, g.messages.map((m) => m.id), g.status])).toEqual([
      ["run-1", ["111"], "done"],
      ["run-2", ["222"], "done"],
    ]);
    expect(state.groups[0].entries.map((e) => [e.toolName, e.status])).toEqual([
      ["run_tool", "done"],
    ]);
    expect(state.groups[1].entries.map((e) => e.toolName)).toEqual(["get_histories"]);
  });

  it("stops the group on a runtime error, with what it said or a plain reason", () => {
    expect(
      run([{ type: "agent_start" }, { type: "error", message: "brain exited" }]).events[1],
    ).toEqual({
      kind: "group-end",
      groupId: "run-1",
      at: 2000,
      error: "brain exited",
    });
    expect(run([{ type: "agent_start" }, { type: "error", message: {} }]).events[1]).toMatchObject({
      error: "Stopped by an error that gave no reason",
    });
  });

  it("feeds the core end to end: a run that read Galaxy and answered", () => {
    const { events } = run([
      { type: "agent_start" },
      userMessage("How many histories?"),
      { type: "message_update", assistantMessageEvent: { type: "thinking_delta" } },
      { type: "tool_execution_start", toolCallId: "c1", toolName: "get_histories", args: {} },
      { type: "tool_execution_end", toolCallId: "c1", toolName: "get_histories", result: {} },
      { type: "message_update", assistantMessageEvent: { type: "text_delta" } },
      { type: "agent_end" },
    ]);
    const state = events.reduce<NarrationState>(advance, EMPTY_STATE);
    expect(state.groups).toHaveLength(1);
    expect(state.groups[0]).toMatchObject({ id: "run-1", status: "done" });
    expect(state.groups[0].messages[0].text).toBe("How many histories?");
    expect(state.groups[0].entries.map((e) => [e.toolName, e.status])).toEqual([
      ["get_histories", "done"],
    ]);
  });

  it("reads a message's text from its text parts", () => {
    expect(
      messageText({
        content: [{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }],
      }),
    ).toBe("ab");
    expect(messageText({ content: "plain" })).toBe("plain");
  });
});
