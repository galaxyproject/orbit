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
import {
  defineWhatsHappeningInline,
  type WhatsHappeningInlineElement,
} from "../app/src/renderer/whats-happening/views/whats-happening-inline.js";

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
      "● Thinking… (9s)",
      'You asked: "Download the runs"',
      // Nothing done in Galaxy: just the header, no "Answered without…" line.
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
});

describe("<whats-happening> cards", () => {
  const ran = (
    id: string,
    at: number,
    outputs: { id: string; hid: number; name: string }[],
    jobs: { id: string; state: string }[] = [],
  ): NarrationEvent[] => [
    { id, toolName: "run_tool", phase: "start", groupId: "m1", at, args: { tool_id: "fastp" } },
    {
      id,
      toolName: "run_tool",
      phase: "end",
      groupId: "m1",
      at: at + 1_000,
      result: { data: { outputs, jobs }, success: true },
    },
  ];
  const look = (id: string, at: number): NarrationEvent[] => [
    { id, toolName: "get_history_contents", phase: "start", groupId: "m1", at },
    { id, toolName: "get_history_contents", phase: "end", groupId: "m1", at: at + 500 },
  ];
  const buildUrl = (ref: { kind: string; id: string }) =>
    `https://galaxy.test/${ref.kind}/${ref.id}`;

  it("shows a change with what it made as links into Galaxy, and its reads folded", async () => {
    const state = play([
      ...asked("m1", "Trim the reads", 0),
      ...look("l1", 1_000),
      ...ran("r1", 2_000, [
        { id: "d8", hid: 8, name: "trimmed_R1" },
        { id: "d9", hid: 9, name: "trimmed_R2" },
      ]),
      { kind: "model", groupId: "m1", at: 4_000, activity: "writing" },
    ]);
    const el = await mount({ state, now: 5_000, buildUrl });
    expect(lines(el)).toContain("✅ Ran fastp");
    const links = [...el.shadowRoot!.querySelectorAll("a")].map((a) => [
      a.textContent,
      a.getAttribute("href"),
    ]);
    expect(links).toEqual([
      ["#8 trimmed_R1", "https://galaxy.test/dataset/d8"],
      ["#9 trimmed_R2", "https://galaxy.test/dataset/d9"],
    ]);
    const checks = el.shadowRoot!.querySelector("details.fold");
    expect(checks?.querySelector("summary")?.textContent?.trim()).toBe("1 check");
    expect(checks?.hasAttribute("open")).toBe(false);
  });

  it("shows outputs as plain labels when the host gives no links", async () => {
    const state = play([
      ...asked("m1", "Trim", 0),
      ...ran("r1", 1_000, [{ id: "d8", hid: 8, name: "out" }]),
    ]);
    const el = await mount({ state, now: 3_000 });
    expect(el.shadowRoot!.querySelectorAll("a")).toHaveLength(0);
    expect(lines(el)).toContain("→ #8 out");
  });

  it("folds a finished card to one summary line, and keeps it open once the user opens it", async () => {
    const state = play([
      ...asked("m1", "Trim", 0),
      ...ran("r1", 1_000, [{ id: "d8", hid: 8, name: "out" }]),
      { kind: "group-end", groupId: "m1", at: 3_000 },
    ]);
    const el = await mount({ state, now: 4_000 });
    const summary = el.shadowRoot!.querySelector("details.summary") as HTMLDetailsElement;
    expect(summary.querySelector("summary")?.textContent?.trim()).toBe("1 change to your Galaxy");
    expect(summary.open).toBe(false);
    summary.open = true;
    summary.dispatchEvent(new Event("toggle"));
    el.now = 5_000;
    await el.updateComplete;
    expect((el.shadowRoot!.querySelector("details.summary") as HTMLDetailsElement).open).toBe(true);
  });

  it("says why a change failed in one line, with the whole error on demand, and its earlier tries", async () => {
    const message =
      'Run tool failed: 400: {"err_msg": "Parameter \'lineNum\' must be set", "err_code": 400008}\ntraceback …';
    const tryRun = (id: string, at: number, ok: boolean): NarrationEvent[] => [
      { id, toolName: "run_tool", phase: "start", groupId: "m1", at, args: { tool_id: "cat1" } },
      ok
        ? {
            id,
            toolName: "run_tool",
            phase: "end",
            groupId: "m1",
            at: at + 1,
            result: { data: { outputs: [] }, success: true },
          }
        : {
            id,
            toolName: "run_tool",
            phase: "end",
            groupId: "m1",
            at: at + 1,
            result: { success: false, message },
          },
    ];
    const failed = play([...asked("m1", "Run it", 0), ...tryRun("t1", 1_000, false)]);
    const el = await mount({ state: failed, now: 3_000 });
    expect(lines(el)).toContain("❌ cat1 failed");
    expect(lines(el)).toContain("Parameter 'lineNum' must be set");
    expect(el.shadowRoot!.querySelector("pre.error")?.textContent).toBe(message);

    const retried = play([
      ...asked("m1", "Run it", 0),
      ...tryRun("t1", 1_000, false),
      ...tryRun("t2", 2_000, true),
    ]);
    const again = await mount({ state: retried, now: 3_000 });
    expect(lines(again)).toContain("✅ Ran cat1");
    expect(lines(again)).toContain("✗ An earlier try failed: Parameter 'lineNum' must be set");
  });

  it("shows a workflow run's progress and folds its steps", async () => {
    const state = play([
      ...asked("m1", "Run the workflow", 0),
      { id: "w1", toolName: "invoke_workflow", phase: "start", groupId: "m1", at: 1_000 },
      {
        id: "w1",
        toolName: "invoke_workflow",
        phase: "end",
        groupId: "m1",
        at: 1_500,
        result: { data: { id: "i1", state: "new" }, success: true },
      },
      {
        kind: "job-state",
        at: 2_000,
        id: "i1",
        state: "scheduled",
        steps: [
          { index: 0, label: "Reads", state: "scheduled" },
          {
            index: 1,
            label: "fastp",
            state: "scheduled",
            jobs: [
              { id: "j1", state: "ok" },
              { id: "j2", state: "running" },
            ],
          },
        ],
      },
    ]);
    const el = await mount({ state, now: 3_000 });
    expect(lines(el)).toContain("1 of 2 jobs done");
    const steps = [...el.shadowRoot!.querySelectorAll("details.fold > summary")].map((s) =>
      s.textContent?.trim(),
    );
    expect(steps).toContain("2 steps");
    const items = [...el.shadowRoot!.querySelectorAll(".item")].map((i) => i.textContent?.trim());
    expect(items).toEqual(["Step 1: Reads", "Step 2: fastp — 1 ok, 1 running"]);
  });

  it("puts the harness's follow-ups in a folded section of the card they follow up on", async () => {
    const state = play([
      ...asked("m1", "Trim", 0, "u1"),
      ...ran("r1", 1_000, [{ id: "d8", hid: 8, name: "out" }], [{ id: "j1", state: "queued" }]),
      { kind: "group-end", groupId: "m1", at: 3_000 },
      { kind: "job-state", at: 9_000, id: "j1", state: "ok" },
      { kind: "group-start", groupId: "f1", at: 10_000 },
      {
        kind: "group-message",
        groupId: "f1",
        at: 10_000,
        text: "[auto] j1 finished",
        followUp: true,
        about: [{ kind: "job", id: "j1" }],
      },
      { id: "c1", toolName: "get_dataset_details", phase: "start", groupId: "f1", at: 10_500 },
      { id: "c1", toolName: "get_dataset_details", phase: "end", groupId: "f1", at: 11_000 },
      { kind: "group-end", groupId: "f1", at: 12_000 },
    ]);
    const el = await mount({ state, now: 13_000, assistantName: "Orbit" });
    expect(el.shadowRoot!.querySelectorAll("section.card")).toHaveLength(1);
    expect(lines(el)).toContain("1 change to your Galaxy · Orbit followed up (1)");
  });
});

describe("<whats-happening-inline>", () => {
  const inlineTag = defineWhatsHappeningInline();
  async function inline(
    props: Partial<WhatsHappeningInlineElement>,
  ): Promise<WhatsHappeningInlineElement> {
    const el = document.createElement(inlineTag) as WhatsHappeningInlineElement;
    Object.assign(el, props);
    document.body.append(el);
    await el.updateComplete;
    return el;
  }
  const line = (el: WhatsHappeningInlineElement) =>
    el.shadowRoot!.querySelector("summary")?.textContent?.replace(/\s+/g, " ").trim();
  const ranOne: NarrationEvent[] = [
    {
      id: "r1",
      toolName: "run_tool",
      phase: "start",
      groupId: "m1",
      at: 1_000,
      args: { tool_id: "fastp" },
    },
    {
      id: "r1",
      toolName: "run_tool",
      phase: "end",
      groupId: "m1",
      at: 2_000,
      result: { data: { outputs: [{ id: "d8", hid: 8, name: "out" }], jobs: [] }, success: true },
    },
  ];

  it("draws nothing for a message with no work, or without a message", async () => {
    const state = play(asked("m1", "Hi", 0, "u1"));
    expect(
      (await inline({ state, now: 1_000, userMessageId: "u9" })).shadowRoot!.childElementCount,
    ).toBe(0);
    expect((await inline({ state, now: 1_000 })).shadowRoot!.childElementCount).toBe(0);
  });

  it("with hide-until-action, stays hidden until the work touches Galaxy or asks the user", async () => {
    const thinking = play([
      ...asked("m1", "Trim", 0, "u1"),
      { kind: "model", groupId: "m1", at: 500, activity: "thinking" },
    ]);
    const el = await inline({ state: thinking, now: 1_000, userMessageId: "u1" });
    expect(line(el)).toBe("● Thinking… · 1s so far");

    el.hideUntilAction = true;
    await el.updateComplete;
    expect(el.shadowRoot!.childElementCount).toBe(0);
    el.state = advance(thinking, { kind: "group-end", groupId: "m1", at: 2_000 });
    await el.updateComplete;
    expect(el.shadowRoot!.childElementCount).toBe(0);

    el.state = play([...asked("m1", "Trim", 0, "u1"), ranOne[0]]);
    await el.updateComplete;
    expect(line(el)).toMatch(/^● Running fastp/);

    el.state = play([
      ...asked("m1", "Trim", 0, "u1"),
      { kind: "awaiting-user", groupId: "m1", at: 500, id: "p1", text: "approve the run" },
      { kind: "group-end", groupId: "m1", at: 600 },
    ]);
    await el.updateComplete;
    expect(line(el)).toMatch(/^⏸ To continue, approve the run/);
  });

  it("says in one line where the message's work stands, folded over its card", async () => {
    const working = play([
      ...asked("m1", "Trim", 0, "u1"),
      { kind: "model", groupId: "m1", at: 500, activity: "thinking" },
    ]);
    const el = await inline({ state: working, now: 3_000, userMessageId: "u1" });
    expect(line(el)).toBe("● Thinking… · 3s so far");
    const details = el.shadowRoot!.querySelector("details.inline") as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(details.querySelector("section.card")).not.toBeNull();
    // The bubble and the line already say what was asked and where it stands.
    expect(details.querySelector("section.card header")).toBeNull();

    const waiting = play([
      ...asked("m1", "Trim", 0, "u1"),
      { kind: "awaiting-user", groupId: "m1", at: 1_000, text: "approve fastp", id: "p1" },
      { kind: "group-end", groupId: "m1", at: 2_000 },
    ]);
    expect(line(await inline({ state: waiting, now: 3_000, userMessageId: "u1" }))).toBe(
      "⏸ To continue, approve fastp · waiting 2s",
    );

    const done = play([
      ...asked("m1", "Trim", 0, "u1"),
      ...ranOne,
      { kind: "group-end", groupId: "m1", at: 3_000 },
    ]);
    expect(line(await inline({ state: done, now: 4_000, userMessageId: "u1" }))).toBe(
      "✅ Done in 3s · 1 change to your Galaxy",
    );

    const stopped = play([
      ...asked("m1", "Trim", 0, "u1"),
      { kind: "group-end", groupId: "m1", at: 1_000, error: "model gone" },
    ]);
    expect(line(await inline({ state: stopped, now: 2_000, userMessageId: "u1" }))).toBe(
      "❌ Stopped after 1s: model gone",
    );
  });

  it("follows a follow-up at work on the message's work, and counts it once done", async () => {
    const base: NarrationEvent[] = [
      ...asked("m1", "Trim", 0, "u1"),
      {
        id: "r1",
        toolName: "run_tool",
        phase: "start",
        groupId: "m1",
        at: 1_000,
        args: { tool_id: "fastp" },
      },
      {
        id: "r1",
        toolName: "run_tool",
        phase: "end",
        groupId: "m1",
        at: 2_000,
        result: { data: { outputs: [], jobs: [{ id: "j1", state: "ok" }] }, success: true },
      },
      { kind: "group-end", groupId: "m1", at: 3_000 },
      { kind: "group-start", groupId: "f1", at: 4_000 },
      {
        kind: "group-message",
        groupId: "f1",
        at: 4_000,
        text: "[auto] j1 done",
        followUp: true,
        about: [{ kind: "job", id: "j1" }],
      },
      { kind: "model", groupId: "f1", at: 4_500, activity: "writing" },
    ];
    const el = await inline({
      state: play(base),
      now: 6_000,
      userMessageId: "u1",
      assistantName: "Orbit",
    });
    expect(line(el)).toBe("● Writing a reply… · 6s so far");
    const after = await inline({
      state: play([...base, { kind: "group-end", groupId: "f1", at: 7_000 }]),
      now: 8_000,
      userMessageId: "u1",
      assistantName: "Orbit",
    });
    expect(line(after)).toBe("✅ Done in 7s · 1 change to your Galaxy · Orbit followed up (1)");
  });

  it("shows one card, and notes any other work for the message instead of stacking it", async () => {
    const state = play([
      ...asked("m1", "Trim", 0, "u1"),
      { kind: "group-end", groupId: "m1", at: 1_000 },
      { kind: "group-start", groupId: "m2", at: 2_000 },
      {
        kind: "group-message",
        groupId: "m2",
        at: 2_000,
        text: "Trim",
        followUp: false,
        messageId: "u1",
      },
      { kind: "group-end", groupId: "m2", at: 3_000 },
    ]);
    const el = await inline({ state, now: 4_000, userMessageId: "u1" });
    expect(el.shadowRoot!.querySelectorAll("section.card")).toHaveLength(1);
    // Nothing done in Galaxy: no summary, and no dot left dangling before it.
    expect(line(el)).toBe("✅ Done in 1s+1 more in Activity");
  });
});
