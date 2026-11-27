// Builds the package: compiled JS and .d.ts files in dist/, from src/, and the pedal-lock command in dist/bin/ (npm run
// build). TypeScript rewrites the relative `.ts` imports of the JS it emits but not of the declarations, so those are
// rewritten here; the command is compiled on its own and pointed at dist/'s modules. dist/ is made afresh each time,
// so nothing removed from src/ stays behind.

import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const pkg = fileURLToPath(new URL("..", import.meta.url));
const dist = join(pkg, "dist");
rmSync(dist, { recursive: true, force: true });
const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
const compile = (config: string) => execFileSync(process.execPath, [tsc, "-p", join(pkg, config)], { stdio: "inherit" });
compile("tsconfig.build.json");

// the command: compiled with what it imports from src/, which dist/ already has, so only its own file is kept
compile("tsconfig.bin.json");
const scratch = join(dist, "bin-build");
mkdirSync(join(dist, "bin"));
for (const f of readdirSync(join(scratch, "bin")).filter((f) => f.endsWith(".js"))) {
  const out = join(dist, "bin", f);
  writeFileSync(out, readFileSync(join(scratch, "bin", f), "utf8").replace(/(["'])\.\.\/src\//g, "$1../"));
  chmodSync(out, 0o755);
}
rmSync(scratch, { recursive: true, force: true });

const relativeTs = /(from\s+|import\(\s*)(["'])(\.{1,2}\/[^"']*)\.ts\2/g;
const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
for (const file of walk(dist).filter((f) => f.endsWith(".d.ts"))) {
  const text = readFileSync(file, "utf8");
  const out = text.replace(relativeTs, (_m, lead: string, q: string, path: string) => `${lead}${q}${path}.js${q}`);
  if (out !== text) writeFileSync(file, out);
}
