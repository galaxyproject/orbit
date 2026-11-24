/**
 * Rows: a group's entries arranged the way the user reads them, as changes to
 * their Galaxy with the reads and checks done for each underneath. Worked out
 * from the entries on demand, so the state itself stays a plain list.
 */

import { normalizeToolName } from "./catalog.js";
import type { GroupRows, NarrationEntry, NarrationGroup, NarrationRow } from "./types.js";

/**
 * A group's entries as rows. A read or check goes under the change that works
 * on the same Galaxy object (the dataset a run uses or makes, the job it
 * started, …), preferring the first such change after it. Otherwise it goes
 * under the most recent change before it, or the first change if it came
 * before any. A change that failed and was tried again folds into the row of
 * the retry, as one of its `attempts`. A group that changed nothing keeps its
 * reads and checks in `checks`.
 */
export function rowsOf(group: NarrationGroup): GroupRows {
  const entries = group.entries;
  const changes = entries.flatMap((entry, at) => (entry.kind === "change" ? [{ entry, at }] : []));
  const children = new Map<NarrationEntry, NarrationEntry[]>(changes.map((c) => [c.entry, []]));
  const internal: NarrationEntry[] = [];
  const checks: NarrationEntry[] = [];
  entries.forEach((entry, at) => {
    if (entry.kind === "internal") {
      internal.push(entry);
      return;
    }
    if (entry.kind === "change") return;
    if (changes.length === 0) {
      checks.push(entry);
      return;
    }
    const sharing = changes.filter((c) => sharesTarget(entry, c.entry));
    const before = changes.filter((c) => c.at < at);
    const home =
      // Works on the same object: the first such change after it, else the last before it.
      sharing.find((c) => c.at > at) ??
      sharing[sharing.length - 1] ??
      // Otherwise: the change before it, or the first change if it came before any.
      before[before.length - 1] ??
      changes[0];
    children.get(home.entry)?.push(entry);
  });
  const rows = changes.map((c) => ({
    change: c.entry,
    attempts: [] as NarrationEntry[],
    children: children.get(c.entry) ?? [],
  }));
  const kept: NarrationRow[] = [];
  rows.forEach((row, i) => {
    // A failed change tried again later: its row folds into the retry's.
    const retry =
      row.change.status === "failed"
        ? rows.slice(i + 1).find((r) => sameChange(row.change, r.change))
        : undefined;
    if (!retry) {
      kept.push(row);
      return;
    }
    retry.attempts.unshift(...row.attempts, row.change);
    retry.children = [...row.children, ...retry.children].sort(
      (a, b) => entries.indexOf(a) - entries.indexOf(b),
    );
  });
  return { rows: kept, checks, internal };
}

/**
 * Whether two changes are tries at the same thing: the same tool on the same
 * inputs (datasets, tool, history, …), or, for a change with no inputs such
 * as an upload, the same title.
 */
function sameChange(a: NarrationEntry, b: NarrationEntry): boolean {
  if (normalizeToolName(a.toolName).name !== normalizeToolName(b.toolName).name) return false;
  const inputs = (e: NarrationEntry): string =>
    e.galaxyRefs
      .filter((r) => r.role === "input")
      .map((r) => `${r.kind}:${r.id}`)
      .sort()
      .join(",");
  const [ia, ib] = [inputs(a), inputs(b)];
  return ia || ib ? ia === ib : a.title === b.title;
}

/** Whether a read or check and a change name the same Galaxy object. */
function sharesTarget(read: NarrationEntry, change: NarrationEntry): boolean {
  return read.galaxyRefs.some((r) =>
    change.galaxyRefs.some((c) => c.kind === r.kind && c.id === r.id),
  );
}
