/**
 * The narrator: folds a stream of `ToolEvent`s into the list of narration
 * entries the view draws.
 *
 * Pure: same entries and event in, same entries out. It never mutates its
 * input, and it returns the input unchanged when an event has nothing to do,
 * so a caller can skip a redraw with a plain `===` check.
 */

import { isJobSuccess, isJobTerminal, isPlainObject } from "@galaxyproject/galaxy-ops/browser";

import {
  classifyTool,
  describeDoneCall,
  describeFailedCall,
  describeToolCall,
  inputRefs,
  operationFor,
  startsGalaxyWork,
} from "./catalog.js";
import { EMPTY_NAMES, learnNames } from "./names.js";
import {
  envelopeOf,
  failureMessage,
  failureReason,
  producedRefs,
  producedSummary,
  startedWork,
} from "./results.js";
import type {
  GalaxyRun,
  NameMemory,
  NarrationEntry,
  NarrationEvent,
  NarrationGroup,
  NarrationState,
  NowLine,
  ToolEvent,
  WaitingRequest,
} from "./types.js";

export function narrate(
  entries: readonly NarrationEntry[],
  event: ToolEvent,
  names: NameMemory = EMPTY_NAMES,
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
          kind: classifyTool(event.toolName),
          ...galaxyFacts(event.toolName),
          status: "running",
          title: describeToolCall(event.toolName, event.args, names),
          ...outcomeTitlesFor(event.toolName, event.args, names),
          links: isPlainObject(event.args) ? inputRefs(event.args.inputs, names) : [],
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

export const EMPTY_STATE: NarrationState = { groups: [], galaxyRunning: [], names: EMPTY_NAMES };

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
      const groups = state.groups.map((g) => (g.status === "active" ? close(g, event.at) : g));
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
      return updateActive(state, (g) =>
        event.error
          ? { ...g, status: "stopped", now: null, endedAt: event.at, error: event.error }
          : close(g, event.at),
      );
    case "awaiting-user": {
      // Usually arrives mid-group (the call that asked ended, the model is still
      // replying); if the group has already ended, it still belongs to it.
      const last = state.groups[state.groups.length - 1];
      if (!last) {
        return state;
      }
      const request: WaitingRequest = {
        text: event.text,
        since: event.at,
        ...(event.id ? { id: event.id } : {}),
      };
      const pending = last.waitingFor ?? [];
      const same = event.id ? pending.findIndex((r) => r.id === event.id) : -1;
      // Asking again under the same id updates that request and keeps its place and age.
      const waitingFor =
        same === -1
          ? [...pending, request]
          : pending.map((r, i) => (i === same ? { ...r, text: event.text } : r));
      const updated: NarrationGroup =
        last.status === "done"
          ? { ...last, status: "waiting", waitingFor }
          : { ...last, waitingFor };
      return { ...state, groups: [...state.groups.slice(0, -1), updated] };
    }
    case "user-replied": {
      const answers = (r: WaitingRequest): boolean => !event.id || r.id === event.id;
      if (!state.groups.some((g) => g.waitingFor?.some(answers))) {
        return state;
      }
      return {
        ...state,
        groups: state.groups.map((g) => {
          if (!g.waitingFor?.some(answers)) {
            return g;
          }

          const left = g.waitingFor.filter((r) => !answers(r));
          if (left.length > 0) {
            return { ...g, waitingFor: left };
          }
          const { waitingFor: _answered, ...rest } = g;
          return rest.status === "waiting" ? { ...rest, status: "done" as const } : rest;
        }),
      };
    }
    case "galaxy-finished": {
      // A loose "something finished" report, for work no result named by id;
      // work with a Galaxy id waits for its own job-state instead.
      const loose = state.galaxyRunning.filter((w) => !w.galaxyId);
      if (loose.length === 0) {
        return state;
      }
      const label = event.label?.toLowerCase();
      const match = label ? loose.find((w) => w.title.toLowerCase().includes(label)) : undefined;
      // An unmatched report still means something finished; the oldest work is the best guess.
      const drop = match ?? loose[0];
      return { ...state, galaxyRunning: state.galaxyRunning.filter((w) => w !== drop) };
    }
    case "job-state":
      return applyJobState(state, event.id, event.state, event.at);
  }
}

function advanceTool(state: NarrationState, event: ToolEvent): NarrationState {
  // A tool call outside any group (shouldn't happen, but harnesses vary) opens one.
  const base = activeGroup(state) ? state : advance(state, { kind: "group-start", at: event.at });
  let next = updateActive(base, (g) => {
    let entries = narrate(g.entries, event, state.names);
    if (entries === g.entries) return g;
    if (event.phase === "end") {
      entries = entries.map((e) => (e.id === event.id ? finishEntry(e, event) : e));
    }
    const entry = entries.find((e) => e.id === event.id);
    const now =
      event.phase === "start"
        ? `${entry?.title ?? event.toolName}…`
        : event.phase === "end"
          ? "Deciding the next step…"
          : null;
    return now ? withNow({ ...g, entries }, now, event.at) : { ...g, entries };
  });
  // A call can return without an error yet carry a failed envelope: nothing was started then.
  const refused = event.phase === "end" && envelopeOf(event.result)?.success === false;
  if (event.phase === "end" && !event.isError && !refused && startsGalaxyWork(event.toolName)) {
    const entry = activeGroup(next)?.entries.find((e) => e.id === event.id);
    if (entry && !next.galaxyRunning.some((w) => w.id === event.id)) {
      const runs = startedWork(event.toolName, event.result);
      if (runs.length === 0) {
        // The result named no job: track the call itself until a loose report.
        next = {
          ...next,
          galaxyRunning: [
            ...next.galaxyRunning,
            { id: event.id, title: entry.title, since: event.at },
          ],
        };
      } else {
        next = updateActive(next, (g) => ({
          ...g,
          entries: g.entries.map((e) =>
            e.id === event.id ? settle({ ...e, galaxy: runs }, event.at) : e,
          ),
        }));
        const pending = runs.filter((r) => !runFinished(r));
        next = {
          ...next,
          galaxyRunning: [
            ...next.galaxyRunning,
            ...pending.map((r) => ({
              id: event.id,
              galaxyId: r.id,
              title: entry.title,
              since: event.at,
            })),
          ],
        };
      }
    }
  }
  if (event.phase === "end" && !event.isError) {
    const names = learnNames(next.names, event.toolName, event.result);
    if (names !== next.names) next = { ...next, names };
  }
  return next;
}

/**
 * A Galaxy job or invocation that has reached an end, successful or not.
 * Whether Galaxy reported the run at an end, successful or not.
 */
export function runEnded(run: Pick<GalaxyRun, "kind" | "state">): boolean {
  return run.kind === "invocation"
    ? ["completed", "failed", "cancelled"].includes(run.state)
    : isJobTerminal(run.state);
}

/** Nothing more will be heard about the run: it ended, or the harness let go of it. */
function runFinished(run: GalaxyRun): boolean {
  return runEnded(run) || run.untracked === true;
}

function runFailed(run: GalaxyRun): boolean {
  if (!runEnded(run)) return false;
  return run.kind === "invocation"
    ? run.state === "failed" || run.state === "cancelled"
    : !isJobSuccess(run.state);
}

/**
 * An entry whose call started Galaxy work: running until nothing more will be
 * heard about any of its runs; then failed if any failed, untracked if any was
 * let go before it ended, else done. A call that itself failed stays failed.
 */
function settle(entry: NarrationEntry, at: number): NarrationEntry {
  const runs = entry.galaxy ?? [];
  if (runs.length === 0 || entry.status === "failed") return entry;
  if (!runs.every(runFinished)) {
    const { endedAt: _notYet, ...rest } = entry;
    return { ...rest, status: "running" };
  }
  if (runs.some(runFailed)) {
    return { ...entry, status: "failed", detail: runsFailedLine(runs), endedAt: at };
  }
  const status = runs.some((r) => !runEnded(r)) ? "untracked" : "done";
  return { ...entry, status, endedAt: at };
}

/** Galaxy's states for a job or invocation that was stopped rather than failing on its own. */
const CANCELLED_STATES = new Set(["deleted", "deleting", "deleted_new", "cancelled", "cancelling"]);

/**
 * Why a call's Galaxy work failed, from the runs' states: "The Galaxy job
 * failed", "2 of 3 Galaxy jobs failed", "The workflow run was cancelled".
 */
function runsFailedLine(runs: readonly GalaxyRun[]): string {
  const parts: string[] = [];
  for (const [kind, one, many] of [
    ["job", "Galaxy job", "Galaxy jobs"],
    ["invocation", "workflow run", "workflow runs"],
  ] as const) {
    const all = runs.filter((r) => r.kind === kind);
    const failed = all.filter(runFailed);
    if (failed.length === 0) continue;
    const plural = failed.length > 1;
    const verb = failed.every((r) => CANCELLED_STATES.has(r.state))
      ? plural
        ? "were cancelled"
        : "was cancelled"
      : "failed";
    const who =
      all.length === 1
        ? `The ${one}`
        : failed.length === all.length
          ? `All ${all.length} ${many}`
          : `${failed.length} of ${all.length} ${many}`;
    parts.push(`${who} ${verb}`);
  }
  return parts.join("; ");
}

function applyJobState(
  state: NarrationState,
  id: string,
  galaxyState: string,
  at: number,
): NarrationState {
  let touched = false;
  const groups = state.groups.map((g) => {
    if (!g.entries.some((e) => e.galaxy?.some((r) => r.id === id))) return g;
    touched = true;
    return {
      ...g,
      entries: g.entries.map((e) => {
        if (!e.galaxy?.some((r) => r.id === id)) return e;
        const galaxy = e.galaxy.map((r) => {
          if (r.id !== id) return r;
          // Letting go keeps the last state Galaxy reported, so the view can say "last seen running".
          return galaxyState === "untracked"
            ? { ...r, untracked: true }
            : { ...r, state: galaxyState };
        });
        return settle({ ...e, galaxy }, at);
      }),
    };
  });
  if (!touched) {
    return state;
  }
  const finished =
    galaxyState === "untracked" ||
    runEnded({ kind: "job", state: galaxyState }) ||
    runEnded({ kind: "invocation", state: galaxyState });
  return {
    ...state,
    groups,
    galaxyRunning: finished
      ? state.galaxyRunning.filter((w) => w.galaxyId !== id)
      : state.galaxyRunning,
  };
}

/**
 * The single line to show right now: the active group's status, or else what
 * the user needs to do, or else the Galaxy work still running after its group
 * ended, or nothing when idle.
 */
export function currentStatus(state: NarrationState): NowLine | null {
  const active = activeGroup(state);
  if (active?.now) {
    return active.now;
  }

  const waiting = state.groups
    .filter((g) => g.status === "waiting")
    .flatMap((g) => g.waitingFor ?? [])
    .sort((a, b) => a.since - b.since);

  if (waiting.length > 0) {
    const more = waiting.length - 1;
    return {
      text: `Waiting for you: ${waiting[0].text}${more > 0 ? ` (+${more} more)` : ""}`,
      since: waiting[0].since,
    };
  }

  const work = state.galaxyRunning[0];
  if (!work) {
    return null;
  }
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

/** Ends a group without an error: waiting if it left the user something to do, else done. */
function close(group: NarrationGroup, at: number): NarrationGroup {
  const waiting = (group.waitingFor?.length ?? 0) > 0;
  return { ...group, status: waiting ? "waiting" : "done", now: null, endedAt: at };
}

/** Sets the status line, keeping `since` (and the same object) when the text hasn't changed. */
function withNow(group: NarrationGroup, text: string, at: number): NarrationGroup {
  if (group.now?.text === text) return group;
  return { ...group, now: { text, since: at } };
}

/** What galaxy-ops says about the operation behind a tool, for the entry. */
function galaxyFacts(toolName: string): Pick<NarrationEntry, "domain" | "destructive"> {
  const op = operationFor(toolName);
  if (!op) return {};
  return { domain: op.domain, ...(op.destructive ? { destructive: true } : {}) };
}

function outcomeTitlesFor(
  toolName: string,
  args: unknown,
  names: NameMemory,
): Pick<NarrationEntry, "doneTitle" | "failedTitle"> {
  const doneTitle = describeDoneCall(toolName, args, names);
  const failedTitle = describeFailedCall(toolName, args, names);
  return { ...(doneTitle ? { doneTitle } : {}), ...(failedTitle ? { failedTitle } : {}) };
}

/**
 * What a call's result says, put on its entry: a failure the harness didn't
 * flag (a failed envelope) marks it failed; a failed entry gets the reason, a
 * successful one the links to what it produced and a short line about them.
 */
function finishEntry(entry: NarrationEntry, event: ToolEvent): NarrationEntry {
  const refused = envelopeOf(event.result)?.success === false;
  if (entry.status === "failed" || refused) {
    const reason = failureReason(event.result);
    const message = failureMessage(event.result);
    return {
      ...entry,
      status: "failed",
      endedAt: entry.endedAt ?? event.at,
      ...(reason ? { detail: reason } : {}),
      ...(message ? { failureMessage: message } : {}),
    };
  }
  const produced = producedRefs(event.toolName, event.result);
  if (produced.length === 0) return entry;
  const detail = producedSummary(produced);
  return { ...entry, links: [...entry.links, ...produced], ...(detail ? { detail } : {}) };
}
