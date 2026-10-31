/**
 * Reading a Galaxy call's result: the galaxy-ops envelope every surface emits,
 * `{ data, success, message, count, pagination }` (or `{ success: false,
 * message, errorKind }`), and what's in its `data`.
 *
 * The harness adapter hands over the envelope itself, as an object or as its
 * JSON text; how a harness wraps it (pi puts it in a text content block) is
 * the adapter's business, not the core's.
 */

import { isPlainObject, type GalaxyResult } from "@galaxyproject/galaxy-ops/browser";

import { normalizeToolName } from "./catalog.js";
import { galaxyRef } from "./refs.js";
import type { GalaxyRef, GalaxyRefKind } from "./types.js";

/** A Galaxy job or workflow invocation a call started, as the result reported it. */
export interface StartedWork {
  kind: "job" | "invocation";
  id: string;
  /** Galaxy's state when the call returned, e.g. `queued`, `new`, `ok`. */
  state: string;
}

/** The galaxy-ops envelope in a result, or null when there isn't one. */
export function envelopeOf(result: unknown): GalaxyResult<unknown> | null {
  let value = result;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!isPlainObject(value) || typeof value.success !== "boolean" || !("data" in value)) {
    return null;
  }
  return value as unknown as GalaxyResult<unknown>;
}

/**
 * The jobs and invocations a successful call started: `jobs` on a tool
 * submission (`run_tool`, `run_user_tool`) or an upload, and the invocation(s)
 * an `invoke_workflow` returns. Nothing for a failed call or any other operation.
 */
export function startedWork(toolName: string, result: unknown): StartedWork[] {
  const envelope = envelopeOf(result);
  if (!envelope?.success) return [];
  const data: unknown = envelope.data;
  switch (normalizeToolName(toolName).name) {
    case "run_tool":
    case "run_user_tool":
    case "upload_file_from_url":
    case "upload_file":
      return isPlainObject(data) && Array.isArray(data.jobs)
        ? data.jobs.flatMap((job) => workOf("job", job))
        : [];
    case "invoke_workflow":
      return (Array.isArray(data) ? data : [data]).flatMap((inv) => workOf("invocation", inv));
    default:
      return [];
  }
}

function workOf(kind: StartedWork["kind"], value: unknown): StartedWork[] {
  if (!isPlainObject(value) || typeof value.id !== "string") return [];
  return [{ kind, id: value.id, state: typeof value.state === "string" ? value.state : "new" }];
}

/**
 * What a successful call produced or touched, as links to Galaxy: the
 * datasets and collections a tool run or upload made (with their history
 * item indexes and names), its jobs, the history a call created, the workflow
 * runs it started. Nothing for a failed call or a read.
 */
export function producedRefs(toolName: string, result: unknown): GalaxyRef[] {
  const envelope = envelopeOf(result);
  if (!envelope?.success) return [];
  const data: unknown = envelope.data;
  switch (normalizeToolName(toolName).name) {
    case "run_tool":
    case "run_user_tool":
    case "upload_file":
    case "upload_file_from_url":
    case "upload_local_file": {
      if (!isPlainObject(data)) return [];
      return [
        ...refsOf("dataset", data.outputs),
        ...refsOf("collection", data.output_collections),
        ...refsOf("job", data.jobs),
      ];
    }
    case "create_history":
    case "update_history":
      return refsOf("history", [data]);
    case "invoke_workflow":
      return refsOf("invocation", Array.isArray(data) ? data : [data]);
    case "import_workflow_from_iwc":
      return refsOf("workflow", [data]);
    default:
      return [];
  }
}

function refsOf(kind: GalaxyRefKind, values: unknown): GalaxyRef[] {
  if (!Array.isArray(values)) return [];
  return values.flatMap((value) => {
    if (!isPlainObject(value) || typeof value.id !== "string") return [];
    const hid = typeof value.hid === "number" ? value.hid : undefined;
    const name = typeof value.name === "string" && value.name ? value.name : undefined;
    return [galaxyRef(kind, value.id, { hid, name, role: "output" })];
  });
}

/** A short line for what a call produced, e.g. "2 new datasets (#41, #42)". */
export function producedSummary(refs: readonly GalaxyRef[]): string | undefined {
  const parts: string[] = [];
  for (const [kind, one, many] of [
    ["dataset", "new dataset", "new datasets"],
    ["collection", "new collection", "new collections"],
  ] as const) {
    const found = refs.filter((r) => r.kind === kind && r.role !== "input");
    if (found.length === 0) continue;
    const hids = found.flatMap((r) => (r.hid === undefined ? [] : [`#${r.hid}`]));
    const list = hids.length === found.length ? ` (${hids.join(", ")})` : "";
    parts.push(`${found.length} ${found.length === 1 ? one : many}${list}`);
  }
  return parts.length > 0 ? parts.join(", ") : undefined;
}

/**
 * Why a call failed, when its result says: the envelope's message, with
 * Galaxy's own `err_msg` pulled out when it is buried in there, and the
 * wrapper's "Error calling tool …" preamble dropped.
 */
export function failureReason(result: unknown): string | undefined {
  let text = failureMessage(result);
  if (text === undefined) return undefined;
  const galaxySaid = /"err_msg"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(text)?.[1];
  if (galaxySaid) {
    text = galaxySaid.replace(/\\"/g, '"');
  }
  return text
    .replace(/^\s*(Error:\s*)+/i, "")
    .replace(/^Error calling tool '[^']*':\s*/i, "")
    .trim();
}

/**
 * A failed call's whole message, as the result gave it (the envelope's
 * message, or the harness's error text), for a view that shows it in full.
 */
export function failureMessage(result: unknown): string | undefined {
  const envelope = envelopeOf(result);
  const text =
    envelope && !envelope.success
      ? envelope.message
      : typeof result === "string" && envelope === null
        ? result
        : undefined;
  return typeof text === "string" && text.trim() ? text : undefined;
}
