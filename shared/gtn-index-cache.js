/**
 * The GTN index, and where it lives between sessions. Node-only: it is the one piece of the GTN
 * core that touches the filesystem, so a browser shell uses `buildGtnIndex` directly instead.
 *
 * Building it costs ~35 requests and ~26MB off training.galaxyproject.org (shared/gtn-index.js
 * explains why there is no cheaper way), so it is built once and kept at
 * `<state dir>/cache/gtn/index.json` for a day. A session that has already loaded it holds it in
 * memory as well, because the file is about a megabyte and re-parsing it on every search would
 * undo most of the point.
 */

import fs from "node:fs";
import path from "node:path";
import { GTN_INDEX_VERSION, buildGtnIndex } from "./gtn-index.js";

const TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Where the index is kept is the host's business -- Orbit puts it under its state dir, the MCP
 * server under its own -- so the path comes in rather than being decided here. Everything else
 * about the cache is the same wherever it runs.
 */

/** @type {Map<string, any>} Held for the life of the process, keyed by cache file. */
const memo = new Map();
/** @type {Map<string, Promise<any>>} Builds in flight, so two callers share one. */
const inFlight = new Map();

/** Drop the in-memory copy. Tests use it; nothing in a session needs to. */
export function resetGtnIndexMemo() {
  memo.clear();
  inFlight.clear();
}

/** The cached index if it is present, current and fresh, else undefined. @param {string} file */
function readCache(file) {
  try {
    const stat = fs.statSync(file);
    if (Date.now() - stat.mtimeMs >= TTL_MS) return undefined;
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
    // A cache written by an older projection has fields this build does not understand.
    if (parsed?.version !== GTN_INDEX_VERSION) return undefined;
    if (!Array.isArray(parsed.materials) || parsed.materials.length === 0) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

/** @param {string} file @param {any} index */
function writeCache(file, index) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Write beside the target and rename, so a crash mid-write cannot leave a half-written
    // index that the next session would parse as a cache hit.
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(index), "utf-8");
    fs.renameSync(tmp, file);
  } catch (err) {
    // A cache we cannot write costs a rebuild next time, nothing more.
    console.error("[gtn] index cache write failed:", err);
  }
}

/**
 * The index, from memory, then disk, then GTN.
 *
 * A stale cache is preferred to a failed build: if GTN is unreachable the right answer is
 * yesterday's tutorials, not an error. Only a complete absence of both propagates.
 *
 * @param {{ cacheFile: string, force?: boolean, signal?: AbortSignal,
 *           onProgress?: (done: number, total: number) => void }} opts
 */
export async function loadGtnIndex(opts) {
  const file = opts.cacheFile;
  if (!opts.force && memo.has(file)) return memo.get(file);
  if (!opts.force) {
    const cached = readCache(file);
    if (cached) {
      memo.set(file, cached);
      return cached;
    }
  }
  const running = inFlight.get(file);
  if (running) return running;

  const build = (async () => {
    try {
      const index = await buildGtnIndex({
        fetchJson: async (/** @type {string} */ url) => {
          const resp = await fetch(url, { signal: opts.signal });
          if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
          return resp.json();
        },
        onProgress: opts.onProgress,
        signal: opts.signal,
      });
      memo.set(file, index);
      writeCache(file, index);
      return index;
    } catch (error) {
      // Expired but readable beats nothing at all.
      const stale = (() => {
        try {
          const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
          return parsed?.version === GTN_INDEX_VERSION && parsed.materials?.length
            ? parsed
            : undefined;
        } catch {
          return undefined;
        }
      })();
      if (stale) {
        memo.set(file, stale);
        return stale;
      }
      throw error;
    } finally {
      inFlight.delete(file);
    }
  })();

  inFlight.set(file, build);
  return build;
}
