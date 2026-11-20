import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TOOLS, handleMcpMessage } from "../packages/gtn-mcp/lib/server.js";
import type { GtnIndex } from "../shared/gtn-index.js";

const index = {
  version: 2,
  built_at: "2026-11-17T00:00:00.000Z",
  topics: [{ id: "assembly", title: "Assembly" }],
  materials: [
    {
      id: "assembly/chloroplast",
      short_id: "T00001",
      title: "Chloroplast genome assembly",
      topic_id: "assembly",
      topic: "Assembly",
      type: "tutorial",
      url: "https://training.galaxyproject.org/topics/assembly/tutorials/chloroplast/tutorial.html",
      level: "Introductory",
      time_estimation: "4h",
      mod_date: null,
      tags: ["nanopore"],
      objectives: ["Assemble a chloroplast genome"],
      questions: [],
      tools: [],
      servers: { exact: [], inexact: [] },
      zenodo_link: "https://zenodo.org/record/1",
      key_points: ["Long reads make organelle assembly tractable."],
      requirements: [{ type: "internal", topic_name: "assembly", tutorials: ["basics"] }],
      workflows: [
        {
          name: "chloroplast-assembly",
          title: "Chloroplast genome assembly",
          ga: "https://training.galaxyproject.org/x/chloroplast-assembly.ga",
          html: "https://training.galaxyproject.org/x/chloroplast-assembly.html",
          trs: "https://training.galaxyproject.org/training-material/api/ga4gh/trs/v2/tools/assembly-chloroplast/versions/chloroplast-assembly",
          wfid: "assembly-chloroplast",
          tests: true,
          license: "MIT",
        },
      ],
      also_in: [],
    },
    {
      id: "assembly/basics",
      short_id: "T00002",
      title: "Assembly basics",
      topic_id: "assembly",
      topic: "Assembly",
      type: "tutorial",
      url: "https://training.galaxyproject.org/topics/assembly/tutorials/basics/tutorial.html",
      level: "Introductory",
      time_estimation: "30m",
      mod_date: null,
      tags: [],
      objectives: ["Know what an assembler does"],
      questions: [],
      tools: [],
      servers: { exact: [], inexact: [] },
      zenodo_link: null,
      key_points: [],
      requirements: [],
      workflows: [],
      also_in: [],
    },
  ],
  failures: [],
} as unknown as GtnIndex;

const fetched: string[] = [];
const ctx = {
  getIndex: async () => index,
  fetchJson: async (url: string) => {
    fetched.push(url);
    if (url.endsWith(".ga")) {
      return {
        name: "Chloroplast assembly",
        steps: { "0": { type: "tool", tool_id: "iuc/flye/flye/2.9" } },
      };
    }
    return { "2.9": [{ url: "https://usegalaxy.org", name: "Main", usegalaxy: true }] };
  },
};
const rpc = (method: string, params?: unknown, id: unknown = 1) =>
  handleMcpMessage({ jsonrpc: "2.0", id, method, params }, ctx);

describe("gtn-mcp handshake", () => {
  it("echoes a protocol version it knows and names itself", async () => {
    const res = (await rpc("initialize", { protocolVersion: "2025-03-26" })) as any;
    expect(res.result.protocolVersion).toBe("2025-03-26");
    expect(res.result.serverInfo).toEqual({ name: "gtn", version: "0.1.0" });
    expect(res.result.capabilities.tools).toBeDefined();
  });

  it("falls back to its own newest version when the client asks for one it does not know", async () => {
    const res = (await rpc("initialize", { protocolVersion: "1999-01-01" })) as any;
    expect(res.result.protocolVersion).toBe("2025-06-18");
  });

  it("answers nothing to a notification, which must not get a reply", async () => {
    await expect(
      handleMcpMessage({ jsonrpc: "2.0", method: "notifications/initialized" }, ctx),
    ).resolves.toBeUndefined();
  });

  it("rejects a message that is not JSON-RPC 2.0", async () => {
    const res = (await handleMcpMessage({ id: 1, method: "ping" }, ctx)) as any;
    expect(res.error.code).toBe(-32600);
  });

  it("reports an unknown method as method-not-found", async () => {
    const res = (await rpc("resources/list")) as any;
    expect(res.error.code).toBe(-32601);
  });
});

describe("gtn-mcp tools", () => {
  it("declares every tool with an object input schema", () => {
    expect(TOOLS.map((t) => t.name)).toEqual([
      "gtn_find_tutorial",
      "gtn_learning_path",
      "gtn_find_workflow",
      "gtn_get_workflow",
      "gtn_tutorials_for_tool",
      "gtn_servers_for_tool",
    ]);
    for (const tool of TOOLS) {
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.description.length).toBeGreaterThan(40);
    }
  });

  it("returns search results as JSON text content", async () => {
    const res = (await rpc("tools/call", {
      name: "gtn_find_tutorial",
      arguments: { query: "chloroplast" },
    })) as any;
    expect(res.result.isError).toBeUndefined();
    const payload = JSON.parse(res.result.content[0].text);
    expect(payload.count).toBe(1);
    expect(payload.tutorials[0].title).toBe("Chloroplast genome assembly");
  });

  it("hands back the ga url and TRS endpoint for a workflow", async () => {
    const res = (await rpc("tools/call", {
      name: "gtn_find_workflow",
      arguments: { query: "chloroplast" },
    })) as any;
    const payload = JSON.parse(res.result.content[0].text);
    expect(payload.workflows[0].ga_url).toContain(".ga");
    expect(payload.workflows[0].trs_endpoint).toContain("/ga4gh/trs/v2/");
  });

  it("calls an unknown tool an isError result, not a transport error", async () => {
    const res = (await rpc("tools/call", { name: "gtn_delete_everything" })) as any;
    expect(res.error).toBeUndefined();
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toContain("Unknown tool");
  });

  it("reports an index that cannot be loaded as isError rather than throwing", async () => {
    const res = (await handleMcpMessage(
      { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "gtn_find_tutorial" } },
      {
        getIndex: async () => {
          throw new Error("GTN unreachable");
        },
      },
    )) as any;
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toContain("GTN unreachable");
  });

  it("reads a workflow through the injected fetcher and summarises it", async () => {
    const res = (await rpc("tools/call", {
      name: "gtn_get_workflow",
      arguments: { wfid: "assembly-chloroplast" },
    })) as any;
    expect(res.result.isError).toBeUndefined();
    const payload = JSON.parse(res.result.content[0].text);
    expect(payload.wfid).toBe("assembly-chloroplast");
    expect(payload.step_count).toBe(1);
    expect(fetched.some((u) => u.endsWith(".ga"))).toBe(true);
  });

  it("asks for a reference instead of guessing when gtn_get_workflow is called bare", async () => {
    const res = (await rpc("tools/call", { name: "gtn_get_workflow", arguments: {} })) as any;
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toContain("Give wfid, name or url");
  });

  it("lists tutorials for a tool without touching the network", async () => {
    const before = fetched.length;
    const res = (await rpc("tools/call", {
      name: "gtn_tutorials_for_tool",
      arguments: { tool: "nothing-here" },
    })) as any;
    expect(JSON.parse(res.result.content[0].text).count).toBe(0);
    expect(fetched.length).toBe(before);
  });

  it("returns the public servers for a tool", async () => {
    index.materials[0].tools.push("toolshed.g2.bx.psu.edu/repos/iuc/flye/flye/2.9");
    const res = (await rpc("tools/call", {
      name: "gtn_servers_for_tool",
      arguments: { tool: "flye" },
    })) as any;
    const payload = JSON.parse(res.result.content[0].text);
    expect(payload.tool).toBe("toolshed.g2.bx.psu.edu/repos/iuc/flye/flye");
    expect(payload.any_version[0].url).toBe("https://usegalaxy.org");
  });
});

describe("gtn-mcp stdio entry point", () => {
  /**
   * Drives bin/gtn-mcp.js as a real subprocess over a pipe, which is the one way to see the
   * things the protocol layer cannot: a stray write to stdout corrupting the stream, a crash on
   * a bad line, the handshake over a real pipe.
   *
   * It does NOT cover the drain-on-close path in the bin. Losing a reply when stdin closes only
   * shows up for a tool slow enough to still be in flight, and every tool that is reaches the
   * network -- so reproducing it here would mean a test that fetches from training.galaxyproject.org.
   * That path was verified by hand against the live API instead.
   */
  async function run(requests: unknown[], cacheDir: string): Promise<Record<string, any>> {
    const bin = path.join(__dirname, "..", "packages", "gtn-mcp", "bin", "gtn-mcp.js");
    const child = spawn(process.execPath, [bin], {
      env: { ...process.env, GTN_MCP_CACHE_DIR: cacheDir },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (out += chunk));
    for (const req of requests) child.stdin.write(`${JSON.stringify(req)}\n`);
    child.stdin.end();
    await new Promise((resolve) => child.on("close", resolve));

    const byId: Record<string, any> = {};
    for (const line of out.split("\n").filter(Boolean)) {
      // Anything unparseable here means something wrote to stdout that was not a message.
      const parsed = JSON.parse(line);
      byId[String(parsed.id)] = parsed;
    }
    return byId;
  }

  let cacheDir: string;
  beforeAll(() => {
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "gtn-mcp-test-"));
    fs.writeFileSync(path.join(cacheDir, "index.json"), JSON.stringify(index));
  });
  afterAll(() => fs.rmSync(cacheDir, { recursive: true, force: true }));

  it("handshakes and lists its tools over a pipe, writing only messages to stdout", async () => {
    const replies = await run(
      [
        { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
        { jsonrpc: "2.0", method: "notifications/initialized" },
        { jsonrpc: "2.0", id: 2, method: "tools/list" },
      ],
      cacheDir,
    );
    expect(replies["1"].result.serverInfo.name).toBe("gtn");
    expect(replies["2"].result.tools).toHaveLength(6);
    // The notification carried no id and must not have produced a reply.
    expect(Object.keys(replies).sort()).toEqual(["1", "2"]);
  });

  it("answers a request written immediately before stdin closes", async () => {
    const replies = await run(
      [
        {
          jsonrpc: "2.0",
          id: 7,
          method: "tools/call",
          params: { name: "gtn_find_tutorial", arguments: { query: "chloroplast" } },
        },
      ],
      cacheDir,
    );
    expect(replies["7"]).toBeDefined();
    expect(JSON.parse(replies["7"].result.content[0].text).count).toBe(1);
  });

  it("answers a malformed line with a parse error rather than dying", async () => {
    const bin = path.join(__dirname, "..", "packages", "gtn-mcp", "bin", "gtn-mcp.js");
    const child = spawn(process.execPath, [bin], {
      env: { ...process.env, GTN_MCP_CACHE_DIR: cacheDir },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stdin.write("not json\n");
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "ping" })}\n`);
    child.stdin.end();
    await new Promise((resolve) => child.on("close", resolve));
    const lines = out
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    expect(lines[0].error.code).toBe(-32700);
    // It kept going: the next line was still answered.
    expect(lines[1].id).toBe(3);
  });
});

describe("gtn-mcp learning path", () => {
  it("returns the ordered chain, with the entry point named", async () => {
    const res = (await rpc("tools/call", {
      name: "gtn_learning_path",
      arguments: { id: "assembly/chloroplast" },
    })) as any;
    expect(res.result.isError).toBeUndefined();
    const body = JSON.parse(res.result.content[0].text);
    expect(body.status).toBe("ok");
    expect(body.path.map((p: { id: string }) => p.id)).toEqual([
      "assembly/basics",
      "assembly/chloroplast",
    ]);
    expect(body.start_here.id).toBe("assembly/basics");
    expect(body.total_time).toBe("4h30m");
    expect(body.caveats).toEqual(["Long reads make organelle assembly tractable."]);
  });

  it("reports an unknown tutorial as an error rather than an empty path", async () => {
    const res = (await rpc("tools/call", {
      name: "gtn_learning_path",
      arguments: { id: "assembly/nope" },
    })) as any;
    expect(res.result.isError).toBe(true);
  });

  it("puts the entry point in the search result too, so the chain is not missed", async () => {
    const res = (await rpc("tools/call", {
      name: "gtn_find_tutorial",
      arguments: { query: "chloroplast" },
    })) as any;
    const body = JSON.parse(res.result.content[0].text);
    expect(body.tutorials[0].id).toBe("assembly/chloroplast");
    expect(body.start_here.id).toBe("assembly/basics");
  });
});
