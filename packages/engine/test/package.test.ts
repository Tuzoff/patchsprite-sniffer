// The package as an app takes it: the build (npm run build, which npm test runs first), its exports map, and a main
// entry that runs in a browser (no Node API anywhere in what it imports).

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const pkgDir = fileURLToPath(new URL("..", import.meta.url));
const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));

/** Every module a file imports, following relative imports: the files reached, and the bare specifiers seen. */
function importGraph(entry: string): { files: Set<string>; bare: Set<string> } {
  const files = new Set<string>();
  const bare = new Set<string>();
  const todo = [entry];
  while (todo.length) {
    const file = todo.pop()!;
    if (files.has(file)) continue;
    files.add(file);
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/^\s*(?:import|export)\s[^;]*?\sfrom\s+"([^"]+)"|^\s*import\s+"([^"]+)"|import\(\s*"([^"]+)"\s*\)/gms)) {
      const spec = m[1] ?? m[2] ?? m[3];
      if (spec.startsWith(".")) todo.push(resolve(dirname(file), spec));
      else bare.add(spec);
    }
  }
  return { files, bare };
}

test("the main entry is browser-safe: it imports no Node API and none of the Node-only code", () => {
  for (const entry of [join(pkgDir, "src", "index.ts"), join(pkgDir, "dist", "index.js")]) {
    const { files, bare } = importGraph(entry);
    assert.deepEqual([...bare].sort(), ["zod"], `${entry} imports only zod`);
    assert.ok(![...files].some((f) => /^(src|dist)[\\/]node[\\/]/.test(relative(pkgDir, f))), `${entry} reaches no file under node/`);
    assert.ok(files.size > 10, "the graph was followed");
  }
});

test("the exports map points at built files, with types, and the Node-only entry only under the node condition", () => {
  for (const [sub, target] of Object.entries(pkg.exports as Record<string, string | Record<string, string>>)) {
    for (const file of typeof target === "string" ? [target] : Object.values(target)) assert.ok(existsSync(join(pkgDir, file)), `${sub}: ${file} is built`);
  }
  assert.deepEqual(Object.keys(pkg.exports["./node"]), ["types", "node"]);
  const dts = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? dts(join(dir, e.name)) : e.name.endsWith(".d.ts") ? [join(dir, e.name)] : []));
  for (const f of dts(join(pkgDir, "dist"))) assert.doesNotMatch(readFileSync(f, "utf8"), /from\s+["']\.{1,2}\/[^"']*\.ts["']/, `${f} imports .js files`);
});

test("the built package exports what an app imports from it, by its own name", async () => {
  const main = await import("@patchsprite/engine");
  for (const name of [
    "ProtocolSchema", "parseProtocol", "parseDeviceMap", "ProtocolCodec", "messageFramer", "AddressFramer", "AddressReassembler", "addressValue",
    "addressBytes", "decompress", "LabelFormat", "bestMidiPortMatches", "canonicalJson", "fingerprint", "sha256Hex", "entryFingerprint",
    "TRUST_LEVELS", "weakest", "OUTCOMES", "SourceSchema", "MeasuredValueSchema", "MEASURED_FIELDS", "cmdsOverlap", "BlockedCmds",
    "MapCheckRecordSchema", "MapCheckStateSchema", "observeCodecUse", "ENGINE_VERSION",
  ]) assert.ok(name in main, `main exports ${name}`);
  const node = await import("@patchsprite/engine/node");
  for (const name of ["writeFileAtomic", "loadDeviceMapIn", "modelMapsIn", "acquirePedalLock", "setPedalLockHome", "openMidiTransport", "dataHome"]) {
    assert.ok(name in node, `node exports ${name}`);
  }
  assert.equal(main.ENGINE_VERSION, pkg.version);
});
