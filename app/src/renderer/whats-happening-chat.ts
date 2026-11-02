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
import type { GalaxyLinkBuilder, MessageLabeler } from "./whats-happening/views/parts.js";
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

/** What the chat gives What's Happening: its lines, and a way back to each message. */
export interface ChatLines {
  /** For `ChatPanel.setUserMessageHook`: puts a line under each user message. */
  hook: (row: HTMLElement, message: UserMessageDrawn) => void;
  /** A user message's number in the chat, for the Activity list's cards. */
  messageLabel: MessageLabeler;
  /** Scrolls the chat to a user message and highlights it for a moment. */
  showMessage: (userMessageId: string) => void;
}

/**
 * The chat's What's Happening lines. A replayed bubble without an id stays
 * unmatched, so a new message's work never lands under an old bubble with the
 * same words.
 */
export function createChatLines(
  narration: OrbitNarration,
  dock: HTMLElement,
  buildUrl?: GalaxyLinkBuilder,
): ChatLines {
  const tag = defineWhatsHappeningInline();
  // Lines still waiting for their message, oldest first.
  let waiting: Line[] = [];
  let matched: WhatsHappeningInlineElement[] = [];
  let approvals: Approval[] = [];
  const taken = new Set<string>();
  // Each user message's bubble row, by message id, once its line is matched.
  const bubbles = new Map<string, HTMLElement>();

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
        const row = rows.get(line.el);
        if (row) bubbles.set(message.id, row);
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

  const hook = (row: HTMLElement, { text, replayed, id }: UserMessageDrawn): void => {
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
      bubbles.set(id, row);
    } else if (!replayed && !approved) {
      waiting.push({ el, text });
    }
    update(narration.state);
  };

  /** The bubble row still in the chat for a message, if any. */
  const bubbleOf = (id: string): HTMLElement | undefined => {
    const row = bubbles.get(id);
    return row?.isConnected ? row : undefined;
  };

  return {
    hook,
    messageLabel: (id) => bubbleOf(id)?.dataset.promptNum,
    showMessage: (id) => {
      const row = bubbleOf(id);
      if (!row) return;
      row.scrollIntoView?.({ block: "center", behavior: "smooth" });
      row.classList.add("wh-shown");
      setTimeout(() => row.classList.remove("wh-shown"), SHOWN_FOR_MS);
    },
  };
}

/** How long a message the user asked to see stays highlighted, in milliseconds. */
const SHOWN_FOR_MS = 1500;
