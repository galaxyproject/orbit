/**
 * What's Happening in Orbit's chat: a `<whats-happening-inline>` line per user
 * message, showing what Orbit did for it.
 *
 * A live bubble is drawn before pi has seen its message, and pi's message id
 * (its timestamp) arrives later through the narration. So its line starts
 * without an id and is matched to its message when the message shows up: by
 * its text, in the order the messages were sent. A replayed bubble comes with
 * its id.
 */

import {
  defineWhatsHappeningInline,
  type WhatsHappeningInlineElement,
} from "./whats-happening/views/whats-happening-inline.js";
import type { NarrationState } from "./whats-happening/core/types.js";
import type { UserMessageDrawn } from "./chat/chat-panel.js";
import type { GalaxyLinkBuilder } from "./whats-happening/views/parts.js";
import type { OrbitNarration } from "./whats-happening-orbit.js";

/** One user bubble's line, and the text it is matched by. */
interface Line {
  el: WhatsHappeningInlineElement;
  text: string;
}

/** An /approve line, and the proposal whose run it may show. */
interface Approval {
  el: WhatsHappeningInlineElement;
  proposalId: string;
}

/** Each line's bubble row, so a cleared chat takes its lines out of the dock too. */
const rows = new WeakMap<WhatsHappeningInlineElement, HTMLElement>();
const inChat = (el: WhatsHappeningInlineElement): boolean => rows.get(el)?.isConnected ?? false;

/**
 * Returns the hook for `ChatPanel.setUserMessageHook`. A replayed bubble without
 * an id stays unmatched, so a new message's work never lands under an old
 * bubble with the same words.
 */
export function chatInlineHook(
  narration: OrbitNarration,
  dock: HTMLElement,
  buildUrl?: GalaxyLinkBuilder,
): (row: HTMLElement, message: UserMessageDrawn) => void {
  const tag = defineWhatsHappeningInline();
  // Lines still waiting for their message, oldest first.
  let waiting: Line[] = [];
  let matched: WhatsHappeningInlineElement[] = [];
  let approvals: Approval[] = [];
  const taken = new Set<string>();

  /** A cleared chat (/new, /clear) takes its lines with it, docked ones too. */
  function prune(): void {
    for (const el of dock.querySelectorAll<WhatsHappeningInlineElement>(tag)) {
      if (!inChat(el)) el.remove();
    }
    waiting = waiting.filter((line) => inChat(line.el));
    matched = matched.filter((el) => inChat(el));
  }

  function update(state: NarrationState): void {
    prune();
    for (const group of state.groups) {
      for (const message of group.messages) {
        if (message.by !== "user" || !message.id || taken.has(message.id)) continue;
        const index = waiting.findIndex((line) => line.text.trim() === message.text.trim());
        if (index === -1) continue;
        // Lines before the match belong to messages pi never saw (local slash commands).
        const [line] = waiting.splice(0, index + 1).slice(-1);
        taken.add(message.id);
        line.el.userMessageId = message.id;
        matched.push(line.el);
      }
    }
    approvals = approvals.filter(({ el, proposalId }) => {
      if (!inChat(el)) return false;
      const run = state.groups.find((g) =>
        g.messages[0]?.text.includes(`The user approved ${proposalId}.`),
      );
      if (!run) return true;
      // Run for a message that asked for it shows in that message's line; else here.
      const id = run.messages[0].id;
      if (!run.followUpOfIds?.length && id) {
        el.userMessageId = id;
        matched.push(el);
      }
      return false;
    });
    for (const el of matched) el.state = state;
  }

  narration.subscribe(update);

  return (row, { text, replayed, id }) => {
    prune();
    const el = document.createElement(tag) as WhatsHappeningInlineElement;
    el.hideIfNothingHappened = true;
    el.assistantName = "Orbit";
    el.buildUrl = buildUrl;
    el.className = "wh-inline";
    rows.set(el, row);
    const approved = /^\/approve\s+(prop-[\w-]+)/.exec(text.trim())?.[1];
    if (approved) {
      // Stacks in the dock beside the line of the message being worked on.
      dock.append(el);
      approvals.push({ el, proposalId: approved });
    } else if (text.trim().startsWith("/")) {
      row.after(el);
    } else {
      // The docked line(s) join the chat, before this bubble; this one docks.
      row.before(...dock.querySelectorAll(tag));
      dock.append(el);
    }
    if (id) {
      taken.add(id);
      el.userMessageId = id;
      matched.push(el);
    } else if (!replayed && !approved) {
      waiting.push({ el, text });
    }
    update(narration.state);
  };
}
