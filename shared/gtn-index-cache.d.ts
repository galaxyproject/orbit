import type { GtnIndex } from "./gtn-index.js";

export interface LoadGtnIndexOptions {
  /** Where the index is kept. The host decides; the cache only reads and writes it. */
  cacheFile: string;
  /** Rebuild even if a fresh cache exists. */
  force?: boolean;
  signal?: AbortSignal;
  /** Called as topics come in, for a status line during the one slow call. */
  onProgress?: (done: number, total: number) => void;
}

export function loadGtnIndex(opts: LoadGtnIndexOptions): Promise<GtnIndex>;
export function resetGtnIndexMemo(): void;
