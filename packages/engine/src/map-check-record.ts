// The records an app keeps of a unit's map checks (map-checks.ts): one log line per check, and a state file of the
// marks each entry holds per firmware. A sniffer capture or a seed patch can carry the same records as evidence, so
// their shapes are here, and published as JSON Schemas (schemas/map-check-record.v1.schema.json,
// schemas/map-check-state.v2.schema.json). A record names the device by make and model and the firmware the unit
// reports, never a person, machine or path.

import { z } from "zod";
import { OUTCOMES, type TrustLevel } from "./map-checks.ts";

/** The levels a mark can hold: `blocked` comes from the map and `unchecked` is no mark. */
export const MARKED_LEVELS = ["unsupported", "suspect", "shape-ok", "player-confirmed", "verified"] as const satisfies readonly TrustLevel[];

const fp = z.string().max(64);
const at = z.string().max(64);
const entry = z.string().max(256);
const firmware = z.string().max(64);

/** When an entry or pin reached its mark, and the fingerprint of the claim it is about. */
export const MarkSchema = z.strictObject({ fp, at });

/** One entry's mark on one firmware. */
export const EntryMarkSchema = MarkSchema.extend({
  trust: z.enum(MARKED_LEVELS),
  /** for suspect and unsupported: why */
  why: z.string().max(1024).optional(),
  /** for unsupported: the build of the app that could not run it */
  app: z.string().max(64).optional(),
});
export type EntryMark = z.infer<typeof EntryMarkSchema>;

/** The choices a unit has settled: choice name -> the option it showed. */
export const PinsSchema = z.record(z.string().max(128), MarkSchema.extend({ option: z.string().max(64) }));

export const FirmwareChecksSchema = z.strictObject({ pins: PinsSchema, entries: z.record(entry, EntryMarkSchema) });
export type FirmwareChecks = z.infer<typeof FirmwareChecksSchema>;

/** The state file: one device's marks, per firmware the unit reported. */
export const MAP_CHECK_STATE_VERSION = 2;
export const MapCheckStateSchema = z.strictObject({ schema: z.literal(MAP_CHECK_STATE_VERSION), firmwares: z.record(firmware, FirmwareChecksSchema) });
export type MapCheckState = z.infer<typeof MapCheckStateSchema>;

/** One log line: a check as it happened (an Observation, with where and when). */
export const MAP_CHECK_RECORD_VERSION = 1;
export const MapCheckRecordSchema = z.strictObject({
  /** ISO 8601 time, UTC */
  at,
  /** `<make>/<device>` */
  map: z.string().max(129).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/),
  /** fingerprint of the whole map */
  mapVersion: fp,
  firmware,
  /** fingerprint of the entry's definition */
  fp,
  entry,
  outcome: z.enum(OUTCOMES),
  how: z.string().max(64).optional(),
  claimed: z.json().optional(),
  observed: z.json().optional(),
  why: z.string().max(1024).optional(),
  strikes: z.number().int().min(1).max(1000).optional(),
});
export type MapCheckRecord = z.infer<typeof MapCheckRecordSchema>;
