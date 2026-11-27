import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { deviceMapPathIn, loadDeviceMapIn, modelMapsIn, openMidiTransport, PortBusyError, PortNotFoundError, writeFileAtomic, type RtMidiModule } from "../src/node/index.ts";

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
