import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  acquirePedalLock,
  dataHome,
  defaultDataHome,
  deviceMapPathIn,
  foreignPedalLock,
  loadDeviceMapIn,
  modelMapsIn,
  openMidiTransport,
  PEDAL_LOCK_MAX_AGE_MS,
  PEDAL_LOCK_TOKEN_ENV,
  pedalLockPath,
  PortBusyError,
  PortNotFoundError,
  readPedalLock,
  releasePedalLock,
  setPedalLockHome,
  writeFileAtomic,
  type RtMidiModule,
} from "../src/node/index.ts";

const vectorsMap = fileURLToPath(new URL("./fixtures/map-checks/vectors-map.json", import.meta.url));
const temp = (t: { after: (fn: () => void) => void }) => {
  const dir = mkdtempSync(join(tmpdir(), "engine-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test("writeFileAtomic replaces a file whole and leaves no temp file", (t) => {
  const dir = temp(t);
  const file = join(dir, "state.json");
  writeFileAtomic(file, "one");
  writeFileAtomic(file, "two");
  assert.equal(readFileSync(file, "utf8"), "two");
  assert.throws(() => writeFileAtomic(join(dir, "missing", "x.json"), "x"));
});

test("device maps load from a folder, with the protocol beside them; a name part can't leave it", (t) => {
  const dir = temp(t);
  mkdirSync(join(dir, "acme", "rig-y"), { recursive: true });
  writeFileSync(join(dir, "acme", "rig-y", "protocol.json"), readFileSync(vectorsMap));
  const model = { device: "rig-y", firmware: "2.04", modules: { amp: 1 }, models: [{ module: "amp", model: "clean", code: "0x1", params: null, evidence: ["made up"] }] };
  writeFileSync(join(dir, "acme", "rig-y", "2.04.json"), JSON.stringify(model));
  writeFileSync(join(dir, "acme", "rig-y", "notes.json"), "{}");
  const map = loadDeviceMapIn(dir, "acme", "rig-y", "2.04");
  assert.equal(map.protocol?.driver, "param-change");
  assert.deepEqual(modelMapsIn(join(dir, "acme", "rig-y")).map((m) => m.firmware), ["2.04"], "a file that is no model map is skipped");
  assert.throws(() => deviceMapPathIn(dir, "acme", "rig-y", "../../x"), /not a valid device map name part/);
  assert.throws(() => loadDeviceMapIn(dir, "acme", "rig-y", "9.99"), /no device map for acme rig-y 9.99/);
});

test("the data folder: PATCHSPRITE_HOME when absolute, refused when relative, else the platform default", () => {
  const home = join(tmpdir(), "ps-home");
  assert.equal(dataHome({ PATCHSPRITE_HOME: home }), home);
  assert.throws(() => dataHome({ PATCHSPRITE_HOME: "relative" }), /absolute/);
  assert.equal(defaultDataHome({}, { platform: "win32", home: "C:\\Users\\x" }), join("C:\\Users\\x", "Claude", "Patchsprite"));
  assert.equal(defaultDataHome({ XDG_DATA_HOME: "/data" }, { platform: "linux", home: "/home/x" }), join("/data", "patchsprite"));
});

test("the pedal lock: one holder, its token lets its own processes through, and it goes stale after its max age", (t) => {
  const dir = temp(t);
  const env = { PATCHSPRITE_HOME: dir };
  assert.equal(pedalLockPath(env), join(dir, "pedal.lock"));
  const got = acquirePedalLock("editor walk", { env, token: "secret" });
  assert.ok(got.ok);
  const again = acquirePedalLock("other", { env });
  assert.ok(!again.ok && again.holder.owner === "editor walk");
  assert.equal(foreignPedalLock({ ...env, [PEDAL_LOCK_TOKEN_ENV]: "secret" }), undefined, "the holder's token is its own");
  assert.equal(foreignPedalLock({ ...env, [PEDAL_LOCK_TOKEN_ENV]: "other" })?.owner, "editor walk");
  const file = JSON.parse(readFileSync(join(dir, "pedal.lock"), "utf8"));
  assert.deepEqual(Object.keys(file).sort(), ["owner", "pid", "startedAt", "tokenHash"], "the file format the app reads");
  mock.timers.enable({ apis: ["Date"], now: Date.now() });
  try {
    mock.timers.tick(PEDAL_LOCK_MAX_AGE_MS - 1000);
    assert.ok(readPedalLock(env), "still live just before its max age");
    mock.timers.tick(2000);
    assert.equal(readPedalLock(env), undefined, "stale after it");
    assert.ok(acquirePedalLock("taker", { env }).ok, "a stale lock is taken over");
  } finally {
    mock.timers.reset();
  }
  assert.equal(releasePedalLock(got.lock, env), false, "a lock taken over is no longer the first holder's to release");
});

test("an app sets where the lock lives", (t) => {
  const dir = temp(t);
  setPedalLockHome(() => dir);
  try {
    assert.equal(pedalLockPath({}), join(dir, "pedal.lock"));
  } finally {
    setPedalLockHome(dataHome);
  }
});

test("pedal-lock.mjs takes the lock while its command runs, in the shared file", (t) => {
  const dir = temp(t);
  const bin = fileURLToPath(new URL("../bin/pedal-lock.mjs", import.meta.url));
  const env: NodeJS.ProcessEnv = { ...process.env, PATCHSPRITE_HOME: dir };
  delete env[PEDAL_LOCK_TOKEN_ENV];
  assert.equal(execFileSync(process.execPath, [bin, "status"], { env, encoding: "utf8" }).trim(), "free");
  const probe = `process.stdout.write(require("node:fs").readFileSync(${JSON.stringify(join(dir, "pedal.lock"))}, "utf8"))`;
  const r = spawnSync(process.execPath, [bin, "run", "--owner", "test walk", "--", process.execPath, "-e", probe], { env, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).owner, "test walk");
  assert.equal(execFileSync(process.execPath, [bin, "status"], { env, encoding: "utf8" }).trim(), "free", "released when the command ends");
});

/** A made-up RtMidi binding: its ports, and what was opened, sent and destroyed. */
function fakeMidi(ports: string[], opts: { busy?: boolean } = {}) {
  const log: string[] = [];
  let onMessage: (dt: number, msg: number[]) => void = () => {};
  class Input {
    static getPortNames = () => ports;
    ignoreTypes() {}
    on(_e: "message", cb: (dt: number, msg: number[]) => void) {
      onMessage = cb;
    }
    openPort(i: number) {
      if (opts.busy) throw new Error("in use");
      log.push(`in ${i}`);
    }
    destroy() {
      log.push("in destroyed");
    }
  }
  class Output {
    static getPortNames = () => ports;
    sendMessage(m: number[]) {
      log.push(`sent ${m.join(",")}`);
    }
    openPort(i: number) {
      log.push(`out ${i}`);
    }
    destroy() {
      log.push("out destroyed");
    }
  }
  return { midi: { Input, Output } as RtMidiModule, log, receive: (m: number[]) => onMessage(0, m) };
}

test("the RtMidi transport opens the one port that names the device, and destroys both handles", () => {
  const { midi, log, receive } = fakeMidi(["Other MIDI", "2- Acme FX-1"]);
  const t = openMidiTransport(midi, "Acme FX-1");
  const heard: number[][] = [];
  t.onData((c) => heard.push([...c]));
  t.send(Uint8Array.of(0xf0, 0x7d, 0xf7));
  receive([0xf0, 0x7d, 0x01, 0xf7]);
  t.close();
  assert.deepEqual(log, ["in 1", "out 1", "sent 240,125,247", "in destroyed", "out destroyed"]);
  assert.deepEqual(heard, [[0xf0, 0x7d, 0x01, 0xf7]]);
  assert.throws(() => openMidiTransport(fakeMidi(["Other"]).midi, "Acme FX-1"), PortNotFoundError);
  assert.throws(() => openMidiTransport(fakeMidi(["Acme FX-1", "2- Acme FX-1"]).midi, "Acme FX-1"), (e) => e instanceof PortNotFoundError && e.ambiguous);
  const busy = fakeMidi(["Acme FX-1"], { busy: true });
  assert.throws(() => openMidiTransport(busy.midi, "Acme FX-1"), PortBusyError);
  assert.deepEqual(busy.log, ["in destroyed", "out destroyed"], "a port that won't open leaves no handle held");
});
