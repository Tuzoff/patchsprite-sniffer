// A device mapping: what each model and control is called and how it is addressed on the wire.
// Mappings live in <make>/<device>/<firmware>.json under the private device-maps folder, with the device's protocol
// in <make>/<device>/protocol.json beside them (see docs/formats/device-map.md). They hold only what
// contributors observed themselves (captures, read-backs, editor walks). Never vendor files.

import { parseProtocol, type Protocol } from "./protocol-schema.ts";

export interface ParamDef {
  id: number;
  name: string;
  /** "knob" | "switch" | "list" | "tempo/sync" as seen in the editor */
  type: string;
  min?: number | string;
  max?: number | string;
  default?: number | string;
}

export interface ModelDef {
  module: string;
  model: string;
  /** wire code, hex string like "0x01000011" */
  code: string;
  params: ParamDef[] | null;
  /** where the entry comes from, e.g. "ui-walk:00010" or "read-back:patch_120.bin" */
  evidence: string[];
}

export interface DeviceMapping {
  device: string;
  firmware: string;
  provenance: string;
  /** module name -> wire index */
  modules: Record<string, number>;
  knownBadTypes?: { type: number; why: string }[];
  models: ModelDef[];
  /** The device's protocol: framing, messages, layouts, settings (validated by the protocol schema). */
  protocol?: Protocol;
}

/** Keys a map file may have. Anything else is refused, so a section never silently vanishes on load. */
const MAP_KEYS = new Set(["device", "firmware", "provenance", "modules", "known_bad_types", "knownBadTypes", "models", "protocol"]);

/** Accepts the JSON file shape (snake_case keys from the mapping tools) or the typed shape. */
export function loadMapping(json: unknown): DeviceMapping {
  if (json === null || typeof json !== "object" || Array.isArray(json)) throw new Error("a device map is a JSON object");
  const j = json as Record<string, unknown>;
  const unknown = Object.keys(j).filter((k) => !MAP_KEYS.has(k));
  if (unknown.length) throw new Error(`device map has unknown keys: ${unknown.join(", ")}`);
  const m: DeviceMapping = {
    device: String(j.device),
    firmware: String(j.firmware),
    provenance: String(j.provenance ?? ""),
    modules: (j.modules ?? {}) as Record<string, number>,
    knownBadTypes: (j.knownBadTypes ?? j.known_bad_types ?? []) as { type: number; why: string }[],
    models: (j.models ?? []) as ModelDef[],
    ...(j.protocol !== undefined ? { protocol: parseProtocol(j.protocol) } : {}),
  };
  if (!m.models.length) throw new Error(`mapping for ${m.device} has no models`);
  for (const [mod, i] of Object.entries(m.modules)) {
    if (!Number.isInteger(i) || i < 0 || i > 0xfe) throw new Error(`module ${mod}: wire index ${i} is not 0..254`);
  }
  for (const x of m.models) {
    const code = /^0x[0-9a-f]{1,8}$/i.test(String(x.code)) ? Number(x.code) : NaN;
    if (!Number.isInteger(code) || code < 0 || code > 0xffffffff) throw new Error(`${x.module}/${x.model}: bad code ${x.code}`);
    for (const p of x.params ?? []) {
      if (!Number.isInteger(p.id) || p.id < 0 || p.id > 24) throw new Error(`${x.model} ${p.name}: param id ${p.id} is not 0..24`);
    }
  }
  return m;
}

/** A model or control name the map does not know: a refusal for the player, not a crash. */
export class UnknownNameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnknownNameError";
  }
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

export class ModelIndex {
  readonly byCode = new Map<number, ModelDef>();
  private readonly byName = new Map<string, ModelDef[]>();

  readonly mapping: DeviceMapping;

  constructor(mapping: DeviceMapping) {
    this.mapping = mapping;
    for (const m of mapping.models) {
      this.byCode.set(Number(m.code), m);
      const k = norm(m.model);
      this.byName.set(k, [...(this.byName.get(k) ?? []), m]);
    }
  }

  code(m: ModelDef): number {
    return Number(m.code);
  }

  /** Find a model by name, optionally qualified as "MODULE/Model" or limited to a module. */
  find(name: string, module?: string): ModelDef {
    let mod = module;
    let model = name;
    const slash = name.indexOf("/");
    if (!mod && slash > 0) {
      mod = name.slice(0, slash);
      model = name.slice(slash + 1);
    }
    const hits = (this.byName.get(norm(model)) ?? []).filter((m) => !mod || norm(m.module) === norm(mod));
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) {
      throw new UnknownNameError(`"${name}" is ambiguous: ${hits.map((h) => `${h.module}/${h.model}`).join(", ")}`);
    }
    throw new UnknownNameError(`no model "${name}"${mod ? ` in ${mod}` : ""} in the ${this.mapping.device} mapping`);
  }

  param(m: ModelDef, name: string): ParamDef {
    const p = m.params?.find((q) => norm(q.name) === norm(name));
    if (!p) {
      const names = m.params?.map((q) => q.name).join(", ") ?? "none observed";
      throw new UnknownNameError(`${m.module}/${m.model} has no control "${name}" (controls: ${names})`);
    }
    return p;
  }

  moduleIndex(module: string): number {
    const i = Object.hasOwn(this.mapping.modules, module) ? this.mapping.modules[module] : undefined;
    if (i === undefined) throw new Error(`no wire index observed for module ${module}`);
    return i;
  }
}
