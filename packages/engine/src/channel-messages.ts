// MIDI channel messages: Control Change, Program Change with Bank Select, and NRPN, as a device map's `controls`
// section names them (see docs/formats/device-map.md, "controls"). They are fire-and-forget: nothing
// the unit sends answers them, so a driver can say what it sent, never what the unit did with it.
//
// Generic and browser-safe: no device fact and no Node API lives here. The map is untrusted input, so every count is
// capped and lookups by name never reach inherited properties. It imports nothing that imports protocol-schema.ts,
// which imports it: an unknown name is a SafetyError (a refusal), as is a value the map does not allow.

import { z } from "zod";
import { SafetyError } from "./safety.ts";

/** Controls in one map. */
const MAX_CONTROLS = 4096;
/** Values one control may list as allowed. */
const MAX_ALLOWED = 16384;
/** Problems named per map: a map that names one per enum key on every control must not fill memory. */
const MAX_ISSUES = 100;
/** Options one control's `accepts` names; the rest are counted. */
const MAX_NAMED = 32;

const has = (o: object, k: string) => Object.hasOwn(o, k);
const name = z.string().max(64).regex(/^[a-z][A-Za-z0-9]*$/, "names are camelCase");
const seven = z.number().int().min(0).max(0x7f);
const fourteen = z.number().int().min(0).max(0x3fff);

/** Status nibbles (the high half of the first byte); the low half is the channel, 0-15 for channels 1-16. */
const CC = 0xb0;
const PC = 0xc0;
/** Controllers with a fixed job: Bank Select, Data Entry, (N)RPN address and data increment. */
const BANK_MSB = 0;
const BANK_LSB = 32;
const DATA_MSB = 6;
const DATA_LSB = 38;
const NRPN_LSB = 98;
const NRPN_MSB = 99;
/** The controllers NRPN writes use: a plain CC on one of them would garble the next NRPN write. */
const NRPN_CCS = [DATA_MSB, DATA_LSB, 96, 97, NRPN_LSB, NRPN_MSB, 100, 101];
/** 120-127 are channel mode messages (all sound off, reset controllers, local control, omni, mono, poly): never sent. */
const LAST_PLAIN_CC = 119;

const valueRule = {
  /** How the player names it ("Scene", "Footswitch A"). Default: the control's name. */
  label: z.string().min(1).max(64).optional(),
  /** What kind of control it is ("scene", "stomp", "tuner"), for listing them together. */
  group: name.optional(),
  /** The range sent; default the whole range the message carries (0-127, or 0-16383 for a 14-bit NRPN). */
  min: fourteen.optional(),
  max: fourteen.optional(),
  /** Name of an enum in the map's `enums`: its keys are accepted and shown for these values. */
  enum: name.optional(),
  /** The only values ever sent (safety: values known to be safe). */
  allowed: z.array(fourteen).min(1).max(MAX_ALLOWED).optional(),
  /** A footswitch-like control: "press" sends `value`, then `release` when given. */
  press: z.strictObject({ value: fourteen, release: fourteen.optional() }).optional(),
  /** send: the host sends it (default); notify: the unit sends it unasked; both. */
  dir: z.enum(["send", "notify", "both"]).optional(),
  /** Free text: where the fact comes from. */
  note: z.string().max(1024).optional(),
};

const CcControl = z.strictObject({ type: z.literal("cc"), cc: z.number().int().min(0).max(LAST_PLAIN_CC), ...valueRule });
const PcControl = z.strictObject({ type: z.literal("pc"), ...valueRule });
/** A Non-Registered Parameter Number: CC99 (address MSB), CC98 (address LSB), then CC6 (value, or its top 7 bits) and,
 * for a 14-bit value, CC38 (its low 7 bits). */
const NrpnControl = z.strictObject({ type: z.literal("nrpn"), msb: seven, lsb: seven, bits: z.union([z.literal(7), z.literal(14)]), ...valueRule });
const ControlSchema = z.discriminatedUnion("type", [CcControl, PcControl, NrpnControl]);

/** How a preset number becomes Bank Select and Program Change: bank = preset / perBank, program = preset % perBank. */
const PresetsSchema = z.strictObject({
  count: z.number().int().min(1).max(128 * 16384),
  /** Which Bank Select controllers carry the bank: none, CC0 alone, CC32 alone, or both (CC0 the bank's top 7 bits). */
  bank: z.enum(["none", "msb", "lsb", "msb-lsb"]),
  /** Programs per bank: 128 unless the unit uses fewer. */
  perBank: z.number().int().min(1).max(128).optional(),
  /** How long the unit takes to load a preset: nothing else is sent to it for this long after the program change. */
  settleMs: z.number().int().min(0).max(10_000).optional(),
  note: z.string().max(1024).optional(),
});

export const ControlsSchema = z.strictObject({
  /** The channel the unit listens on: a setting on the unit, which no message reads back. */
  channel: z.strictObject({
    /** The unit's factory setting, 1-16. */
    default: z.number().int().min(1).max(16),
    /** The unit can listen on every channel. */
    omni: z.boolean().optional(),
    /** Where the player finds the setting on the unit ("Settings > MIDI > MIDI Channel"). */
    where: z.string().min(1).max(256).optional(),
  }),
  items: z.preprocess((v, ctx) => {
    if (v !== null && typeof v === "object" && Object.keys(v).length > MAX_CONTROLS) {
      ctx.addIssue({ code: "custom", message: `at most ${MAX_CONTROLS} controls` });
      return z.NEVER;
    }
    return v;
  }, z.record(name, ControlSchema)),
  presets: PresetsSchema.optional(),
});
export type Controls = z.infer<typeof ControlsSchema>;
export type Control = z.infer<typeof ControlSchema>;

/** The largest value a control's message carries. */
const ceiling = (c: Control) => (c.type === "nrpn" && c.bits === 14 ? 0x3fff : 0x7f);
const what = (c: Control) => (c.type === "cc" ? `CC ${c.cc}` : c.type === "pc" ? "program change" : `NRPN ${c.msb}/${c.lsb}`);

/**
 * Problems with a `controls` section beyond its shape: ranges, enums, controls that would send the same message, and
 * controllers another job owns. `enums` are the map's.
 */
export function controlsIssues(c: Controls, enums: Record<string, Record<string, number>>): string[] {
  const out: string[] = [];
  const seen = new Map<string, string>();
  const items = Object.entries(c.items);
  const nrpn = items.some(([, x]) => x.type === "nrpn");
  const bankCcs = bankSelectCcs(c.presets);
  for (const [n, x] of items) {
    if (out.length >= MAX_ISSUES) return out.slice(0, MAX_ISSUES);
    const where = `controls.items.${n}`;
    const top = ceiling(x);
    const lo = x.min ?? 0;
    const hi = x.max ?? top;
    if (hi > top) out.push(`${where}: max ${hi} is past the ${top} a ${what(x)} carries`);
    if (lo > hi) out.push(`${where}: min ${lo} is above max ${hi}`);
    const allowed = x.allowed && new Set(x.allowed);
    const fits = (v: number) => v >= lo && v <= hi && (!allowed || allowed.has(v));
    for (const v of x.allowed ?? []) {
      if (v >= lo && v <= hi) continue;
      out.push(`${where}: allowed value ${v} is outside ${lo}-${hi}`);
      if (out.length >= MAX_ISSUES) break;
    }
    if (x.enum !== undefined) {
      if (!has(enums, x.enum)) out.push(`${where}: no enum "${x.enum}" in the map`);
      else
        for (const [k, v] of Object.entries(enums[x.enum])) {
          if (fits(v)) continue;
          out.push(`${where}: enum ${x.enum} key ${k} is ${v}, which it can't send`);
          if (out.length >= MAX_ISSUES) break;
        }
    }
    if (x.press) for (const v of [x.press.value, x.press.release]) if (v !== undefined && !fits(v)) out.push(`${where}: press value ${v} is one it can't send`);
    const key = x.type === "cc" ? `cc ${x.cc}` : x.type === "pc" ? "pc" : `nrpn ${x.msb} ${x.lsb}`;
    if (seen.has(key)) out.push(`${where}: sends the same ${what(x)} as ${seen.get(key)}`);
    else seen.set(key, n);
    if (x.type === "cc" && nrpn && NRPN_CCS.includes(x.cc)) out.push(`${where}: CC ${x.cc} carries NRPN writes in this map`);
    if (x.type === "cc" && bankCcs.includes(x.cc)) out.push(`${where}: CC ${x.cc} is the bank select of controls.presets`);
    if (x.type === "nrpn" && x.dir !== undefined && x.dir !== "send") out.push(`${where}: an NRPN the unit sends is not read yet; its dir is "send"`);
    if (x.type === "pc" && c.presets) out.push(`${where}: program changes select presets (controls.presets); a control can't send one too`);
  }
  const p = c.presets;
  if (p) {
    const banks = p.bank === "none" ? 1 : p.bank === "msb-lsb" ? 16384 : 128;
    const per = p.perBank ?? 128;
    if (p.count > banks * per) out.push(`controls.presets: ${p.count} presets don't fit ${banks} bank${banks > 1 ? "s" : ""} of ${per}`);
  }
  return out.slice(0, MAX_ISSUES);
}

/** A value as a tool passes it: a number, an enum key, or "press" / "release" on a footswitch-like control. */
export type ControlValue = number | string;

/** An incoming channel message the map names: a preset the unit selected (0-based), or a control it reports. */
export type Heard =
  | { preset: number }
  | {
      control: string;
      value: number;
      /** the enum key for the value, when the control names an enum that has one */
      key?: string;
    };

/**
 * Encodes and reads the channel messages a map's `controls` section names. Every method returns whole MIDI messages,
 * one per array entry: a host sends them one at a time (Windows sends a short message per call), in order.
 */
export class ChannelCodec {
  readonly controls: Controls;
  private readonly enums: Record<string, Record<string, number>>;
  /** the bank last heard per channel, for reading an incoming program change as a preset */
  private readonly heardBank = new Map<number, { msb: number; lsb: number }>();

  /** the controls the unit reports (dir notify or both), by CC number and for a program change, for decode */
  private readonly reportedCc = new Map<number, string>();
  private readonly reportedPc: string | undefined;

  constructor(controls: Controls, enums: Record<string, Record<string, number>> = {}) {
    this.controls = controls;
    this.enums = enums;
    let pc: string | undefined;
    for (const [n, c] of Object.entries(controls.items)) {
      if (c.dir === undefined || c.dir === "send") continue;
      if (c.type === "cc" && !this.reportedCc.has(c.cc)) this.reportedCc.set(c.cc, n);
      if (c.type === "pc") pc ??= n;
    }
    this.reportedPc = pc;
  }

  /** The controls the host may send, in the map's order. */
  names(): string[] {
    return Object.keys(this.controls.items).filter((n) => this.controls.items[n].dir !== "notify");
  }

  control(n: string): Control {
    if (!has(this.controls.items, n)) throw new SafetyError(`no control "${n}" on this unit`);
    return this.controls.items[n];
  }

  label(n: string): string {
    return this.control(n).label ?? n;
  }

  /** The values a control accepts, in words: "0-127", "a, b, c", "press". */
  accepts(n: string): string {
    const c = this.control(n);
    const parts: string[] = [];
    const named = (xs: (string | number)[]) => xs.slice(0, MAX_NAMED).join(", ") + (xs.length > MAX_NAMED ? ` and ${xs.length - MAX_NAMED} more` : "");
    if (c.enum !== undefined && has(this.enums, c.enum)) parts.push(named(Object.keys(this.enums[c.enum])));
    else if (c.allowed) parts.push(named(c.allowed));
    else parts.push(`${c.min ?? 0}-${c.max ?? ceiling(c)}`);
    if (c.press) parts.push("press");
    return parts.join(", or ");
  }

  /** The raw value a tool's value means for a control, refused when the map does not allow it. */
  value(n: string, v: ControlValue): number {
    const c = this.control(n);
    let raw: number;
    if (typeof v === "number") raw = v;
    else if (c.press && (v === "press" || v === "release")) {
      if (v === "release" && c.press.release === undefined) throw new SafetyError(`${this.label(n)} has no release value`);
      raw = v === "press" ? c.press.value : c.press.release!;
    } else if (c.enum !== undefined && has(this.enums, c.enum) && has(this.enums[c.enum], v.toLowerCase())) raw = this.enums[c.enum][v.toLowerCase()];
    else if (/^\d{1,5}$/.test(v)) raw = Number(v);
    else throw new SafetyError(`${this.label(n)} takes ${this.accepts(n)}, not "${v}"`);
    const lo = c.min ?? 0;
    const hi = c.max ?? ceiling(c);
    if (!Number.isInteger(raw) || raw < lo || raw > hi) throw new SafetyError(`${this.label(n)} takes ${this.accepts(n)}; ${v} is outside that`);
    if (c.allowed && !c.allowed.includes(raw)) throw new SafetyError(`${this.label(n)} takes ${this.accepts(n)}; ${v} is not one of them`);
    return raw;
  }

  /** The enum key a raw value has on a control, if any. */
  key(n: string, raw: number): string | undefined {
    const e = this.control(n).enum;
    if (e === undefined || !has(this.enums, e)) return undefined;
    return Object.keys(this.enums[e]).find((k) => this.enums[e][k] === raw);
  }

  /** The messages that send a control a value on a channel (1-16). "press" sends the release after when the map has one. */
  encode(n: string, v: ControlValue, channel: number): Uint8Array[] {
    const c = this.control(n);
    if (c.dir === "notify") throw new SafetyError(`${this.label(n)} is something the unit reports; it is not sent`);
    const ch = channelNibble(channel);
    const one = (raw: number) => messagesFor(c, raw, ch);
    const raw = this.value(n, v);
    if (v === "press" && c.press?.release !== undefined) return [...one(raw), ...one(c.press.release)];
    return one(raw);
  }

  /** The messages that select a preset (0-based): Bank Select as the map says, then the program change. */
  preset(index: number, channel: number): Uint8Array[] {
    const p = this.controls.presets;
    if (!p) throw new SafetyError("this unit's map has no preset select");
    if (!Number.isInteger(index) || index < 0 || index >= p.count) throw new SafetyError(`the unit has presets 1-${p.count}; ${index + 1} is not one`);
    const ch = channelNibble(channel);
    const per = p.perBank ?? 128;
    const bank = Math.floor(index / per);
    const program = index % per;
    const out: Uint8Array[] = [];
    if (p.bank === "msb") out.push(Uint8Array.of(CC | ch, BANK_MSB, bank));
    if (p.bank === "lsb") out.push(Uint8Array.of(CC | ch, BANK_LSB, bank));
    if (p.bank === "msb-lsb") out.push(Uint8Array.of(CC | ch, BANK_MSB, bank >> 7), Uint8Array.of(CC | ch, BANK_LSB, bank & 0x7f));
    out.push(Uint8Array.of(PC | ch, program));
    return out;
  }

  /**
   * What an incoming message means: a control the unit reports (dir notify or both), or the preset a program change
   * selects under controls.presets (read with the Bank Select heard before it). Anything else, on another channel, or
   * a running-status fragment, is null.
   */
  decode(msg: Uint8Array, channel: number): Heard | null {
    const ch = channelNibble(channel);
    if (msg.length < 2 || (msg[0] & 0x0f) !== ch) return null;
    const status = msg[0] & 0xf0;
    const p = this.controls.presets;
    if (status === CC && msg.length >= 3 && bankSelectCcs(p).includes(msg[1])) {
      const b = this.heardBank.get(ch) ?? { msb: 0, lsb: 0 };
      this.heardBank.set(ch, msg[1] === BANK_MSB ? { ...b, msb: msg[2] } : { ...b, lsb: msg[2] });
      return null;
    }
    if (status === PC && p) {
      const b = this.heardBank.get(ch) ?? { msb: 0, lsb: 0 };
      const bank = p.bank === "msb" ? b.msb : p.bank === "lsb" ? b.lsb : p.bank === "msb-lsb" ? (b.msb << 7) | b.lsb : 0;
      const per = p.perBank ?? 128;
      const value = bank * per + msg[1];
      return msg[1] < per && value < p.count ? { preset: value } : null;
    }
    // NRPN reports are not read: a unit that sends them is not one the seeds name yet
    const n = status === PC ? this.reportedPc : status === CC && msg.length >= 3 ? this.reportedCc.get(msg[1]) : undefined;
    if (n === undefined) return null;
    const value = status === PC ? msg[1] : msg[2];
    const key = this.key(n, value);
    return { control: n, value, ...(key !== undefined ? { key } : {}) };
  }
}

/** The Bank Select controllers a preset select uses. */
function bankSelectCcs(p: Controls["presets"]): number[] {
  return !p ? [] : p.bank === "msb" ? [BANK_MSB] : p.bank === "lsb" ? [BANK_LSB] : p.bank === "msb-lsb" ? [BANK_MSB, BANK_LSB] : [];
}

function channelNibble(channel: number): number {
  if (!Number.isInteger(channel) || channel < 1 || channel > 16) throw new SafetyError(`MIDI channels are 1-16; ${channel} is not one`);
  return channel - 1;
}

/** One value as the messages its control's type needs. */
function messagesFor(c: Control, raw: number, ch: number): Uint8Array[] {
  if (c.type === "cc") return [Uint8Array.of(CC | ch, c.cc, raw)];
  if (c.type === "pc") return [Uint8Array.of(PC | ch, raw)];
  const out = [Uint8Array.of(CC | ch, NRPN_MSB, c.msb), Uint8Array.of(CC | ch, NRPN_LSB, c.lsb)];
  if (c.bits === 7) out.push(Uint8Array.of(CC | ch, DATA_MSB, raw));
  else out.push(Uint8Array.of(CC | ch, DATA_MSB, raw >> 7), Uint8Array.of(CC | ch, DATA_LSB, raw & 0x7f));
  return out;
}
