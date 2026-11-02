/**
 * `<whats-happening-inline>`: one user message's work on one line, for under
 * its chat bubble. The line says where the work stands; opening it shows the
 * message's card, the same card the list draws.
 *
 * It shows one card: the work the message started, with its follow-ups and
 * retries inside. In the rare case the message has more work besides, a quiet
 * note says so, so the chat isn't filled with cards.
 */

import { css, html, nothing, type TemplateResult } from "lit";

import { groupsForUserMessage } from "../core/narrator.js";
import type { NarrationGroup } from "../core/types.js";
import { card, cardStyles, hostOf, isFinished, summaryLine } from "./card.js";
import { elapsed, NarrationView, nowText, partStyles, shorten, type DrawContext } from "./parts.js";

export class WhatsHappeningInlineElement extends NarrationView {
  static override properties = {
    ...NarrationView.properties,
    userMessageId: { type: String, attribute: "user-message-id" },
  };

  /** The user message whose work to show. */
  declare userMessageId?: string;

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
      ${card(main, ctx, followUps)}
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
  const ended = Math.max(...all.map((g) => g.endedAt ?? ctx.now));
  const took = elapsed((all.every(isFinished) ? ended : ctx.now) - main.startedAt);
  // Whatever is at work right now: the message's own work, or a follow-up on it.
  const live = all.find((g) => g.status === "active" && g.now);
  if (live?.now) return `● ${nowText(live.now, ctx)} · ${took} so far`;
  const waiting = all.flatMap((g) => g.waitingFor ?? [])[0];
  if (waiting)
    return `⏸ To continue, ${waiting.text} · waiting ${elapsed(ctx.now - waiting.since)}`;
  if (all.some((g) => !isFinished(g))) return `⏳ Galaxy is still working · ${took} so far`;
  if (main.status === "stopped") {
    return `❌ Stopped after ${took}${main.error ? `: ${shorten(main.error, 120)}` : ""}`;
  }
  return `✅ Done in ${took} · ${summaryLine(main, followUps, ctx)}`;
}

/** Registers the element under a tag name, once; returns the tag it is defined under. */
export function defineWhatsHappeningInline(tag = "whats-happening-inline"): string {
  if (!customElements.get(tag)) {
    customElements.define(tag, class extends WhatsHappeningInlineElement {});
  }
  return tag;
}
