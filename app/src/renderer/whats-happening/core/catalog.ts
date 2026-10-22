/**
 * The catalog: turns a tool call into the plain-language title the user sees.
 *
 * Harnesses spell Galaxy MCP tool names differently (`galaxy_run_tool` in
 * Orbit, `mcp__galaxy__run_tool` in Claude Code, bare `run_tool` elsewhere),
 * so names are normalized to the bare MCP name before lookup. A tool with no
 * entry gets a generic fallback title rather than nothing.
 */

import type { ToolKind } from "./types.js";

const GALAXY_PREFIXES = ["mcp__galaxy__", "galaxy_"];

export interface NormalizedToolName {
  /** The name with any Galaxy prefix removed, e.g. `run_tool`. */
  name: string;
  /** Whether the harness name carried a Galaxy prefix. */
  galaxy: boolean;
}

export function normalizeToolName(toolName: string): NormalizedToolName {
  for (const prefix of GALAXY_PREFIXES) {
    if (toolName.startsWith(prefix)) return { name: toolName.slice(prefix.length), galaxy: true };
  }
  return { name: toolName, galaxy: false };
}

type Describer = (args: Record<string, unknown>) => string;

const DESCRIBERS: Record<string, Describer> = {
  run_tool: (args) => `Running ${galaxyToolLabel(args.tool_id)}`,
};

/**
 * The kind of every known Galaxy tool (bare names). Galaxy MCP tools first,
 * then the Galaxy tools harnesses add for their own records. Read-only
 * `get_*` / `search_*` / `list_*` tools are covered by the name rules below,
 * so only exceptions to those rules need listing.
 */
const KNOWN_KINDS: Record<string, ToolKind> = {
  run_tool: "change",
  run_user_tool: "change",
  invoke_workflow: "change",
  upload_file: "change",
  upload_file_from_url: "change",
  upload_local_file: "change",
  create_history: "change",
  update_history: "change",
  import_workflow_from_iwc: "change",
  cancel_workflow_invocation: "change",
  create_user_tool: "change",
  delete_user_tool: "change",
  create_page: "change",
  update_page: "change",
  revert_page_revision: "change",
  get_job_details: "wait",
  get_invocations: "wait",
  invocation_check_one: "wait",
  invocation_check_all: "wait",
  connect: "look",
  check_compatibility: "look",
  download_dataset: "look",
  job_record: "internal",
  invocation_record: "internal",
  set_profile: "internal",
};

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
 * What a call means to the user. Known tools use the map; an unknown Galaxy
 * tool is judged by its name, defaulting to a read-only look so a new tool
 * never shows up as a change it isn't; anything that isn't a Galaxy tool is
 * the harness's own bookkeeping.
 */
export function classifyTool(toolName: string): ToolKind {
  const { name, galaxy } = normalizeToolName(toolName);
  const known = KNOWN_KINDS[name];
  if (known) {
    return known;
  }
  if (!galaxy) {
    return "internal";
  }
  return CHANGE_PREFIXES.some((p) => name.startsWith(p)) ? "change" : "look";
}

/**
 * Galaxy MCP tools whose success means Galaxy keeps working after the call
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

/** Title for a tool call, from its harness name and arguments. */
export function describeToolCall(toolName: string, args: unknown): string {
  const { name, galaxy } = normalizeToolName(toolName);
  const describer = DESCRIBERS[name];
  if (describer) return describer(isRecord(args) ? args : {});
  return galaxy ? `Working with Galaxy: ${name}` : `Using ${name}`;
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
