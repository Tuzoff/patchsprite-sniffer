import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  compressLiteral,
  decompress,
  DeviceMapSchema,
  ENGINE_VERSION,
  entryFingerprint,
  fingerprint,
  LabelFormat,
  livenessRead,
  MapCheckRecordSchema,
  MapCheckStateSchema,
  MEASURED_FIELDS,
  measuredFieldSchema,
  MeasuredValueSchema,
  messageFramer,
  observeCodecUse,
  OUTCOMES,
  parseDeviceMap,
  parseProtocol,
  ProtocolCodec,
  ProtocolSchema,
  bestMidiPortMatches,
  ChannelCodec,
  weakest,
  type MeasuredField,
} from "../src/index.ts";

const fixture = (name: string) => new URL(`./fixtures/map-checks/${name}`, import.meta.url);
const vectors = JSON.parse(readFileSync(fixture("fingerprint-vectors.json"), "utf8"));
const rawMap = () => JSON.parse(readFileSync(fixture(vectors.entries.map), "utf8"));
const measuredValue = { value: 100, unit: "ms", measuredOn: "acme/fx-1 firmware 1.0.0", date: "2026-01-01", source: "manual" };

test("entry fingerprints and the map version match the shared vectors", () => {
  const protocol = parseProtocol(rawMap());
  assert.equal(fingerprint(protocol), vectors.entries.mapVersion);
  for (const e of vectors.entries.list as { firmware: string; entry: string; fp: string }[]) {
    assert.equal(entryFingerprint(protocol, e.firmware, e.entry), e.fp, `${e.firmware} ${e.entry}`);
  }
  assert.equal(entryFingerprint(protocol, "2.04", "noSuchMessage"), fingerprint(null));
});

test("a message encodes, frames, and reads back as itself through the map's framing", () => {
  const protocol = parseProtocol(rawMap());
  const codec = new ProtocolCodec(protocol, "2.04");
  const framer = messageFramer(protocol.transport);
  const sent = codec.encode("setScene", { scene: 5 });
  const wire = framer.frame({ cmd: sent.cmd, payload: sent.payload });
  assert.equal(wire[0], 0xf0);
  assert.equal(wire.at(-1), 0xf7);
  const inner = framer.decode(wire);
  assert.ok(inner.data);
  assert.deepEqual(codec.identify(sent.cmd, inner.data, "host"), ["setScene"]);
  assert.deepEqual(codec.decode("setScene", inner.data), { scene: 5 });
  assert.throws(() => codec.encode("setScene", { scene: 8 }), /scene/, "a value past the map's max is refused");
  assert.ok(Array.isArray(codec.lookalikes()));
});

test("the codec tells its observer what it encoded and decoded, and an observer that throws stops nothing", () => {
  const protocol = parseProtocol(rawMap());
  const codec = new ProtocolCodec(protocol, "2.04");
  const seen: string[] = [];
  observeCodecUse((p, use, message) => {
    assert.equal(p, protocol);
    seen.push(`${use} ${message}`);
  });
  try {
    const sent = codec.encode("setScene", { scene: 1 });
    codec.decode("setScene", sent.payload);
    assert.deepEqual(seen, ["encode setScene", "decode setScene"]);
    observeCodecUse(() => {
      throw new Error("observer down");
    });
    assert.equal(codec.decode("setScene", sent.payload).scene, 1);
  } finally {
    observeCodecUse(undefined);
  }
});

test("a map the sniffer builds states its driver; the loader reads one without it as patch-dump", () => {
  const { driver, ...noDriver } = rawMap();
  assert.equal(driver, "param-change");
  assert.equal(parseDeviceMap(rawMap()).driver, "param-change");
  assert.equal(DeviceMapSchema.safeParse(noDriver).success, false);
  assert.throws(() => parseDeviceMap(noDriver), /states its driver/);
  assert.equal(parseProtocol(noDriver).driver, undefined, "the loader still reads it, as a patch-dump map");
  assert.throws(() => parseProtocol({ ...rawMap(), driver: "rig" }), /renamed "param-change"/);
});

test("a measured value takes the one shared shape, in its field's unit and range; no older shape is read", () => {
  assert.ok(MeasuredValueSchema.safeParse(measuredValue).success);
  for (const field of Object.keys(MEASURED_FIELDS) as MeasuredField[]) {
    const { unit, max } = MEASURED_FIELDS[field];
    const schema = measuredFieldSchema(field);
    assert.ok(schema.safeParse({ ...measuredValue, unit, value: max }).success, field);
    assert.equal(schema.safeParse({ ...measuredValue, unit, value: max + 1 }).success, false, `${field} above its max`);
    assert.equal(schema.safeParse({ ...measuredValue, unit: unit === "ms" ? "s" : "ms" }).success, false, `${field} in another unit`);
    assert.equal(schema.safeParse({ ...measuredValue, unit, source: "probe" }).success, false, `${field} from an unknown source`);
    assert.equal(schema.safeParse(max).success, false, `${field} as a bare number`);
  }
  assert.equal(measuredFieldSchema("transport.timing.measured.roundTripMedianMs").safeParse({ ...measuredValue, value: 0 }).success, false, "a round trip takes time");
  const map = rawMap();
  map.transport.timing.compareToggle = { ms: 100, measuredOn: "x", date: "2026-01-01", source: "manual" };
  assert.equal(ProtocolSchema.safeParse(map).success, false, "the shape before the shared one is refused");
  map.transport.timing.compareToggle = measuredValue;
  assert.ok(ProtocolSchema.safeParse(map).success);
});

test("map-check records list every outcome, answered-on-resend among them", () => {
  assert.ok(OUTCOMES.includes("answered-on-resend"));
  const record = { at: "2026-01-01T00:00:00.000Z", map: "acme/rig-y", mapVersion: vectors.entries.mapVersion, firmware: "2.04", fp: "0123456789abcdef", entry: "getPreset" };
  for (const outcome of OUTCOMES) assert.ok(MapCheckRecordSchema.safeParse({ ...record, outcome }).success, outcome);
  assert.ok(MapCheckRecordSchema.safeParse({ ...record, outcome: "answered-on-resend", how: "resend" }).success);
  assert.equal(MapCheckRecordSchema.safeParse({ ...record, outcome: "lost" }).success, false);
  assert.equal(MapCheckRecordSchema.safeParse({ ...record, outcome: "confirms", map: "../etc" }).success, false, "a record names a device, never a path");
  assert.equal(MapCheckRecordSchema.safeParse({ ...record, outcome: "confirms", user: "someone" }).success, false);
  const state = { schema: 2, firmwares: { "2.04": { pins: { presetOrder: { option: "lsbFirst", fp: "a", at: "b" } }, entries: { getPreset: { trust: "verified", fp: "a", at: "b" } } } } };
  assert.ok(MapCheckStateSchema.safeParse(state).success);
  state.firmwares["2.04"].entries.getPreset.trust = "blocked";
  assert.ok(MapCheckStateSchema.safeParse(state).success, "a freeze blocks an entry by a mark");
  state.firmwares["2.04"].entries.getPreset.trust = "unchecked";
  assert.equal(MapCheckStateSchema.safeParse(state).success, false, "unchecked is no mark");
  const later = { ...state, firmwares: { "2.04": { pins: {}, entries: {}, unverifiable: { setGain: { fp: "a", at: "b" } }, laterRecord: {} } }, laterKey: 1 };
  assert.deepEqual(MapCheckStateSchema.parse(later), later, "a later build's keys are kept");
  assert.equal(weakest(["verified", "suspect", "shape-ok"]), "suspect");
});

test("the liveness read is the first bare safeRead request one reply answers; none marked, none given", () => {
  const map = rawMap();
  assert.equal(livenessRead(new ProtocolCodec(parseProtocol(map), "2.04")), undefined, "no safeRead: the driver asks the identity request");
  map.messages.setScene.safeRead = { fields: { scene: 1 } }; // sent with its own values: not bare
  assert.equal(livenessRead(new ProtocolCodec(parseProtocol(map), "2.04")), undefined, "a read that needs fields is no liveness read");
  map.messages.getPresetName.safeRead = true;
  map.messages.getPreset.safeRead = true;
  assert.equal(livenessRead(new ProtocolCodec(parseProtocol(map), "2.04")), "getPreset", "the first in the map's order");
});

test("LZO, labels and port names", () => {
  const data = Uint8Array.from({ length: 300 }, (_, i) => (i * 7) & 0xff);
  assert.deepEqual(decompress(compressLiteral(data)), data);
  const labels = new LabelFormat({ pattern: "{bank}-{slot}", bankSize: 4, firstBank: 1, firstSlot: 1 });
  assert.equal(labels.label(5), "2-2");
  assert.equal(labels.parse("2-2"), 5);
  const ports = ["Acme FX-1 MIDI", "2- Acme FX-1", "Acme FX-10"];
  assert.deepEqual(bestMidiPortMatches(ports, ["Acme FX-1"]).map((h) => h.port), [1]);
});

test("ENGINE_VERSION is package.json's version", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(ENGINE_VERSION, pkg.version);
});

test("a control-only map: channel messages only, encoded and heard by ChannelCodec", () => {
  const map = {
    schema: 1,
    driver: "control-only",
    transport: { framing: "midi-channel" },
    messages: {},
    layouts: {},
    controls: {
      channel: { default: 1 },
      items: { drive: { type: "nrpn", msb: 1, lsb: 2, bits: 14 }, scene: { type: "cc", cc: 20, max: 3 }, looper: { type: "cc", cc: 22, dir: "notify" } },
      presets: { count: 200, bank: "msb", perBank: 100 },
    },
  };
  const p = parseDeviceMap(map);
  const codec = new ChannelCodec(p.controls!);
  assert.deepEqual(codec.encode("scene", 2, 1).map((m) => [...m]), [[0xb0, 20, 2]]);
  assert.throws(() => codec.encode("scene", 4, 1), /scene/);
  assert.deepEqual(codec.preset(150, 2).map((m) => [...m]), [[0xb1, 0, 1], [0xc1, 50]]);
  assert.equal(codec.encode("drive", 16383, 1).length, 4, "CC99, CC98, then the value's top and low 7 bits");
  assert.ok(codec.decode(Uint8Array.of(0xb0, 22, 1), 1));
  assert.throws(() => parseDeviceMap({ ...map, driver: "param-change" }), /needs driver "control-only"/);
  assert.throws(() => parseDeviceMap({ ...map, messages: { x: { cmd: "01", dir: "send" } } }), /sends no SysEx/);
});
