/**
 * Name memory: the names of Galaxy things, learned from results the harness
 * already received, so later rows can say "Select random lines on
 * "synthetic_counts.tsv" (#4)" instead of ids. No extra Galaxy calls.
 */

import { isPlainObject } from "@galaxyproject/galaxy-ops/browser";

import { operationFor } from "./catalog.js";
import { envelopeOf } from "./results.js";
import type { NameMemory, NamedItem } from "./types.js";

export const EMPTY_NAMES: NameMemory = {
  tools: {},
  datasets: {},
  collections: {},
  histories: {},
  workflows: {},
};

/** How far into a result to look for named records, and how many to take from one result. */
const MAX_DEPTH = 3;
const MAX_RECORDS = 2000;

/**
 * Learns names from a successful call's result. Datasets and collections are
 * told apart by Galaxy's own `history_content_type` / `model_class`; tools,
 * histories and workflows by the galaxy-ops domain of the operation that
 * returned them.
 * Returns the same memory when nothing new was learned.
 */
export function learnNames(names: NameMemory, toolName: string, result: unknown): NameMemory {
  const envelope = envelopeOf(result);
  if (!envelope?.success) return names;
  const domain = operationFor(toolName)?.domain;
  const learned = {
    tools: { ...names.tools },
    datasets: { ...names.datasets },
    collections: { ...names.collections },
    histories: { ...names.histories },
    workflows: { ...names.workflows },
  };
  let changed = false;
  for (const record of namedRecords(envelope.data)) {
    const { id, name } = record;
    const hid = typeof record.hid === "number" ? record.hid : undefined;
    const type = record.history_content_type ?? record.model_class;
    let into: Record<string, string> | Record<string, NamedItem> | undefined;
    let value: string | NamedItem = name;
    if (type === "dataset" || type === "HistoryDatasetAssociation") {
      into = learned.datasets;
      value = hid === undefined ? { id, name } : { id, name, hid };
    } else if (type === "dataset_collection" || type === "HistoryDatasetCollectionAssociation") {
      into = learned.collections;
      value = hid === undefined ? { id, name } : { id, name, hid };
    } else if (domain === "tools" || domain === "userTools") {
      into = learned.tools;
    } else if (domain === "histories" && hid === undefined) {
      into = learned.histories;
    } else if (domain === "workflows") {
      into = learned.workflows;
    }
    if (!into || JSON.stringify(into[id]) === JSON.stringify(value)) continue;
    (into as Record<string, typeof value>)[id] = value;
    changed = true;
  }
  return changed ? learned : names;
}

interface NamedRecord {
  id: string;
  name: string;
  hid?: unknown;
  history_content_type?: unknown;
  model_class?: unknown;
}

/** Plain objects with a string `id` and `name`, found a few levels into a result. */
function namedRecords(data: unknown): NamedRecord[] {
  const found: NamedRecord[] = [];
  const walk = (value: unknown, depth: number) => {
    if (found.length >= MAX_RECORDS || depth > MAX_DEPTH) return;
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1);
      return;
    }
    if (!isPlainObject(value)) return;
    if (typeof value.id === "string" && typeof value.name === "string" && value.name) {
      found.push(value as unknown as NamedRecord);
    }
    for (const child of Object.values(value)) {
      if (Array.isArray(child) || isPlainObject(child)) walk(child, depth + 1);
    }
  };
  walk(data, 0);
  return found;
}
