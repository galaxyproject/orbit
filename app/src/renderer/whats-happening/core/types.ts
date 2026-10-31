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
  galaxy?: readonly GalaxyRun[];
  /**
   * `untracked`: the call's Galaxy work reached no known end; the harness
   * stopped following a job that was still going, so we can't say how it ended.
   */
  status: "running" | "done" | "failed" | "untracked";
  /** Plain-language summary, e.g. "Running FastQC on reads.fastq". */
  title: string;
  /** How the call is told once it has finished, when that reads differently ("Looked at your history"). */
  doneTitle?: string;
  detail?: string;
  links: GalaxyRef[];
  startedAt: number;
  endedAt?: number;
}

/**
 * Lifecycle events: everything the harness reports besides tool calls. A
 * group is all the work done for one message, from `group-start` to
 * `group-end`.
 */
export type LifecycleEvent =
  | { kind: "group-start"; at: number }
  | {
      kind: "group-info";
      at: number;
      /** The message that started the group, as the user typed it. */
      text: string;
      /** True when the harness started the group itself (e.g. to follow up on a Galaxy job). */
      followUp: boolean;
    }
  | { kind: "model"; at: number; activity: "thinking" | "writing" | "tool-call" }
  | { kind: "group-end"; at: number; error?: string }
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
    }
  | {
      /**
       * The harness can't go on until the user acts: an approval, a permission
       * prompt, a question. Optional; harnesses without such a step never send it.
       */
      kind: "awaiting-user";
      at: number;
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
}

/** Something the harness is waiting on the user for. */
export interface WaitingRequest extends NowLine {
  id?: string;
}

/** All the work done for one message. */
export interface NarrationGroup {
  id: string;
  /** The message that started the group, once known. */
  text?: string;
  followUp: boolean;
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
}

export interface NarrationState {
  groups: readonly NarrationGroup[];
  galaxyRunning: readonly GalaxyWork[];
  names: NameMemory;
}
