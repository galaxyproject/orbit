// The MCP surface over the GTN index: tool declarations, and the JSON-RPC handling that serves
// them. Kept apart from bin/gtn-mcp.js so the protocol can be tested without a subprocess.
//
// This speaks MCP directly rather than through the SDK. The server answers four methods over
// newline-delimited JSON-RPC and holds no session state, which is small enough that a dependency
// would cost more than it saves -- the same call shared/gtn.js makes in hand-writing its scanner.

import {
  gtnFindTutorials,
  gtnFindWorkflows,
  gtnLearningPath,
  gtnGetWorkflow,
  gtnServersForTool,
  gtnTutorialsForTool,
} from "../../../shared/gtn-index.js";
import { gtnUrl } from "../../../shared/gtn.js";

export const SERVER_NAME = "gtn";
export const SERVER_VERSION = "0.1.0";

/** Revisions of the MCP spec this server knows how to answer. Newest first. */
const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

const FILTERS = {
  topic: { type: "string", description: "Restrict to a GTN topic, e.g. 'assembly'" },
  tool: { type: "string", description: "Only results whose tutorial uses this Galaxy tool id" },
  server: { type: "string", description: "Only results supported on this Galaxy server URL" },
  limit: { type: "number", description: "Results to return (1-50, default 10)" },
};

export const TOOLS = [
  {
    name: "gtn_find_tutorial",
    description:
      "Search every Galaxy Training Network tutorial at once, ranked by relevance. Give the " +
      "analysis in the user's own words rather than a keyword. The first call builds a local " +
      "index of GTN and takes a few seconds; later calls are instant.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What the user wants to do, in words" },
        ...FILTERS,
        has_workflow: {
          type: "boolean",
          description: "Only tutorials that ship a runnable workflow",
        },
      },
    },
  },
  {
    name: "gtn_learning_path",
    description:
      "Resolve where someone should actually start, for a tutorial they want to reach. GTN " +
      "tutorials declare prerequisites, so the best match for a question is routinely the " +
      "middle of a chain. Call this whenever a user asks where to begin, says they are new to " +
      "a subject, or you are about to recommend a tutorial as a starting point. Returns " +
      "start_here, the ordered path, total time, and the tutorial's own key points as caveats.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Material id, e.g. 'evolution/mtb_transmission'" },
        topic: { type: "string", description: "Topic id, with `tutorial`" },
        tutorial: { type: "string", description: "Tutorial name, with `topic`" },
        query: { type: "string", description: "Resolve the goal tutorial by search instead" },
      },
    },
  },
  {
    name: "gtn_find_workflow",
    description:
      "Search the workflows that GTN tutorials ship. These are teaching workflows: each comes " +
      "with the tutorial explaining it. Returns ga_url (importable into Galaxy) and " +
      "trs_endpoint (the same descriptor over GA4GH TRS).",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The analysis the workflow should perform" },
        ...FILTERS,
        tests_only: { type: "boolean", description: "Only workflows GTN tests in CI" },
      },
    },
  },
  {
    name: "gtn_get_workflow",
    description:
      "Read one GTN workflow: what goes in, which tools run in what order, what comes out. " +
      "Identify it with the wfid and name from a gtn_find_workflow result, or its ga_url. " +
      "Returns a summary rather than the raw file; pass full=true for the document itself.",
    inputSchema: {
      type: "object",
      properties: {
        wfid: { type: "string", description: "Workflow id from gtn_find_workflow" },
        name: { type: "string", description: "Workflow name from gtn_find_workflow" },
        url: { type: "string", description: "The ga_url from gtn_find_workflow" },
        full: { type: "boolean", description: "Return the whole .ga instead of a summary" },
      },
    },
  },
  {
    name: "gtn_tutorials_for_tool",
    description:
      "Find the GTN tutorials that use a given Galaxy tool. Accepts a full versioned tool id, " +
      "an unversioned one, or a bare name like 'fastqc'; an ambiguous name comes back as " +
      "candidates to choose from. Useful when a tool fails or its parameters are unclear.",
    inputSchema: {
      type: "object",
      properties: {
        tool: { type: "string", description: "Galaxy tool id, or part of one" },
        limit: { type: "number", description: "Tutorials to return (1-50, default 20)" },
      },
      required: ["tool"],
    },
  },
  {
    name: "gtn_servers_for_tool",
    description:
      "Find which public Galaxy servers install a given tool, per tool version, from GTN's " +
      "public server tool listing. any_version lists the servers that have it at all. Covers " +
      "the public usegalaxy.* servers only.",
    inputSchema: {
      type: "object",
      properties: { tool: { type: "string", description: "Galaxy tool id, or part of one" } },
      required: ["tool"],
    },
  },
];

/** @param {unknown} id @param {{ code: number, message: string }} error */
const fail = (id, error) => ({ jsonrpc: "2.0", id, error });
/** @param {unknown} id @param {unknown} result */
const ok = (id, result) => ({ jsonrpc: "2.0", id, result });

/** @param {unknown} body */
const text = (body) => ({ content: [{ type: "text", text: JSON.stringify(body, null, 2) }] });
/** @param {string} message */
const problem = (message) => ({ content: [{ type: "text", text: message }], isError: true });

/**
 * Run one tool and shape the result the way MCP wants it.
 *
 * A tool that fails comes back as `isError` content rather than a JSON-RPC error: the client
 * should hand the reason to the model, not treat the call as a transport failure.
 * @param {string} name @param {any} args
 * @param {{ getIndex: () => Promise<any>, fetchJson: (url: string) => Promise<unknown> }} ctx
 */
async function callTool(name, args, ctx) {
  const params = args ?? {};
  try {
    const index = await ctx.getIndex();
    switch (name) {
      case "gtn_find_tutorial":
        return text(gtnFindTutorials(index, params));
      case "gtn_find_workflow":
        return text(gtnFindWorkflows(index, params));
      case "gtn_learning_path": {
        const result = gtnLearningPath(index, params);
        if (result.status === "not-found") return problem(result.hint);
        return text(result);
      }
      case "gtn_tutorials_for_tool":
        return text(gtnTutorialsForTool(index, params));
      case "gtn_get_workflow": {
        const result = await gtnGetWorkflow(index, params, {
          fetchJson: ctx.fetchJson,
          checkUrl: gtnUrl,
        });
        if (result.ok) return text(result.workflow);
        if (result.reason === "ambiguous") {
          return text({ ambiguous: true, choices: result.choices });
        }
        return problem(
          result.reason === "no-ref"
            ? "Give wfid, name or url. Find them with gtn_find_workflow."
            : result.reason === "bad-url"
              ? result.problem
              : `Could not read that workflow (${result.reason}).`,
        );
      }
      case "gtn_servers_for_tool": {
        const result = await gtnServersForTool(index, params.tool, { fetchJson: ctx.fetchJson });
        if (result.ok) {
          return text({
            tool: result.tool,
            versions: result.versions,
            any_version: result.any_version,
          });
        }
        if (result.reason === "unresolved") {
          return text({ tool: params.tool, candidates: result.candidates });
        }
        return problem(
          result.reason === "built-in"
            ? `"${result.tool}" is a built-in Galaxy tool, so it is on every server and not in the listing.`
            : `No public server listing for "${result.tool}".`,
        );
      }
      default:
        return problem(`Unknown tool: ${name}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return problem(`Error searching GTN: ${message}`);
  }
}

/**
 * Answer one JSON-RPC message, or return undefined when none is owed -- a notification carries
 * no id and must not be replied to.
 * @param {any} message
 * @param {{ getIndex: () => Promise<any>, fetchJson?: (url: string) => Promise<unknown> }} ctx
 */
export async function handleMcpMessage(message, ctx) {
  if (!message || typeof message !== "object" || message.jsonrpc !== "2.0") {
    return fail(message?.id ?? null, { code: -32600, message: "Invalid Request" });
  }
  const { id, method, params } = message;
  const isNotification = id === undefined || id === null;

  switch (method) {
    case "initialize": {
      const asked = params?.protocolVersion;
      return ok(id, {
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
    }
    case "notifications/initialized":
    case "notifications/cancelled":
      return undefined;
    case "ping":
      return ok(id, {});
    case "tools/list":
      return ok(id, { tools: TOOLS });
    case "tools/call":
      return ok(id, await callTool(params?.name, params?.arguments, ctx));
    default:
      if (isNotification) return undefined;
      return fail(id, { code: -32601, message: `Method not found: ${method}` });
  }
}
