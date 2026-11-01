/**
 * `<whats-happening>`: the list view. The live status pinned on top, then one
 * card per message, newest first; for a side panel or a dashboard widget. With
 * `user-message-id` it draws only that message's work.
 *
 * Built on Lit, so any page can use it, whatever framework it runs (Orbit's
 * plain DOM and React, Galaxy's Vue). It imports nothing from a harness: the
 * host hands it the state and, optionally, Galaxy links, the assistant's name
 * and a message. It is styled with `--wh-*` CSS custom properties.
 */

import { css, html, nothing } from "lit";

import { groupsForUserMessage } from "../core/narrator.js";
import { cardStyles, cards } from "./card.js";
import { NarrationView, partStyles, statusLines } from "./parts.js";

export type { GalaxyLinkBuilder } from "./parts.js";

export class WhatsHappeningElement extends NarrationView {
  static override properties = {
    ...NarrationView.properties,
    userMessageId: { type: String, attribute: "user-message-id" },
  };

  /** Draw only the work for this user message (e.g. under its chat bubble). */
  declare userMessageId?: string;

  static override styles = [
    partStyles,
    cardStyles,
    css`
      .empty {
        padding: 24px 0;
        text-align: center;
        color: var(--wh-muted, GrayText);
      }
    `,
  ];

  override render() {
    const ctx = this.context;
    const groups = this.userMessageId
      ? groupsForUserMessage(ctx.state, this.userMessageId)
      : ctx.state.groups;
    // Newest first; follow-ups inside the card they belong to.
    const drawn = cards(groups, ctx);
    if (this.userMessageId) {
      // Just that message's work, and nothing when there is none.
      return groups.length === 0 ? nothing : drawn;
    }
    if (groups.length === 0) {
      const who = this.assistantName ?? "your assistant";
      return html`<div class="empty">
        When ${who} starts working, each step will show up here.
      </div>`;
    }
    return html`${statusLines(ctx)}${drawn}`;
  }
}

/** Registers the element under a tag name, once; returns the tag it is defined under. */
export function defineWhatsHappening(tag = "whats-happening"): string {
  if (!customElements.get(tag)) customElements.define(tag, class extends WhatsHappeningElement {});
  return tag;
}
