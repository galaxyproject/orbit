// A searchable index of the whole Galaxy Training Network, the part every shell shares.
//
// The GTN API has no search endpoint: there is `topics.json` and a payload per topic, and
// nothing that spans them (`/ga4gh/trs/v2/tools` is not listed, and 404s). Searching across
// GTN therefore means reading all ~35 topics -- about 26MB -- and that is far too much to pull
// on every query. So we pull once, project each material down to the fields a search actually
// reads, and keep that: ~770KB for 689 materials and 413 workflows.
//
// Nothing here touches the filesystem or the network directly. `buildGtnIndex` takes the
// fetcher, so the desktop shell can cache to disk, the MCP server to its own store, and a
// browser worker not at all, without this module knowing which it is.

import { GTN_API, GTN_BASE } from "./gtn.js";

/**
 * Bumped when the projection changes shape. A cache written by an older version is rebuilt
 * rather than read, so a stale entry cannot feed fields the search no longer understands.
 */
export const GTN_INDEX_VERSION = 2;

/** Query words that carry no signal; dropped before scoring so they cannot pad a match. */
const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "can",
  "do",
  "does",
  "for",
  "from",
  "how",
  "i",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "that",
  "the",
  "to",
  "use",
  "using",
  "was",
  "what",
  "when",
  "where",
  "which",
  "with",
  "my",
]);

/**
 * Field weights. Title leads because a GTN title is written to say what the tutorial is;
 * tools weigh least because a long tool list would otherwise outrank a direct title hit.
 */
const WEIGHTS = {
  title: 8,
  id: 3,
  tags: 4,
  objectives: 2,
  questions: 2,
  topic: 2,
  tools: 1,
  workflows: 3,
};

/** @param {unknown} value @returns {value is Record<string, any>} */
const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

/** @param {unknown} value @returns {string[]} */
const strings = (value) =>
  Array.isArray(value) ? value.filter((v) => typeof v === "string" && v.trim()) : [];

/** A GTN url as the API gives it -- relative to the site root -- made absolute. @param {unknown} url */
function absolute(url) {
  if (typeof url !== "string" || !url) return "";
  return url.startsWith("/") ? `${GTN_BASE}${url}` : url;
}

/** @param {string} text @returns {string[]} */
export function gtnTokens(text) {
  return text
    .toLowerCase()
    .split(/[^a-z0-9+.#-]+/)
    .map((t) => t.replace(/^[-.]+|[-.]+$/g, ""))
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

/** The server entries of one `supported_servers` bucket, as bare urls. @param {unknown} bucket */
function serverUrls(bucket) {
  if (!Array.isArray(bucket)) return [];
  return bucket
    .map((s) => (isRecord(s) ? s.url : s))
    .filter((u) => typeof u === "string" && u)
    .map((u) => String(u).replace(/\/+$/, ""));
}

/**
 * One material's workflows, keeping only what a caller can act on: where the `.ga` is, the TRS
 * endpoint that serves its descriptor, and whether it is covered by tests.
 * @param {unknown} value @param {string} materialTitle
 */
/**
 * Normalize a material's `requirements`. Only `internal` entries name another GTN material and
 * can be walked; `none` and `external` are human-readable preconditions ("access to the SURF
 * Research Cloud") that must be reported as text and never followed. An `internal` entry with no
 * `tutorials` list names a whole topic -- 14 of them do -- and is kept as a topic-level
 * requirement rather than expanded into every tutorial that topic happens to contain.
 *
 * @param {unknown} value
 * @returns {{ type: string; topic_name?: string; tutorials?: string[]; title?: string; link?: string }[]}
 */
function projectRequirements(value) {
  if (!Array.isArray(value)) return [];
  /** @type {any[]} */
  const out = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const type = typeof entry.type === "string" ? entry.type : "none";
    if (type === "internal") {
      const topicName = typeof entry.topic_name === "string" ? entry.topic_name : "";
      if (!topicName) continue;
      const tutorials = strings(entry.tutorials);
      out.push(
        tutorials.length
          ? { type, topic_name: topicName, tutorials }
          : { type, topic_name: topicName },
      );
    } else {
      out.push({
        type,
        ...(typeof entry.title === "string" ? { title: entry.title } : {}),
        ...(typeof entry.link === "string" ? { link: entry.link } : {}),
      });
    }
  }
  return out;
}

function projectWorkflows(value, materialTitle) {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).map((w) => ({
    name: typeof w.wfname === "string" ? w.wfname : (w.workflow ?? null),
    title: typeof w.title === "string" && w.title ? w.title : materialTitle,
    ga: absolute(w.url),
    html: absolute(w.url_html),
    trs: typeof w.trs_endpoint === "string" ? w.trs_endpoint : null,
    wfid: typeof w.wfid === "string" ? w.wfid : null,
    tests: w.tests === true,
    license: w.license ?? null,
  }));
}

/**
 * Project one material -- a tutorial, slide deck or FAQ -- to its index entry.
 *
 * The projection is the whole point: a topic payload runs to megabytes because it carries
 * rendered bodies and contributor records, and none of that is searched.
 * @param {unknown} material @param {{ id: string; title: string | null }} topic
 */
export function gtnProjectMaterial(material, topic) {
  if (!isRecord(material)) return undefined;
  const title = typeof material.title === "string" ? material.title : "";
  if (!title) return undefined;
  const servers = isRecord(material.supported_servers) ? material.supported_servers : {};
  return {
    id: typeof material.id === "string" ? material.id : `${topic.id}/${material.tutorial_name}`,
    short_id: material.short_id ?? null,
    title,
    topic_id: topic.id,
    topic: topic.title,
    type: material.type ?? null,
    url: absolute(material.url),
    level: material.level ?? null,
    time_estimation: material.time_estimation ?? null,
    mod_date: material.mod_date ?? null,
    tags: strings(material.tags),
    objectives: strings(material.objectives),
    questions: strings(material.questions),
    tools: strings(material.tools),
    servers: { exact: serverUrls(servers.exact), inexact: serverUrls(servers.inexact) },
    workflows: projectWorkflows(material.workflows, title),
    zenodo_link: typeof material.zenodo_link === "string" ? material.zenodo_link : null,
    key_points: strings(material.key_points),
    requirements: projectRequirements(material.requirements),
    /** Other topics that cross-list this material; filled in by `dedupe`. */
    also_in: /** @type {string[]} */ ([]),
  };
}

/**
 * Every material of one topic payload, projected.
 * @param {unknown} payload @param {string} topicId
 */
export function gtnProjectTopic(payload, topicId) {
  if (!isRecord(payload)) return undefined;
  const topic = {
    id: topicId,
    title: typeof payload.title === "string" ? payload.title : topicId,
  };
  const materials = Array.isArray(payload.materials) ? payload.materials : [];
  return materials
    .map((m) => gtnProjectMaterial(m, topic))
    .filter(/** @returns {m is NonNullable<typeof m>} */ (m) => m !== undefined);
}

/**
 * Collapse cross-listed materials.
 *
 * GTN lists one tutorial under every topic it is relevant to -- 55 of 689 appear more than once,
 * so a search for "chloroplast assembly" would otherwise return the same tutorial twice and look
 * broken. The material's own id names its home topic (`assembly/chloroplast-assembly`), so that
 * occurrence wins and the rest become `also_in`, which the topic filter still honours.
 * @param {any[]} materials
 */
function dedupe(materials) {
  /** @type {Map<string, any>} */
  const byId = new Map();
  for (const m of materials) {
    const home = String(m.id).split("/")[0];
    const seen = byId.get(m.id);
    if (!seen) {
      byId.set(m.id, m);
      continue;
    }
    // Keep whichever copy sits in the material's home topic.
    const winner = seen.topic_id === home ? seen : m.topic_id === home ? m : seen;
    const loser = winner === seen ? m : seen;
    for (const t of [loser.topic_id, ...loser.also_in]) {
      if (t !== winner.topic_id && !winner.also_in.includes(t)) winner.also_in.push(t);
    }
    byId.set(m.id, winner);
  }
  return [...byId.values()];
}

/**
 * Build the index, reading every topic through the caller's fetcher.
 *
 * One topic failing does not fail the build: GTN is a live site and a single bad payload should
 * cost that topic's tutorials, not the whole search. The failures come back with the index so a
 * caller can say the result is partial rather than quietly serving a hole.
 *
 * @param {{
 *   fetchJson: (url: string) => Promise<unknown>,
 *   onProgress?: (done: number, total: number) => void,
 *   signal?: { aborted: boolean },
 * }} io
 */
export async function buildGtnIndex({ fetchJson, onProgress, signal }) {
  const payload = await fetchJson(`${GTN_API}/topics.json`);
  if (!isRecord(payload)) throw new Error("GTN returned an unexpected topics payload");

  const topicIds = Object.keys(payload).sort();
  /** @type {any[]} */
  const materials = [];
  /** @type {{ topic: string; error: string }[]} */
  const failures = [];

  for (const [i, id] of topicIds.entries()) {
    if (signal?.aborted) throw new Error("GTN index build aborted");
    try {
      const projected = gtnProjectTopic(await fetchJson(`${GTN_API}/topics/${id}.json`), id);
      if (projected) materials.push(...projected);
      else failures.push({ topic: id, error: "unexpected topic payload" });
    } catch (error) {
      failures.push({ topic: id, error: error instanceof Error ? error.message : String(error) });
    }
    onProgress?.(i + 1, topicIds.length);
  }

  return {
    version: GTN_INDEX_VERSION,
    built_at: new Date().toISOString(),
    topics: topicIds.map((id) => ({
      id,
      title:
        isRecord(payload[id]) && typeof payload[id].title === "string" ? payload[id].title : id,
    })),
    materials: dedupe(materials),
    failures,
  };
}

/**
 * Score one material against the query tokens.
 *
 * A token matched on a word boundary scores its field's full weight and a token matched inside a
 * longer word scores a fraction of it, so that `rna` still finds `rna-seq` without letting a
 * substring hit outrank a real one. A token found in several fields takes its best field plus a
 * quarter of the rest: breadth should count for something, but not enough for a tutorial that
 * merely lists a tool to climb over one with the word in its title. Materials missing a token
 * entirely score 0 and drop out: the
 * query is read as AND, because a GTN search that returns everything loosely related is the same
 * as no search. `requireAll` relaxes that for the second pass described in `rank`.
 * @param {any} material @param {string[]} tokens @param {string} phrase @param {number} needed
 */
function scoreMaterial(material, tokens, phrase, needed) {
  /** @type {[string, string, number][]} */
  const fields = [
    ["title", material.title, WEIGHTS.title],
    ["id", material.id, WEIGHTS.id],
    ["topic", material.topic ?? "", WEIGHTS.topic],
    ["tags", material.tags.join(" "), WEIGHTS.tags],
    ["objectives", material.objectives.join(" "), WEIGHTS.objectives],
    ["questions", material.questions.join(" "), WEIGHTS.questions],
    ["tools", material.tools.join(" "), WEIGHTS.tools],
    [
      "workflows",
      material.workflows.map((/** @type {any} */ w) => w.name ?? "").join(" "),
      WEIGHTS.workflows,
    ],
  ];
  const lowered = fields.map(
    /** @returns {[string, number]} */ ([, text, weight]) => [String(text).toLowerCase(), weight],
  );

  let score = 0;
  let matched = 0;
  for (const token of tokens) {
    let best = 0;
    let total = 0;
    for (const [text, weight] of lowered) {
      const at = text.indexOf(token);
      if (at < 0) continue;
      const before = at === 0 ? "" : text[at - 1];
      const after = text[at + token.length] ?? "";
      const whole = !/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after);
      const hit = whole ? weight : weight * 0.4;
      total += hit;
      best = Math.max(best, hit);
    }
    if (best > 0) matched += 1;
    score += best + (total - best) * 0.25;
  }
  if (matched < needed) return 0;
  // A material whose title reads as the query itself is what the caller meant.
  if (phrase && String(material.title).toLowerCase().includes(phrase)) score += 10;
  return score;
}

/**
 * Rank materials against a query, strictly first and then loosely.
 *
 * Requiring every token is right when it finds something and useless when it does not: a caller
 * who asks for "variant calling bacteria" and gets nothing because the tutorial says "bacterial"
 * is worse off than one who gets the near misses labelled as near misses. So a strict pass runs
 * first, and only an empty result falls back -- with `relaxed` set, so the caller can say so.
 *
 * The fallback still asks for most of the query, not any of it. A question phrased as a sentence
 * ("identify transmission clusters from bacterial SNPs") has five content words that no single
 * tutorial carries, and matching on any one of them would return a third of GTN with the right
 * answer merely sorted to the top. Half the words, rounded up, keeps the count meaningful.
 * @param {any[]} materials @param {string[]} tokens @param {string} phrase
 */
function rank(materials, tokens, phrase, floor) {
  const pass = (/** @type {number} */ needed) =>
    materials
      .map((m) => ({ m, score: scoreMaterial(m, tokens, phrase, needed) }))
      .filter((h) => h.score > 0)
      .sort((a, b) => b.score - a.score || String(a.m.title).localeCompare(String(b.m.title)));

  // `floor` is the loose pass: match any one token and let the score order the result. Only the
  // learning-path resolver asks for it, and only after the normal passes found nothing.
  if (floor !== undefined) return { hits: pass(floor), relaxed: true };

  const strict = pass(tokens.length);
  if (strict.length > 0 || tokens.length < 2) return { hits: strict, relaxed: false };
  return { hits: pass(Math.ceil(tokens.length / 2)), relaxed: true };
}

/** @param {any} index @param {{ topic?: string, tool?: string, server?: string }} filters */
function applyFilters(index, filters) {
  let materials = index.materials;
  if (filters.topic) {
    const topic = filters.topic.toLowerCase();
    materials = materials.filter(
      (/** @type {any} */ m) =>
        m.topic_id.toLowerCase() === topic ||
        String(m.topic ?? "").toLowerCase() === topic ||
        m.also_in.some((/** @type {string} */ t) => t.toLowerCase() === topic),
    );
  }
  if (filters.tool) {
    const tool = filters.tool.toLowerCase();
    materials = materials.filter((/** @type {any} */ m) =>
      m.tools.some((/** @type {string} */ t) => t.toLowerCase().includes(tool)),
    );
  }
  if (filters.server) {
    const server = filters.server.toLowerCase().replace(/\/+$/, "");
    materials = materials.filter((/** @type {any} */ m) =>
      [...m.servers.exact, ...m.servers.inexact].some((/** @type {string} */ s) =>
        s.toLowerCase().includes(server),
      ),
    );
  }
  return materials;
}

/**
 * Find tutorials. Ranked when a query is given, alphabetical when it is only filters, so that
 * `topic: "assembly"` reads as a listing rather than an arbitrary order.
 *
 * @param {any} index
 * @param {{ query?: string, topic?: string, tool?: string, server?: string,
 *           has_workflow?: boolean, limit?: number }} [opts]
 */
export function gtnFindTutorials(index, opts = {}) {
  const limit = Math.min(Math.max(opts.limit ?? 10, 1), 50);
  let materials = applyFilters(index, opts);
  if (opts.has_workflow) {
    materials = materials.filter((/** @type {any} */ m) => m.workflows.length > 0);
  }

  const phrase = (opts.query ?? "").trim().toLowerCase();
  const tokens = gtnTokens(opts.query ?? "");
  /** @type {any[]} */
  let hits;
  let relaxed = false;
  if (tokens.length === 0) {
    hits = [...materials].sort((a, b) => String(a.title).localeCompare(String(b.title)));
  } else {
    const ranked = rank(materials, tokens, phrase, opts.loose ? 1 : undefined);
    hits = ranked.hits.map((h) => h.m);
    relaxed = ranked.relaxed;
  }

  // Resolved for the top hit only: one walk is cheap, and it is the hit the answer gets built on.
  const topStart = hits.length ? startHereFor(index, hits[0]) : undefined;

  return {
    count: hits.length,
    ...(opts.query ? { query: opts.query } : {}),
    ...(relaxed ? { relaxed: true } : {}),
    returned: Math.min(hits.length, limit),
    tutorials: hits.slice(0, limit).map((m) => ({
      id: m.id,
      title: m.title,
      topic: m.topic,
      topic_id: m.topic_id,
      type: m.type,
      url: m.url,
      level: m.level,
      time_estimation: m.time_estimation,
      tags: m.tags,
      objectives: m.objectives.slice(0, 3),
      workflow_count: m.workflows.length,
      // A GTN workflow carrying tests is a real quality signal, and the difference is not
      // cosmetic: the TB transmission tutorial ships three workflows, none of them tested,
      // while its own prerequisite ships two that are. Reporting only a count invites the
      // model to describe the first as "tested, pre-configured workflows".
      tested_workflow_count: m.workflows.filter((/** @type {any} */ w) => w.tests).length,
      prerequisite_count: (m.requirements ?? []).filter(
        (/** @type {any} */ r) => r.type === "internal" && Array.isArray(r.tutorials),
      ).length,
      servers: m.servers.exact,
    })),
    // The top hit's entry point, inline. A separate lookup the model has to think to call is a
    // lookup it will skip -- it just matched a tutorial, so as far as it knows the question is
    // answered. Putting the chain in the result it already has is what makes it unavoidable.
    ...(topStart ? { start_here: topStart } : {}),
    hint:
      hits.length === 0
        ? "No match. Try fewer or broader words, or call with no query and a topic to browse."
        : topStart
          ? "The top hit has prerequisites: start_here is where this user begins. gtn_learning_path gives the full ordered chain."
          : "Use gtn_fetch with a tutorial URL to read it, or gtn_find_workflow to get its workflow.",
  };
}

/**
 * Find workflows attached to GTN tutorials.
 *
 * These are teaching workflows, which is not the same thing as the production workflows the IWC
 * tools search: a GTN workflow comes with the tutorial that explains it, and `tests: true` marks
 * the ones GTN runs in CI.
 *
 * @param {any} index
 * @param {{ query?: string, topic?: string, tool?: string, server?: string,
 *           tests_only?: boolean, limit?: number }} [opts]
 */
export function gtnFindWorkflows(index, opts = {}) {
  const limit = Math.min(Math.max(opts.limit ?? 10, 1), 50);
  const materials = applyFilters(index, opts).filter(
    (/** @type {any} */ m) => m.workflows.length > 0,
  );

  const phrase = (opts.query ?? "").trim().toLowerCase();
  const tokens = gtnTokens(opts.query ?? "");
  const scored =
    tokens.length === 0
      ? { hits: materials.map((/** @type {any} */ m) => ({ m, score: 1 })), relaxed: false }
      : rank(materials, tokens, phrase);

  /** @type {{ m: any, w: any, score: number }[]} */
  const rows = [];
  for (const { m, score } of scored.hits) {
    for (const w of m.workflows) {
      if (opts.tests_only && !w.tests) continue;
      rows.push({ m, w, score });
    }
  }
  rows.sort(
    (a, b) => b.score - a.score || String(a.w.name ?? "").localeCompare(String(b.w.name ?? "")),
  );

  return {
    count: rows.length,
    ...(opts.query ? { query: opts.query } : {}),
    ...(scored.relaxed ? { relaxed: true } : {}),
    returned: Math.min(rows.length, limit),
    workflows: rows.slice(0, limit).map(({ m, w }) => ({
      name: w.name,
      title: w.title,
      tutorial: m.title,
      tutorial_url: m.url,
      topic: m.topic,
      topic_id: m.topic_id,
      ga_url: w.ga,
      trs_endpoint: w.trs,
      wfid: w.wfid,
      tested: w.tests,
      license: w.license,
      tools: m.tools.slice(0, 12),
      servers: m.servers.exact,
    })),
    hint:
      rows.length === 0
        ? "No GTN workflow matched. GTN workflows accompany tutorials; for production workflows search the IWC registry instead."
        : "ga_url downloads the workflow; trs_endpoint serves the same descriptor over GA4GH TRS.",
  };
}

/**
 * A Galaxy tool id reduced to the `owner/repo/tool` form GTN keys things by.
 *
 * Tool ids arrive in three shapes -- a full versioned toolshed id from a workflow step, the same
 * without a version, and a bare name like `Cut1` for a built-in -- and all three have to land on
 * the same entry.
 * @param {string} toolId
 */
export function gtnShortToolId(toolId) {
  const parts = String(toolId).split("/");
  // toolshed.g2.bx.psu.edu/repos/<owner>/<repo>/<tool>[/<version>]
  if (parts.length >= 5 && parts[1] === "repos") return parts.slice(2, 5).join("/");
  return String(toolId);
}

/**
 * Index the materials by tool, in the `owner/repo/tool` form.
 *
 * This reproduces GTN's own `top-tools.json` exactly -- checked across a sample of 14 tools and
 * all 1239 of its keys -- so there is no reason to pull that megabyte separately.
 * @param {any} index
 */
function toolMap(index) {
  /** @type {Map<string, { materials: any[], ids: Set<string> }>} */
  const byTool = new Map();
  for (const m of index.materials) {
    for (const full of m.tools) {
      const key = gtnShortToolId(full);
      let entry = byTool.get(key);
      if (!entry) {
        entry = { materials: [], ids: new Set() };
        byTool.set(key, entry);
      }
      entry.ids.add(full);
      if (!entry.materials.includes(m)) entry.materials.push(m);
    }
  }
  return byTool;
}

/**
 * Tool ids in the index that a loose name could mean, most-used first.
 *
 * A caller rarely has the exact id: they have "fastqc", or a versioned id copied off a workflow
 * step. Both resolve here, and an ambiguous name comes back as a list to choose from rather than
 * a guess.
 * @param {any} index @param {string} tool
 */
export function gtnResolveTool(index, tool) {
  const byTool = toolMap(index);
  const exact = gtnShortToolId(tool);
  if (byTool.has(exact)) return { match: exact, candidates: [exact], entry: byTool.get(exact) };

  const needle = String(tool).toLowerCase();
  const candidates = [...byTool.keys()]
    .filter((k) => k.toLowerCase().includes(needle))
    .sort((a, b) => byTool.get(b).materials.length - byTool.get(a).materials.length);
  if (candidates.length === 1) {
    return { match: candidates[0], candidates, entry: byTool.get(candidates[0]) };
  }
  return { match: undefined, candidates, entry: undefined };
}

/**
 * Which GTN tutorials use a given Galaxy tool.
 *
 * The question a failing step raises -- "what does a working use of this tool look like?" -- and
 * answerable from the index alone.
 * @param {any} index @param {{ tool: string, limit?: number }} opts
 */
export function gtnTutorialsForTool(index, opts) {
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 50);
  const resolved = gtnResolveTool(index, opts.tool);

  if (!resolved.entry) {
    return {
      tool: opts.tool,
      count: 0,
      tutorials: [],
      candidates: resolved.candidates.slice(0, 20),
      hint: resolved.candidates.length
        ? "That name matches several tools. Call again with one of `candidates`."
        : "No GTN tutorial uses a tool by that name. Check the id, or search with gtn_find_tutorial.",
    };
  }

  const materials = [...resolved.entry.materials].sort((a, b) =>
    String(a.title).localeCompare(String(b.title)),
  );
  return {
    tool: resolved.match,
    tool_ids: [...resolved.entry.ids].sort(),
    count: materials.length,
    returned: Math.min(materials.length, limit),
    tutorials: materials.slice(0, limit).map((m) => ({
      id: m.id,
      title: m.title,
      topic: m.topic,
      url: m.url,
      level: m.level,
      workflow_count: m.workflows.length,
    })),
    hint: "Use gtn_fetch with a tutorial URL to see how the tool is used in context.",
  };
}

/** Steps of a `.ga` document in their numeric order. @param {any} ga */
function orderedSteps(ga) {
  const steps = ga && typeof ga === "object" ? (ga.steps ?? {}) : {};
  return Object.keys(steps)
    .sort((a, b) => Number(a) - Number(b))
    .map((k) => ({ key: k, step: steps[k] }))
    .filter((s) => s.step && typeof s.step === "object");
}

/**
 * Reduce a `.ga` workflow to something a model can read.
 *
 * A GTN workflow runs to tens of kilobytes, nearly all of it serialised tool state and canvas
 * positions. What is worth reading is the shape: what goes in, which tools run in what order,
 * what comes out. The `.ga` itself stays one fetch away for anyone who needs to import it.
 * @param {unknown} ga
 */
export function gtnWorkflowSummary(ga) {
  if (!isRecord(ga)) return undefined;
  const steps = orderedSteps(ga);
  /** @type {string[]} */
  const tools = [];
  /** @type {any[]} */
  const inputs = [];
  /** @type {any[]} */
  const outputs = [];

  const described = steps.map(({ key, step }) => {
    const toolId = typeof step.tool_id === "string" ? step.tool_id : null;
    if (toolId && !tools.includes(toolId)) tools.push(toolId);
    const type = step.type ?? null;
    if (typeof type === "string" && type.endsWith("input")) {
      inputs.push({
        step: Number(key),
        type,
        label: step.label ?? null,
        annotation: step.annotation || null,
      });
    }
    for (const out of Array.isArray(step.workflow_outputs) ? step.workflow_outputs : []) {
      if (isRecord(out)) {
        outputs.push({
          step: Number(key),
          output_name: out.output_name ?? null,
          label: out.label ?? null,
        });
      }
    }
    return {
      step: Number(key),
      type,
      name: step.name ?? null,
      label: step.label ?? null,
      tool_id: toolId,
      tool_version: step.tool_version ?? null,
      annotation: step.annotation || null,
    };
  });

  return {
    name: ga.name ?? null,
    annotation: ga.annotation || null,
    tags: strings(ga.tags),
    version: ga.version ?? null,
    license: ga.license ?? null,
    step_count: described.length,
    inputs,
    outputs,
    tools,
    steps: described,
  };
}

/**
 * The index's record of one workflow, found by its GTN ids.
 *
 * Callers come back with ids they read off a `gtn_find_workflow` result, so the lookup answers
 * from the index rather than rebuilding a url -- a constructed url is a url that can 404.
 * @param {any} index @param {{ wfid?: string, name?: string, url?: string }} ref
 */
export function gtnLookupWorkflow(index, ref) {
  /** @type {{ material: any, workflow: any }[]} */
  const all = [];
  for (const m of index.materials) {
    for (const w of m.workflows) all.push({ material: m, workflow: w });
  }
  let hits = all;
  if (ref.url) hits = hits.filter((h) => h.workflow.ga === ref.url);
  if (ref.wfid) hits = hits.filter((h) => h.workflow.wfid === ref.wfid);
  if (ref.name) {
    const name = ref.name.toLowerCase().replace(/\.ga$/, "");
    hits = hits.filter((h) => String(h.workflow.name ?? "").toLowerCase() === name);
  }
  return hits;
}

/** The `psl/<tool>.json` url for one unversioned toolshed id. @param {string} toolId */
export function gtnToolServersUrl(toolId) {
  return `${GTN_API}/psl/${encodeURIComponent(toolId)}.json`;
}

/**
 * Which public Galaxy servers install a tool, from a `psl/<tool>.json` payload.
 *
 * GTN answers per version, which is the honest shape -- a server having "the tool" is not the
 * same as having the version a workflow pins -- so the versions are kept and a union added for
 * the common case of just wanting somewhere to run it.
 * @param {unknown} payload
 */
export function gtnParseToolServers(payload) {
  if (!isRecord(payload)) return undefined;
  /** @type {Map<string, { url: string, name: string | null, usegalaxy: boolean }>} */
  const union = new Map();
  const versions = Object.entries(payload)
    .map(([version, list]) => {
      const servers = (Array.isArray(list) ? list : []).filter(isRecord).map((s) => {
        const entry = {
          url: String(s.url ?? "").replace(/\/+$/, ""),
          name: s.name ?? null,
          usegalaxy: s.usegalaxy === true,
        };
        if (entry.url && !union.has(entry.url)) union.set(entry.url, entry);
        return entry;
      });
      return { version, server_count: servers.length, servers };
    })
    .sort((a, b) => b.server_count - a.server_count || b.version.localeCompare(a.version));

  return { versions, any_version: [...union.values()] };
}

/**
 * Read one GTN workflow: locate it in the index, fetch its `.ga`, summarise it.
 *
 * The fetch is injected, and the url is re-checked against the GTN host before it is used even
 * though it came out of the index -- a cache file on disk is not a trusted input, and this is
 * the one place in the GTN tools that turns stored data into a network call.
 *
 * Returns a discriminated result rather than throwing, so each shell can render "ambiguous" and
 * "not found" in its own way without unpicking an exception.
 *
 * @param {any} index
 * @param {{ wfid?: string, name?: string, url?: string, full?: boolean }} ref
 * @param {{ fetchJson: (url: string) => Promise<unknown>, checkUrl?: (url: string) => { problem?: string } }} io
 */
export async function gtnGetWorkflow(index, ref, io) {
  if (!ref.wfid && !ref.name && !ref.url) {
    return { ok: /** @type {false} */ (false), reason: "no-ref" };
  }
  const hits = gtnLookupWorkflow(index, ref);
  if (hits.length === 0) return { ok: /** @type {false} */ (false), reason: "not-found" };
  if (hits.length > 1) {
    return {
      ok: /** @type {false} */ (false),
      reason: /** @type {"ambiguous"} */ ("ambiguous"),
      choices: hits.map((h) => ({
        wfid: h.workflow.wfid,
        name: h.workflow.name,
        tutorial: h.material.title,
      })),
    };
  }

  const { material, workflow } = hits[0];
  const checked = io.checkUrl?.(workflow.ga);
  if (checked?.problem) {
    return { ok: /** @type {false} */ (false), reason: "bad-url", problem: checked.problem };
  }

  const ga = await io.fetchJson(workflow.ga);
  const summary = gtnWorkflowSummary(ga);
  if (!summary) return { ok: /** @type {false} */ (false), reason: "not-a-workflow" };

  return {
    ok: /** @type {true} */ (true),
    workflow: {
      wfid: workflow.wfid,
      workflow_name: workflow.name,
      tutorial: material.title,
      tutorial_url: material.url,
      topic: material.topic,
      ga_url: workflow.ga,
      trs_endpoint: workflow.trs,
      tested: workflow.tests,
      license: workflow.license ?? summary.license,
      ...(ref.full ? { workflow: ga } : summary),
      hint: "Galaxy has no import-from-GTN tool; ga_url is what a user imports by hand.",
    },
    steps: summary.step_count,
  };
}

/**
 * Which public Galaxy servers install a tool.
 *
 * `psl` keys its listing by the full unversioned toolshed id, while the index knows tools by
 * their short form, so the full id is recovered from the versioned ids the tutorials recorded.
 * A tool with no toolshed id at all -- a Galaxy built-in like `Cut1` -- is not in the listing,
 * and says so rather than fetching a url that cannot exist.
 *
 * @param {any} index @param {string} tool
 * @param {{ fetchJson: (url: string) => Promise<unknown> }} io
 */
export async function gtnServersForTool(index, tool, io) {
  const resolved = gtnResolveTool(index, tool);
  if (!resolved.entry) {
    return {
      ok: /** @type {false} */ (false),
      reason: /** @type {"unresolved"} */ ("unresolved"),
      candidates: resolved.candidates.slice(0, 20),
    };
  }

  const fullId = [...resolved.entry.ids]
    .map((id) => id.split("/").slice(0, 5).join("/"))
    .find((id) => id.includes("/repos/"));
  if (!fullId) {
    return { ok: /** @type {false} */ (false), reason: "built-in", tool: resolved.match };
  }

  const parsed = gtnParseToolServers(await io.fetchJson(gtnToolServersUrl(fullId)));
  if (!parsed) return { ok: /** @type {false} */ (false), reason: "bad-payload", tool: fullId };
  return { ok: /** @type {true} */ (true), tool: fullId, ...parsed };
}

// ---------------------------------------------------------------------------
// Prerequisite graph
//
// A GTN material declares the materials it assumes you have already done, in
// `requirements`. That edge is hand-curated by people who teach this stuff, and it is the one
// thing about GTN a model cannot reconstruct from the prose -- so a search that only ranks
// materials will hand someone the middle of a chain and call it an answer. "Transmission
// clusters" is a near-exact title match for `evolution/mtb_transmission`, while its prerequisite
// `variant-analysis/tb-variant-analysis` is a strictly worse lexical match and always will be.
// No amount of ranking surfaces it. Walking the graph does.
//
// Identity here is the material id, which the GTN sets to `<topic_name>/<tutorial_name>`; that
// was checked against all 689 raw materials, with no exceptions. Titles are neither unique nor
// stable, and a bare tutorial_name is not unique across topics, so neither is used as a key.

/** `1H`, `1h`, `30m`, `1H30M`, `0H30M` -- GTN writes all of these. One pass, case-insensitive. */
const DURATION_RE = /^\s*(?:(\d+)\s*[dD])?\s*(?:(\d+)\s*[hH])?\s*(?:(\d+)\s*[mM])?\s*$/;

/**
 * Minutes in a GTN `time_estimation`, or undefined if it is absent or unparseable.
 * @param {unknown} text
 * @returns {number | undefined}
 */
export function gtnParseDuration(text) {
  if (typeof text !== "string") return undefined;
  const m = DURATION_RE.exec(text);
  if (!m || (m[1] === undefined && m[2] === undefined && m[3] === undefined)) return undefined;
  return Number(m[1] ?? 0) * 1440 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
}

/**
 * Render minutes the way the GTN writes them, so a total reads like the parts it came from.
 * @param {number} minutes
 * @returns {string}
 */
export function gtnFormatDuration(minutes) {
  if (!Number.isFinite(minutes) || minutes <= 0) return "0m";
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  if (!h) return `${m}m`;
  return m ? `${h}h${m}m` : `${h}h`;
}

/** @type {WeakMap<object, Map<string, any>>} */
const materialIdCache = new WeakMap();

/**
 * Materials keyed by id. Memoized per index object: a learning-path call touches the map once
 * per edge, and rebuilding it for each would make a deep chain quadratic for no reason.
 * @param {any} index
 * @returns {Map<string, any>}
 */
function materialsById(index) {
  const cached = materialIdCache.get(index);
  if (cached) return cached;
  /** @type {Map<string, any>} */
  const map = new Map();
  for (const m of index.materials ?? []) map.set(String(m.id), m);
  materialIdCache.set(index, map);
  return map;
}

/** Internal requirement entries that actually name one or more tutorials. */
function internalEdges(material) {
  return (material?.requirements ?? []).filter(
    (/** @type {any} */ r) => r.type === "internal" && Array.isArray(r.tutorials),
  );
}

/**
 * The human-readable form of a requirement that cannot be walked: a `none`/`external`
 * precondition, or an `internal` entry that names a topic rather than a tutorial.
 */
function requirementText(index, entry) {
  if (entry.type === "internal") {
    const topic = (index.topics ?? []).find((/** @type {any} */ t) => t.id === entry.topic_name);
    return `familiarity with the ${topic ? `"${topic.title}"` : `"${entry.topic_name}"`} topic`;
  }
  const title = entry.title ?? "an unnamed precondition";
  return entry.link ? `${title} (${entry.link})` : String(title);
}

/** The slice of a material that a path entry shows. */
function pathEntry(material, isRoot) {
  const tested = material.workflows.filter((/** @type {any} */ w) => w.tests).length;
  return {
    id: material.id,
    topic_id: material.topic_id,
    topic: material.topic,
    title: material.title,
    url: material.url,
    level: material.level,
    time_estimation: material.time_estimation,
    zenodo_link: material.zenodo_link,
    workflows: material.workflows.length,
    tested_workflows: tested,
    root: isRoot,
  };
}

/**
 * Walk a material's prerequisites depth-first and return them in the order they should be done.
 *
 * Guards, each of which is a thing the live GTN actually does:
 *   - 2 tutorials list themselves as their own prerequisite, so a naive walk never terminates.
 *     The stack check drops the self-edge and the visited set keeps the rest of the graph linear.
 *   - 14 internal entries name a topic with no tutorial list. Those are reported as text, not
 *     expanded into every tutorial in that topic.
 *   - every one of the internal edges resolves today. If one ever stops resolving that is a GTN
 *     bug and worth seeing, so it is reported in `unresolved` rather than skipped silently.
 *
 * @param {any} index
 * @param {string} goalId
 */
function walkRequirements(index, goalId) {
  const byId = materialsById(index);
  /** @type {Set<string>} */
  const visited = new Set();
  /** @type {any[]} */
  const order = [];
  /** @type {string[]} */
  const alsoAssumed = [];
  /** @type {{ from: string; missing: string }[]} */
  const unresolved = [];

  /**
   * @param {string} id
   * @param {Set<string>} stack
   */
  const visit = (id, stack) => {
    if (visited.has(id) || stack.has(id)) return;
    const material = byId.get(id);
    if (!material) return;
    const nested = new Set(stack).add(id);
    for (const entry of material.requirements ?? []) {
      if (entry.type !== "internal" || !Array.isArray(entry.tutorials)) {
        const text = requirementText(index, entry);
        if (!alsoAssumed.includes(text)) alsoAssumed.push(text);
        continue;
      }
      for (const tutorial of entry.tutorials) {
        const target = `${entry.topic_name}/${tutorial}`;
        if (target === id) continue;
        if (!byId.has(target)) {
          unresolved.push({ from: id, missing: target });
          continue;
        }
        visit(target, nested);
      }
    }
    visited.add(id);
    order.push(material);
  };

  visit(goalId, new Set());
  return { order, alsoAssumed, unresolved };
}

/**
 * Materials that declare this one as a prerequisite -- the same graph read backwards, which is
 * what "what do I do after this?" asks for.
 * @param {any} index
 * @param {string} id
 */
function nextSteps(index, id) {
  const [topicName, tutorialName] = String(id).split("/");
  /** @type {any[]} */
  const out = [];
  for (const m of index.materials ?? []) {
    if (m.id === id) continue;
    const wants = internalEdges(m).some(
      (/** @type {any} */ r) => r.topic_name === topicName && r.tutorials.includes(tutorialName),
    );
    if (wants)
      out.push({ id: m.id, title: m.title, url: m.url, time_estimation: m.time_estimation });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Resolve a material and the ordered chain of GTN tutorials that leads to it.
 *
 * Takes `id` (`"<topic>/<tutorial>"`), or `topic` + `tutorial`, or a `query` that is resolved
 * through the ordinary tutorial search and reports which material it landed on.
 *
 * @param {any} index
 * @param {{ id?: string; topic?: string; tutorial?: string; query?: string }} opts
 */
export function gtnLearningPath(index, opts = {}) {
  const byId = materialsById(index);

  /** @type {string | undefined} */
  let goalId;
  /** @type {string | undefined} */
  let matchedFrom;
  let looseMatch = false;
  if (opts.id) goalId = String(opts.id).trim();
  else if (opts.topic && opts.tutorial) goalId = `${opts.topic}/${opts.tutorial}`.trim();
  else if (opts.query) {
    let found = gtnFindTutorials(index, { query: opts.query, limit: 3 });
    // "Where do I start?" arrives as prose, and the normal search wants a material to match
    // every word of it (half, on the relaxed pass). The real terms score exactly right and the
    // match is then lost to `have`, `need` and `start` -- words that do occur in GTN text, so
    // they cannot be discounted as unfamiliar either. Fall back to matching any one word and
    // let the score decide: a title carrying three rare query terms outranks a stray `start` by
    // a wide margin. Reported as `loose_match` so a weak hit is never passed off as a firm one.
    if (!found.tutorials.length) {
      const loose = gtnFindTutorials(index, { query: opts.query, limit: 3, loose: true });
      if (loose.tutorials.length) {
        found = loose;
        looseMatch = true;
      }
    }
    if (!found.tutorials.length) {
      return {
        status: "not-found",
        query: opts.query,
        hint: "No tutorial matched. Try gtn_find_tutorial with fewer, more specific words, then pass the id you want.",
      };
    }
    goalId = found.tutorials[0].id;
    matchedFrom = opts.query;
  }

  if (!goalId) {
    return {
      status: "not-found",
      hint: 'Pass id ("<topic>/<tutorial>"), or topic + tutorial, or query.',
    };
  }

  const goal = byId.get(goalId);
  if (!goal) {
    const tail = goalId.split("/").pop();
    const candidates = [...byId.keys()].filter((k) => k.endsWith(`/${tail}`)).slice(0, 5);
    return {
      status: "not-found",
      id: goalId,
      ...(candidates.length ? { candidates } : {}),
      hint: candidates.length
        ? "That id did not resolve. Did you mean one of the candidates?"
        : 'No material has that id. Ids look like "variant-analysis/tb-variant-analysis".',
    };
  }

  const { order, alsoAssumed, unresolved } = walkRequirements(index, goal.id);
  const path = order.map((m) => pathEntry(m, internalEdges(m).length === 0));
  const prerequisites = path.filter((p) => p.id !== goal.id);
  const first = prerequisites[0];

  let totalMinutes = 0;
  let timed = 0;
  for (const m of order) {
    const minutes = gtnParseDuration(m.time_estimation);
    if (minutes !== undefined) {
      totalMinutes += minutes;
      timed += 1;
    }
  }

  return {
    status: "ok",
    ...(matchedFrom ? { matched_from_query: matchedFrom } : {}),
    ...(looseMatch ? { loose_match: true } : {}),
    // Named for what it is for. A field called `prerequisites` gets summarized away; the entry
    // point is the answer to "where do I start", so it is its own required, top-level field.
    start_here: first
      ? { ...first, why: "declared prerequisite of the tutorial that matched your question" }
      : {
          ...pathEntry(goal, true),
          why: "this tutorial declares no GTN prerequisites -- it is itself the entry point",
        },
    goal: pathEntry(goal, internalEdges(goal).length === 0),
    path,
    prerequisite_count: prerequisites.length,
    also_assumed: alsoAssumed,
    total_time: timed ? gtnFormatDuration(totalMinutes) : null,
    ...(timed && timed < order.length ? { total_time_partial: true } : {}),
    caveats: goal.key_points ?? [],
    next_steps: nextSteps(index, goal.id),
    ...(unresolved.length ? { unresolved } : {}),
    hint: prerequisites.length
      ? "Do `path` in order; start_here is the entry point. Name the tools from the tutorial's own tools list rather than equivalents."
      : "No GTN prerequisites: this tutorial is an entry point.",
  };
}

/**
 * The entry point for a matched material, or undefined when it is already an entry point.
 * Deliberately small: the search result carries the first step and the count, and
 * `gtnLearningPath` carries the rest.
 *
 * @param {any} index
 * @param {any} material
 */
function startHereFor(index, material) {
  if (internalEdges(material).length === 0) return undefined;
  const resolved = gtnLearningPath(index, { id: material.id });
  if (resolved.status !== "ok" || !resolved.prerequisite_count) return undefined;
  return {
    ...resolved.start_here,
    total_time: resolved.total_time,
    steps_to_goal: resolved.path.length,
  };
}
