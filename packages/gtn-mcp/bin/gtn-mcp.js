#!/usr/bin/env node
// stdio entry point for the GTN MCP server.
//
// MCP over stdio puts one JSON-RPC message per line on stdout, so nothing else may be written
// there: every diagnostic in this file goes to stderr, or it would corrupt the stream.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { loadGtnIndex } from "../../../shared/gtn-index-cache.js";
import { handleMcpMessage } from "../lib/server.js";

/**
 * Where the index is cached. Orbit points this at its own state dir; standing alone, the server
 * uses the usual per-user cache location.
 */
function cacheFile() {
  const configured = process.env.GTN_MCP_CACHE_DIR;
  if (configured) return path.join(configured, "index.json");
  const base =
    process.env.XDG_CACHE_HOME ||
    (process.platform === "darwin"
      ? path.join(os.homedir(), "Library", "Caches")
      : path.join(os.homedir(), ".cache"));
  return path.join(base, "gtn-mcp", "index.json");
}

const file = cacheFile();
const ctx = {
  getIndex: () => loadGtnIndex({ cacheFile: file }),
  /** The tools that reach past the index do their own fetching through this. */
  fetchJson: async (url) => {
    const resp = await fetch(url);
    // A 404 is an answer for the public server listing, not a failure.
    if (resp.status === 404) return undefined;
    if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
    return resp.json();
  },
};

/** One line out, one message. */
function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

const rl = readline.createInterface({ input: process.stdin });

/**
 * Requests still being answered.
 *
 * stdin closing does not mean the work is done: a tool that fetches can still be in flight, and
 * exiting on `close` drops its reply. A client that keeps the pipe open never notices, but one
 * that writes its requests and closes -- a script, a test -- loses exactly the slow answers.
 */
const pending = new Set();

rl.on("line", (line) => {
  const text = line.trim();
  if (!text) return;
  let message;
  try {
    message = JSON.parse(text);
  } catch {
    send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    return;
  }
  // Messages are answered as they complete rather than in order: JSON-RPC matches on id, and
  // serialising them would make a slow first call (the index build) block every later one.
  const work = handleMcpMessage(message, ctx)
    .then((response) => {
      if (response) send(response);
    })
    .catch((error) => {
      process.stderr.write(`[gtn-mcp] ${error?.stack ?? error}\n`);
      if (message?.id !== undefined && message?.id !== null) {
        send({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32603, message: String(error?.message ?? error) },
        });
      }
    })
    .finally(() => pending.delete(work));
  pending.add(work);
});

rl.on("close", () => {
  // Drain, then go. New work cannot arrive once stdin is closed, so one pass settles everything.
  void Promise.allSettled([...pending]).then(() => process.exit(0));
});

if (process.argv.includes("--build-index")) {
  // A way to pay the one slow call up front, e.g. from a postinstall or a cron entry.
  loadGtnIndex({ cacheFile: file, force: true })
    .then((index) => {
      process.stderr.write(
        `[gtn-mcp] indexed ${index.materials.length} materials to ${file}\n` +
          (index.failures.length ? `[gtn-mcp] ${index.failures.length} topic(s) failed\n` : ""),
      );
      process.exit(0);
    })
    .catch((error) => {
      process.stderr.write(`[gtn-mcp] index build failed: ${error?.message ?? error}\n`);
      process.exit(1);
    });
} else if (!fs.existsSync(file)) {
  process.stderr.write(`[gtn-mcp] no cached index yet; the first search will build one\n`);
}
