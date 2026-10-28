/**
 * The catalog: what each tool call means to the user, and the title they see.
 *
 * Built on galaxy-ops' operation registry, which every Galaxy surface shares
 * (galaxy-mcp's TypeScript server, galaxy-cli, Orbit's in-process tools): an
 * operation's wire name, whether it writes to Galaxy, whether it is
 * destructive, its domain and its summary all come from there. Harnesses spell
 * the names differently (bare `run_tool` in Orbit, `mcp__galaxy__run_tool` in
 * Claude Code, `galaxy_run_tool` in older Orbit), so names are normalized to
 * the bare wire name before lookup.
 */

import { allOperations, type AnyOperation } from "@galaxyproject/galaxy-ops/browser";

import type { ToolKind } from "./types.js";

const GALAXY_PREFIXES = ["mcp__galaxy__", "galaxy_"];

const OPERATIONS: ReadonlyMap<string, AnyOperation> = new Map(
  allOperations.map((op) => [op.name, op]),
);

/** The galaxy-ops operation behind a tool name, if there is one. */
export function operationFor(toolName: string): AnyOperation | undefined {
  return OPERATIONS.get(normalizeToolName(toolName).name);
}

export interface NormalizedToolName {
  /** The name with any Galaxy prefix removed, e.g. `run_tool`. */
  name: string;
  /** Whether this is a Galaxy tool: a galaxy-ops operation, or a name carrying a Galaxy prefix. */
  galaxy: boolean;
}

export function normalizeToolName(toolName: string): NormalizedToolName {
  for (const prefix of GALAXY_PREFIXES) {
    if (toolName.startsWith(prefix)) return { name: toolName.slice(prefix.length), galaxy: true };
  }
  return { name: toolName, galaxy: OPERATIONS.has(toolName) || toolName in KIND_OVERRIDES };
}

type Describer = (args: Record<string, unknown>) => string;

const DESCRIBERS: Record<string, Describer> = {
  run_tool: (args) => `Running ${galaxyToolLabel(args.tool_id)}`,
};

/**
 * Where what a call means to the user differs from what galaxy-ops says about
 * it, or where galaxy-ops doesn't know the name. galaxy-ops marks reads and
 * writes; narration also needs `wait` (a read that checks on running work) and
 * `internal` (the harness's own records and helpers), and treats a download as
 * a look, since it changes nothing in the user's Galaxy.
 */
const KIND_OVERRIDES: Record<string, ToolKind> = {
  get_job_details: "wait",
  get_invocations: "wait",
  download_dataset: "look",
  // Orbit's own Galaxy tools, beside galaxy-ops' operations.
  list_jobs: "wait",
  get_job_logs: "look",
  upload_local_file: "change",
  invocation_check_one: "wait",
  invocation_check_all: "wait",
  job_record: "internal",
  invocation_record: "internal",
  read_output: "internal",
  set_profile: "internal",
};

/** For a Galaxy tool galaxy-ops doesn't know: a name that reads as a write is a change. */
const CHANGE_PREFIXES = [
  "run_",
  "invoke_",
  "upload_",
  "create_",
  "update_",
  "delete_",
  "import_",
  "cancel_",
  "revert_",
];

/**
 * What a call means to the user. The overrides come first, then galaxy-ops'
 * own say (an operation that writes is a change, any other a look). A Galaxy
 * tool galaxy-ops doesn't know is judged by its name, defaulting to a look so a
 * new tool never shows up as a change it isn't. Anything that isn't a Galaxy
 * tool is the harness's own bookkeeping.
 */
export function classifyTool(toolName: string): ToolKind {
  const { name, galaxy } = normalizeToolName(toolName);
  const override = KIND_OVERRIDES[name];
  if (override) {
    return override;
  }
  const op = OPERATIONS.get(name);
  if (op) {
    return op.readOnly === false ? "change" : "look";
  }
  if (!galaxy) {
    return "internal";
  }
  return CHANGE_PREFIXES.some((p) => name.startsWith(p)) ? "change" : "look";
}

/**
 * Galaxy tools whose success means Galaxy keeps working after the call
 * returns, and whose finish the harness reports. Uploads also run as Galaxy
 * jobs, but Orbit's poller never reports them finished, so counting them here
 * left "Galaxy is still working" on screen forever; they come back once job
 * state is read directly.
 */
const STARTS_GALAXY_WORK = new Set(["run_tool", "run_user_tool", "invoke_workflow"]);

/** Whether a successful call to this tool leaves a job running in Galaxy. */
export function startsGalaxyWork(toolName: string): boolean {
  return STARTS_GALAXY_WORK.has(normalizeToolName(toolName).name);
}

/**
 * Title for a tool call, from its harness name and arguments. Without a
 * describer of our own, a galaxy-ops operation is titled by the first sentence
 * of its summary.
 */
export function describeToolCall(toolName: string, args: unknown): string {
  const { name, galaxy } = normalizeToolName(toolName);
  const describer = DESCRIBERS[name];
  if (describer) return describer(isRecord(args) ? args : {});
  const op = OPERATIONS.get(name);
  if (op) return firstSentence(op.summary);
  return galaxy ? `Working with Galaxy: ${name}` : `Using ${name}`;
}

/** The opening sentence of an operation's summary, without code marks or the closing period. */
function firstSentence(summary: string): string {
  const sentence = summary.split(/(?<=\.)\s/)[0] ?? summary;
  return sentence.replace(/`/g, "").replace(/\.$/, "");
}

/**
 * A short label for a Galaxy tool id. Tool Shed ids are long paths ending in
 * `<repo>/<tool>/<version>`, so the tool segment is used; built-in ids such as
 * `__BUILD_LIST__` are shown as they are.
 */
function galaxyToolLabel(toolId: unknown): string {
  if (typeof toolId !== "string" || toolId === "") return "a Galaxy tool";
  const parts = toolId.split("/");
  return parts.length >= 2 ? parts[parts.length - 2] : toolId;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
