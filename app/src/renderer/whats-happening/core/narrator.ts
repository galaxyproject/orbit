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
  argRefs,
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
  invocationsSeen,
  producedRefs,
  producedSummary,
  startedWork,
} from "./results.js";
import type {
  ActivityLine,
  GalaxyRef,
  GalaxyRun,
  GalaxyRunRef,
  GroupMessage,
  InvocationStep,
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
          galaxyRefs: isPlainObject(event.args) ? targetRefs(event.args, names) : [],
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
      // Groups run side by side; starting one never ends another.
      if (activeGroup(state, event.groupId)) return state;
      const group: NarrationGroup = {
        id: event.groupId,
        messages: [],
        followUp: false,
        status: "active",
        now: { text: "Reading your request…", since: event.at },
        entries: [],
        startedAt: event.at,
      };
      return { ...state, groups: [...state.groups, group] };
    }
    case "group-message":
      return updateActive(state, event.groupId, (g) => {
        // The same message reported twice adds nothing.
        if (event.messageId && g.messages.some((m) => m.id === event.messageId)) return g;
        const message: GroupMessage = {
          ...(event.messageId ? { id: event.messageId } : {}),
          text: event.text,
          at: event.at,
          by: event.followUp ? "harness" : "user",
        };
        const followUpOf = event.about ? groupsThatStarted(state, event.about) : [];
        return {
          ...g,
          messages: [...g.messages, message],
          // A group the harness started stays its own, even once the user adds a message.
          followUp: g.messages.length === 0 ? event.followUp : g.followUp,
          ...(event.about?.length ? { about: event.about } : {}),
          ...(followUpOf.length > 0 ? { followUpOf } : {}),
          now:
            event.followUp && g.now?.text === "Reading your request…"
              ? { text: "Checking on your Galaxy work…", since: g.now.since }
              : g.now,
        };
      });
    case "model":
      return updateActive(state, event.groupId, (g) =>
        withNow(g, MODEL_STATUS[event.activity], event.at),
      );
    case "group-end":
      return updateActive(state, event.groupId, (g) =>
        event.error
          ? { ...g, status: "stopped", now: null, endedAt: event.at, error: event.error }
          : close(g, event.at),
      );
    case "awaiting-user": {
      // Usually arrives mid-group (the call that asked ended, the model is still
      // replying); if the group has already ended, it still belongs to it.
      const index = lastIndex(state.groups, (g) => g.id === event.groupId);
      const last = state.groups[index];
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
      return { ...state, groups: replaced(state.groups, index, updated) };
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
      return applyJobState(state, event.id, event.state, event.at, {
        steps: event.steps,
        progress: event.progress,
      });
  }
}

function advanceTool(state: NarrationState, event: ToolEvent): NarrationState {
  // A call's events go to its group, even once that group has ended (a late end).
  let base = state;
  let index = lastIndex(state.groups, (g) => g.id === event.groupId);
  if (index === -1 && event.phase === "start") {
    // A call outside any group (shouldn't happen, but harnesses vary) opens one.
    base = advance(state, { kind: "group-start", at: event.at, groupId: event.groupId });
    index = base.groups.length - 1;
  }
  let next = updateAt(base, index, (g) => {
    let entries = narrate(g.entries, event, state.names);
    if (entries === g.entries) return g;
    if (event.phase === "end") {
      entries = entries.map((e) => (e.id === event.id ? finishEntry(e, event) : e));
    }
    const entry = entries.find((e) => e.id === event.id);
    const stillRunning = lastOf(entries, (e) => e.status === "running" && !e.startedRuns);
    let now: NowLine | null = null;
    if (event.phase === "start") {
      // A call started: say what it is doing.
      now = { text: `${entry?.title ?? event.toolName}…`, since: event.at };
    } else if (event.phase === "end" && stillRunning) {
      // A call ended while another is still running: back to that one, with its own timer.
      now = { text: `${stillRunning.title}…`, since: stillRunning.startedAt };
    } else if (event.phase === "end") {
      // The last running call ended: the model picks what to do next.
      now = { text: "Deciding the next step…", since: event.at };
    }
    return now && g.status === "active"
      ? withNow({ ...g, entries }, now.text, now.since)
      : { ...g, entries };
  });
  // A call can return without an error yet carry a failed envelope: nothing was started then.
  const refused = event.phase === "end" && envelopeOf(event.result)?.success === false;
  if (event.phase === "end" && !event.isError && !refused && startsGalaxyWork(event.toolName)) {
    const entry = next.groups[index]?.entries.find((e) => e.id === event.id);
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
        next = updateAt(next, index, (g) => ({
          ...g,
          entries: g.entries.map((e) =>
            e.id === event.id ? settle({ ...e, startedRuns: runs }, event.at) : e,
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
    // A read of a workflow run's details tells its steps.
    for (const run of invocationsSeen(event.result)) {
      next = withRunSteps(next, run.id, run.steps ?? []);
    }
  }
  return next;
}

/** Puts a workflow invocation's steps on its run; the same state when nothing changed. */
function withRunSteps(
  state: NarrationState,
  id: string,
  steps: readonly InvocationStep[],
): NarrationState {
  const target = (r: GalaxyRun): boolean =>
    r.kind === "invocation" &&
    r.id === id &&
    JSON.stringify(r.steps) !== JSON.stringify(mergedSteps(r.steps, steps));
  if (!state.groups.some((g) => g.entries.some((e) => e.startedRuns?.some(target)))) return state;
  return {
    ...state,
    groups: state.groups.map((g) =>
      g.entries.some((e) => e.startedRuns?.some(target))
        ? {
            ...g,
            entries: g.entries.map((e) =>
              e.startedRuns?.some(target)
                ? {
                    ...e,
                    startedRuns: e.startedRuns.map((r) =>
                      target(r) ? { ...r, steps: mergedSteps(r.steps, steps) } : r,
                    ),
                  }
                : e,
            ),
          }
        : g,
    ),
  };
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
  const runs = entry.startedRuns ?? [];
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

/**
 * A run's newer steps, keeping the jobs an earlier report listed for a step
 * the newer one reports without them.
 */
function mergedSteps(
  known: readonly InvocationStep[] | undefined,
  newer: readonly InvocationStep[],
): InvocationStep[] {
  return newer.map((step) => {
    const jobs = step.jobs ?? known?.find((s) => s.index === step.index)?.jobs;
    return jobs ? { ...step, jobs } : step;
  });
}

/** The first step of a workflow run with a failed job, as "step 4 (First Select)". */
function failedStep(run: GalaxyRun): string | undefined {
  const step = [...(run.steps ?? [])]
    .sort((a, b) => a.index - b.index)
    .find((s) => s.jobs?.some((j) => isJobTerminal(j.state) && !isJobSuccess(j.state)));
  if (!step) return undefined;
  return `step ${step.index + 1}${step.label ? ` (${step.label})` : ""}`;
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
    // A single workflow run that failed says at which step, when its steps are known.
    const step = all.length === 1 && verb === "failed" ? failedStep(failed[0]) : undefined;
    parts.push(`${who} ${verb}${step ? ` at ${step}` : ""}`);
  }
  return parts.join("; ");
}

function applyJobState(
  state: NarrationState,
  id: string,
  galaxyState: string,
  at: number,
  extra: Pick<GalaxyRun, "steps" | "progress"> = {},
): NarrationState {
  let touched = false;
  const groups = state.groups.map((g) => {
    if (!g.entries.some((e) => e.startedRuns?.some((r) => r.id === id))) return g;
    touched = true;
    return {
      ...g,
      entries: g.entries.map((e) => {
        if (!e.startedRuns?.some((r) => r.id === id)) return e;
        const startedRuns = e.startedRuns.map((r) => {
          if (r.id !== id) return r;
          // Letting go keeps the last state Galaxy reported, so the view can say "last seen running".
          const withSteps =
            r.kind === "invocation"
              ? {
                  ...r,
                  ...(extra.steps ? { steps: mergedSteps(r.steps, extra.steps) } : {}),
                  ...(extra.progress ? { progress: extra.progress } : {}),
                }
              : r;
          return galaxyState === "untracked"
            ? { ...withSteps, untracked: true }
            : { ...withSteps, state: galaxyState };
        });
        return settle({ ...e, startedRuns }, at);
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
 * Everything happening right now: each group at work (newest first), each
 * request waiting on the user (oldest first), and each piece of Galaxy work
 * still running. Several can be true at once, e.g. a paused follow-up waiting
 * on the user while Galaxy keeps running jobs. Empty when idle.
 */
export function currentActivity(state: NarrationState): ActivityLine[] {
  const working: ActivityLine[] = state.groups
    .flatMap((g) =>
      g.status === "active" && g.now
        ? [{ kind: "working" as const, groupId: g.id, text: g.now.text, since: g.now.since }]
        : [],
    )
    .reverse();
  const waiting: ActivityLine[] = state.groups
    .flatMap((g) =>
      (g.waitingFor ?? []).map((r) => ({
        kind: "waiting" as const,
        groupId: g.id,
        text: r.text,
        since: r.since,
        ...(r.id ? { id: r.id } : {}),
      })),
    )
    .sort((a, b) => a.since - b.since);
  const galaxy: ActivityLine[] = state.galaxyRunning.map((w) => {
    const group = state.groups.find((g) => g.entries.some((e) => e.id === w.id));
    return {
      kind: "galaxy",
      text: w.title,
      since: w.since,
      ...(group ? { groupId: group.id } : {}),
      ...(w.galaxyId ? { galaxyId: w.galaxyId } : {}),
    };
  });
  return [...working, ...waiting, ...galaxy];
}

/**
 * The single line to show when there is room for only one: the newest group's
 * status, or else what the user needs to do, or else the Galaxy work still
 * running, or nothing when idle. The first of `currentActivity()`, with the
 * rest of its kind counted.
 */
export function currentStatus(state: NarrationState): NowLine | null {
  const lines = currentActivity(state);
  const working = lines.find((l) => l.kind === "working");
  if (working) {
    return { text: working.text, since: working.since };
  }
  for (const [kind, lead] of [
    ["waiting", "Waiting for you"],
    ["galaxy", "Galaxy is still working"],
  ] as const) {
    const same = lines.filter((l) => l.kind === kind);
    if (same.length === 0) continue;
    const more = same.length - 1;
    return {
      text: `${lead}: ${same[0].text}${more > 0 ? ` (+${more} more)` : ""}`,
      since: same[0].since,
    };
  }
  return null;
}

/** The group with this id, while it is still at work. */
function activeGroup(state: NarrationState, id: string): NarrationGroup | undefined {
  return state.groups[activeIndex(state, id)];
}

function activeIndex(state: NarrationState, id: string): number {
  return lastIndex(state.groups, (g) => g.status === "active" && g.id === id);
}

function lastOf<T>(items: readonly T[], match: (item: T) => boolean): T | undefined {
  return items[lastIndex(items, match)];
}

function lastIndex<T>(items: readonly T[], match: (item: T) => boolean): number {
  for (let i = items.length - 1; i >= 0; i--) if (match(items[i])) return i;
  return -1;
}

function replaced<T>(items: readonly T[], index: number, item: T): T[] {
  const copy = items.slice();
  copy[index] = item;
  return copy;
}

/** The groups whose calls started any of these Galaxy jobs or invocations, in order. */
function groupsThatStarted(state: NarrationState, runs: readonly GalaxyRunRef[]): string[] {
  const started = (r: GalaxyRun): boolean =>
    runs.some((ref) => ref.kind === r.kind && ref.id === r.id);
  return state.groups
    .filter((g) => g.entries.some((e) => e.startedRuns?.some(started)))
    .map((g) => g.id);
}

/**
 * The message a group serves: its first message from the user, or for a
 * follow-up the harness started, the message of the work it follows up on.
 * Undefined when nothing ties the group to a message.
 */
export function anchorUserMessage(
  state: NarrationState,
  group: NarrationGroup,
  seen: ReadonlySet<string> = new Set(),
): GroupMessage | undefined {
  const ownUserMessage = group.messages.find((m) => m.by === "user");
  if (ownUserMessage) return ownUserMessage;
  const visited = new Set([...seen, group.id]);
  for (const id of group.followUpOf ?? []) {
    const origin = state.groups.find((g) => g.id === id);
    if (!origin || visited.has(id)) continue;
    const originUserMessage = anchorUserMessage(state, origin, visited);
    if (originUserMessage) return originUserMessage;
  }
  return undefined;
}

/**
 * Everything done for one message the user sent (e.g. a chat bubble), by the
 * harness's id for it: the group it started or was added to, and the
 * follow-ups on that work, in order. What a display shows under or links from
 * that message.
 */
export function groupsForUserMessage(
  state: NarrationState,
  userMessageId: string,
): NarrationGroup[] {
  return state.groups.filter(
    (g) =>
      g.messages.some((m) => m.id === userMessageId) ||
      anchorUserMessage(state, g)?.id === userMessageId,
  );
}

function updateActive(
  state: NarrationState,
  id: string,
  change: (group: NarrationGroup) => NarrationGroup,
): NarrationState {
  return updateAt(state, activeIndex(state, id), change);
}

function updateAt(
  state: NarrationState,
  index: number,
  change: (group: NarrationGroup) => NarrationGroup,
): NarrationState {
  const group = state.groups[index];
  if (!group) return state;
  const updated = change(group);
  if (updated === group) return state;
  return { ...state, groups: replaced(state.groups, index, updated) };
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

/**
 * What a call works on, from its arguments: the datasets and collections in
 * its tool inputs, and any Galaxy object an argument names by id, each once.
 */
function targetRefs(args: Record<string, unknown>, names: NameMemory): GalaxyRef[] {
  const refs = [...inputRefs(args.inputs, names), ...argRefs(args, names)];
  return refs.filter(
    (ref, i) => refs.findIndex((r) => r.kind === ref.kind && r.id === ref.id) === i,
  );
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
 * successful one the refs to what it produced and a short line about them.
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
  // A read of a workflow run keeps what it saw, even for a run started elsewhere.
  const seenRuns = invocationsSeen(event.result);
  const read = seenRuns.length > 0 ? { ...entry, seenRuns } : entry;
  const produced = producedRefs(event.toolName, event.result);
  if (produced.length === 0) return read;
  const detail = producedSummary(produced);
  return {
    ...read,
    galaxyRefs: [...read.galaxyRefs, ...produced],
    ...(detail ? { detail } : {}),
  };
}
