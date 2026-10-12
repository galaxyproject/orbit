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
  /** What the user sees, e.g. the dataset or history name. */
  label: string;
}

/** One human-readable line in the narration. */
export interface NarrationEntry {
  /** The `ToolEvent.id` this entry narrates. */
  id: string;
  toolName: string;
  status: "running" | "done" | "failed";
  /** Plain-language summary, e.g. "Running FastQC on reads.fastq". */
  title: string;
  detail?: string;
  links: GalaxyRef[];
  startedAt: number;
  endedAt?: number;
}
