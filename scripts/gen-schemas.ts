// Writes the JSON Schemas in schemas/ from the engine's zod schemas. `npm run schemas` after changing a schema; a
// test fails while a committed file is out of date. Rules a JSON Schema can't state (checkSeedPatch) are only in code.

import { writeFileSync } from "node:fs";
import { schemaFiles } from "./schemas.ts";

for (const [file, text] of Object.entries(schemaFiles())) writeFileSync(new URL(`../schemas/${file}`, import.meta.url), text);
