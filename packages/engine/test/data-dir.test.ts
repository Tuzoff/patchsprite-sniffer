// The data folder (src/data-dir.ts): PATCHSPRITE_HOME, then <home>\Claude\Patchsprite on Windows or the XDG data
// folder elsewhere. Temp folders only, so this computer's real folders are never looked at.

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { dataHome, defaultDataHome } from "../src/data-dir.ts";
import { pedalLockPath } from "../src/pedal-lock.ts";

const temp = () => mkdtempSync(join(tmpdir(), "patchsprite-home-"));

test("PATCHSPRITE_HOME comes first, then <home>\\Claude\\Patchsprite on Windows, Application Support on a Mac, the XDG data folder elsewhere", () => {
  const home = temp();
  const set = join(home, "elsewhere");
  const win = { platform: "win32" as const, home };
  assert.equal(dataHome({ PATCHSPRITE_HOME: set }, win), set);
  assert.equal(dataHome({}, win), join(home, "Claude", "Patchsprite"));
  assert.equal(dataHome({ PATCHSPRITE_HOME: "" }, win), join(home, "Claude", "Patchsprite"), "empty counts as unset");
  assert.equal(dataHome({}, { platform: "linux", home }), join(home, ".local", "share", "patchsprite"));
  assert.equal(dataHome({ XDG_DATA_HOME: join(home, "xdg") }, { platform: "linux", home }), join(home, "xdg", "patchsprite"));
  assert.equal(dataHome({ XDG_DATA_HOME: join(home, "xdg") }, { platform: "darwin", home }), join(home, "Library", "Application Support", "Patchsprite"), "a Mac reads no XDG folder");
  const simMac = { PATCHSPRITE_TRANSPORT: "sim", PATCHSPRITE_SIM_OS: "darwin" };
  assert.equal(dataHome(simMac, { platform: "linux", home }), join(home, "Library", "Application Support", "Patchsprite"), "the app's simulator stands in for a Mac off Windows");
  assert.equal(dataHome({ PATCHSPRITE_SIM_OS: "darwin" }, { platform: "linux", home }), join(home, ".local", "share", "patchsprite"), "only under the simulator");
  assert.equal(defaultDataHome({ XDG_DATA_HOME: "relative" }, { platform: "linux", home }), join(home, ".local", "share", "patchsprite"), "a relative XDG_DATA_HOME is ignored");
  assert.throws(() => dataHome({ PATCHSPRITE_HOME: "rel" }), /PATCHSPRITE_HOME must be an absolute path/, "a relative one would differ per process");
});

test("LOCALAPPDATA never moves the data folder (Claude Desktop's package redirects it)", () => {
  const home = temp();
  assert.equal(dataHome({ LOCALAPPDATA: join(home, "local") }, { platform: "win32", home }), join(home, "Claude", "Patchsprite"));
});

test("the lock is pedal.lock in the data folder, where the Patchsprite app looks for it", () => {
  const home = temp();
  assert.equal(pedalLockPath({ PATCHSPRITE_HOME: home }), join(home, "pedal.lock"));
});
