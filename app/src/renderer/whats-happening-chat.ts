/**
 * What's Happening under Orbit's chat messages: a `<whats-happening-inline>`
 * line under each user bubble, showing what Orbit did for that message.
 *
 * A bubble is drawn before pi has seen its message, and pi's message id (its
 * timestamp) arrives later through the narration. So each line starts without
 * an id and is matched to its message when the message shows up: by its text,
 * in the order the messages were sent.
 */

import {
  defineWhatsHappeningInline,
  type WhatsHappeningInlineElement,
} from "./whats-happening/views/whats-happening-inline.js";
import type { NarrationState } from "./whats-happening/core/types.js";
import type { OrbitNarration } from "./whats-happening-orbit.js";

/** One user bubble's line, and the text it is matched by. */
interface Line {
  el: WhatsHappeningInlineElement;
  text: string;
}

/**
 * Returns the hook for `ChatPanel.setUserMessageHook`. Replayed bubbles get a line
 * too, but stay unmatched: the narration doesn't survive a reload yet, so
 * matching them would hand a new message's work to an old bubble with the same
 * words.
 */
export function chatInlineHook(
  narration: OrbitNarration,
): (row: HTMLElement, text: string, replayed: boolean) => void {
  const tag = defineWhatsHappeningInline();
  // Lines still waiting for their message, oldest first.
  let waiting: Line[] = [];
  let matched: WhatsHappeningInlineElement[] = [];
  const taken = new Set<string>();

  function update(state: NarrationState): void {
    // A cleared chat (/new, /clear) takes its lines with it.
    waiting = waiting.filter((line) => line.el.isConnected);
    matched = matched.filter((el) => el.isConnected);
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
    for (const el of matched) el.state = state;
  }

  narration.subscribe(update);

  return (row, text, replayed) => {
    const el = document.createElement(tag) as WhatsHappeningInlineElement;
    el.hideUntilAction = true;
    el.assistantName = "Orbit";
    el.className = "wh-inline";
    row.after(el);
    if (replayed) return;
    waiting.push({ el, text });
    update(narration.state);
  };
}
