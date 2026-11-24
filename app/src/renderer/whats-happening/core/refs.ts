/** Building `GalaxyRef`s, shared by the catalog (inputs) and results (outputs). */

import type { GalaxyRef, GalaxyRefKind } from "./types.js";

/** A ref with its label built from the history item index and name when known, else the id. */
export function galaxyRef(
  kind: GalaxyRefKind,
  id: string,
  extra: Pick<GalaxyRef, "hid" | "name" | "role"> = {},
): GalaxyRef {
  const label = [extra.hid === undefined ? "" : `#${extra.hid}`, extra.name ?? ""]
    .filter(Boolean)
    .join(" ");
  return {
    kind,
    id,
    label: label || id,
    ...(extra.hid === undefined ? {} : { hid: extra.hid }),
    ...(extra.name === undefined ? {} : { name: extra.name }),
    ...(extra.role === undefined ? {} : { role: extra.role }),
  };
}
