/**
 * `<whats-happening-inline>`: one user message's work on one line, for under
 * its chat bubble. The line says where the work stands; opening it shows the
 * inside of the message's card, as the list draws it, without the title and
 * state the bubble and the line already show.
 *
 * It shows one card: the work the message started, with its follow-ups and
 * retries inside. In the rare case the message has more work besides, a quiet
 * note says so, so the chat isn't filled with cards.
 */

import { css, html, nothing, type TemplateResult } from "lit";

import { groupsForUserMessage, runEnded } from "../core/narrator.js";
import { rowsOf } from "../core/rows.js";
import type { NarrationGroup } from "../core/types.js";
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
    hideUntilAction: { type: Boolean, attribute: "hide-until-action" },
  };

  /** The user message whose work to show. */
  declare userMessageId?: string;

  /**
   * Draw nothing until the message's work touches Galaxy or asks the user
   * something, for a host whose chat already shows the assistant thinking and
   * replying. Off by default.
   */
  declare hideUntilAction: boolean;

  constructor() {
    super();
    this.hideUntilAction = false;
  }

  static override styles = [
    partStyles,
    cardStyles,
    css`
      .more {
        margin-left: 8px;
        font-size: 0.92em;
      }
    `,
  ];

  override render() {
    if (!this.userMessageId) return nothing;
    const ctx = this.context;
    const groups = groupsForUserMessage(ctx.state, this.userMessageId);
    // The main card: the work this message itself started (follow-ups live inside it).
    const main =
      groups.find((g) => g.messages.some((m) => m.id === this.userMessageId)) ?? groups[0];
    if (!main) return nothing;
    const followUps = groups.filter((g) => hostOf(ctx.state, g) === main);
    const more = groups.filter((g) => g !== main && !followUps.includes(g)).length;
    if (this.hideUntilAction && !tookAction(groups)) return nothing;
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
