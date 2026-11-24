// The JSON Schema files the repo publishes, generated from the engine's zod schemas.

import { z } from "zod";
import { SEED_PATCH_VERSION, SeedPatchSchema } from "../packages/engine/src/seed-patch.ts";

/** File name to its text. */
export function schemaFiles(): Record<string, string> {
  const seedPatch = {
    ...z.toJSONSchema(SeedPatchSchema, { target: "draft-2020-12", unrepresentable: "any" }),
    $id: `https://github.com/patchsprite-app/patchsprite-sniffer/schemas/seed-patch.v${SEED_PATCH_VERSION}.schema.json`,
    title: "Patchsprite seed patch (proposal)",
    description:
      "Changes a unit's evidence makes to a seed device map, one change per entry, each with its evidence. Format: docs/formats/seed-patch.md. Further rules this schema can't state are in checkSeedPatch (packages/engine/src/seed-patch.ts).",
  };
  return { [`seed-patch.v${SEED_PATCH_VERSION}.schema.json`]: `${JSON.stringify(seedPatch, null, 2)}\n` };
}
