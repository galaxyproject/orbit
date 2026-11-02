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
  const hook = chatInlineHook(narration);
  const container = document.createElement("div");
  document.body.append(container);
  const message = (text: string, replayed = false): WhatsHappeningInlineElement => {
    const el = document.createElement("div");
    el.className = "user-turn";
    container.append(el);
    hook(el, text, replayed);
    return el.nextElementSibling as WhatsHappeningInlineElement;
  };
  // pi seeing a message: a run starting with it, its timestamp as its id.
  const piSees = (text: string, timestamp: number) => {
    narration.onAgentEvent({ type: "agent_start" });
    narration.onAgentEvent({
      type: "message_start",
      message: { role: "user", content: [{ type: "text", text }], timestamp },
    });
  };
  return { narration, container, message, piSees };
}

describe("What's Happening under Orbit's chat messages", () => {
  it("puts a line under each bubble, and gives it its message once pi has seen it", () => {
    const { message, piSees, narration } = chat();
    const line = message("Trim the reads");
    expect(line.tagName.toLowerCase()).toBe("whats-happening-inline");
    expect(line.hideUntilAction).toBe(true);
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

  it("leaves replayed bubbles unmatched, so new work never lands under an old bubble", () => {
    const { message, piSees } = chat();
    const old = message("How many histories?", true);
    const fresh = message("How many histories?");
    piSees("How many histories?", 5);
    expect(old.userMessageId).toBeUndefined();
    expect(fresh.userMessageId).toBe("5");
  });

  it("forgets lines a cleared chat took away", () => {
    const { message, piSees, container } = chat();
    message("Trim the reads");
    container.replaceChildren();
    const after = message("Trim the reads");
    piSees("Trim the reads", 9);
    expect(after.userMessageId).toBe("9");
  });
});
