// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";

import { chatInlineHook } from "../app/src/renderer/whats-happening-chat.js";
import { createOrbitNarration } from "../app/src/renderer/whats-happening-orbit.js";
import type { WhatsHappeningInlineElement } from "../app/src/renderer/whats-happening/views/whats-happening-inline.js";

/** A chat with the What's Happening hook, and a way to draw user messages into it. */
function chat() {
  const narration = createOrbitNarration({
    readFile: async () => ({ ok: false }),
    describeModelError: (message) => message,
    syncEveryMs: 0,
  });
  const container = document.createElement("div");
  const dock = document.createElement("div");
  document.body.append(container, dock);
  const hook = chatInlineHook(narration, dock);
  const message = (text: string, replayed = false, id?: string): WhatsHappeningInlineElement => {
    const el = document.createElement("div");
    el.className = "user-turn";
    container.append(el);
    hook(el, { text, replayed, ...(id ? { id } : {}) });
    // Slash commands' lines go under their bubble; /approve's, like messages', to the dock.
    const underBubble = text.startsWith("/") && !text.startsWith("/approve");
    const line = underBubble ? el.nextElementSibling : dock.lastElementChild;
    return line as WhatsHappeningInlineElement;
  };
  // pi seeing a message: a run starting with it, its timestamp as its id.
  const piSees = (text: string, timestamp: number) => {
    narration.onAgentEvent({ type: "agent_start" });
    narration.onAgentEvent({
      type: "message_start",
      message: { role: "user", content: [{ type: "text", text }], timestamp },
    });
  };
  return { narration, container, dock, message, piSees };
}

describe("What's Happening under Orbit's chat messages", () => {
  it("puts a line under each bubble, and gives it its message once pi has seen it", () => {
    const { message, piSees, narration } = chat();
    const line = message("Trim the reads");
    expect(line.tagName.toLowerCase()).toBe("whats-happening-inline");
    expect(line.hideIfNothingHappened).toBe(true);
    expect(line.userMessageId).toBeUndefined();

    piSees("Trim the reads", 111);
    expect(line.userMessageId).toBe("111");
    expect(line.state).toBe(narration.state);
  });

  it("matches in send order, skipping bubbles pi never saw", () => {
    const { message, piSees } = chat();
    const help = message("/help");
    const first = message("continue");
    const second = message("continue");
    piSees("continue", 1);
    piSees("continue", 2);
    expect([help.userMessageId, first.userMessageId, second.userMessageId]).toEqual([
      undefined,
      "1",
      "2",
    ]);
  });

  it("matches a replayed bubble by its id, and never by its text", () => {
    const { message, piSees, narration } = chat();
    const known = message("Trim the reads", true, "3");
    expect(known.userMessageId).toBe("3");
    expect(known.state).toBe(narration.state);

    const old = message("How many histories?", true);
    const fresh = message("How many histories?");
    piSees("How many histories?", 5);
    expect(old.userMessageId).toBeUndefined();
    expect(fresh.userMessageId).toBe("5");
  });

  it("docks the latest message's line, and moves it into the chat when the next message is sent", () => {
    const { message, container, dock } = chat();
    const first = message("Run my workflow");
    expect(first.parentElement).toBe(dock);

    // A slash command leaves the docked line where it is, its own line under its bubble.
    const help = message("/help");
    expect(first.parentElement).toBe(dock);
    expect(help.parentElement).toBe(container);

    // The next message takes the dock; the line before it joins the chat, before its bubble.
    const second = message("How many histories?");
    expect(second.parentElement).toBe(dock);
    const secondRow = container.lastElementChild;
    expect(secondRow?.previousElementSibling).toBe(first);
  });

  it("shows a run approved from an earlier session on its /approve line, stacked in the dock", () => {
    const { message, dock, narration } = chat();
    const asking = message("How many histories?");
    const approve = message("/approve prop-old");
    expect([...dock.children]).toEqual([asking, approve]);

    narration.onAgentEvent({ type: "agent_start" });
    narration.onAgentEvent({
      type: "message_start",
      message: {
        role: "user",
        content: [
          { type: "text", text: "[Orbit approval] The user approved prop-old. Submit it." },
        ],
        timestamp: 7,
      },
    });
    expect(approve.userMessageId).toBe("7");
  });

  it("leaves the /approve line empty when the run shows with the message that asked for it", () => {
    const { message, narration, piSees } = chat();
    message("Propose the run");
    piSees("Propose the run", 1);
    narration.onAgentEvent({
      type: "tool_execution_end",
      toolCallId: "p",
      toolName: "loom_propose",
      result: { content: [{ type: "text", text: "Proposed prop-new\n| Label | Run |" }] },
    });
    narration.onAgentEvent({ type: "agent_end" });
    const approve = message("/approve prop-new");
    narration.onNotify("Approved prop-new (attempt 1, spec_revision 2)");
    narration.onAgentEvent({ type: "agent_start" });
    narration.onAgentEvent({
      type: "message_start",
      message: {
        role: "user",
        content: [
          { type: "text", text: "[Orbit approval] The user approved prop-new. Submit it." },
        ],
        timestamp: 2,
      },
    });
    expect(approve.userMessageId).toBeUndefined();
  });

  it("forgets lines a cleared chat took away, docked ones too", () => {
    const { message, piSees, container, dock } = chat();
    message("Trim the reads");
    container.replaceChildren();
    const after = message("Trim the reads");
    expect(dock.children).toHaveLength(1);
    expect(container.querySelector("whats-happening-inline")).toBeNull();
    piSees("Trim the reads", 9);
    expect(after.userMessageId).toBe("9");
  });
});
