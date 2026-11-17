import { describe, expect, it } from "vitest";
import {
  buildGtnIndex,
  gtnFindTutorials,
  gtnFormatDuration,
  gtnLearningPath,
  gtnParseDuration,
  gtnFindWorkflows,
  gtnLookupWorkflow,
  gtnParseToolServers,
  gtnProjectTopic,
  gtnResolveTool,
  gtnShortToolId,
  gtnTokens,
  gtnToolServersUrl,
  gtnTutorialsForTool,
  gtnWorkflowSummary,
} from "../shared/gtn-index.js";

/**
 * A topic payload trimmed to the fields the projection reads. `assembly/chloroplast` is
 * deliberately cross-listed under `plants` below, the way GTN really lists it.
 */
const assembly = {
  title: "Assembly",
  materials: [
    {
      id: "assembly/chloroplast",
      title: "Chloroplast genome assembly",
      type: "tutorial",
      url: "/topics/assembly/tutorials/chloroplast/tutorial.html",
      level: "Introductory",
      time_estimation: "4h",
      tags: ["nanopore", "plants"],
      objectives: ["Assemble a chloroplast genome from long reads"],
      questions: ["How do I assemble an organelle genome?"],
      tools: ["toolshed.g2.bx.psu.edu/repos/iuc/flye/flye/2.9"],
      supported_servers: {
        exact: [{ url: "https://usegalaxy.org.au", name: "Galaxy Australia" }],
        inexact: [{ url: "https://usegalaxy.eu/", name: "Galaxy Europe" }],
      },
      workflows: [
        {
          wfname: "chloroplast-assembly",
          workflow: "chloroplast-assembly.ga",
          url: "/topics/assembly/tutorials/chloroplast/workflows/chloroplast-assembly.ga",
          url_html: "/topics/assembly/tutorials/chloroplast/workflows/chloroplast-assembly.html",
          trs_endpoint:
            "https://training.galaxyproject.org/training-material/api/ga4gh/trs/v2/tools/assembly-chloroplast/versions/chloroplast-assembly",
          wfid: "assembly-chloroplast",
          tests: true,
          license: "MIT",
        },
      ],
    },
    {
      id: "assembly/flye-guide",
      title: "Assembling with Flye",
      type: "tutorial",
      url: "/topics/assembly/tutorials/flye-guide/tutorial.html",
      objectives: ["Run a long-read assembler end to end"],
    },
    {
      id: "assembly/slides-intro",
      title: "Introduction to assembly",
      type: "slides",
      url: "/topics/assembly/slides/intro.html",
      objectives: ["Explain what an assembler does"],
    },
  ],
};

const plants = {
  title: "Plants",
  // GTN repeats the whole material under every topic that cross-lists it.
  materials: [assembly.materials[0]],
};

const topics = {
  assembly: { name: "assembly", title: "Assembly" },
  plants: { name: "plants", title: "Plants" },
};

const fetchJson = async (url: string) => {
  if (url.endsWith("/topics.json")) return topics;
  if (url.endsWith("/topics/assembly.json")) return assembly;
  if (url.endsWith("/topics/plants.json")) return plants;
  throw new Error(`unexpected url ${url}`);
};

describe("gtnTokens", () => {
  it("drops stopwords and keeps the compound terms bioinformatics names things with", () => {
    expect(gtnTokens("How do I use RNA-seq with fastp 0.23?")).toEqual([
      "rna-seq",
      "fastp",
      "0.23",
    ]);
  });
});

describe("gtnProjectTopic", () => {
  it("projects a material, absolutising urls and flattening servers", () => {
    const materials = gtnProjectTopic(assembly, "assembly")!;
    expect(materials).toHaveLength(3);
    const [chloroplast] = materials;
    expect(chloroplast.url).toBe(
      "https://training.galaxyproject.org/topics/assembly/tutorials/chloroplast/tutorial.html",
    );
    expect(chloroplast.servers).toEqual({
      exact: ["https://usegalaxy.org.au"],
      // The trailing slash GTN sometimes carries is normalised away so the filter can match.
      inexact: ["https://usegalaxy.eu"],
    });
    expect(chloroplast.workflows[0]).toMatchObject({
      name: "chloroplast-assembly",
      tests: true,
      wfid: "assembly-chloroplast",
    });
  });

  it("returns undefined for a payload that is not a topic", () => {
    expect(gtnProjectTopic("nope", "assembly")).toBeUndefined();
  });
});

describe("buildGtnIndex", () => {
  it("collapses a cross-listed material and records the other topic", async () => {
    const index = await buildGtnIndex({ fetchJson });
    const chloroplast = index.materials.filter((m) => m.id === "assembly/chloroplast");
    expect(chloroplast).toHaveLength(1);
    expect(chloroplast[0].topic_id).toBe("assembly");
    expect(chloroplast[0].also_in).toEqual(["plants"]);
    expect(index.failures).toEqual([]);
  });

  it("keeps the other topics when one fails", async () => {
    const index = await buildGtnIndex({
      fetchJson: async (url) => {
        if (url.endsWith("/topics/plants.json")) throw new Error("boom");
        return fetchJson(url);
      },
    });
    expect(index.failures).toEqual([{ topic: "plants", error: "boom" }]);
    expect(index.materials.length).toBe(3);
  });
});

describe("gtnFindTutorials", () => {
  it("ranks a title match above a tutorial that merely uses the tool", async () => {
    const index = await buildGtnIndex({ fetchJson });
    const found = gtnFindTutorials(index, { query: "flye" });
    // Both match: one in its title, one only in its tool list.
    expect(found.count).toBe(2);
    expect(found.tutorials.map((t) => t.id)).toEqual([
      "assembly/flye-guide",
      "assembly/chloroplast",
    ]);
  });

  it("requires every token, then relaxes rather than returning nothing", async () => {
    const index = await buildGtnIndex({ fetchJson });
    const strict = gtnFindTutorials(index, { query: "chloroplast nanopore" });
    expect(strict.relaxed).toBeUndefined();
    expect(strict.count).toBe(1);

    // "mitochondrial" appears nowhere, so the strict pass is empty and the relaxed one answers.
    const loose = gtnFindTutorials(index, { query: "chloroplast mitochondrial" });
    expect(loose.relaxed).toBe(true);
    expect(loose.tutorials[0].id).toBe("assembly/chloroplast");
  });

  it("finds a cross-listed material under either topic", async () => {
    const index = await buildGtnIndex({ fetchJson });
    expect(gtnFindTutorials(index, { topic: "plants" }).count).toBe(1);
    expect(gtnFindTutorials(index, { topic: "assembly" }).count).toBe(3);
  });

  it("filters on tool and server", async () => {
    const index = await buildGtnIndex({ fetchJson });
    expect(gtnFindTutorials(index, { tool: "flye" }).count).toBe(1);
    expect(gtnFindTutorials(index, { server: "usegalaxy.org.au" }).count).toBe(1);
    expect(gtnFindTutorials(index, { server: "usegalaxy.org" }).count).toBe(1);
    expect(gtnFindTutorials(index, { has_workflow: true }).count).toBe(1);
  });

  it("says so instead of guessing when nothing matches", async () => {
    const index = await buildGtnIndex({ fetchJson });
    const found = gtnFindTutorials(index, { query: "proteomics" });
    expect(found.count).toBe(0);
    expect(found.hint).toContain("No match");
  });
});

describe("gtnFindWorkflows", () => {
  it("returns the ga url and TRS endpoint for a matching tutorial", async () => {
    const index = await buildGtnIndex({ fetchJson });
    const found = gtnFindWorkflows(index, { query: "chloroplast" });
    expect(found.count).toBe(1);
    expect(found.workflows[0]).toMatchObject({
      name: "chloroplast-assembly",
      tutorial: "Chloroplast genome assembly",
      tested: true,
    });
    expect(found.workflows[0].ga_url).toContain("/chloroplast-assembly.ga");
    expect(found.workflows[0].trs_endpoint).toContain("/ga4gh/trs/v2/tools/");
  });

  it("only considers materials that have a workflow", async () => {
    const index = await buildGtnIndex({ fetchJson });
    // The slides and the Flye guide match "assembly" but carry no workflow.
    expect(gtnFindWorkflows(index, { query: "assembly" }).count).toBe(1);
  });

  it("honours tests_only", async () => {
    const index = await buildGtnIndex({ fetchJson });
    index.materials.find((m) => m.id === "assembly/chloroplast")!.workflows[0].tests = false;
    expect(gtnFindWorkflows(index, { tests_only: true }).count).toBe(0);
  });
});

describe("gtnShortToolId", () => {
  it("reduces every id shape to owner/repo/tool", () => {
    expect(gtnShortToolId("toolshed.g2.bx.psu.edu/repos/iuc/flye/flye/2.9+galaxy0")).toBe(
      "iuc/flye/flye",
    );
    expect(gtnShortToolId("toolshed.g2.bx.psu.edu/repos/iuc/flye/flye")).toBe("iuc/flye/flye");
    // Built-ins carry no owner or version and must survive untouched.
    expect(gtnShortToolId("Cut1")).toBe("Cut1");
  });
});

describe("gtnResolveTool", () => {
  it("resolves an exact id, a versioned id and an unambiguous fragment alike", async () => {
    const index = await buildGtnIndex({ fetchJson });
    expect(gtnResolveTool(index, "iuc/flye/flye").match).toBe("iuc/flye/flye");
    expect(gtnResolveTool(index, "toolshed.g2.bx.psu.edu/repos/iuc/flye/flye/2.9").match).toBe(
      "iuc/flye/flye",
    );
    expect(gtnResolveTool(index, "flye").match).toBe("iuc/flye/flye");
  });

  it("offers candidates rather than guessing when a name is ambiguous", async () => {
    const index = await buildGtnIndex({ fetchJson });
    index.materials[0].tools.push("toolshed.g2.bx.psu.edu/repos/iuc/flye_extra/flye_extra/1.0");
    const resolved = gtnResolveTool(index, "flye");
    expect(resolved.match).toBeUndefined();
    expect(resolved.candidates).toContain("iuc/flye/flye");
    expect(resolved.candidates).toContain("iuc/flye_extra/flye_extra");
  });
});

describe("gtnTutorialsForTool", () => {
  it("lists the tutorials using a tool, with the versions seen", async () => {
    const index = await buildGtnIndex({ fetchJson });
    const found = gtnTutorialsForTool(index, { tool: "flye" });
    expect(found.tool).toBe("iuc/flye/flye");
    expect(found.count).toBe(1);
    expect(found.tutorials[0].title).toBe("Chloroplast genome assembly");
    expect(found.tool_ids).toEqual(["toolshed.g2.bx.psu.edu/repos/iuc/flye/flye/2.9"]);
  });

  it("says no tutorial uses it rather than returning an empty success", async () => {
    const index = await buildGtnIndex({ fetchJson });
    const found = gtnTutorialsForTool(index, { tool: "nothing-uses-this" });
    expect(found.count).toBe(0);
    expect(found.hint).toContain("No GTN tutorial");
  });
});

describe("gtnLookupWorkflow", () => {
  it("finds a workflow by wfid, by name and by url", async () => {
    const index = await buildGtnIndex({ fetchJson });
    expect(gtnLookupWorkflow(index, { wfid: "assembly-chloroplast" })).toHaveLength(1);
    expect(gtnLookupWorkflow(index, { name: "chloroplast-assembly" })).toHaveLength(1);
    // A name given with its extension is still the same workflow.
    expect(gtnLookupWorkflow(index, { name: "chloroplast-assembly.ga" })).toHaveLength(1);
    expect(gtnLookupWorkflow(index, { wfid: "nope" })).toHaveLength(0);
  });
});

describe("gtnWorkflowSummary", () => {
  const ga = {
    name: "Chloroplast assembly",
    annotation: "Assemble and polish",
    tags: ["assembly"],
    version: 3,
    steps: {
      // Deliberately out of order: `.ga` keys are strings, so a lexical sort would put 10 second.
      "10": { type: "tool", name: "Fasta Stats", tool_id: "toolshed/x/fasta_stats/1.0" },
      "0": { type: "data_input", label: "Long reads", annotation: "FASTQ" },
      "1": {
        type: "tool",
        name: "Flye",
        tool_id: "toolshed/iuc/flye/flye/2.9",
        tool_version: "2.9",
        workflow_outputs: [{ output_name: "consensus", label: "assembly" }],
      },
    },
  };

  it("keeps the shape and drops the bulk", () => {
    const summary = gtnWorkflowSummary(ga)!;
    expect(summary.name).toBe("Chloroplast assembly");
    expect(summary.step_count).toBe(3);
    expect(summary.steps.map((s) => s.step)).toEqual([0, 1, 10]);
    expect(summary.inputs).toEqual([
      { step: 0, type: "data_input", label: "Long reads", annotation: "FASTQ" },
    ]);
    expect(summary.outputs).toEqual([{ step: 1, output_name: "consensus", label: "assembly" }]);
    expect(summary.tools).toEqual(["toolshed/iuc/flye/flye/2.9", "toolshed/x/fasta_stats/1.0"]);
  });

  it("returns undefined for something that is not a workflow", () => {
    expect(gtnWorkflowSummary("not a workflow")).toBeUndefined();
  });
});

describe("gtnParseToolServers", () => {
  it("keeps the per-version answer and adds the union", () => {
    const parsed = gtnParseToolServers({
      "0.74": [
        { url: "https://usegalaxy.org/", name: "Main", usegalaxy: true },
        { url: "https://usegalaxy.eu", name: "EU", usegalaxy: true },
      ],
      "0.62": [{ url: "https://usegalaxy.eu", name: "EU", usegalaxy: true }],
    })!;
    // Most-installed version first.
    expect(parsed.versions[0].version).toBe("0.74");
    expect(parsed.versions[0].server_count).toBe(2);
    // The trailing slash is normalised, so the union does not count one server twice.
    expect(parsed.any_version.map((s) => s.url).sort()).toEqual([
      "https://usegalaxy.eu",
      "https://usegalaxy.org",
    ]);
  });

  it("builds a psl url that escapes the id's slashes", () => {
    expect(gtnToolServersUrl("toolshed.g2.bx.psu.edu/repos/devteam/fastqc/fastqc")).toBe(
      "https://training.galaxyproject.org/training-material/api/psl/toolshed.g2.bx.psu.edu%2Frepos%2Fdevteam%2Ffastqc%2Ffastqc.json",
    );
  });
});

// ---------------------------------------------------------------------------
// Prerequisite graph
//
// The fixture mirrors the shapes the live GTN actually contains, each of which was counted
// against all 35 topics on 2026-11-17: a two-deep chain (233 materials carry requirements), an
// `internal` entry naming a topic with no tutorial list (14 of those), a tutorial that lists
// itself (2 of those), and `none` / `external` entries that must never be walked (33 and 7).

const trainingTopics = {
  basics: { name: "basics", title: "Galaxy Basics" },
  variants: { name: "variants", title: "Variant Analysis" },
  outbreak: { name: "outbreak", title: "Outbreak Investigation" },
  odd: { name: "odd", title: "Odd Corners" },
};

const basics = {
  title: "Galaxy Basics",
  materials: [
    {
      id: "basics/collections",
      title: "Working with collections",
      tutorial_name: "collections",
      topic_name: "basics",
      url: "/topics/basics/tutorials/collections/tutorial.html",
      // Intermediate, but a root: `level` says nothing about where a chain begins.
      level: "Intermediate",
      time_estimation: "30m",
      requirements: null,
    },
  ],
};

const variants = {
  title: "Variant Analysis",
  materials: [
    {
      id: "variants/calling",
      title: "Variant calling from reads",
      tutorial_name: "calling",
      topic_name: "variants",
      url: "/topics/variants/tutorials/calling/tutorial.html",
      level: "Intermediate",
      time_estimation: "2H",
      zenodo_link: "https://zenodo.org/record/3496437",
      requirements: [],
      workflows: [
        {
          wfname: "reads-to-vcf",
          url: "/w/reads-to-vcf.ga",
          wfid: "variants-calling",
          tests: true,
        },
        { wfname: "qc-first", url: "/w/qc-first.ga", wfid: "variants-calling", tests: true },
      ],
    },
  ],
};

const outbreak = {
  title: "Outbreak Investigation",
  materials: [
    {
      id: "outbreak/clusters",
      title: "Identifying transmission clusters",
      tutorial_name: "clusters",
      topic_name: "outbreak",
      url: "/topics/outbreak/tutorials/clusters/tutorial.html",
      level: "Intermediate",
      time_estimation: "2h",
      key_points: ["Clustering is very much influenced by sampling."],
      requirements: [
        { type: "internal", topic_name: "basics", tutorials: ["collections"] },
        { type: "internal", topic_name: "variants", tutorials: ["calling"] },
        { type: "none", title: "Access to the SURF Research Cloud" },
        { type: "external", title: "A primer on phylogenetics", link: "https://example.org/p" },
      ],
      workflows: [
        {
          wfname: "fastq-to-vcf",
          url: "/w/fastq-to-vcf.ga",
          wfid: "outbreak-clusters",
          tests: false,
        },
      ],
    },
    {
      id: "outbreak/phylogeny",
      title: "Building a phylogeny",
      tutorial_name: "phylogeny",
      topic_name: "outbreak",
      url: "/topics/outbreak/tutorials/phylogeny/tutorial.html",
      time_estimation: "1H",
      requirements: [{ type: "internal", topic_name: "outbreak", tutorials: ["clusters"] }],
    },
  ],
};

const odd = {
  title: "Odd Corners",
  materials: [
    {
      id: "odd/ouroboros",
      title: "A tutorial that requires itself",
      tutorial_name: "ouroboros",
      topic_name: "odd",
      url: "/topics/odd/tutorials/ouroboros/tutorial.html",
      requirements: [{ type: "internal", topic_name: "odd", tutorials: ["ouroboros"] }],
    },
    {
      id: "odd/topic-level",
      title: "Needs a whole topic",
      tutorial_name: "topic-level",
      topic_name: "odd",
      url: "/topics/odd/tutorials/topic-level/tutorial.html",
      requirements: [{ type: "internal", topic_name: "basics" }],
    },
    {
      id: "odd/dangling",
      title: "Points at a tutorial that is gone",
      tutorial_name: "dangling",
      topic_name: "odd",
      url: "/topics/odd/tutorials/dangling/tutorial.html",
      requirements: [{ type: "internal", topic_name: "basics", tutorials: ["vanished"] }],
    },
  ],
};

const trainingFetch = async (url: string) => {
  if (url.endsWith("/topics.json")) return trainingTopics;
  if (url.endsWith("/topics/basics.json")) return basics;
  if (url.endsWith("/topics/variants.json")) return variants;
  if (url.endsWith("/topics/outbreak.json")) return outbreak;
  if (url.endsWith("/topics/odd.json")) return odd;
  throw new Error(`unexpected url ${url}`);
};

const trainingIndex = () => buildGtnIndex({ fetchJson: trainingFetch });

describe("gtnParseDuration", () => {
  it("reads every spelling GTN uses, in either case", () => {
    expect(gtnParseDuration("1H")).toBe(60);
    expect(gtnParseDuration("1h")).toBe(60);
    expect(gtnParseDuration("30m")).toBe(30);
    expect(gtnParseDuration("30M")).toBe(30);
    expect(gtnParseDuration("1H30M")).toBe(90);
    expect(gtnParseDuration("0H30M")).toBe(30);
  });

  it("returns undefined rather than zero for what it cannot read", () => {
    expect(gtnParseDuration(null)).toBeUndefined();
    expect(gtnParseDuration("a while")).toBeUndefined();
    expect(gtnParseDuration("")).toBeUndefined();
  });

  it("round-trips through the format GTN writes", () => {
    expect(gtnFormatDuration(270)).toBe("4h30m");
    expect(gtnFormatDuration(120)).toBe("2h");
    expect(gtnFormatDuration(45)).toBe("45m");
  });
});

describe("gtnLearningPath", () => {
  it("orders the chain from root to goal and names where to start", async () => {
    const index = await trainingIndex();
    const path = gtnLearningPath(index, { id: "outbreak/clusters" });
    if (path.status !== "ok") throw new Error("expected a resolved path");

    expect(path.path.map((p) => p.id)).toEqual([
      "basics/collections",
      "variants/calling",
      "outbreak/clusters",
    ]);
    expect(path.start_here.id).toBe("basics/collections");
    expect(path.goal.id).toBe("outbreak/clusters");
    expect(path.prerequisite_count).toBe(2);
    // 30m + 2H + 2h, summed across the two spellings.
    expect(path.total_time).toBe("4h30m");
  });

  it("reports what a tutorial assumes but does not teach, without walking it", async () => {
    const index = await trainingIndex();
    const path = gtnLearningPath(index, { id: "outbreak/clusters" });
    if (path.status !== "ok") throw new Error("expected a resolved path");

    expect(path.also_assumed).toEqual([
      "Access to the SURF Research Cloud",
      "A primer on phylogenetics (https://example.org/p)",
    ]);
    // Neither appears as a step: they are preconditions, not tutorials.
    expect(path.path.map((p) => p.id)).not.toContain("Access to the SURF Research Cloud");
  });

  it("carries the goal's own key points through as caveats", async () => {
    const index = await trainingIndex();
    const path = gtnLearningPath(index, { id: "outbreak/clusters" });
    if (path.status !== "ok") throw new Error("expected a resolved path");
    expect(path.caveats).toEqual(["Clustering is very much influenced by sampling."]);
  });

  it("reads the requirement graph backwards for what comes next", async () => {
    const index = await trainingIndex();
    const path = gtnLearningPath(index, { id: "outbreak/clusters" });
    if (path.status !== "ok") throw new Error("expected a resolved path");
    expect(path.next_steps.map((n) => n.id)).toEqual(["outbreak/phylogeny"]);
  });

  it("marks the tested workflows apart from the untested ones along the path", async () => {
    const index = await trainingIndex();
    const path = gtnLearningPath(index, { id: "outbreak/clusters" });
    if (path.status !== "ok") throw new Error("expected a resolved path");
    const byId = Object.fromEntries(path.path.map((p) => [p.id, p]));
    expect(byId["variants/calling"]).toMatchObject({ workflows: 2, tested_workflows: 2 });
    expect(byId["outbreak/clusters"]).toMatchObject({ workflows: 1, tested_workflows: 0 });
  });

  it("terminates on a tutorial that lists itself as its own prerequisite", async () => {
    const index = await trainingIndex();
    const path = gtnLearningPath(index, { id: "odd/ouroboros" });
    if (path.status !== "ok") throw new Error("expected a resolved path");
    expect(path.path.map((p) => p.id)).toEqual(["odd/ouroboros"]);
    expect(path.prerequisite_count).toBe(0);
  });

  it("reports a topic-level requirement as text instead of expanding the topic", async () => {
    const index = await trainingIndex();
    const path = gtnLearningPath(index, { id: "odd/topic-level" });
    if (path.status !== "ok") throw new Error("expected a resolved path");
    expect(path.also_assumed).toEqual(['familiarity with the "Galaxy Basics" topic']);
    expect(path.path.map((p) => p.id)).toEqual(["odd/topic-level"]);
  });

  it("surfaces an edge that does not resolve rather than skipping it silently", async () => {
    const index = await trainingIndex();
    const path = gtnLearningPath(index, { id: "odd/dangling" });
    if (path.status !== "ok") throw new Error("expected a resolved path");
    expect(path.unresolved).toEqual([{ from: "odd/dangling", missing: "basics/vanished" }]);
  });

  it("says a root tutorial is itself the entry point", async () => {
    const index = await trainingIndex();
    const path = gtnLearningPath(index, { id: "basics/collections" });
    if (path.status !== "ok") throw new Error("expected a resolved path");
    expect(path.prerequisite_count).toBe(0);
    expect(path.start_here.id).toBe("basics/collections");
    expect(path.start_here.why).toMatch(/entry point/);
  });

  it("accepts topic + tutorial as well as an id", async () => {
    const index = await trainingIndex();
    const byPair = gtnLearningPath(index, { topic: "outbreak", tutorial: "clusters" });
    if (byPair.status !== "ok") throw new Error("expected a resolved path");
    expect(byPair.goal.id).toBe("outbreak/clusters");
  });

  it("suggests the full id when given a bare tutorial name", async () => {
    const index = await trainingIndex();
    const path = gtnLearningPath(index, { id: "clusters" });
    expect(path.status).toBe("not-found");
    if (path.status !== "not-found") throw new Error("unreachable");
    expect(path.candidates).toEqual(["outbreak/clusters"]);
  });

  it("resolves a question asked in prose, and says the match was a loose one", async () => {
    const index = await trainingIndex();
    // Every real term scores, but `have`, `need` and `start` do not -- and the ordinary search
    // requires half the words to match, so this finds nothing without the loose fallback.
    const path = gtnLearningPath(index, {
      query: "I have 48 isolates and I need transmission clusters. Where do I start?",
    });
    if (path.status !== "ok") throw new Error("expected a resolved path");
    expect(path.goal.id).toBe("outbreak/clusters");
    expect(path.start_here.id).toBe("basics/collections");
    expect(path.loose_match).toBe(true);
  });

  it("says so plainly when nothing matches at all", async () => {
    const index = await trainingIndex();
    const path = gtnLearningPath(index, { query: "zzzzqqq" });
    expect(path.status).toBe("not-found");
  });
});

describe("gtnFindTutorials prerequisite signals", () => {
  it("carries the top hit's entry point inline, so the chain cannot be missed", async () => {
    const index = await trainingIndex();
    const found = gtnFindTutorials(index, { query: "transmission clusters", limit: 3 });
    expect(found.tutorials[0].id).toBe("outbreak/clusters");
    expect(found.start_here?.id).toBe("basics/collections");
    expect(found.start_here?.steps_to_goal).toBe(3);
    expect(found.hint).toMatch(/start_here/);
  });

  it("leaves start_here off when the top hit is already an entry point", async () => {
    const index = await trainingIndex();
    const found = gtnFindTutorials(index, { query: "working with collections" });
    expect(found.tutorials[0].id).toBe("basics/collections");
    expect(found.start_here).toBeUndefined();
  });

  it("separates tested workflows from the rest, which a bare count hides", async () => {
    const index = await trainingIndex();
    const found = gtnFindTutorials(index, { query: "transmission clusters" });
    expect(found.tutorials[0]).toMatchObject({
      workflow_count: 1,
      tested_workflow_count: 0,
      prerequisite_count: 2,
    });
  });
});
