/**
 * `<whats-happening-inline>`: one user message's work on one line, for under
 * its chat bubble. The line says where the work stands; opening it shows the
 * inside of the message's card, as the list draws it, without the title and
 * state the bubble and the line already show.
 *
 * It shows one card: the work the message started, with its follow-ups and
 * retries inside. In the rare case the message has more work besides, a quiet
 * note says so, so the chat isn't filled with cards.
 *
 * With `show-elsewhere`, it also says when something else is still going on
 * (other messages' work, Galaxy jobs), as a button that fires `show-activity`
 * so the host can show the full list.
 */

import { css, html, nothing, type TemplateResult } from "lit";

import { currentActivity, groupsForUserMessage, runEnded } from "../core/narrator.js";
import { rowsOf } from "../core/rows.js";
import type { NarrationGroup, NarrationState } from "../core/types.js";
import { cardBody, cardStyles, hostOf, isFinished, summaryLine } from "./card.js";
import {
  doneAt,
  elapsed,
  NarrationView,
  nowText,
  partStyles,
  shorten,
  type DrawContext,
} from "./parts.js";

export class WhatsHappeningInlineElement extends NarrationView {
  static override properties = {
    ...NarrationView.properties,
    userMessageId: { type: String, attribute: "user-message-id" },
    hideIfNothingHappened: { type: Boolean, attribute: "hide-if-nothing-happened" },
    showElsewhere: { type: Boolean, attribute: "show-elsewhere" },
  };

  /** The user message whose work to show. */
  declare userMessageId?: string;

  /**
   * Once the message's work is over, draw nothing if it never touched Galaxy or
   * asked the user something, for a host whose chat already shows the
   * assistant's reply. While the work is going, the line shows. Off by default.
   */
  declare hideIfNothingHappened: boolean;

  /**
   * Also say when anything else is going on (other messages' work, Galaxy jobs
   * they started), with a button that fires `show-activity`; e.g. for the line
   * docked above a chat's input. Off by default.
   */
  declare showElsewhere: boolean;

  constructor() {
    super();
    this.hideIfNothingHappened = false;
    this.showElsewhere = false;
  }

  static override styles = [
    partStyles,
    cardStyles,
    css`
      .more {
        margin-left: 8px;
        font-size: 0.92em;
      }
      .with-elsewhere {
        display: flex;
        align-items: flex-start;
        gap: 8px;
      }
      .with-elsewhere > details {
        flex: 1;
        min-width: 0;
      }
      .elsewhere {
        flex: none;
        margin-left: auto;
        padding: 0 6px;
        border: 1px solid var(--wh-border, rgba(127, 127, 127, 0.4));
        border-radius: 5px;
        background: none;
        color: inherit;
        font: inherit;
        font-size: 0.92em;
        cursor: pointer;
      }
      .elsewhere:hover {
        border-color: currentColor;
      }
    `,
  ];

  override render() {
    const ctx = this.context;
    const groups = this.userMessageId ? groupsForUserMessage(ctx.state, this.userMessageId) : [];
    const line = this.#line(ctx, groups);
    const others = this.showElsewhere ? runningElsewhere(ctx.state, groups) : 0;
    if (others === 0) return line;
    const show = (event: Event) =>
      event.currentTarget?.dispatchEvent(
        new CustomEvent("show-activity", { bubbles: true, composed: true }),
      );
    return html`<div class="with-elsewhere">
      ${line}
      <button class="elsewhere" title="Show everything going on" @click=${show}>
        ⏳ ${others} more running ›
      </button>
    </div>`;
  }

  /** The message's own line, folded over its card; nothing when it has none to show. */
  #line(ctx: DrawContext, groups: readonly NarrationGroup[]): TemplateResult | typeof nothing {
    // The main card: the work this message itself started (follow-ups live inside it).
    const main =
      groups.find((g) => g.messages.some((m) => m.id === this.userMessageId)) ?? groups[0];
    if (!main) return nothing;
    const followUps = groups.filter((g) => hostOf(ctx.state, g) === main);
    const more = groups.filter((g) => g !== main && !followUps.includes(g)).length;
    if (this.hideIfNothingHappened && groups.every(isFinished) && !tookAction(groups))
      return nothing;
    const key = `inline:${main.id}`;
    const open = ctx.isOpen(key, false);
    const onToggle = (event: Event) => {
      const now = (event.target as HTMLDetailsElement).open;
      if (now !== open) ctx.setOpen(key, now);
    };
    return html`<details class="inline" ?open=${open} @toggle=${onToggle}>
      <summary>
        ${inlineLine(main, followUps, ctx)}${
          more > 0 ? html`<span class="more">+${more} more in Activity</span>` : nothing
        }
      </summary>
      <section class="card">${cardBody(main, ctx, followUps)}</section>
    </details>`;
  }
}

/** How many things are going on outside this message's own work: other groups at work, waits, Galaxy jobs. */
function runningElsewhere(state: NarrationState, own: readonly NarrationGroup[]): number {
  const ids = new Set(own.map((g) => g.id));
  return currentActivity(state).filter((line) => !line.groupId || !ids.has(line.groupId)).length;
}

/** Where a message's work stands, in one line, with how long it has taken. */
function inlineLine(
  main: NarrationGroup,
  followUps: readonly NarrationGroup[],
  ctx: DrawContext,
): TemplateResult | string {
  const all = [main, ...followUps];
  const took = elapsed((all.every(isFinished) ? doneAt(all, ctx.now) : ctx.now) - main.startedAt);
  // Whatever is at work right now: the message's own work, or a follow-up on it.
  const live = all.find((g) => g.status === "active" && g.now);
  if (live?.now) return `● ${nowText(live.now, ctx)} · ${took} so far`;
  const waiting = all.flatMap((g) => g.waitingFor ?? [])[0];
  if (waiting)
    return `⏸ To continue, ${waiting.text} · waiting ${elapsed(ctx.now - waiting.since)}`;
  if (all.some((g) => !isFinished(g))) {
    // What Galaxy is working on, the harness's label for it, and how far it has got when counted.
    const running = all
      .flatMap((g) => g.entries)
      .find((e) => e.status === "running" && e.startedRuns);
    if (!running) return `⏳ Galaxy is still working · ${took} so far`;
    const progress = running.startedRuns?.find(
      (r) => r.progress && r.progress.totalJobs > 0,
    )?.progress;
    // A workflow run's counts, or a tool run's own jobs when it has several.
    const toolJobs = running.startedRuns?.filter((r) => r.kind === "job") ?? [];
    const jobs = progress
      ? ` · ${progress.completedJobs} of ${progress.totalJobs} jobs`
      : toolJobs.length > 1
        ? ` · ${toolJobs.filter(runEnded).length} of ${toolJobs.length} jobs`
        : "";
    const label = running.startedRuns?.find((r) => r.label)?.label;
    return `⏳ ${running.title}${label ? ` · "${label}"` : ""}${jobs} · ${took} so far`;
  }
  if (main.status === "stopped") {
    return `❌ Stopped after ${took}${main.error ? `: ${shorten(main.error, 120)}` : ""}`;
  }
  const summary = summaryLine(main, followUps, ctx);
  return summary ? `✅ Done in ${took} · ${summary}` : `✅ Done in ${took}`;
}

/** Whether any of this work touched Galaxy or is waiting on the user. */
function tookAction(groups: readonly NarrationGroup[]): boolean {
  return groups.some((g) => {
    const { rows, checks } = rowsOf(g);
    return rows.length > 0 || checks.length > 0 || (g.waitingFor?.length ?? 0) > 0;
  });
}

/** Registers the element under a tag name, once; returns the tag it is defined under. */
export function defineWhatsHappeningInline(tag = "whats-happening-inline"): string {
  if (!customElements.get(tag)) {
    customElements.define(tag, class extends WhatsHappeningInlineElement {});
  }
  return tag;
}
