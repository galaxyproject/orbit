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
