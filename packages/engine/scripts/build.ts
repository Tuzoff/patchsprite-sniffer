// Builds the package: compiled JS and .d.ts files in dist/, from src/ (npm run build). TypeScript rewrites the relative
// `.ts` imports of the JS it emits but not of the declarations, so those are rewritten here, and dist/ is made afresh
// each time so nothing removed from src/ stays behind.

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const pkg = fileURLToPath(new URL("..", import.meta.url));
const dist = join(pkg, "dist");
rmSync(dist, { recursive: true, force: true });
const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
execFileSync(process.execPath, [tsc, "-p", join(pkg, "tsconfig.build.json")], { stdio: "inherit" });

const relativeTs = /(from\s+|import\(\s*)(["'])(\.{1,2}\/[^"']*)\.ts\2/g;
const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
for (const file of walk(dist).filter((f) => f.endsWith(".d.ts"))) {
  const text = readFileSync(file, "utf8");
  const out = text.replace(relativeTs, (_m, lead: string, q: string, path: string) => `${lead}${q}${path}.js${q}`);
  if (out !== text) writeFileSync(file, out);
}
