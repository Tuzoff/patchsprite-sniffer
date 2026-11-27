// Which parameter table of a device map goes with a block: the one keyed by the block itself, else, on a device whose
// slots can each hold any effect, the one keyed by the effect type in it. No device fact lives here.

import type { Parameter, Protocol } from "./protocol-schema.ts";

export interface ParamTable {
  /** what the table is keyed by, and its key: the name self-healing checks file the table's parameters under */
  owner: string;
  params: Record<string, Parameter>;
}

/**
 * The table for a block holding an effect of `type`, as the block's status reports it: a key of the `type` enum, or a
 * number where the map names no such type (which no table is keyed by).
 */
export function paramTable(protocol: Protocol, block: string, type?: string | number): ParamTable | undefined {
  const groups = Object.values(protocol.parameters?.groups ?? {});
  const byBlock = groups.find((g) => g.blocks?.includes(block));
  if (byBlock) return { owner: block, params: byBlock.params };
  if (typeof type !== "string") return undefined;
  const byType = groups.find((g) => g.types?.includes(type));
  return byType && { owner: type, params: byType.params };
}

/** Whether the map keys any table by effect type, so a block's type must be known to name its parameters. */
export const tablesByType = (protocol: Protocol): boolean => Object.values(protocol.parameters?.groups ?? {}).some((g) => g.types);
