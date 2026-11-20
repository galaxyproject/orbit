export const GTN_INDEX_VERSION: number;

export interface GtnWorkflowRef {
  name: string | null;
  title: string;
  ga: string;
  html: string;
  trs: string | null;
  wfid: string | null;
  tests: boolean;
  license: string | null;
}

export interface GtnMaterial {
  id: string;
  short_id: string | null;
  title: string;
  topic_id: string;
  topic: string | null;
  type: string | null;
  url: string;
  level: string | null;
  time_estimation: string | null;
  mod_date: string | null;
  tags: string[];
  objectives: string[];
  questions: string[];
  tools: string[];
  servers: { exact: string[]; inexact: string[] };
  workflows: GtnWorkflowRef[];
  zenodo_link: string | null;
  key_points: string[];
  requirements: GtnRequirement[];
  also_in: string[];
}

/**
 * A declared precondition. Only `internal` entries carrying a `tutorials` list name GTN
 * materials and can be walked; everything else is text to report, never to follow.
 */
export type GtnRequirement =
  | { type: "internal"; topic_name: string; tutorials?: string[] }
  | { type: string; title?: string; link?: string };

export interface GtnPathEntry {
  id: string;
  topic_id: string;
  topic: string | null;
  title: string;
  url: string;
  level: string | null;
  time_estimation: string | null;
  zenodo_link: string | null;
  workflows: number;
  tested_workflows: number;
  root: boolean;
}

export type GtnLearningPathResult =
  | {
      status: "ok";
      matched_from_query?: string;
      loose_match?: true;
      start_here: GtnPathEntry & { why: string };
      goal: GtnPathEntry;
      path: GtnPathEntry[];
      prerequisite_count: number;
      also_assumed: string[];
      total_time: string | null;
      total_time_partial?: true;
      caveats: string[];
      next_steps: { id: string; title: string; url: string; time_estimation: string | null }[];
      unresolved?: { from: string; missing: string }[];
      hint: string;
    }
  | {
      status: "not-found";
      id?: string;
      query?: string;
      candidates?: string[];
      hint: string;
    };

export function gtnLearningPath(
  index: GtnIndex,
  opts?: { id?: string; topic?: string; tutorial?: string; query?: string },
): GtnLearningPathResult;

/** Minutes in a GTN `time_estimation` (`1H`, `30m`, `1H30M`), or undefined if unparseable. */
export function gtnParseDuration(text: unknown): number | undefined;

/** Minutes rendered the way the GTN writes them, e.g. `4h30m`. */
export function gtnFormatDuration(minutes: number): string;

export interface GtnIndex {
  version: number;
  built_at: string;
  topics: { id: string; title: string }[];
  materials: GtnMaterial[];
  failures: { topic: string; error: string }[];
}

export interface GtnFindFilters {
  query?: string;
  topic?: string;
  tool?: string;
  server?: string;
  limit?: number;
}

export interface GtnTutorialHit {
  id: string;
  title: string;
  topic: string | null;
  topic_id: string;
  type: string | null;
  url: string;
  level: string | null;
  time_estimation: string | null;
  tags: string[];
  objectives: string[];
  workflow_count: number;
  tested_workflow_count: number;
  prerequisite_count: number;
  servers: string[];
}

export interface GtnWorkflowHit {
  name: string | null;
  title: string;
  tutorial: string;
  tutorial_url: string;
  topic: string | null;
  topic_id: string;
  ga_url: string;
  trs_endpoint: string | null;
  wfid: string | null;
  tested: boolean;
  license: string | null;
  tools: string[];
  servers: string[];
}

export function gtnTokens(text: string): string[];

export function gtnProjectMaterial(
  material: unknown,
  topic: { id: string; title: string | null },
): GtnMaterial | undefined;

export function gtnProjectTopic(payload: unknown, topicId: string): GtnMaterial[] | undefined;

export function buildGtnIndex(io: {
  fetchJson: (url: string) => Promise<unknown>;
  onProgress?: (done: number, total: number) => void;
  signal?: { aborted: boolean };
}): Promise<GtnIndex>;

export function gtnFindTutorials(
  index: GtnIndex,
  opts?: GtnFindFilters & { has_workflow?: boolean; loose?: boolean },
): {
  count: number;
  query?: string;
  relaxed?: true;
  returned: number;
  tutorials: GtnTutorialHit[];
  /** The top hit's entry point, when the top hit declares prerequisites. */
  start_here?: GtnPathEntry & { why: string; total_time: string | null; steps_to_goal: number };
  hint: string;
};

export function gtnFindWorkflows(
  index: GtnIndex,
  opts?: GtnFindFilters & { tests_only?: boolean },
): {
  count: number;
  query?: string;
  relaxed?: true;
  returned: number;
  workflows: GtnWorkflowHit[];
  hint: string;
};

export interface GtnWorkflowStep {
  step: number;
  type: string | null;
  name: string | null;
  label: string | null;
  tool_id: string | null;
  tool_version: string | null;
  annotation: string | null;
}

export interface GtnWorkflowSummary {
  name: string | null;
  annotation: string | null;
  tags: string[];
  version: string | number | null;
  license: string | null;
  step_count: number;
  inputs: { step: number; type: string; label: string | null; annotation: string | null }[];
  outputs: { step: number; output_name: string | null; label: string | null }[];
  tools: string[];
  steps: GtnWorkflowStep[];
}

export interface GtnServerEntry {
  url: string;
  name: string | null;
  usegalaxy: boolean;
}

export function gtnShortToolId(toolId: string): string;

/**
 * A resolved tool always carries its id; an unresolved one carries only the candidates. Stated
 * as a union so a caller that checks `entry` does not then have to re-check `match`.
 */
export function gtnResolveTool(
  index: GtnIndex,
  tool: string,
):
  | { match: string; candidates: string[]; entry: { materials: GtnMaterial[]; ids: Set<string> } }
  | { match: undefined; candidates: string[]; entry: undefined };

export function gtnTutorialsForTool(
  index: GtnIndex,
  opts: { tool: string; limit?: number },
): {
  tool: string | undefined;
  tool_ids?: string[];
  count: number;
  returned?: number;
  tutorials: {
    id: string;
    title: string;
    topic: string | null;
    url: string;
    level: string | null;
    workflow_count: number;
  }[];
  candidates?: string[];
  hint: string;
};

export function gtnWorkflowSummary(ga: unknown): GtnWorkflowSummary | undefined;

export function gtnLookupWorkflow(
  index: GtnIndex,
  ref: { wfid?: string; name?: string; url?: string },
): { material: GtnMaterial; workflow: GtnWorkflowRef }[];

export function gtnToolServersUrl(toolId: string): string;

export function gtnParseToolServers(payload: unknown):
  | {
      versions: { version: string; server_count: number; servers: GtnServerEntry[] }[];
      any_version: GtnServerEntry[];
    }
  | undefined;

export type GtnGetWorkflowResult =
  | { ok: true; workflow: Record<string, unknown>; steps: number }
  | { ok: false; reason: "no-ref" | "not-found" | "not-a-workflow" }
  | { ok: false; reason: "bad-url"; problem: string }
  | {
      ok: false;
      reason: "ambiguous";
      choices: { wfid: string | null; name: string | null; tutorial: string }[];
    };

export function gtnGetWorkflow(
  index: GtnIndex,
  ref: { wfid?: string; name?: string; url?: string; full?: boolean },
  io: {
    fetchJson: (url: string) => Promise<unknown>;
    checkUrl?: (url: string) => { problem?: string };
  },
): Promise<GtnGetWorkflowResult>;

export type GtnServersForToolResult =
  | {
      ok: true;
      tool: string;
      versions: { version: string; server_count: number; servers: GtnServerEntry[] }[];
      any_version: GtnServerEntry[];
    }
  | { ok: false; reason: "unresolved"; candidates: string[] }
  | { ok: false; reason: "built-in" | "bad-payload"; tool: string | undefined };

export function gtnServersForTool(
  index: GtnIndex,
  tool: string,
  io: { fetchJson: (url: string) => Promise<unknown> },
): Promise<GtnServersForToolResult>;
