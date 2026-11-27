// The JSON Schema files the repo publishes, generated from the engine's zod schemas.

import { z } from "zod";
import { CAPTURE_VERSION, CaptureHeaderSchema, CaptureRecordSchema } from "../packages/engine/src/capture.ts";
import { MAP_CHECK_RECORD_VERSION, MAP_CHECK_STATE_VERSION, MapCheckRecordSchema, MapCheckStateSchema } from "../packages/engine/src/map-check-record.ts";
import { ProtocolSchema } from "../packages/engine/src/protocol-schema.ts";
import { SEED_PATCH_VERSION, SeedPatchSchema } from "../packages/engine/src/seed-patch.ts";

const ID = "https://github.com/patchsprite-app/patchsprite-sniffer/schemas";
const jsonSchema = (schema: z.ZodType) => z.toJSONSchema(schema, { target: "draft-2020-12", unrepresentable: "any" }) as Record<string, unknown>;
const text = (schema: object) => `${JSON.stringify(schema, null, 2)}\n`;

/** File name to its text. */
export function schemaFiles(): Record<string, string> {
  const seedPatch = {
    ...jsonSchema(SeedPatchSchema),
    $id: `${ID}/seed-patch.v${SEED_PATCH_VERSION}.schema.json`,
    title: "Patchsprite seed patch (proposal)",
    description:
      "Changes a unit's evidence makes to a seed device map, one change per entry, each with its evidence. Format: docs/formats/seed-patch.md. Further rules this schema can't state are in checkSeedPatch (packages/engine/src/seed-patch.ts).",
  };
  // the map as the open format states it: with its driver (parseDeviceMap); the loader's own checks are in code
  const map = jsonSchema(ProtocolSchema);
  const deviceMap = {
    ...map,
    required: [...new Set([...((map.required as string[] | undefined) ?? []), "driver"])],
    $id: `${ID}/device-map.v1.schema.json`,
    title: "Patchsprite device map: the protocol section",
    description:
      "A device map's protocol.json. Format: docs/formats/device-map.md. The cross-checks this schema can't state (cmds that clash, layouts that don't fit, limits across firmwares) are in parseDeviceMap (packages/engine/src/protocol-schema.ts).",
  };
  const captureLine = {
    ...jsonSchema(z.union([CaptureHeaderSchema, CaptureRecordSchema])),
    $id: `${ID}/capture-line.v${CAPTURE_VERSION}.schema.json`,
    title: "Patchsprite capture line",
    description:
      "One line of a capture file (JSON Lines): the header on the first line, a record on every other. Format: docs/formats/capture.md. Rules across lines are in parseCapture (packages/engine/src/capture.ts).",
  };
  const record = {
    ...jsonSchema(MapCheckRecordSchema),
    $id: `${ID}/map-check-record.v${MAP_CHECK_RECORD_VERSION}.schema.json`,
    title: "Patchsprite map-check record",
    description: "One check a unit made of its map entry, as an app logs it (one JSON object per line). packages/engine/src/map-check-record.ts.",
  };
  const state = {
    ...jsonSchema(MapCheckStateSchema),
    $id: `${ID}/map-check-state.v${MAP_CHECK_STATE_VERSION}.schema.json`,
    title: "Patchsprite map-check state",
    description: "The marks one device's map entries hold, per firmware the unit reported. packages/engine/src/map-check-record.ts.",
  };
  return {
    [`seed-patch.v${SEED_PATCH_VERSION}.schema.json`]: text(seedPatch),
    [`capture-line.v${CAPTURE_VERSION}.schema.json`]: text(captureLine),
    "device-map.v1.schema.json": text(deviceMap),
    [`map-check-record.v${MAP_CHECK_RECORD_VERSION}.schema.json`]: text(record),
    [`map-check-state.v${MAP_CHECK_STATE_VERSION}.schema.json`]: text(state),
  };
}
