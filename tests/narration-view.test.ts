// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";

import { advance, EMPTY_STATE } from "../app/src/renderer/whats-happening/core/narrator.js";
import type {
  NarrationEvent,
  NarrationState,
} from "../app/src/renderer/whats-happening/core/types.js";
import {
  defineWhatsHappening,
  type WhatsHappeningElement,
} from "../app/src/renderer/whats-happening/views/whats-happening.js";

const tag = defineWhatsHappening();

function play(events: NarrationEvent[]): NarrationState {
  return events.reduce<NarrationState>(advance, EMPTY_STATE);
}

/** Mounts the element with these properties and waits for it to draw. */
async function mount(props: Partial<WhatsHappeningElement>): Promise<WhatsHappeningElement> {
  const el = document.createElement(tag) as WhatsHappeningElement;
  Object.assign(el, props);
  document.body.append(el);
  await el.updateComplete;
  return el;
}

/** The element's text, one entry per line of what it draws. */
function lines(el: WhatsHappeningElement): string[] {
  return (el.shadowRoot?.textContent ?? "")
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

const asked = (groupId: string, text: string, at: number, messageId?: string): NarrationEvent[] => [
  { kind: "group-start", groupId, at },
  {
    kind: "group-message",
    groupId,
    at,
    text,
    followUp: false,
    ...(messageId ? { messageId } : {}),
  },
];

afterEach(() => {
  document.body.innerHTML = "";
});

describe("<whats-happening>", () => {
  it("says what will show up before anything has happened, naming the assistant when given", async () => {
    expect(lines(await mount({}))).toEqual([
      "When your assistant starts working, each step will show up here.",
    ]);
    expect(lines(await mount({ assistantName: "Orbit" }))).toEqual([
      "When Orbit starts working, each step will show up here.",
    ]);
  });

  it("pins what is happening now above the cards, newest card first", async () => {
    const state = play([
      ...asked("m1", "Download the runs", 0),
      { kind: "group-end", groupId: "m1", at: 5_000 },
      ...asked("m2", "Trim them", 10_000),
      { kind: "model", groupId: "m2", at: 11_000, activity: "thinking" },
    ]);
    const el = await mount({ state, now: 20_000 });
    expect(lines(el)).toEqual([
      "● Thinking… (9s)",
      'You asked: "Trim them"',
      "⏳ 10s",
      'You asked: "Download the runs"',
      "✅ Done in 5s",
    ]);
  });

  it("says nothing is running once everything has settled, and redraws when the state changes", async () => {
    const el = await mount({ state: play(asked("m1", "Hi", 0)), now: 1_000 });
    expect(lines(el)[0]).toBe("● Reading your request… (1s)");
    el.state = advance(el.state, { kind: "group-end", groupId: "m1", at: 2_000 });
    await el.updateComplete;
    expect(lines(el)[0]).toBe("Nothing running");
  });

  it("says who is slow once nothing has happened for a while", async () => {
    const state = play([
      ...asked("m1", "List my histories", 0),
      { id: "a", toolName: "get_histories", phase: "start", groupId: "m1", at: 1_000 },
    ]);
    const el = await mount({ state, now: 45_000, assistantName: "Orbit" });
    expect(lines(el)[0]).toBe("● Galaxy is taking a while to answer… (44s)");
  });

  it("titles the harness's own follow-ups by the assistant's name, or neutrally", async () => {
    const state = play([
      { kind: "group-start", groupId: "f1", at: 0 },
      { kind: "group-message", groupId: "f1", at: 0, text: "[auto] check", followUp: true },
      { kind: "group-end", groupId: "f1", at: 1_000 },
    ]);
    expect(lines(await mount({ state, now: 2_000 }))).toContain("Followed up on its own");
    expect(lines(await mount({ state, now: 2_000, assistantName: "Orbit" }))).toContain(
      "Orbit followed up",
    );
  });

  it("draws only one message's work when given a user message, and nothing when it has none", async () => {
    const state = play([
      ...asked("m1", "First", 0, "u1"),
      { kind: "group-end", groupId: "m1", at: 1_000 },
      ...asked("m2", "Second", 2_000, "u2"),
    ]);
    const first = await mount({ state, now: 3_000, userMessageId: "u1" });
    expect(lines(first)).toEqual(['You asked: "First"', "✅ Done in 1s"]);
    const none = await mount({ state, now: 3_000, userMessageId: "u9" });
    expect(lines(none)).toEqual([]);
  });
});
