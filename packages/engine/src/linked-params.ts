// Parameters a device checks together (a min and max pair, an order of effects): which set a parameter is in, whether
// values keep the set's rules, and the order to write a change in so the device never holds a state the rules forbid.
// The sets and rules are the map's (`parameters.groups.<g>.linked`, docs/formats/device-map.md); no device
// fact lives here, and nothing here sends a message.

import { paramTable } from "./param-tables.ts";
import type { LinkedSetDef, LinkRule, Protocol } from "./protocol-schema.ts";

/** A linked set of one block's table: its parameters by name and id, in the order the device takes them. */
export interface LinkedSet {
  /** the set's name in the map */
  name: string;
  /** what the table is keyed by (a block, or the effect type in it), as self-healing checks name it */
  owner: string;
  params: { name: string; id: number }[];
  def: LinkedSetDef;
}

/** One write of a plan: a parameter's id and the raw value it is set to. */
export interface Write {
  id: number;
  value: number;
}

/** The self-healing entry of a linked set: its claim that these rules and this order are what the unit wants. */
export const linkedEntry = (owner: string, set: string): string => `linked/${owner}/${set}`;

/** The linked sets of the table a block holding an effect of `type` takes. */
export function linkedSets(protocol: Protocol, block: string, type?: string | number): LinkedSet[] {
  const table = paramTable(protocol, block, type);
  if (!table) return [];
  return Object.entries(table.linked).map(([name, def]) => ({
    name,
    owner: table.owner,
    params: def.params.map((n) => ({ name: n, id: table.params[n].id })),
    def,
  }));
}

/** The linked set a parameter of a block is in, if any. */
export function linkedSetOf(protocol: Protocol, block: string, id: number, type?: string | number): LinkedSet | undefined {
  return linkedSets(protocol, block, type).find((s) => s.params.some((p) => p.id === id));
}

/** A rule's parameters, in the set's order. */
const ruleParams = (set: LinkedSet, r: LinkRule) => (r.params ? r.params.map((n) => set.params.find((p) => p.name === n)!) : set.params);

/**
 * Every way values break the set's rules, as a key (which rule, which pair or which value held again by which
 * parameter) and in the player's words. `label` names a value as the player reads it (its option name, say); a value
 * the set lacks is not checked.
 */
function* faults(set: LinkedSet, values: ReadonlyMap<number, number>, label: (id: number, v: number) => string): Generator<[string, string]> {
  for (const [n, r] of (set.def.rules ?? []).entries()) {
    const ps = ruleParams(set, r);
    if (r.kind === "ascending") {
      for (let i = 1; i < ps.length; i++) {
        const a = values.get(ps[i - 1].id);
        const b = values.get(ps[i].id);
        if (a === undefined || b === undefined || (r.strict ? a < b : a <= b)) continue;
        yield [`${n}:${ps[i].id}`, `${ps[i - 1].name} (${label(ps[i - 1].id, a)}) must stay ${r.strict ? "below" : "at or below"} ${ps[i].name} (${label(ps[i].id, b)})`];
      }
    } else {
      const free = new Set(r.repeatable ?? []);
      const first = new Map<number, string>();
      for (const p of ps) {
        const v = values.get(p.id);
        if (v === undefined || free.has(v)) continue;
        const twin = first.get(v);
        if (twin !== undefined) yield [`${n}:${p.id}=${v}`, `${twin} and ${p.name} can't both be ${label(p.id, v)}`];
        else first.set(v, p.name);
      }
    }
  }
}

const rawLabel = (_: number, v: number) => String(v);

/** The ways values break the set's rules, by key (empty: they keep them). */
const faultKeys = (set: LinkedSet, values: ReadonlyMap<number, number>) => new Set(Array.from(faults(set, values, rawLabel), ([k]) => k));

/**
 * Why values break the set's rules, in the player's words, or undefined when they keep them. `label` names a value
 * as the player reads it (its option name, say); a value the set lacks is not checked.
 */
export function linkedFault(set: LinkedSet, values: ReadonlyMap<number, number>, label: (id: number, v: number) => string = rawLabel): string | undefined {
  return faults(set, values, label).next().value?.[1];
}

export type Plan = { writes: Write[] } | { refused: string };

/**
 * The writes that take a linked set from `current` to `target` (raw values by id; `target` holds the ones that change,
 * the rest stay as they are), in an order the device takes without ever holding a state the rules forbid:
 * - commit "last": every parameter of the set, in the set's order, so the last one commits them all;
 * - commit "each": the ones that change, each written once, every write keeping the rules: on a unit already outside
 *   them, a write may mend a fault but never adds one. None is refused when no such order exists.
 * A target that breaks the rules is refused; a change to nothing plans no writes. Nothing is sent here.
 */
export function writePlan(set: LinkedSet, current: ReadonlyMap<number, number>, target: ReadonlyMap<number, number>, label?: (id: number, v: number) => string): Plan {
  for (const id of target.keys()) if (!set.params.some((p) => p.id === id)) throw new Error(`parameter ${id} is not in the linked set ${set.name}`);
  const missing = set.params.find((p) => !current.has(p.id) && !target.has(p.id));
  if (missing) return { refused: `the unit did not report ${missing.name}, which is set together with ${others(set, missing.name)}` };
  const end = new Map(set.params.map((p) => [p.id, target.get(p.id) ?? current.get(p.id)!]));
  const fault = linkedFault(set, end, label);
  if (fault) return { refused: fault };
  const changing = set.params.filter((p) => end.get(p.id) !== current.get(p.id));
  if (!changing.length) return { writes: [] };
  if (set.def.commit === "last") return { writes: set.params.map((p) => ({ id: p.id, value: end.get(p.id)! })) };
  // each write lands at once: write the first change (in the set's order) that adds no fault to those the unit holds,
  // and again until none is left. For an ascending rule from a state that keeps it this always finds an order (the
  // ones going down from the start, the ones going up from the end); a distinct set's swap has none, since one write
  // in it makes a twin.
  const now = new Map(current);
  const writes: Write[] = [];
  let left = changing;
  while (left.length) {
    const before = faultKeys(set, now);
    const next = left.find((p) => [...faultKeys(set, new Map(now).set(p.id, end.get(p.id)!))].every((k) => before.has(k)));
    if (!next) {
      return {
        refused: `the unit takes ${left.map((p) => p.name).join(", ")} one at a time and checks each, so this change would pass through values it refuses; change them in smaller steps`,
      };
    }
    now.set(next.id, end.get(next.id)!);
    writes.push({ id: next.id, value: end.get(next.id)! });
    left = left.filter((p) => p !== next);
  }
  return { writes };
}

const others = (set: LinkedSet, name: string) => set.params.filter((p) => p.name !== name).map((p) => p.name).join(", ");
