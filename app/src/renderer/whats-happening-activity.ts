/**
 * What's Happening in Orbit's Activity tab: the `<whats-happening>` list, every
 * message's work with the live status on top, in the tab's top section.
 */

import {
  defineWhatsHappening,
  type WhatsHappeningElement,
} from "./whats-happening/views/whats-happening.js";
import type { GalaxyLinkBuilder } from "./whats-happening/views/parts.js";
import type { ChatLines } from "./whats-happening-chat.js";
import type { OrbitNarration } from "./whats-happening-orbit.js";

/** Mounts the list in `container` and keeps it drawing the narration; returns the element. */
export function mountWhatsHappeningList(
  container: HTMLElement,
  narration: OrbitNarration,
  buildUrl?: GalaxyLinkBuilder,
  chat?: Pick<ChatLines, "messageLabel" | "showMessage">,
): WhatsHappeningElement {
  const list = document.createElement(defineWhatsHappening()) as WhatsHappeningElement;
  list.assistantName = "Orbit";
  list.buildUrl = buildUrl;
  // Each card shows its message's number in the chat; clicking it goes there.
  list.messageLabel = chat?.messageLabel;
  list.addEventListener("show-message", (event) => {
    chat?.showMessage((event as CustomEvent<{ userMessageId: string }>).detail.userMessageId);
  });
  list.state = narration.state;
  narration.subscribe((state) => (list.state = state));
  container.append(list);
  return list;
}
