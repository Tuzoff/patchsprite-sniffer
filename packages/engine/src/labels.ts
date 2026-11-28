// Patch labels as a device's map spells them (`display.patchLabel`): a generic formatter and parser, so "A41-1" or
// "P124" is the map's business, not the code's.

import type { Display } from "./protocol-schema.ts";

type Def = Display["patchLabel"];

const TOKEN = /\{(bank|slot|index)(?::([1-9]))?\}/g;

const pad = (n: number, width: string | undefined) => (width ? String(n).padStart(Number(width), "0") : String(n));

/** Labels for patch indexes and back, by a map's pattern. */
export class LabelFormat {
  private readonly def: Required<Def>;
  private readonly re: RegExp;
  private readonly tokens: string[];

  constructor(def: Def) {
    this.def = { firstBank: 0, firstSlot: 0, firstIndex: 0, ...def };
    this.tokens = [...def.pattern.matchAll(TOKEN)].map((m) => m[1]);
    let src = "";
    let last = 0;
    for (const m of def.pattern.matchAll(TOKEN)) {
      src += def.pattern.slice(last, m.index).replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(\\d{1,6})";
      last = m.index! + m[0].length;
    }
    src += def.pattern.slice(last).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    this.re = new RegExp(`^${src}$`, "i");
  }

  /** The label of patch index i. */
  label(i: number): string {
    const d = this.def;
    const v = { bank: Math.floor(i / d.bankSize) + d.firstBank, slot: (i % d.bankSize) + d.firstSlot, index: i + d.firstIndex };
    return d.pattern.replace(TOKEN, (_, t: "bank" | "slot" | "index", w: string | undefined) => pad(v[t], w));
  }

  /** The patch index a label names, or an error saying what a label looks like. */
  parse(label: string): number {
    const m = this.re.exec(label.trim());
    const d = this.def;
    if (m) {
      const v: Record<string, number> = {};
      this.tokens.forEach((t, k) => (v[t] = Number(m[k + 1])));
      let i: number | undefined;
      if (v.index !== undefined) i = v.index - d.firstIndex;
      else if (v.bank !== undefined && v.slot !== undefined) {
        const slot = v.slot - d.firstSlot;
        if (slot >= 0 && slot < d.bankSize) i = (v.bank - d.firstBank) * d.bankSize + slot;
      }
      if (i !== undefined && i >= 0) return i;
    }
    throw new Error(`not a patch label: ${label} (labels look like ${this.label(0)})`);
  }

  /** A regular expression source the tools' input schemas check labels with. */
  get pattern(): string {
    return this.re.source;
  }
}
