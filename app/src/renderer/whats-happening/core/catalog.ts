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

import {
  allOperations,
  isPlainObject,
  type AnyOperation,
  type OperationDomain,
} from "@galaxyproject/galaxy-ops/browser";

import { galaxyRef } from "./refs.js";
import type { GalaxyRef, NameMemory, ToolKind } from "./types.js";

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

/**
 * How a change is said while it runs, once it's done, and if it failed, from
 * the call's arguments and the names learned so far.
 */
type Describer = (
  args: Record<string, unknown>,
  names: NameMemory | undefined,
) => { now: string; done: string; failed: string };

const DESCRIBERS: Record<string, Describer> = {
  run_tool: (args, names) => {
    const tool =
      (typeof args.tool_id === "string" && names?.tools[args.tool_id]) ||
      galaxyToolLabel(args.tool_id);
    const on = onAccession(args.inputs) || onInputs(args.inputs, names);
    return { now: `Running ${tool}${on}`, done: `Ran ${tool}${on}`, failed: `${tool} failed${on}` };
  },
  create_history: (args) => {
    const name = quoted(args.history_name);
    return name
      ? {
          now: `Creating history ${name}`,
          done: `Created history ${name}`,
          failed: `Couldn't create history ${name}`,
        }
      : {
          now: "Creating a history",
          done: "Created a history",
          failed: "Couldn't create a history",
        };
  },
  update_history: (args) =>
    typeof args.name === "string" && args.name
      ? {
          now: `Renaming your history to ${quoted(args.name)}`,
          done: `Renamed your history to ${quoted(args.name)}`,
          failed: `Couldn't rename your history to ${quoted(args.name)}`,
        }
      : {
          now: "Updating your history",
          done: "Updated your history",
          failed: "Couldn't update your history",
        },
  invoke_workflow: () => ({
    now: "Starting a workflow run",
    done: "Ran a workflow",
    failed: "The workflow run failed",
  }),
  cancel_workflow_invocation: () => ({
    now: "Cancelling a workflow run",
    done: "Cancelled a workflow run",
    failed: "Couldn't cancel a workflow run",
  }),
  import_workflow_from_iwc: () => ({
    now: "Adding a workflow to your Galaxy",
    done: "Added a workflow to your Galaxy",
    failed: "Couldn't add a workflow to your Galaxy",
  }),
  upload_file_from_url: (args) => uploading(fileLabel(args.file_name ?? args.url)),
  upload_file: (args) => uploading(fileLabel(args.path ?? args.file_path)),
  upload_local_file: (args) => uploading(fileLabel(args.path ?? args.file_path)),
};

function uploading(file: string): ReturnType<Describer> {
  return { now: `Uploading ${file}`, done: `Uploaded ${file}`, failed: `Couldn't upload ${file}` };
}

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

/** How a read or a check is said while it runs, and once it's done. */
type Wording = readonly [now: string, done: string];

/**
 * Plain wording for reads and checks, by the galaxy-ops domain of the
 * operation: what the user is told, not what the operation is called.
 */
const DOMAIN_WORDING: Record<OperationDomain, Wording> = {
  connection: ["Connecting to Galaxy", "Connected to Galaxy"],
  histories: ["Looking at your history", "Looked at your history"],
  datasets: ["Checking a dataset", "Checked a dataset"],
  collections: ["Checking a collection", "Checked a collection"],
  jobs: ["Checking on a job", "Checked on a job"],
  tools: ["Finding the right Galaxy tool", "Looked up a Galaxy tool"],
  userTools: ["Finding the right Galaxy tool", "Looked up a Galaxy tool"],
  workflows: ["Looking for a workflow", "Looked for a workflow"],
  iwc: ["Looking for a workflow", "Looked for a workflow"],
  invocations: ["Checking on a workflow run", "Checked on a workflow run"],
  pages: ["Reading your Galaxy page", "Read your Galaxy page"],
};

/** Wording for Galaxy tools outside galaxy-ops' registry, by name. */
const NAME_WORDING: [RegExp, Wording][] = [
  [/^(list_jobs|invocation_check)/, ["Checking on your jobs", "Checked on your jobs"]],
  [/^get_job_logs$/, ["Reading a job's log", "Read a job's log"]],
  [/ena|organism|assembl/, ["Searching public data", "Searched public data"]],
];

/** The plain wording for a read or a check, if this call is one we have words for. */
function wordingFor(toolName: string): Wording | undefined {
  const kind = classifyTool(toolName);
  if (kind !== "look" && kind !== "wait") return undefined;
  const { name, galaxy } = normalizeToolName(toolName);
  const op = OPERATIONS.get(name);
  if (op) return DOMAIN_WORDING[op.domain];
  if (!galaxy) return undefined;
  return NAME_WORDING.find(([pattern]) => pattern.test(name))?.[1];
}

/**
 * Title for a tool call, from its harness name and arguments: our own words
 * for a few changes, plain wording by domain for reads and checks, else the
 * first sentence of the galaxy-ops operation's summary.
 */
export function describeToolCall(toolName: string, args: unknown, names?: NameMemory): string {
  const { name, galaxy } = normalizeToolName(toolName);
  const describer = DESCRIBERS[name];
  if (describer) return describer(isPlainObject(args) ? args : {}, names).now;
  const wording = wordingFor(toolName);
  if (wording) return wording[0];
  const op = OPERATIONS.get(name);
  if (op) return firstSentence(op.summary);
  return galaxy ? `Working with Galaxy: ${name}` : `Using ${name}`;
}

/**
 * How a finished call is told afterwards ("Looked at your history", "Created
 * history "RNA-seq""), or undefined when its title reads the same either way.
 */
export function describeDoneCall(
  toolName: string,
  args?: unknown,
  names?: NameMemory,
): string | undefined {
  const describer = DESCRIBERS[normalizeToolName(toolName).name];
  if (describer) return describer(isPlainObject(args) ? args : {}, names).done;
  return wordingFor(toolName)?.[1];
}

/**
 * How a change that failed is told ("RNA STAR failed on 3 datasets",
 * "Couldn't upload counts.tsv"), or undefined when we have no words of our own
 * for it and its title stands.
 */
export function describeFailedCall(
  toolName: string,
  args?: unknown,
  names?: NameMemory,
): string | undefined {
  const describer = DESCRIBERS[normalizeToolName(toolName).name];
  return describer?.(isPlainObject(args) ? args : {}, names).failed;
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

/** A sequencing-run accession among a tool's inputs (SRR / ERR / DRR), as " on SRR123…". */
function onAccession(inputs: unknown): string {
  if (!isPlainObject(inputs)) return "";
  const found = Object.values(inputs).find(
    (v): v is string => typeof v === "string" && /^[SED]RR\d+$/.test(v.trim()),
  );
  return found ? ` on ${found.trim()}` : "";
}

/**
 * The datasets and collections a call's inputs point at (`{ src: "hda" | "hdca",
 * id }` anywhere in them), each once, as input refs: always with the Galaxy id,
 * and with the history item index and name when they've been seen.
 */
export function inputRefs(inputs: unknown, names?: NameMemory): GalaxyRef[] {
  const found = new Map<string, GalaxyRef>();
  const walk = (value: unknown, depth: number) => {
    if (depth > 4) return;
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1);
    } else if (isPlainObject(value)) {
      if ((value.src === "hda" || value.src === "hdca") && typeof value.id === "string") {
        if (found.has(value.id)) return;
        const collection = value.src === "hdca";
        const known = collection ? names?.collections[value.id] : names?.datasets[value.id];
        found.set(
          value.id,
          galaxyRef(collection ? "collection" : "dataset", value.id, {
            hid: known?.hid,
            name: known?.name,
            role: "input",
          }),
        );
        return;
      }
      for (const child of Object.values(value)) walk(child, depth + 1);
    }
  };
  walk(inputs, 0);
  return [...found.values()];
}

/**
 * The inputs said in a title: ` on "reads.fastq" (#4)` for one whose name is
 * known, ` on 3 datasets` for several, and nothing for one it hasn't seen.
 */
function onInputs(inputs: unknown, names: NameMemory | undefined): string {
  const refs = inputRefs(inputs, names);
  if (refs.length === 0) return "";
  if (refs.length > 1) {
    const collections = refs.every((r) => r.kind === "collection");
    return ` on ${refs.length} ${collections ? "collections" : "datasets"}`;
  }
  const [only] = refs;
  if (only.name === undefined) return "";
  return ` on "${only.name}"${only.hid === undefined ? "" : ` (#${only.hid})`}`;
}

function quoted(value: unknown): string {
  return typeof value === "string" && value.trim() ? `"${value.trim()}"` : "";
}

/** The last path or URL segment, or "a file". */
function fileLabel(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "a file";
  const last = value
    .trim()
    .replace(/[?#].*$/, "")
    .split(/[\\/]/)
    .filter(Boolean)
    .pop();
  return last ?? "a file";
}
