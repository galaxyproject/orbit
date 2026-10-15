/**
 * The narrator: folds a stream of `ToolEvent`s into the list of narration
 * entries the view draws.
 *
 * Pure: same entries and event in, same entries out. It never mutates its
 * input, and it returns the input unchanged when an event has nothing to do,
 * so a caller can skip a redraw with a plain `===` check.
 */

import { describeToolCall, startsGalaxyWork } from "./catalog.js";
import type {
  NarrationEntry,
  NarrationEvent,
  NarrationGroup,
  NarrationState,
  NowLine,
  ToolEvent,
} from "./types.js";

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

export const EMPTY_STATE: NarrationState = { groups: [], galaxyRunning: [] };

const MODEL_STATUS = {
  thinking: "Thinking…",
  writing: "Writing a reply…",
  "tool-call": "Preparing the next step…",
} as const;

/**
 * Folds any narration event into the whole state: groups of work per message,
 * each with its own live status line, plus Galaxy work still running after
 * its group ended. Same purity rules as `narrate`.
 */
export function advance(state: NarrationState, event: NarrationEvent): NarrationState {
  if ("phase" in event) return advanceTool(state, event);
  switch (event.kind) {
    case "group-start": {
      const groups = state.groups.map((g) =>
        g.status === "active" ? { ...g, status: "done" as const, now: null, endedAt: event.at } : g,
      );
      const group: NarrationGroup = {
        id: `g${state.groups.length + 1}`,
        followUp: false,
        status: "active",
        now: { text: "Reading your request…", since: event.at },
        entries: [],
        startedAt: event.at,
      };
      return { ...state, groups: [...groups, group] };
    }
    case "group-info":
      return updateActive(state, (g) => ({
        ...g,
        text: event.text,
        followUp: event.followUp,
        now:
          event.followUp && g.now?.text === "Reading your request…"
            ? { text: "Checking on your Galaxy work…", since: g.now.since }
            : g.now,
      }));
    case "model":
      return updateActive(state, (g) => withNow(g, MODEL_STATUS[event.activity], event.at));
    case "group-end":
      return updateActive(state, (g) => ({
        ...g,
        status: event.error ? "stopped" : "done",
        now: null,
        endedAt: event.at,
        ...(event.error ? { error: event.error } : {}),
      }));
    case "galaxy-finished": {
      if (state.galaxyRunning.length === 0) return state;
      const label = event.label?.toLowerCase();
      const index = label
        ? state.galaxyRunning.findIndex((w) => w.title.toLowerCase().includes(label))
        : -1;
      // An unmatched report still means something finished; the oldest work is the best guess.
      const drop = index === -1 ? 0 : index;
      return { ...state, galaxyRunning: state.galaxyRunning.filter((_, i) => i !== drop) };
    }
  }
}

function advanceTool(state: NarrationState, event: ToolEvent): NarrationState {
  // A tool call outside any group (shouldn't happen, but harnesses vary) opens one.
  const base = activeGroup(state) ? state : advance(state, { kind: "group-start", at: event.at });
  let next = updateActive(base, (g) => {
    const entries = narrate(g.entries, event);
    if (entries === g.entries) return g;
    const entry = entries.find((e) => e.id === event.id);
    const now =
      event.phase === "start"
        ? `${entry?.title ?? event.toolName}…`
        : event.phase === "end"
          ? "Deciding the next step…"
          : null;
    return now ? withNow({ ...g, entries }, now, event.at) : { ...g, entries };
  });
  if (event.phase === "end" && !event.isError && startsGalaxyWork(event.toolName)) {
    const entry = activeGroup(next)?.entries.find((e) => e.id === event.id);
    if (entry && !next.galaxyRunning.some((w) => w.id === event.id)) {
      next = {
        ...next,
        galaxyRunning: [
          ...next.galaxyRunning,
          { id: event.id, title: entry.title, since: event.at },
        ],
      };
    }
  }
  return next;
}

/**
 * The single line to show right now: the active group's status, or else the
 * Galaxy work still running after its group ended, or nothing when idle.
 */
export function currentStatus(state: NarrationState): NowLine | null {
  const active = activeGroup(state);
  if (active?.now) return active.now;
  const work = state.galaxyRunning[0];
  if (!work) return null;
  const more = state.galaxyRunning.length - 1;
  return {
    text: `Galaxy is still working: ${work.title}${more > 0 ? ` (+${more} more)` : ""}`,
    since: work.since,
  };
}

function activeGroup(state: NarrationState): NarrationGroup | undefined {
  const last = state.groups[state.groups.length - 1];
  return last?.status === "active" ? last : undefined;
}

function updateActive(
  state: NarrationState,
  change: (group: NarrationGroup) => NarrationGroup,
): NarrationState {
  const active = activeGroup(state);
  if (!active) return state;
  const updated = change(active);
  if (updated === active) return state;
  return { ...state, groups: [...state.groups.slice(0, -1), updated] };
}

/** Sets the status line, keeping `since` (and the same object) when the text hasn't changed. */
function withNow(group: NarrationGroup, text: string, at: number): NarrationGroup {
  if (group.now?.text === text) return group;
  return { ...group, now: { text, since: at } };
}
