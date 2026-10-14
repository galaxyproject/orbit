/**
 * The narrator: folds a stream of `ToolEvent`s into the list of narration
 * entries the view draws.
 *
 * Pure: same entries and event in, same entries out. It never mutates its
 * input, and it returns the input unchanged when an event has nothing to do,
 * so a caller can skip a redraw with a plain `===` check.
 */

import { describeToolCall } from "./catalog.js";
import type { NarrationEntry, ToolEvent } from "./types.js";

export function narrate(
  entries: readonly NarrationEntry[],
  event: ToolEvent,
): readonly NarrationEntry[] {
  switch (event.phase) {
    case "start": {
      // A repeated start for the same call adds nothing new.
      if (entries.some((e) => e.id === event.id)) return entries;
      return [
        ...entries,
        {
          id: event.id,
          toolName: event.toolName,
          status: "running",
          title: describeToolCall(event.toolName, event.args),
          links: [],
          startedAt: event.at,
        },
      ];
    }
    case "end": {
      // An end for a call we never saw start cannot be narrated, so it is ignored.
      const index = entries.findIndex((e) => e.id === event.id);
      if (index === -1) return entries;
      const next = entries.slice();
      next[index] = {
        ...entries[index],
        status: event.isError ? "failed" : "done",
        endedAt: event.at,
      };
      return next;
    }
    case "update":
      // Not observed from pi yet; nothing to show until a tool reports progress.
      return entries;
  }
}
