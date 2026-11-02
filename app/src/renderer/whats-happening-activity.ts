/**
 * What's Happening in Orbit's Activity tab: the `<whats-happening>` list, every
 * message's work with the live status on top, in the tab's top section.
 */

import {
  defineWhatsHappening,
  type WhatsHappeningElement,
} from "./whats-happening/views/whats-happening.js";
import type { GalaxyLinkBuilder } from "./whats-happening/views/parts.js";
import type { OrbitNarration } from "./whats-happening-orbit.js";

/** Mounts the list in `container` and keeps it drawing the narration; returns the element. */
export function mountWhatsHappeningList(
  container: HTMLElement,
  narration: OrbitNarration,
  buildUrl?: GalaxyLinkBuilder,
): WhatsHappeningElement {
  const list = document.createElement(defineWhatsHappening()) as WhatsHappeningElement;
  list.assistantName = "Orbit";
  list.buildUrl = buildUrl;
  list.state = narration.state;
  narration.subscribe((state) => (list.state = state));
  container.append(list);
  return list;
}
