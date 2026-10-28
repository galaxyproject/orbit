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
 * submission (`run_tool`, `run_user_tool`), and the invocation(s) an
 * `invoke_workflow` returns. Nothing for a failed call or any other operation.
 */
export function startedWork(toolName: string, result: unknown): StartedWork[] {
  const envelope = envelopeOf(result);
  if (!envelope?.success) return [];
  const data: unknown = envelope.data;
  switch (normalizeToolName(toolName).name) {
    case "run_tool":
    case "run_user_tool":
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
