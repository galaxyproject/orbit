/**
 * The pi adapter: turns events from pi's agent runtime (the RPC stream Orbit
 * runs on) into narration events for the core.
 *
 * Pure: an adapter state and one pi event in, the next state and the narration
 * events out. It knows pi's protocol only; what a particular harness means by
 * its own messages (Orbit's "[Orbit …]" follow-ups, say) or how it words a
 * model error comes in through options.
 */

import type { GalaxyRunRef, NarrationEvent, ToolEvent } from "../core/types.js";

/** What the adapter remembers between events. */
export interface PiAdapterState {
  /** How many groups have started: one per agent run, plus one per message a run takes in mid-way. */
  runs: number;
  /** The group events go to now. */
  groupId: string;
  /** The id of the message the current group works on ("" when it had none); undefined before one arrives. */
  messageId?: string;
  /** pi said it will retry after a model error, so the next run continues the same group. */
  retrying: boolean;
  /** A model error from the end of the assistant's reply, said when the group ends. */
  modelError?: string;
}

export const PI_ADAPTER_START: PiAdapterState = { runs: 0, groupId: "run-0", retrying: false };

export interface PiAdapterOptions {
  /**
   * Tells the harness's own messages from the user's: for a message the harness
   * sent itself (a follow-up on Galaxy work, say), what it is about and which
   * request it answers; undefined for a message from the user.
   */
  harnessMessage?: (text: string) => { about?: GalaxyRunRef[]; answerId?: string } | undefined;
  /** A model error in the harness's own words. */
  describeModelError?: (message: string) => string;
}

export interface PiAdapterStep {
  state: PiAdapterState;
  events: NarrationEvent[];
}

/** One pi event, at a time the harness stamps, into the narration events it means. */
export function fromPiEvent(
  state: PiAdapterState,
  event: Record<string, unknown>,
  at: number,
  options: PiAdapterOptions = {},
): PiAdapterStep {
  const type = typeof event.type === "string" ? event.type : "";
  const groupId = state.groupId;
  const message = event.message as { role?: string } | undefined;

  if (type.startsWith("tool_execution_")) {
    // A tool call starting, reporting progress, or ending with its result.
    const tool: ToolEvent = {
      id: String(event.toolCallId),
      toolName: String(event.toolName),
      phase: type.slice("tool_execution_".length) as ToolEvent["phase"],
      groupId,
      at,
      args: event.args,
      result: resultOf(event.result),
      isError: event.isError === true,
    };
    return { state, events: [tool] };
  }

  if (type === "message_update") {
    // The model streaming: thinking, writing its reply, or writing a tool call.
    const sub = (event.assistantMessageEvent as { type?: string } | undefined)?.type ?? "";
    const activity = sub.startsWith("thinking")
      ? "thinking"
      : sub.startsWith("text")
        ? "writing"
        : sub.startsWith("toolcall")
          ? "tool-call"
          : undefined;
    return { state, events: activity ? [{ kind: "model", groupId, at, activity }] : [] };
  }

  if (type === "agent_start") {
    // A retry after a model error carries on in the same group.
    if (state.retrying) return { state: { ...state, retrying: false }, events: [] };
    const { messageId: _previous, ...rest } = state;
    const runs = state.runs + 1;
    const next = { ...rest, runs, groupId: `run-${runs}` };
    return { state: next, events: [{ kind: "group-start", groupId: next.groupId, at }] };
  }

  if (type === "agent_end") {
    // pi will try again: the group isn't over.
    if (event.willRetry === true) return { state: { ...state, retrying: true }, events: [] };
    const { modelError, ...rest } = state;
    return {
      state: rest,
      events: [{ kind: "group-end", groupId, at, ...(modelError ? { error: modelError } : {}) }],
    };
  }

  if (type === "error") {
    // The runtime itself failed; the group stops, with whatever it said.
    const said = typeof event.message === "string" && event.message.trim() ? event.message : "";
    return {
      state,
      events: [
        {
          kind: "group-end",
          groupId,
          at,
          error: said || "Stopped by an error that gave no reason",
        },
      ],
    };
  }

  if (type === "message_start" && message?.role === "user") {
    // A message the group works on: the user's, or one the harness sent itself.
    const text = messageText(message);
    const harness = options.harnessMessage?.(text);
    // pi's message has no id of its own; its timestamp tells messages apart.
    const stamp = (message as { timestamp?: unknown }).timestamp;
    const messageId = stamp !== undefined ? String(stamp) : "";
    const events: NarrationEvent[] = [];
    let next: PiAdapterState = { ...state, messageId };
    // A message queued while the run worked (pi takes it in before the run ends)
    // is new work: it gets its own group. The same message seen again is not.
    if (state.messageId !== undefined && (messageId === "" || messageId !== state.messageId)) {
      const { modelError, ...rest } = state;
      const runs = state.runs + 1;
      next = { ...rest, runs, groupId: `run-${runs}`, messageId };
      events.push(
        { kind: "group-end", groupId, at, ...(modelError ? { error: modelError } : {}) },
        { kind: "group-start", groupId: next.groupId, at },
      );
    }
    events.push({
      kind: "group-message",
      groupId: next.groupId,
      at,
      text,
      followUp: harness !== undefined,
      ...(stamp !== undefined ? { messageId } : {}),
      ...(harness?.about?.length ? { about: harness.about } : {}),
      ...(harness?.answerId ? { answerId: harness.answerId } : {}),
    });
    return { state: next, events };
  }

  if (type === "message_end" && message?.role === "assistant") {
    // A model error ends the reply; it is said when the group ends.
    const ended = message as { stopReason?: string; errorMessage?: string };
    if (ended.stopReason === "error") {
      const raw = ended.errorMessage ?? "";
      const modelError = options.describeModelError?.(raw) || raw || "The model reported an error";
      return { state: { ...state, modelError }, events: [] };
    }
    // A reply after the error went through: the run got past it.
    if (state.modelError !== undefined) {
      const { modelError: _recovered, ...rest } = state;
      return { state: rest, events: [] };
    }
  }

  return { state, events: [] };
}

/**
 * A tool result as the core reads it: the galaxy-ops envelope a tool returned
 * as structured content, else its text, else the result as it came.
 */
export function resultOf(result: unknown): unknown {
  const r = result as
    { structuredContent?: unknown; content?: { type?: string; text?: string }[] } | undefined;
  return r?.structuredContent ?? r?.content?.find((c) => c.type === "text")?.text ?? result;
}

/** The text of a pi message (or tool result), its text parts joined. */
export function messageText(message: unknown): string {
  const content = (message as { content?: unknown } | undefined)?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((c) =>
      (c as { type?: string }).type === "text" ? String((c as { text?: unknown }).text ?? "") : "",
    )
    .join("");
}
