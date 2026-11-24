import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { schemaFiles } from "../../../scripts/schemas.ts";
import { fingerprint } from "../src/canonical-json.ts";
import { MAX_PATCH_BYTES, applySeedPatch, hasEntry, parseEntry, parseSeedPatch, reviewReasons, type Change, type Evidence, type SeedPatch } from "../src/seed-patch.ts";

const fixture = (name: string) => readFileSync(new URL(`../../../test/fixtures/seed-patch/${name}`, import.meta.url), "utf8");
const seed = () => JSON.parse(fixture("acme-fx-1.seed.json"));
const example = (): SeedPatch => {
  const r = parseSeedPatch(fixture("acme-fx-1.patch.json"));
  assert.ok(r.ok, JSON.stringify(!r.ok && r.issues));
  return r.patch;
};
/** The example patch with its changes swapped for these. */
const withChanges = (...changes: Change[]): SeedPatch => ({ ...example(), changes });
const messages = (p: SeedPatch) => {
  const r = parseSeedPatch(p);
  return r.ok ? [] : r.issues.map((i) => i.message);
};

const probeOk: Evidence = { kind: "probe", at: "2026-11-24T18:00:01Z", request: "getPreset", sent: "f0 7d 01 10 f7", replies: ["f0 7d 01 11 05 f7"], result: "shape-ok" };
const probeSilent: Evidence = { ...probeOk, replies: [], result: "silent" };
const capture: Evidence = { kind: "capture", source: "walk-1", records: [1] };

test("the example patch parses, applies change by change and leaves the seed untouched", () => {
  const map = seed();
  const before = structuredClone(map);
  const { map: out, rebased, results } = applySeedPatch(map, example());
  assert.deepEqual(map, before);
  assert.equal(rebased, false);
  assert.deepEqual(
    results.map((r) => `${r.change}:${r.status}`),
    ["get-preset:marked", "set-preset:marked", "name-length:applied", "amp-bypass:marked", "tempo:applied", "preset-count:applied", "amp-level:applied", "factory-reset:marked"],
  );
  const m = out as typeof before;
  assert.equal(m.messages.nameReply.payload.fields[0].length, 16);
  assert.equal(m.messages.setTempo.cmd, "40");
  assert.deepEqual(m.firmwares, { "1.20": { constants: { presetCount: 100 } } });
  assert.equal(m.parameters.groups.amp.params.level, undefined);
  assert.ok(hasEntry(m, "param/amp/1", "1.20"));
  assert.ok(!hasEntry(m, "param/amp/2", "1.20"));
});

test("the committed JSON Schema is the one the zod schema generates", () => {
  for (const [file, text] of Object.entries(schemaFiles())) {
    assert.equal(readFileSync(new URL(`../../../schemas/${file}`, import.meta.url), "utf8"), text, `schemas/${file} is out of date: npm run schemas`);
  }
});

test("entry names: the app's map-check kinds and the ones a patch adds", () => {
  assert.deepEqual(parseEntry("getPreset"), { kind: "message", message: "getPreset" });
  assert.deepEqual(parseEntry("setBypass/amp"), { kind: "message", message: "setBypass", block: "amp" });
  assert.deepEqual(parseEntry("param/amp/12"), { kind: "param", block: "amp", id: 12 });
  assert.deepEqual(parseEntry("choice/presetOrder"), { kind: "choice", name: "presetOrder" });
  assert.deepEqual(parseEntry("layout/patch"), { kind: "layout", name: "patch" });
  assert.deepEqual(parseEntry("setting/input_level"), { kind: "setting", id: "input_level" });
  assert.deepEqual(parseEntry("transport"), { kind: "section", section: "transport" });
  for (const bad of ["", "GetPreset", "param/amp", "param/amp/x", "param/amp/012", "choice", "transport/x", "a/b/c", "get-preset", "setting/Input"]) {
    assert.equal(parseEntry(bad), null, bad);
  }
});

test("ops must fit the action and stay inside the entry, in the unit's own firmware", () => {
  const rep = (path: string): Change => ({ id: "c", entry: "nameReply", action: "repair", source: "wire", ops: [{ op: "replace", path, value: 1, was: fingerprint(12) }], evidence: [capture] });
  assert.deepEqual(messages(withChanges(rep("/messages/nameReply/payload/fields/0/length"))), []);
  assert.deepEqual(messages(withChanges(rep("/firmwares/1.20/messages/nameReply"))), []);
  assert.match(messages(withChanges(rep("/messages/getName")))[0], /outside entry nameReply/);
  assert.match(messages(withChanges(rep("/firmwares/1.10/messages/nameReply")))[0], /another firmware's delta/);
  assert.match(messages(withChanges(rep("/messagesX/nameReply")))[0], /outside/);

  const confirmWithOps: Change = { ...rep("/messages/nameReply"), action: "confirm", source: "read-back", evidence: [probeOk] };
  assert.ok(messages(withChanges(confirmWithOps)).some((m) => /carries no ops/.test(m)));
  const { ops: _, ...repairNoOps } = rep("/messages/nameReply");
  assert.ok(messages(withChanges(repairNoOps)).some((m) => /repair needs ops/.test(m)));
  assert.ok(messages(withChanges({ ...rep("/messages/nameReply"), action: "add", entryFp: null })).some((m) => /an add only adds/.test(m)));
  assert.ok(messages(withChanges({ id: "c", entry: "nameReply", action: "remove", ops: [{ op: "add", path: "/messages/nameReply/x", value: 1 }], evidence: [capture] })).some((m) => /a remove only removes/.test(m)));
  assert.ok(messages(withChanges({ id: "c", entry: "nameReply", action: "add", source: "wire", entryFp: "0123456789abcdef", ops: [{ op: "add", path: "/messages/nameReply/x", value: 1 }], evidence: [capture] })).some((m) => /base map lacks/.test(m)));
  assert.ok(messages(withChanges({ id: "c", entry: "nameReply", action: "repair", source: "wire", entryFp: null, ops: [{ op: "add", path: "/messages/nameReply/x", value: 1 }], evidence: [capture] })).some((m) => /needs an entry the base map has/.test(m)));
  assert.ok(messages(withChanges({ id: "c", entry: "fields", action: "add", source: "wire", ops: [{ op: "add", path: "/messages/fields/0", value: 1 }], evidence: [capture] })).some((m) => /appends to an array with -/.test(m)));
  assert.ok(messages(withChanges({ id: "c", entry: "setBypass/amp", action: "repair", source: "wire", ops: [{ op: "add", path: "/messages/setBypass/x", value: 1 }], evidence: [capture] })).some((m) => /one block is for marks/.test(m)));
  assert.match(messages(withChanges({ id: "c", entry: "layout", action: "suspect", evidence: [probeSilent] }))[0], /not an entry name/, "a kind word is never a message name");
  assert.ok(messages(withChanges({ id: "c", entry: "driver", action: "suspect", evidence: [probeSilent] })).length === 0);
});

test("one change per entry and per place in the map", () => {
  const a: Change = { id: "a", entry: "getPreset", action: "suspect", evidence: [probeSilent] };
  assert.ok(messages(withChanges(a, { ...a })).some((m) => /used twice/.test(m)));
  assert.ok(messages(withChanges(a, { ...a, id: "b" })).some((m) => /two changes/.test(m)));
  const layout: Change = { id: "l", entry: "layout/patch", action: "add", source: "wire", ops: [{ op: "add", path: "/layouts/patch", value: { fields: [] } }], evidence: [capture] };
  const inner: Change = { ...layout, id: "m", entry: "constant/x", ops: [{ op: "add", path: "/constants/x", value: 1 }] };
  assert.deepEqual(messages(withChanges(layout, inner)), []);
  // two entries whose homes meet: a section and an entry inside it
  const transport: Change = { id: "t", entry: "transport", action: "repair", source: "wire", ops: [{ op: "replace", path: "/transport/endian", value: "be", was: fingerprint("le") }], evidence: [capture] };
  const transport2: Change = { ...transport, id: "u", entry: "safety", ops: [{ op: "replace", path: "/safety", value: {}, was: fingerprint({}) }] };
  assert.deepEqual(messages(withChanges(transport, transport2)), []);
  const param1: Change = { id: "p1", entry: "param/amp/1", action: "repair", source: "wire", ops: [{ op: "replace", path: "/parameters/groups/amp/params/gain/kind", value: "slider", was: fingerprint("knob") }], evidence: [capture] };
  const param2: Change = { ...param1, id: "p2", entry: "param/amp/7", ops: [{ op: "replace", path: "/parameters/groups/amp/params/gain", value: {}, was: fingerprint({}) }] };
  assert.ok(messages(withChanges(param1, param2)).some((m) => /overlaps an edit of changes\[0\]/.test(m)));
});

test("a change claims no more trust than its evidence shows", () => {
  const confirm = (source: Change["source"], evidence: Change["evidence"]): Change => ({ id: "c", entry: "getPreset", action: "confirm", source, evidence });
  assert.deepEqual(messages(withChanges(confirm("read-back", [probeOk]))), []);
  assert.match(messages(withChanges(confirm("replay-verified", [probeOk])))[0], /no evidence backs "replay-verified"/);
  assert.match(messages(withChanges(confirm("wire", [{ kind: "doc", citation: "manual" }])))[0], /no evidence backs "wire"/);
  assert.deepEqual(messages(withChanges(confirm("player-confirmed", [{ kind: "player", at: "2026-11-24T18:00:00Z", question: "Did the unit switch to preset 12?", answer: "yes" }]))), []);
  assert.match(messages(withChanges(confirm("player-confirmed", [{ kind: "player", at: "2026-11-24T18:00:00Z", question: "Did it switch?", answer: "no" }])))[0], /no evidence backs/);
  assert.ok(messages(withChanges(confirm("read-back", [probeOk, probeSilent]))).some((m) => /that is a suspect/.test(m)));
  assert.ok(messages(withChanges({ ...confirm(undefined, [probeOk]) })).some((m) => /states the source/.test(m)));
  assert.ok(messages(withChanges({ id: "c", entry: "getPreset", action: "suspect", evidence: [probeOk] })).some((m) => /needs evidence against/.test(m)));
  assert.ok(messages(withChanges({ id: "c", entry: "getPreset", action: "suspect", source: "wire", evidence: [probeSilent] })).some((m) => /gives the entry no source/.test(m)));
  assert.ok(messages(withChanges({ id: "c", entry: "factoryReset", action: "block", evidence: [probeSilent] })).some((m) => /freeze or a document/.test(m)));
  const freeze: Evidence = { kind: "freeze", at: "2026-11-24T18:00:00Z", sent: "f0 7d 01 7f f7", recovery: "power-cycle" };
  assert.deepEqual(messages(withChanges({ id: "c", entry: "factoryReset", action: "block", evidence: [freeze] })), []);
  assert.ok(messages(withChanges({ id: "c", entry: "getPreset", action: "suspect", evidence: [{ kind: "capture", source: "nope" }, probeSilent] })).some((m) => /no source "nope"/.test(m)));
});

test("the schema refuses what a patch may not hold", () => {
  const p = JSON.parse(fixture("acme-fx-1.patch.json"));
  const refused = (mutate: (x: typeof p) => void) => {
    const x = structuredClone(p);
    mutate(x);
    return !parseSeedPatch(x).ok;
  };
  assert.ok(refused((x) => (x.format = "other")));
  assert.ok(refused((x) => (x.version = 2)));
  assert.ok(refused((x) => (x.unit.port = "MIDI 2")), "no port names, paths or people");
  assert.ok(refused((x) => (x.changes[0].evidence[0].sent = "F0 7D")), "bytes are lowercase hex");
  assert.ok(refused((x) => (x.changes[0].entry = "get-preset")));
  assert.ok(refused((x) => (x.changes[0].source = "test")), "test provenance is for the app's own test maps");
  assert.ok(refused((x) => (x.changes[2].ops[0].was = undefined)), "a replace says what it replaces");
  assert.ok(refused((x) => (x.changes[2].ops[0].path = "/")), "never the whole map");
  assert.ok(refused((x) => (x.changes = [])));
  assert.ok(!parseSeedPatch(" ".repeat(MAX_PATCH_BYTES + 1)).ok);
  assert.throws(() => parseSeedPatch("{"), SyntaxError);
});

test("applying: stale changes are left out, the rest still land", () => {
  const map = seed();
  map.messages.nameReply.payload.fields[0].length = 14; // the seed moved on since the patch was made
  const { map: out, rebased, results } = applySeedPatch(map, example());
  assert.equal(rebased, true);
  const name = results.find((r) => r.change === "name-length")!;
  assert.equal(name.status, "stale");
  assert.match(name.why!, /the patch expected/);
  assert.equal((out as typeof map).messages.nameReply.payload.fields[0].length, 14);
  assert.equal(results.find((r) => r.change === "tempo")!.status, "applied");

  map.messages.setTempo = { cmd: "40", dir: "send" };
  const again = applySeedPatch(map, example()).results.find((r) => r.change === "tempo")!;
  assert.deepEqual([again.status, again.why], ["stale", "/messages/setTempo: already there"]);
});

test("applying: only the accepted changes, all or nothing each, and they must do what they say", () => {
  const { results } = applySeedPatch(seed(), example(), new Set(["tempo"]));
  assert.deepEqual(results.filter((r) => r.status !== "skipped").map((r) => r.change), ["tempo"]);

  const twoOps: Change = {
    id: "c",
    entry: "nameReply",
    action: "repair",
    source: "wire",
    ops: [
      { op: "replace", path: "/messages/nameReply/cmd", value: "32", was: fingerprint("31") },
      { op: "remove", path: "/messages/nameReply/nothing", was: fingerprint(1) },
    ],
    evidence: [capture],
  };
  const r = applySeedPatch(seed(), withChanges(twoOps));
  assert.equal(r.results[0].status, "stale");
  assert.equal((r.map as ReturnType<typeof seed>).messages.nameReply.cmd, "31", "the first op is rolled back");

  // a repair that moves the parameter off its id no longer has the entry it repairs
  const moved: Change = { id: "c", entry: "param/amp/1", action: "repair", source: "wire", ops: [{ op: "replace", path: "/parameters/groups/amp/params/gain/id", value: 5, was: fingerprint(1) }], evidence: [capture] };
  assert.equal(applySeedPatch(seed(), withChanges(moved)).results[0].status, "refused");
  const notGone: Change = { id: "c", entry: "param/amp/1", action: "remove", ops: [{ op: "remove", path: "/parameters/groups/amp/params/level", was: fingerprint({ id: 2, kind: "knob" }) }], evidence: [capture] };
  assert.equal(applySeedPatch(seed(), withChanges(notGone)).results[0].why, "the entry is still there");
});

test("review reasons come from the ops, not from the producer", () => {
  const reasons = (...changes: Change[]) => reviewReasons(withChanges(...changes)).map((r) => r.reason);
  const edit = (entry: string, op: NonNullable<Change["ops"]>[number]): Change => ({ id: "c", entry, action: "repair", source: "wire", ops: [op], evidence: [capture] });
  assert.deepEqual(reasons(edit("nameReply", { op: "replace", path: "/messages/nameReply/cmd", value: "32", was: fingerprint("31") })), []);
  assert.deepEqual(reasons(edit("safety", { op: "remove", path: "/safety/rules", was: fingerprint([]) })), ["changes safety rules or blocked lists"]);
  assert.deepEqual(reasons(edit("blocked", { op: "replace", path: "/firmwares/1.20/blocked", value: [], was: fingerprint(["x"]) })), ["changes safety rules or blocked lists"]);
  assert.deepEqual(reasons(edit("setBypass", { op: "replace", path: "/messages/setBypass/payload/fields/1/allowed", value: [0, 1, 2], was: fingerprint([0, 1]) })), ["changes what may be written"]);
  assert.deepEqual(reasons(edit("transport", { op: "replace", path: "/transport/endian", value: "be", was: fingerprint("le") })), ["changes the framing of every message"]);
  assert.deepEqual(reasons(edit("getPreset", { op: "add", path: "/messages/getPreset/agentNotes", value: "say it kindly" })), ["adds text the chat model reads"]);
  assert.deepEqual(reasons(edit("host", { op: "add", path: "/host/x", value: { safety: { rules: [] } } })), ["changes safety rules or blocked lists"]);
});
