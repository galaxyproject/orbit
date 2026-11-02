/**
 * Core types for the What's Happening narration.
 *
 * This folder is harness-agnostic: it imports nothing from Orbit, pi or
 * the DOM, so it can be lifted out and driven by any harness that talks to
 * Galaxy through the Galaxy MCP. Each harness writes a thin adapter that turns
 * its own tool-call events into `ToolEvent`s; everything downstream of that
 * shape is shared.
 */

/** One step of a tool call, as reported by the harness. */
export interface ToolEvent {
  /** Stable id for the call, shared by its start, update and end events. */
  id: string;
  /** Tool name as the harness reports it, e.g. `mcp__galaxy__run_tool` or `run_tool`. */
  toolName: string;
  phase: "start" | "update" | "end";
  /** When the harness saw this event, in epoch milliseconds. Supplied by the adapter so the core stays pure. */
  at: number;
  /** The call's arguments. Usually only on `start`. */
  args?: unknown;
  /** The call's result. Only on `end`. */
  result?: unknown;
  /** Whether the call failed. Only meaningful on `end`. */
  isError?: boolean;
  /** The group this call belongs to (see `group-start`). */
  groupId: string;
}

/** The kinds of Galaxy object a narration step can point at. */
export type GalaxyRefKind =
  "history" | "dataset" | "collection" | "job" | "invocation" | "workflow" | "tool";

/**
 * A pointer to something in Galaxy. Deliberately holds no URL: the view
 * builds one from the configured server, so the core never needs to know
 * which Galaxy it is talking to.
 */
export interface GalaxyRef {
  kind: GalaxyRefKind;
  id: string;
  /** What the user sees, e.g. `#41 forward`, built from the history item index and name when known. */
  label: string;
  /** The item's history item index, `hid` (datasets and collections), when known. */
  hid?: number;
  name?: string;
  /** Whether the call read this item or produced it. */
  role?: "input" | "output";
}

/**
 * What a tool call means to the user:
 * - `change`: alters their Galaxy (runs a tool, uploads, creates a history, …)
 * - `look`: reads from Galaxy without changing anything
 * - `wait`: checks on work that is already running
 * - `internal`: the harness's own bookkeeping (files, notes, records)
 */
export type ToolKind = "change" | "look" | "wait" | "internal";

/** One human-readable line in the narration. */
export interface NarrationEntry {
  /** The `ToolEvent.id` this entry narrates. */
  id: string;
  toolName: string;
  kind: ToolKind;
  /** The galaxy-ops domain of the operation (`histories`, `jobs`, `tools`, …), when it is one. */
  domain?: string;
  /** Set when galaxy-ops marks the operation destructive (deleting or cancelling something). */
  destructive?: boolean;
  /**
   * The Galaxy jobs or invocations this call started, as Galaxy last reported
   * them. While any is unfinished the entry stays `running`, even after the
   * call itself returned.
   */
  startedRuns?: readonly GalaxyRun[];
  /**
   * Galaxy runs this call reported on without starting them, e.g. a read of a
   * workflow run's details: their state and steps as the call saw them. Kept
   * even for a run started before the harness was watching.
   */
  seenRuns?: readonly GalaxyRun[];
  /**
   * `untracked`: the call's Galaxy work reached no known end; the harness
   * stopped following a job that was still going, so we can't say how it ended.
   */
  status: "running" | "done" | "failed" | "untracked";
  /** Plain-language summary, e.g. "Running FastQC on reads.fastq". */
  title: string;
  /** How the call is told once it has returned and Galaxy is doing the work, when that reads differently ("Running a workflow"). */
  runningTitle?: string;
  /** How the call is told once it has finished, when that reads differently ("Looked at your history"). */
  doneTitle?: string;
  /** How the call is told if it failed ("RNA STAR failed on 3 datasets"), when that reads differently. */
  failedTitle?: string;
  /** A short line under the title: what the call produced, or why it failed. */
  detail?: string;
  /** A failed call's whole message, exactly as Galaxy or the harness gave it, e.g. for a "show the full error" view. */
  failureMessage?: string;
  /**
   * The Galaxy objects the call was about: what it used (`role: "input"`, from
   * its arguments) and what it made (`role: "output"`, from its result). A view
   * can link to them in Galaxy, and `rowsOf()` matches reads to changes by them.
   *
   * @example
   * // "Ran Select first on "1.bed" (#1) — 1 new dataset (#5)"
   * [
   *   { kind: "dataset", id: "f9cad7b0…a4ef", label: "#1 1.bed", hid: 1, name: "1.bed", role: "input" },
   *   { kind: "tool", id: "Show beginning1", label: "Show beginning1", role: "input" },
   *   { kind: "dataset", id: "f9cad7b0…724f", label: "#5 Select first on data 1", hid: 5, name: "Select first on data 1", role: "output" },
   *   { kind: "job", id: "bbd44e69…3e76b", label: "bbd44e69…3e76b", role: "output" },
   * ]
   */
  galaxyRefs: GalaxyRef[];
  startedAt: number;
  endedAt?: number;
}

/**
 * Lifecycle events: everything the harness reports besides tool calls. A
 * group is all the work done for one message, from `group-start` to
 * `group-end`.
 */
export type LifecycleEvent =
  | {
      kind: "group-start";
      at: number;
      groupId: string;
    }
  | {
      /**
       * A message this group is working on. Usually the user's: the first one is
       * what started the group, and any sent while it runs are added after it.
       */
      kind: "group-message";
      at: number;
      groupId: string;
      /** The message, whole, as it was sent. */
      text: string;
      /** True when the harness sent it itself (e.g. to follow up on a Galaxy job), not the user. */
      followUp: boolean;
      /** The harness's id for the message (e.g. its chat bubble), so a display can find the group from it. */
      messageId?: string;
      /** For a follow-up: the Galaxy jobs or workflow invocations it is about. */
      about?: readonly GalaxyRunRef[];
      /** For a follow-up: the id of the request it answers (an `awaiting-user` id, e.g. an approved proposal's). */
      answerId?: string;
    }
  | { kind: "model"; at: number; activity: "thinking" | "writing" | "tool-call"; groupId: string }
  | { kind: "group-end"; at: number; error?: string; groupId: string }
  | {
      kind: "galaxy-finished";
      at: number;
      /** What the harness called the finished work, when it said; matched loosely. */
      label?: string;
    }
  | {
      /**
       * A Galaxy job or workflow invocation changed state. `id` is Galaxy's id
       * for it, as the call that started it reported. `state` is Galaxy's own
       * word (`queued`, `running`, `ok`, `error`, …; for an invocation
       * `scheduled`, `completed`, `failed`, `cancelled`), or `untracked` when
       * the harness has stopped following it.
       */
      kind: "job-state";
      at: number;
      id: string;
      state: string;
      /** For a workflow invocation, when the harness knows them: its steps. */
      steps?: readonly InvocationStep[];
      /** For a workflow invocation, when the harness counts it: how far it has got. */
      progress?: RunProgress;
    }
  | {
      /**
       * The harness's own label for a Galaxy job or workflow invocation it
       * knows by id, e.g. the step it recorded the run under. Shown beside the
       * run as the harness's description, never as the workflow's or tool's
       * name. Optional.
       */
      kind: "run-labeled";
      at: number;
      id: string;
      label: string;
    }
  | {
      /**
       * The harness can't go on until the user acts: an approval, a permission
       * prompt, a question. Optional; harnesses without such a step never send it.
       */
      kind: "awaiting-user";
      at: number;
      groupId: string;
      /** What the user needs to do, in plain words, e.g. `approve "Select random lines" (/approve prop-4esjcv)`. */
      text: string;
      /**
       * Names this request, so several can be pending at once and a reply can
       * answer just one. Asking again with the same id updates that request.
       */
      id?: string;
    }
  | {
      kind: "user-replied";
      at: number;
      /** The request this answers. Without one, the reply answers everything pending. */
      id?: string;
    };

/** Any event the narration core accepts. Tool events are told apart by their `phase`. */
export type NarrationEvent = ToolEvent | LifecycleEvent;

/** The live status line: what is happening right now, and since when. */
export interface NowLine {
  text: string;
  since: number;
  /**
   * What the line is waiting on, so a view can say who is slow when nothing
   * has happened for a while: the assistant's own reply, a Galaxy call, or
   * one of the harness's own tools (notes, files, web pages).
   */
  waitingOn?: "assistant" | "galaxy" | "harness";
  /**
   * When something last happened under this line (the model streaming more of
   * its reply, say), if anything has since it was set; a long wait is measured
   * from here, not from `since`.
   */
  activeAt?: number;
}

/**
 * One thing happening right now, from `currentActivity()`:
 * - `working`: a group at work, with its status line ("Thinking…")
 * - `waiting`: something the harness is waiting on the user for
 * - `galaxy`: Galaxy work still running, named by the call that started it
 */
export type ActivityLine =
  | (NowLine & { kind: "working"; groupId: string })
  | (NowLine & { kind: "waiting"; groupId: string; id?: string })
  | (NowLine & { kind: "galaxy"; groupId?: string; galaxyId?: string });

/** Something the harness is waiting on the user for. */
export interface WaitingRequest extends NowLine {
  id?: string;
}

/** A message a group serves, kept whole. */
export interface GroupMessage {
  /** The harness's id for the message, when it has one. */
  id?: string;
  text: string;
  at: number;
  /** Whether the user sent it, or the harness itself (a follow-up). */
  by: "user" | "harness";
}

/** All the work done for one message. */
export interface NarrationGroup {
  id: string;
  /** The messages this group serves, in order; its anchor is the first from the user (see `anchorUserMessage`). */
  messages: readonly GroupMessage[];
  /** True when the harness started the group itself. */
  followUp: boolean;
  /** For a follow-up: the Galaxy jobs or workflow invocations it is about, as the harness named them. */
  about?: readonly GalaxyRunRef[];
  /** For a follow-up: the groups that started that Galaxy work, or asked the request it answers. */
  followUpOfIds?: readonly string[];
  /** The ids of every request this group asked the user, kept after they are answered. */
  askedIds?: readonly string[];
  /** `waiting`: the group ended, and the harness is waiting on the user (see `waitingFor`). */
  status: "active" | "done" | "stopped" | "waiting";
  /** Only while active. */
  now: NowLine | null;
  /** What the user needs to do before the harness can go on, oldest first, until they reply. */
  waitingFor?: readonly WaitingRequest[];
  entries: readonly NarrationEntry[];
  startedAt: number;
  endedAt?: number;
  error?: string;
}

/** A Galaxy job or workflow invocation a call started, and its last known state. */
export interface GalaxyRun {
  kind: "job" | "invocation";
  /** Galaxy's id for the job or invocation. */
  id: string;
  /** Galaxy's last reported state. Kept as it was when the harness stops tracking the run. */
  state: string;
  /** Set when the harness stopped following this run before it reached an end. */
  untracked?: boolean;
  /** For a workflow invocation: its steps, as Galaxy last reported them. */
  steps?: readonly InvocationStep[];
  /** For a workflow invocation: how far it has got, when the harness counts that instead of listing steps. */
  progress?: RunProgress;
  /** The harness's own label for the run (see `run-labeled`), e.g. "Run duplicate workflow (simple data)". */
  label?: string;
}

/** Which Galaxy job or workflow invocation, without its state. */
export type GalaxyRunRef = Pick<GalaxyRun, "kind" | "id">;

/** How far a workflow invocation has got, counted, as of a moment. */
export interface RunProgress {
  totalSteps: number;
  completedSteps: number;
  totalJobs: number;
  completedJobs: number;
  failedJobs: number;
  /** When these counts were taken, in epoch milliseconds. */
  at: number;
}

/** One step of a workflow invocation, as Galaxy reported it. */
export interface InvocationStep {
  /** The step's place in the workflow, from 0 (Galaxy's `order_index`). */
  index: number;
  /** The step's label in the workflow, when it has one. */
  label?: string;
  /** Galaxy's scheduling state for the step (`new`, `scheduled`, …). */
  state: string;
  /**
   * The jobs the step ran (several when it maps over a collection), with their
   * states. Absent when Galaxy didn't list them: a read without step details
   * leaves them out, so "no jobs listed" doesn't mean the step ran none.
   */
  jobs?: readonly { id: string; state: string }[];
}

/** Galaxy work that was started and hasn't been reported finished yet. */
export interface GalaxyWork {
  /** The tool call that started it. */
  id: string;
  /** Galaxy's id for the job or invocation, when the call's result named it. */
  galaxyId?: string;
  title: string;
  since: number;
}

/** A dataset or collection: its Galaxy id, its name, and its history item index (`hid`) when known. */
export interface NamedItem {
  id: string;
  name: string;
  hid?: number;
}

/** Names of Galaxy things learned from results so far, by Galaxy id (tools by tool id). */
export interface NameMemory {
  tools: Readonly<Record<string, string>>;
  datasets: Readonly<Record<string, NamedItem>>;
  collections: Readonly<Record<string, NamedItem>>;
  histories: Readonly<Record<string, string>>;
  workflows: Readonly<Record<string, string>>;
}

export interface NarrationState {
  groups: readonly NarrationGroup[];
  galaxyRunning: readonly GalaxyWork[];
  names: NameMemory;
}

/** One change to the user's Galaxy, with the reads and checks that belong to it. */
export interface NarrationRow {
  /** The change, or its latest try when earlier ones failed. */
  change: NarrationEntry;
  /** Earlier tries at the same change that failed, oldest first. */
  attempts: readonly NarrationEntry[];
  /** Reads and checks done for this change (and its earlier tries), in order. */
  children: readonly NarrationEntry[];
}

/** A group's entries arranged for display, from `rowsOf()`. */
export interface GroupRows {
  /** The group's changes, in order, each with its children. */
  rows: readonly NarrationRow[];
  /**
   * Reads and checks of a group that changed nothing, so there is no change to
   * put them under. Empty whenever `rows` has a change.
   */
  checks: readonly NarrationEntry[];
  /** The harness's own bookkeeping (notes, files). */
  internal: readonly NarrationEntry[];
}
