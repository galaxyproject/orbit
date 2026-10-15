/**
 * The catalog: turns a tool call into the plain-language title the user sees.
 *
 * Harnesses spell Galaxy MCP tool names differently (`galaxy_run_tool` in
 * Orbit, `mcp__galaxy__run_tool` in Claude Code, bare `run_tool` elsewhere),
 * so names are normalized to the bare MCP name before lookup. A tool with no
 * entry gets a generic fallback title rather than nothing.
 */

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
