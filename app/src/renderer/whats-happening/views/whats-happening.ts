/**
 * `<whats-happening>`: the list view. The live status pinned on top, then one
 * card per message, newest first; for a side panel or a dashboard widget.
 *
 * Built on Lit, so any page can use it, whatever framework it runs (Orbit's
 * plain DOM and React, Galaxy's Vue). It imports nothing from a harness: the
 * host hands it the state and, optionally, Galaxy links and the assistant's
 * name. It is styled with `--wh-*` CSS custom properties.
 */

import { css, html } from "lit";

import { cardStyles, cards } from "./card.js";
import { NarrationView, partStyles, statusLines } from "./parts.js";

export type { GalaxyLinkBuilder } from "./parts.js";

export class WhatsHappeningElement extends NarrationView {
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
    const groups = ctx.state.groups;
    if (groups.length === 0) {
      const who = this.assistantName ?? "your assistant";
      return html`<div class="empty">
        When ${who} starts working, each step will show up here.
      </div>`;
    }
    // Newest first; follow-ups inside the card they belong to.
    return html`${statusLines(ctx)}${cards(groups, ctx)}`;
  }
}

/** Registers the element under a tag name, once; returns the tag it is defined under. */
export function defineWhatsHappening(tag = "whats-happening"): string {
  if (!customElements.get(tag)) customElements.define(tag, class extends WhatsHappeningElement {});
  return tag;
}
