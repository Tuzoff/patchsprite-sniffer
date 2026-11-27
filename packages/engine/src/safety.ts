// The safety layer. It runs on the user's machine and refuses unsafe writes whatever the caller asks,
// including a server. Rules come from firmware halts and lost patches we actually hit while mapping.

import type { ModelDef, ModelIndex, ParamDef } from "./mapping.ts";

export class SafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SafetyError";
  }
}

/** The safety floor a device's map declares (its `safety` section), enforced before anything is sent. */
export interface DeviceRules {
  /** Scenes (0-based) where a block's model may change, and why only there. */
  algorithmChangeScenes: number[];
  algorithmChangeReason: string;
  /** Model types (the code shifted right by typeShift) that halt the firmware, and why they are refused. */
  knownBadTypes: number[];
  typeShift: number;
  knownBadReason: string;
}

/**
 * A model change or control set that froze the pedal on one firmware. Only these are blocked: they name
 * exactly what froze it. Other commands that froze it are reported, never blocked.
 */
export interface HaltRecord {
  firmware: string;
  /** the driver's name for the command, e.g. "assignAlgorithm" or "setParam" */
  command: string;
  /** what it carried: "model 0x03000002", or "model 0x03000002 param 3" */
  detail: string;
  /** for the player: "DRV/Test Grit" */
  model?: string;
  /** for the player, on a control set: "Gain" */
  control?: string;
  /** ISO time */
  time: string;
}

/** How a blocked change can be tried again; every block refusal ends with it. */
export const UNBLOCK_HINT = "if the player wants to try it again, unblock it with unblock_firmware";

/** The detail a halt record keeps for a model change, and for a control set on that model. */
export const assignDetail = (code: number) => `model 0x${(code >>> 0).toString(16).padStart(8, "0")}`;
export const paramDetail = (code: number, param: number) => `${assignDetail(code)} param ${param}`;

export interface WriteTarget {
  index: number;
  label: string;
  name: string;
  isEmpty: boolean;
}

export class Safety {
  /** Patch slots this app created in this session or recorded as its own. */
  readonly ownedSlots = new Set<number>();

  readonly models: ModelIndex;
  /** Commands that froze the pedal on its firmware: refused from then on, on that firmware only. */
  readonly halts: HaltRecord[] = [];

  rules: DeviceRules;

  // no parameter properties: Node runs these files with type stripping, which only erases types
  constructor(models: ModelIndex, rules: DeviceRules) {
    this.models = models;
    this.rules = rules;
  }

  /** Block what froze the pedal; records for other firmware, or without a detail, are ignored. */
  addHalts(firmware: string, records: HaltRecord[]): void {
    for (const r of records) {
      if (r.firmware !== firmware || typeof r.detail !== "string" || !r.detail) continue;
      if (!this.halts.some((h) => h.detail === r.detail)) this.halts.push(r);
    }
  }

  /** Lift blocks by detail. */
  removeHalts(details: string[]): void {
    for (let i = this.halts.length - 1; i >= 0; i--) if (details.includes(this.halts[i].detail)) this.halts.splice(i, 1);
  }

  private haltFor(detail: string): HaltRecord | undefined {
    return this.halts.find((h) => h.detail === detail);
  }

  checkAssign(code: number, scene: number): ModelDef {
    if (!this.rules.algorithmChangeScenes.includes(scene)) {
      throw new SafetyError(
        `changing a block's model is only allowed in scene ${this.rules.algorithmChangeScenes.map((s) => s + 1).join("/")}; ` +
          `switch to scene ${this.rules.algorithmChangeScenes[0] + 1} first (${this.rules.algorithmChangeReason})`,
      );
    }
    const type = code >>> this.rules.typeShift;
    if (this.rules.knownBadTypes.includes(type)) throw new SafetyError(`model type ${type}: ${this.rules.knownBadReason}`);
    const m = this.models.byCode.get(code);
    if (!m) throw new SafetyError(`model code 0x${code.toString(16).padStart(8, "0")} is not verified on this firmware`);
    const h = this.haltFor(assignDetail(code));
    if (h) throw new SafetyError(`${m.module}/${m.model}: this model froze the pedal on firmware ${h.firmware}; blocked (${UNBLOCK_HINT})`);
    return m;
  }

  checkParam(m: ModelDef, p: ParamDef, value: number): number {
    if (!Number.isFinite(value)) throw new SafetyError(`${p.name}: value must be a number`);
    const min = typeof p.min === "number" ? p.min : undefined;
    const max = typeof p.max === "number" ? p.max : undefined;
    if (p.type === "switch" && value !== 0 && value !== 1) throw new SafetyError(`${p.name} is a switch: use 0 or 1`);
    if ((min !== undefined && value < min) || (max !== undefined && value > max)) {
      throw new SafetyError(`${m.model} ${p.name} = ${value} is outside ${min ?? "?"}..${max ?? "?"}`);
    }
    if (min === undefined || max === undefined) {
      throw new SafetyError(`${m.model} ${p.name}: range not observed yet, refusing to write`);
    }
    const h = this.haltFor(paramDetail(Number(m.code), p.id));
    if (h) throw new SafetyError(`${m.module}/${m.model} ${p.name}: this control froze the pedal on firmware ${h.firmware}; blocked (${UNBLOCK_HINT})`);
    return value;
  }

  /** Writes go only to empty slots or slots we own, unless the user named the slot to overwrite. */
  checkSave(target: WriteTarget, userNamedOverwrite = false): void {
    if (target.isEmpty || this.ownedSlots.has(target.index) || userNamedOverwrite) return;
    throw new SafetyError(
      `${target.label} "${target.name}" is not empty and was not made by this app; ` +
        "name it explicitly to overwrite it (a backup is taken first)",
    );
  }
}
