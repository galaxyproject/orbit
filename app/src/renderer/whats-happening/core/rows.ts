/**
 * Rows: a group's entries arranged the way the user reads them, as changes to
 * their Galaxy with the reads and checks done for each underneath. Worked out
 * from the entries on demand, so the state itself stays a plain list.
 */

import type { GroupRows, NarrationEntry, NarrationGroup } from "./types.js";

/**
 * A group's entries as rows. A read or check goes under the change that works
 * on the same Galaxy object (the dataset a run uses or makes, the job it
 * started, …), preferring the first such change after it. Otherwise it goes
 * under the most recent change before it, or the first change if it came
 * before any. A group that changed nothing keeps its reads and checks in
 * `checks`.
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
  return {
    rows: changes.map((c) => ({ change: c.entry, children: children.get(c.entry) ?? [] })),
    checks,
    internal,
  };
}

/** Whether a read or check and a change name the same Galaxy object. */
function sharesTarget(read: NarrationEntry, change: NarrationEntry): boolean {
  return read.links.some((r) => change.links.some((c) => c.kind === r.kind && c.id === r.id));
}
