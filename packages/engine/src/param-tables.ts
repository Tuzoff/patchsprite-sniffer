// Which parameter table of a device map goes with a block: the one keyed by the block itself, else, on a device whose
// slots can each hold any effect, the one keyed by the effect type in it. No device fact lives here.

import { groupsInMode } from "./modes.ts";
import type { LinkedSetDef, Parameter, Parameters, Protocol } from "./protocol-schema.ts";

/** Where the tables are read from: a codec (its tables are those of the unit's mode), or a map (its own tables, the
 * groups that stand in for others in some mode left out). */
export type TableSource = Pick<Protocol, "modes" | "parameters">;

const groupsOf = (source: TableSource): Parameters["groups"][string][] => Object.values(groupsInMode(source, {}));

export interface ParamTable {
  /** what the table is keyed by, and its key: the name self-healing checks file the table's parameters under */
  owner: string;
  params: Record<string, Parameter>;
  /** parameters the device checks together, by set name (linked-params.ts) */
  linked: Record<string, LinkedSetDef>;
}

/**
 * The table for a block holding an effect of `type`, as the block's status reports it: a key of the `type` enum, or a
 * number where the map names no such type (which no table is keyed by).
 */
export function paramTable(source: TableSource, block: string, type?: string | number): ParamTable | undefined {
  const groups = groupsOf(source);
  const byBlock = groups.find((g) => g.blocks?.includes(block));
  if (byBlock) return { owner: block, params: byBlock.params, linked: byBlock.linked ?? {} };
  if (typeof type !== "string") return undefined;
  const byType = groups.find((g) => g.types?.includes(type));
  return byType && { owner: type, params: byType.params, linked: byType.linked ?? {} };
}

/** Whether the map keys any table by effect type, so a block's type must be known to name its parameters. */
export const tablesByType = (source: TableSource): boolean => groupsOf(source).some((g) => g.types);
