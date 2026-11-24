import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { schemaFiles } from "../../../scripts/schemas.ts";
import { fingerprint } from "../src/canonical-json.ts";
import { MAX_PATCH_BYTES, applySeedPatch, entryPaths, hasEntry, parseEntry, parseSeedPatch, reviewReasons, type Change, type Evidence, type SeedPatch } from "../src/seed-patch.ts";

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
const capture: Evidence = { kind: "capture", file: "walk-1", records: [1] };

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
  assert.ok(messages(withChanges({ id: "c", entry: "setBypass/amp", action: "repair", source: "wire", ops: [{ op: "add", path: "/messages/setBypass/x", value: 1 }], evidence: [capture] })).some((m) => /is for marks/.test(m)));
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
  // appends to one array each go to a new place, but not alongside an edit of the array itself
  const setting = (id: string, op: NonNullable<Change["ops"]>[number]): Change => ({ id, entry: `setting/${id}`, action: "add", source: "wire", ops: [op], evidence: [capture] });
  const append = (id: string) => setting(id, { op: "add", path: "/settings/items/-", value: { id } });
  assert.deepEqual(messages(withChanges(append("a"), append("b"))), []);
  const whole = setting("c", { op: "add", path: "/settings/items", value: [] });
  assert.ok(messages(withChanges(append("a"), whole)).some((m) => /overlaps an edit of changes\[0\]/.test(m)));
  assert.ok(messages(withChanges(whole, append("a"))).some((m) => /overlaps an edit of changes\[0\]/.test(m)));
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
  assert.ok(messages(withChanges({ id: "c", entry: "getPreset", action: "suspect", evidence: [{ kind: "capture", file: "nope" }, probeSilent] })).some((m) => /no file "nope"/.test(m)));
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
  assert.ok(refused((x) => (x.changes[0].source = "test")), "the test source kind is for the app's own hardware-check runs");
  assert.ok(refused((x) => (x.changes[2].ops[0].was = undefined)), "a replace says what it replaces");
  assert.ok(refused((x) => (x.changes[2].ops[0].path = "/")), "never the whole map");
  assert.ok(refused((x) => (x.changes = [])));
  assert.ok(refused((x) => (x.changes[1].entryFp = null)), "a confirm is about an entry the base map has");
  assert.ok(refused((x) => (x.changes[4].ops[0].path = "/messages/setTempo/__proto__")), "a path never reaches a prototype");
  assert.ok(refused((x) => (x.changes[4].ops[0].path = "/messages/__proto__/x")));
  assert.ok(!parseSeedPatch(" ".repeat(MAX_PATCH_BYTES + 1)).ok);
  assert.throws(() => parseSeedPatch("{"), SyntaxError);
  // a value parsing would hide in a prototype, and nesting too deep for the recursive checks, are issues, not throws
  const text = fixture("acme-fx-1.patch.json");
  const tempoValue = '"value": {\n      "cmd": "40"';
  assert.ok(text.includes(tempoValue));
  assert.match(JSON.stringify(parseSeedPatch(text.replace(tempoValue, '"value": {"__proto__": {"allowed": [1]}, "cmd": "40"'))), /no key may be __proto__/);
  const deep = `${"[".repeat(200_000)}${"]".repeat(200_000)}`;
  assert.match(JSON.stringify(parseSeedPatch(text.replace(tempoValue, `"value": {"deep": ${deep}, "cmd": "40"`))), /nests at most/);
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
  assert.deepEqual([again.status, again.why], ["stale", "the map already has the entry"]);
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

test("review reasons come from the ops and the base map, not from the producer", () => {
  // the seed plus the sections the replaces and removes below take things out of
  const base = { ...seed(), safety: { rules: [] }, firmwares: { "1.20": { blocked: ["x"] } }, controls: { items: { volume: { type: "cc", cc: 7, label: "Volume" } } } };
  const reasons = (...changes: Change[]) => reviewReasons(withChanges(...changes), base).map((r) => r.reason);
  const edit = (entry: string, ...ops: NonNullable<Change["ops"]>): Change => ({ id: "c", entry, action: "repair", source: "wire", ops, evidence: [capture] });
  assert.deepEqual(reasons(edit("nameReply", { op: "replace", path: "/messages/nameReply/cmd", value: "32", was: fingerprint("31") })), []);
  assert.deepEqual(reasons(edit("safety", { op: "remove", path: "/safety/rules", was: fingerprint([]) })), ["changes safety rules, blocked lists or hazards"]);
  assert.deepEqual(reasons(edit("blocked", { op: "replace", path: "/firmwares/1.20/blocked", value: [], was: fingerprint(["x"]) })), ["changes safety rules, blocked lists or hazards"]);
  assert.deepEqual(reasons(edit("hazards", { op: "add", path: "/hazards", value: [] })), ["changes safety rules, blocked lists or hazards"]);
  assert.deepEqual(reasons(edit("setBypass", { op: "replace", path: "/messages/setBypass/payload/fields/1/allowed", value: [0, 1, 2], was: fingerprint([0, 1]) })), ["changes what may be written"]);
  assert.deepEqual(reasons(edit("transport", { op: "replace", path: "/transport/endian", value: "be", was: fingerprint("le") })), ["changes the framing of every message"]);
  assert.deepEqual(reasons(edit("session", { op: "add", path: "/session", value: { onConnect: ["editMode"] } })), ["changes what is sent on every connect"]);
  assert.deepEqual(reasons(edit("getPreset", { op: "add", path: "/messages/getPreset/agentNotes", value: "say it kindly" })), ["changes text a chat model reads"]);
  assert.deepEqual(reasons(edit("safety", { op: "add", path: "/safety/notes", value: ["press nothing"] })), ["changes safety rules, blocked lists or hazards", "changes text a chat model reads"]);
  assert.deepEqual(reasons(edit("host", { op: "add", path: "/host/x", value: { safety: { rules: [] } } })), ["changes safety rules, blocked lists or hazards"]);

  // a limit dropped by replacing its parent: the base map shows what went
  const payload = base.messages.setPreset.payload;
  assert.deepEqual(reasons(edit("setPreset", { op: "replace", path: "/messages/setPreset/payload", value: { fields: [{ name: "preset", type: "u8" }] }, was: fingerprint(payload) })), ["changes what may be written"]);
  assert.deepEqual(reasons(edit("setPreset", { op: "remove", path: "/messages/setPreset/payload/fields/0", was: fingerprint(payload.fields[0]) })), ["changes what may be written"]);

  // an op that takes out what the base map doesn't have there: here the second remove takes the item that moved up,
  // the one with the limit, so what goes isn't known from the base map alone
  const fields = [{ name: "a", type: "u8" }, { name: "b", type: "u8", max: 9 }];
  const shifted = { ...base, messages: { ...base.messages, setPreset: { ...base.messages.setPreset, payload: { fields } } } };
  const twoRemoves = edit("setPreset", { op: "remove", path: "/messages/setPreset/payload/fields/0", was: fingerprint(fields[0]) }, { op: "remove", path: "/messages/setPreset/payload/fields/0", was: fingerprint(fields[1]) });
  assert.deepEqual(reviewReasons(withChanges(twoRemoves), shifted).map((r) => r.reason), ["takes out something other than what the base map has there"]);
  assert.equal(applySeedPatch(shifted, withChanges(twoRemoves)).results[0].status, "applied", "the apply takes both, the limit with them");

  // a firmware's delta covers the base map's entry: one without the base's limit drops it on that firmware
  assert.deepEqual(reasons(edit("setPreset", { op: "add", path: "/firmwares/1.20/messages/setPreset", value: { cmd: "12", dir: "request" } })), ["changes what may be written"]);

  // a new send, a new control, a control that now sends elsewhere
  assert.deepEqual(reasons(edit("getName", { op: "replace", path: "/messages/getName/dir", value: "send", was: fingerprint("request") })), ["adds something that writes to the unit"]);
  assert.deepEqual(reasons(edit("getName", { op: "replace", path: "/messages/getName", value: { cmd: "7f", dir: "send" }, was: fingerprint(base.messages.getName) })), ["adds something that writes to the unit"]);
  assert.deepEqual(reasons(edit("setBypass", { op: "replace", path: "/messages/setBypass/cmd", value: "23", was: fingerprint("22") })), []);
  assert.deepEqual(reasons({ ...edit("setTempo", { op: "add", path: "/messages/setTempo", value: { cmd: "40", dir: "send" } }), action: "add" }), ["adds something that writes to the unit"]);
  assert.deepEqual(reasons({ ...edit("getTempo", { op: "add", path: "/messages/getTempo", value: { cmd: "41", dir: "request" } }), action: "add" }), []);
  assert.deepEqual(reasons({ ...edit("control/volume", { op: "add", path: "/controls/items/volume", value: { type: "cc", cc: 7 } }), action: "add" }), ["may change what a control sends to", "adds something that writes to the unit"]);
  assert.deepEqual(reasons(edit("control/volume", { op: "replace", path: "/controls/items/volume/cc", value: 11, was: fingerprint(7) })), ["may change what a control sends to"]);
  assert.deepEqual(reasons(edit("control/volume", { op: "replace", path: "/controls/items/volume/label", value: "Vol", was: fingerprint("Volume") })), []);

  // what first contact may send to an unknown unit, and what counts as a verified write
  assert.deepEqual(reasons(edit("getName", { op: "add", path: "/messages/getName/safeRead", value: true })), ["changes what is probed or what verifies a write"]);
  assert.deepEqual(reasons(edit("setPreset", { op: "add", path: "/messages/setPreset/readBack", value: { message: "getPreset" } })), ["changes what is probed or what verifies a write"]);
});

test("a change that could lift a block goes to review: the pins that tell a blocked message from a send on its cmd", () => {
  // factoryReset is blocked; storeScene shares its cmd and is told apart by a const; getScene can produce any cmd
  const pin = (v: number) => ({ fields: [{ name: "magic", type: "u8", const: v }] });
  const base = seed();
  Object.assign(base.messages, {
    factoryReset: { cmd: "7f", dir: "send", payload: pin(1) },
    storeScene: { cmd: "7f", dir: "send", payload: "scene" },
    getScene: { cmd: "{n}", dir: "request", payload: pin(3) },
  });
  base.layouts = { scene: { size: 2, fields: [{ name: "magic", type: "u8", const: 2 }, { name: "slot", type: "u8" }] } };
  base.blocked = ["factoryReset"];
  base.firmwares = { "1.20": {} };
  const LIFT = "may lift a block: changes what tells a blocked message from a send on its cmd";
  const edit = (entry: string, ...ops: NonNullable<Change["ops"]>): Change => ({ id: `c-${entry}`, entry, action: "repair", source: "wire", ops, evidence: [capture] });
  const reasons = (...changes: Change[]) => reviewReasons(withChanges(...changes), base).map((r) => `${r.change}: ${r.reason}`);

  // the blocked message's own pin, a sharer's pin, the layout a sharer names, a templated request, a firmware's delta
  assert.deepEqual(reasons(edit("factoryReset", { op: "replace", path: "/messages/factoryReset/payload/fields/0/const", value: 2, was: fingerprint(1) })), [`c-factoryReset: ${LIFT}`]);
  assert.deepEqual(reasons(edit("storeScene", { op: "replace", path: "/messages/storeScene/payload", value: pin(1), was: fingerprint("scene") })), [`c-storeScene: ${LIFT}`]);
  assert.deepEqual(reasons(edit("layout/scene", { op: "add", path: "/layouts/scene/maxSize", value: 4 })), [`c-layout/scene: ${LIFT}`]);
  assert.deepEqual(reasons(edit("layout/scene", { op: "replace", path: "/layouts/scene/fields/0/const", value: 1, was: fingerprint(2) })), [`c-layout/scene: ${LIFT}`]);
  assert.deepEqual(reasons(edit("getScene", { op: "remove", path: "/messages/getScene/payload/fields/0/const", was: fingerprint(3) })), [`c-getScene: ${LIFT}`]);
  assert.deepEqual(reasons(edit("storeScene", { op: "add", path: "/firmwares/1.20/messages/storeScene", value: { cmd: "7f", dir: "send" } })), [`c-storeScene: ${LIFT}`, "c-storeScene: adds something that writes to the unit"]);

  // a send moved onto the blocked cmd, and a block put on a send whose payload another change edits
  assert.deepEqual(reasons(edit("setBypass", { op: "replace", path: "/messages/setBypass/cmd", value: "7f", was: fingerprint("22") })), [`c-setBypass: ${LIFT}`]);
  const block = edit("blocked", { op: "add", path: "/firmwares/1.20/blocked", value: ["setPreset"] });
  const rename = edit("setPreset", { op: "replace", path: "/messages/setPreset/payload/fields/0/name", value: "slot", was: fingerprint("preset") });
  assert.deepEqual(reasons(block, rename), ["c-blocked: changes safety rules, blocked lists or hazards", `c-setPreset: ${LIFT}`]);

  // whatever subset a reviewer accepts: a send moved onto the blocked cmd while the block moves off it is still flagged,
  // since accepting only the first leaves both on 7f
  const onto = edit("setBypass", { op: "replace", path: "/messages/setBypass/cmd", value: "7f", was: fingerprint("22") });
  const off = edit("factoryReset", { op: "replace", path: "/messages/factoryReset/cmd", value: "99", was: fingerprint("7f") });
  assert.deepEqual(reasons(onto, off), [`c-setBypass: ${LIFT}`, `c-factoryReset: ${LIFT}`]);

  // a mode's stand-in for a pinned layout or message is pinned too
  const moded = { ...structuredClone(base), modes: { use: { bass: { layouts: { scene: "sceneBass" }, messages: { factoryReset: "factoryResetBass" } } } } };
  moded.layouts.sceneBass = structuredClone(base.layouts.scene);
  moded.messages.factoryResetBass = { cmd: "7e", dir: "send", payload: pin(1) };
  const modedReasons = (c: Change) => reviewReasons(withChanges(c), moded).map((r) => r.reason);
  assert.deepEqual(modedReasons(edit("layout/sceneBass", { op: "replace", path: "/layouts/sceneBass/fields/0/const", value: 1, was: fingerprint(2) })), [LIFT]);
  assert.deepEqual(modedReasons(edit("factoryResetBass", { op: "replace", path: "/messages/factoryResetBass/cmd", value: "7d", was: fingerprint("7e") })), [LIFT]);

  // away from the block's cmd, a payload or cmd repair is still not a review reason
  assert.deepEqual(reasons(rename), []);
  assert.deepEqual(reasons(edit("nameReply", { op: "replace", path: "/messages/nameReply/cmd", value: "32", was: fingerprint("31") })), []);
});

test("ops never write provenance or a draft's bookkeeping", () => {
  const op = (path: string, value: string | number | Record<string, string> = 1): Change => ({ id: "c", entry: "nameReply", action: "repair", source: "wire", ops: [{ op: "add", path, value }], evidence: [capture] });
  assert.ok(messages(withChanges(op("/messages/nameReply/provenance", "replay-verified"))).some((m) => /never write them/.test(m)));
  assert.ok(messages(withChanges(op("/messages/nameReply/x", { provenance: "replay-verified" }))).some((m) => /never write them/.test(m)));
  assert.ok(messages(withChanges({ ...op("/status", "ready"), entry: "driver" })).some((m) => /never write them/.test(m)));
});

test("applying checks a change against the map: its own parameter, an entry to mark, a safe probe", () => {
  const map = seed();
  const level = map.parameters.groups.amp.params.level;
  const wrongParam: Change = { id: "c", entry: "param/amp/1", action: "repair", source: "wire", ops: [{ op: "replace", path: "/parameters/groups/amp/params/level/kind", value: "slider", was: fingerprint(level.kind) }], evidence: [capture] };
  const r1 = applySeedPatch(map, withChanges(wrongParam)).results[0];
  assert.deepEqual([r1.status, r1.why], ["refused", "/parameters/groups/amp/params/level/kind is not where param/amp/1 is"]);
  const rightParam: Change = { ...wrongParam, entry: "param/amp/2" };
  assert.equal(applySeedPatch(map, withChanges(rightParam)).results[0].status, "applied");

  const markMissing: Change = { id: "c", entry: "getTempo", action: "confirm", source: "read-back", evidence: [{ ...probeOk, request: "getPreset" }] };
  assert.equal(applySeedPatch(map, withChanges(markMissing)).results[0].why, "the map has no such entry to mark");
  const blockMissing: Change = { id: "c", entry: "secretMode", action: "block", evidence: [{ kind: "doc", citation: "manual" }] };
  assert.equal(applySeedPatch(map, withChanges(blockMissing)).results[0].status, "marked", "a block may name a message the map lacks");

  const probedSend: Change = { id: "c", entry: "setPreset", action: "suspect", evidence: [{ ...probeSilent, request: "setPreset" } as Evidence] };
  assert.match(applySeedPatch(map, withChanges(probedSend)).results[0].why!, /not a request in the map/);
  map.messages.storePreset = { cmd: "10", dir: "send" };
  const sharedCmd: Change = { id: "c", entry: "getPreset", action: "confirm", source: "read-back", evidence: [probeOk] };
  assert.match(applySeedPatch(map, withChanges(sharedCmd)).results[0].why!, /command 10 the send storePreset also uses/);
  delete map.messages.storePreset;
  map.messages.getName.safeRead = true; // once a map marks safe reads, only those are probed
  assert.match(applySeedPatch(map, withChanges(sharedCmd)).results[0].why!, /not marked safeRead/);
  map.messages.getPreset.safeRead = true;
  assert.equal(applySeedPatch(map, withChanges(sharedCmd)).results[0].status, "marked");
});

test("applying: a failed change leaves the map exactly as it was, arrays and new objects included", () => {
  const map = { ...seed(), settings: { items: [{ id: "a" }, { id: "b" }] } };
  const before = structuredClone(map);
  const failing = (entry: string, ...ops: NonNullable<Change["ops"]>): Change => ({ id: "c", entry, action: "repair", source: "wire", ops, evidence: [capture] });
  const late = { op: "remove", path: "/messages/setPreset/nothing", was: fingerprint(1) } as const;
  for (const c of [
    failing("setPreset", { op: "add", path: "/firmwares/1.20/messages/setPreset/x", value: 1 }, { op: "add", path: "/messages/setPreset/payload/fields/-", value: { name: "y" } }, late),
    failing("setPreset", { op: "remove", path: "/messages/setPreset/payload/fields/0", was: fingerprint(map.messages.setPreset.payload.fields[0]) }, late),
    failing("setting/b", { op: "remove", path: "/settings/items/0", was: fingerprint({ id: "a" }) }),
  ]) {
    const { map: out, results } = applySeedPatch(map, withChanges(c));
    assert.notEqual(results[0].status, "applied");
    assert.deepEqual(out, before);
  }
  assert.deepEqual(map, before, "the input map is never changed");
});

test("applying: a new setting is appended where its id lands, and an add finds no entry there yet", () => {
  const map = { ...seed(), settings: { items: [{ id: "a" }] } };
  const add = (id: string): Change => ({ id: "c", entry: `setting/${id}`, action: "add", source: "wire", ops: [{ op: "add", path: "/settings/items/-", value: { id } }], evidence: [capture] });
  const r = applySeedPatch(map, withChanges(add("b")));
  assert.equal(r.results[0].status, "applied");
  assert.deepEqual((r.map as typeof map).settings.items, [{ id: "a" }, { id: "b" }]);
  assert.deepEqual(applySeedPatch(map, withChanges(add("a"))).results[0], { change: "c", status: "stale", why: "the map already has the entry" });
});

test("applying: probes are judged against the map as probed, the unit's firmware delta included", () => {
  const map = seed();
  map.firmwares = { "1.20": { messages: { wipe: { cmd: "10", dir: "send" }, getTempo: { cmd: "41", dir: "request" } } } };
  const confirm = (request: string): Change => ({ id: "c", entry: "getName", action: "confirm", source: "read-back", evidence: [{ ...probeOk, request }] });
  assert.match(applySeedPatch(map, withChanges(confirm("getPreset"))).results[0].why!, /command 10 the send wipe also uses/);
  assert.equal(applySeedPatch(map, withChanges(confirm("getTempo"))).results[0].status, "marked");
  // an earlier change in the same patch can't make a later probe look safe
  const toRequest: Change = { id: "d", entry: "setPreset", action: "repair", source: "wire", ops: [{ op: "replace", path: "/messages/setPreset/dir", value: "request", was: fingerprint("send") }], evidence: [capture] };
  const probeSet: Change = { ...confirm("setPreset"), entry: "getPreset" };
  assert.match(applySeedPatch(seed(), withChanges(toRequest, probeSet)).results[1].why!, /not a request in the map/);
  const noMessages = { ...seed(), messages: undefined };
  assert.match(applySeedPatch(noMessages, withChanges({ ...confirm("getPreset"), entry: "transport" })).results[0].why!, /not a request in the map/);
});

test("a repair may open the unit's own firmware delta", () => {
  const delta: Change = { id: "c", entry: "nameReply", action: "repair", source: "wire", ops: [{ op: "add", path: "/firmwares/1.20/messages/nameReply", value: { cmd: "31", dir: "reply" } }], evidence: [capture] };
  const { map, results } = applySeedPatch(seed(), withChanges(delta));
  assert.equal(results[0].status, "applied");
  const out = map as ReturnType<typeof seed>;
  // the source goes on the delta, the entry the unit's firmware reads; the base entry keeps what it had
  assert.deepEqual(out.firmwares["1.20"].messages.nameReply, { cmd: "31", dir: "reply", source: { kind: "wire", ref: "capture walk-1 sha256:0000000000000000" } });
  assert.equal(out.messages.nameReply.source, undefined);
});

test("an entry's source comes from the change and its evidence, never from an op", () => {
  const edit = (path: string, value: unknown): Change => ({ id: "c", entry: "getName", action: "repair", source: "wire", ops: [{ op: "add", path, value: value as never }], evidence: [capture] });
  const refuses = (c: Change) => messages(withChanges(c)).some((m) => /source comes from the change/.test(m));
  assert.ok(refuses(edit("/messages/getName/source", { kind: "replay-verified" })));
  assert.ok(refuses({ ...edit("/messages/getName/source/kind", "test"), ops: [{ op: "replace", path: "/messages/getName/source/kind", value: "test", was: fingerprint("doc") }] }));
  assert.ok(refuses({ ...edit("/messages/getName", {}), ops: [{ op: "replace", path: "/messages/getName", value: { cmd: "30", dir: "request", source: { kind: "test" } }, was: fingerprint(seed().messages.getName) }] }));
  assert.ok(refuses({ ...edit("/firmwares/1.20/messages/getName", { cmd: "30", dir: "request", source: { kind: "doc" } }) }));
  assert.ok(refuses({ ...edit("/parameters/groups/amp/params/gain/source", { kind: "doc" }), entry: "param/amp/1" }));
  assert.ok(refuses({ ...edit("/parameters/groups", { amp: { params: [{ source: { kind: "test" } }] } }), entry: "parameters" }), "an array in the value hides none");
  // a measured value's own source is not an entry's
  const timing = { value: 120, unit: "ms", measuredOn: "1.20", date: "2026-11-24", source: "probe" };
  assert.ok(!refuses({ id: "m", entry: "measured/transport.timing.replyTimeoutMs", action: "repair", source: "read-back", ops: [{ op: "replace", path: "/transport/timing/replyTimeoutMs", value: timing, was: fingerprint(300) }], evidence: [probeOk] }));

  // applying: an edit sets it from the evidence that backs it, a confirm only raises it
  const base = seed();
  base.messages.getName.source = { kind: "doc", ref: "Manual p. 3" };
  base.messages.getPreset.source = { kind: "replay-verified" };
  const doc: Evidence = { kind: "doc", citation: "Owner's manual 1.2 p. 28" };
  const yes: Evidence = { kind: "player", at: "2026-11-24T18:00:00Z", question: "did it switch?", answer: "yes" };
  // made against this map, so not rebased
  const against = (m: unknown, ...changes: Change[]) => ({ ...withChanges(...changes), base: { file: fingerprint(m) } });
  const run = (...changes: Change[]) => applySeedPatch(base, against(base, ...changes)).map as ReturnType<typeof seed>;
  const repairName = (source: Change["source"], evidence: Evidence): Change => ({ id: "r", entry: "nameReply", action: "repair", source, ops: [{ op: "replace", path: "/messages/nameReply/cmd", value: "32", was: fingerprint("31") }], evidence: [evidence] });
  assert.deepEqual(run(repairName("doc", doc)).messages.nameReply.source, { kind: "doc", ref: "Owner's manual 1.2 p. 28" });
  assert.deepEqual(run(repairName("read-back", probeOk)).messages.nameReply.source, { kind: "read-back", ref: "probe getPreset at 2026-11-24T18:00:01Z" });
  const confirm = (entry: string, source: Change["source"], evidence: Evidence): Change => ({ id: `k-${entry.toLowerCase()}`, entry, action: "confirm", source, evidence: [evidence] });
  const confirmed = run(confirm("getName", "read-back", probeOk), confirm("getPreset", "read-back", probeOk));
  assert.deepEqual(confirmed.messages.getName.source, { kind: "read-back", ref: "probe getPreset at 2026-11-24T18:00:01Z" }, "a confirm raises doc to read-back");
  assert.deepEqual(confirmed.messages.getPreset.source, { kind: "replay-verified" }, "a confirm never lowers it");
  assert.deepEqual(run(confirm("getName", "player-confirmed", yes)).messages.getName.source, { kind: "player-confirmed", ref: "player at 2026-11-24T18:00:00Z" }, "a player's yes beats a document");
  assert.deepEqual(run(confirm("getPreset", "player-confirmed", yes)).messages.getPreset.source, { kind: "replay-verified" }, "and nothing stronger");
  const getName = { id: "r", entry: "getName", action: "repair" as const, source: "player-confirmed" as const, ops: [{ op: "add" as const, path: "/messages/getName/safeRead", value: true }], evidence: [yes] };
  assert.equal(run(getName).messages.getName.source.kind, "player-confirmed", "an edit replaces the source even with a weaker one");
  // a parameter carries one too
  const gain: Change = { id: "g", entry: "param/amp/1", action: "repair", source: "wire", ops: [{ op: "add", path: "/parameters/groups/amp/params/gain/max", value: 10 }], evidence: [capture] };
  assert.equal(run(gain).parameters.groups.amp.params.gain.source.kind, "wire");

  // an edit's source goes where its ops landed: the base it edited, not the delta it left alone
  const withDelta = structuredClone(base);
  withDelta.firmwares = { "1.20": { messages: { getName: { ...base.messages.getName, source: { kind: "replay-verified" } } } } };
  const baseEdit: Change = { id: "b", entry: "getName", action: "repair", source: "doc", ops: [{ op: "replace", path: "/messages/getName/cmd", value: "33", was: fingerprint("30") }], evidence: [doc] };
  const edited = applySeedPatch(withDelta, against(withDelta, baseEdit)).map as typeof withDelta;
  assert.deepEqual(edited.messages.getName.source, { kind: "doc", ref: "Owner's manual 1.2 p. 28" });
  assert.deepEqual(edited.firmwares["1.20"].messages.getName.source, { kind: "replay-verified" });
  // whatever entry the change names: a section edit inside a parameter gives the parameter the source
  base.parameters.groups.amp.params.gain.source = { kind: "replay-verified" };
  const section: Change = { id: "s", entry: "parameters", action: "repair", source: "doc", ops: [{ op: "replace", path: "/parameters/groups/amp/params/gain/kind", value: "switch", was: fingerprint("knob") }], evidence: [doc] };
  assert.equal(run(section).parameters.groups.amp.params.gain.source.kind, "doc");
  assert.equal(run(section).parameters.groups.amp.params.level.source, undefined, "and only the one it changed");

  // a confirm raises only what its evidence saw: not after an earlier change edited the entry, not on a rebased map,
  // not from one block's or one mode's view of a message
  const confirmName = confirm("getName", "read-back", probeOk);
  assert.equal(run(baseEdit, confirmName).messages.getName.source.kind, "doc");
  assert.equal((applySeedPatch(base, withChanges(confirmName)).map as typeof base).messages.getName.source.kind, "doc");
  assert.equal(run({ ...confirmName, entry: "getName/amp" }).messages.getName.source.kind, "doc");
});

test("every top-level key is an entry: known sections, a draft's own sections, measured values", () => {
  assert.deepEqual(parseEntry("addresses"), { kind: "section", section: "addresses" });
  assert.deepEqual(parseEntry("measured/transport.timing.compareToggle"), { kind: "measured", field: "transport.timing.compareToggle" });
  for (const bad of ["messages", "layouts", "firmwares", "schema", "status", "gaps", "provenance", "measured", "measured/audio", "measured/Audio.x", "measured/firmwares.v2.transport.x", "measured/messages.getPreset.cmd", "measured/status.x"]) assert.equal(parseEntry(bad), null, bad);

  // a draft's own section, by its key alone
  const map = { ...seed(), addressMap: { patch: "10 00" } };
  const draftKey: Change = { id: "c", entry: "addressMap", action: "repair", source: "wire", ops: [{ op: "replace", path: "/addressMap/patch", value: "11 00", was: fingerprint("10 00") }], evidence: [capture] };
  const p = withChanges(draftKey);
  assert.deepEqual(messages(p), []);
  assert.equal(applySeedPatch(map, p).results[0].status, "applied");
  assert.deepEqual(reviewReasons(p, map).map((r) => r.reason), ["changes a map section this engine doesn't know"]);
  assert.match(messages(withChanges({ ...draftKey, ops: [{ op: "add", path: "/other/x", value: 1 }] }))[0], /outside entry addressMap/);

  // a name that is both a message and a top-level section can't be told apart
  const both = { ...map, messages: { ...map.messages, addressMap: { cmd: "50", dir: "request" } } };
  assert.match(applySeedPatch(both, p).results[0].why!, /both a message and a top-level section/);
  // nor can a change make a name both
  const newMsg: Change = { id: "c", entry: "fooBar", action: "add", source: "wire", ops: [{ op: "add", path: "/messages/fooBar", value: { cmd: "50", dir: "request" } }, { op: "add", path: "/fooBar", value: {} }], evidence: [capture] };
  assert.match(applySeedPatch(seed(), withChanges(newMsg)).results[0].why!, /both a message and a top-level section/);
  const sectionThere = { ...seed(), fooBar: {} };
  assert.match(applySeedPatch(sectionThere, withChanges({ ...newMsg, ops: [newMsg.ops![0]] })).results[0].why!, /both a message and a top-level section/);
  // whole sections with a firmware delta are not ambiguous
  const safety = { ...seed(), safety: { rules: [] }, firmwares: { "1.20": { safety: { modelChangeScenes: [1] } } } };
  const confirmSafety: Change = { id: "c", entry: "safety", action: "confirm", source: "doc", evidence: [{ kind: "doc", citation: "manual" }] };
  assert.equal(applySeedPatch(safety, withChanges(confirmSafety)).results[0].status, "marked");

  // a measured value, written where its dotted path says
  const measured: Change = { id: "c", entry: "measured/transport.timing.compareToggle", action: "add", source: "wire", ops: [{ op: "add", path: "/transport/timing/compareToggle", value: { value: 420, unit: "ms", measuredOn: "acme fx-1", date: "2026-11-24", source: "sniffer-capture" } }], evidence: [capture] };
  assert.deepEqual(messages(withChanges(measured)), []);
  assert.equal(applySeedPatch(seed(), withChanges(measured)).results[0].status, "applied");
  assert.match(messages(withChanges({ ...measured, ops: [{ op: "add", path: "/transport/timing/frameGapMs", value: 1 }] }))[0], /outside entry/);
  // addresses frame every message, like the transport
  const addresses = { ...seed(), addresses: { patch: "10 00" } };
  const readdress: Change = { id: "c", entry: "addresses", action: "repair", source: "wire", ops: [{ op: "replace", path: "/addresses/patch", value: "11 00", was: fingerprint("10 00") }], evidence: [capture] };
  assert.deepEqual(reviewReasons(withChanges(readdress), addresses).map((r) => r.reason), ["changes the framing of every message"]);
});

test("a measured value skips the framing review only when it is a measured value", () => {
  const timing = { value: 420, unit: "ms", measuredOn: "acme fx-1", date: "2026-11-24", source: "sniffer-capture" };
  const add = (field: string, value: Record<string, string | number>): Change => ({ id: "c", entry: `measured/${field}`, action: "add", source: "wire", ops: [{ op: "add", path: `/${field.split(".").join("/")}`, value }], evidence: [capture] });
  const reasons = (c: Change) => reviewReasons(withChanges(c), seed()).map((r) => r.reason);
  assert.deepEqual(reasons(add("transport.timing.compareToggle", timing)), []);
  assert.deepEqual(reasons(add("transport.checksum", { algo: "none" } as Record<string, string>)), ["changes the framing of every message"]);
  const header: Change = { id: "c", entry: "measured/transport.frame", action: "repair", source: "wire", ops: [{ op: "replace", path: "/transport/frame", value: timing, was: fingerprint(seed().transport.frame) }], evidence: [capture] };
  assert.deepEqual(reasons(header), ["changes the framing of every message"], "replacing framing with a measured shape still takes the framing out");
  assert.equal(parseEntry("measured/draftThing.x"), null, "a measured value lies in a known section");
});

test("a linked parameter set is an entry in its group", () => {
  assert.deepEqual(parseEntry("linked/amp/gain_pair"), { kind: "linked", group: "amp", set: "gain_pair" });
  for (const bad of ["linked", "linked/amp", "linked/Amp/x", "linked/amp/x/y"]) assert.equal(parseEntry(bad), null, bad);
  const add: Change = { id: "c", entry: "linked/amp/gain_pair", action: "add", source: "wire", ops: [{ op: "add", path: "/parameters/groups/amp/linked/gain_pair", value: { params: ["gain", "level"] } }], evidence: [capture] };
  assert.deepEqual(messages(withChanges(add)), []);
  assert.equal(applySeedPatch(seed(), withChanges(add)).results[0].status, "applied");
  assert.match(messages(withChanges({ ...add, ops: [{ op: "add", path: "/parameters/groups/drive/linked/gain_pair", value: {} }] }))[0], /outside entry/);
  assert.deepEqual(reviewReasons(withChanges(add), seed()).map((r) => r.reason), ["changes what may be written"], "a linked set limits the values written together");
});

test("modes: a message as a mode reads it, a stand-in group's parameter, and the mode a change was seen in", () => {
  assert.deepEqual(parseEntry("getPreset@bass"), { kind: "message", message: "getPreset", mode: "bass" });
  assert.deepEqual(parseEntry("setBypass@bass/amp"), { kind: "message", message: "setBypass", block: "amp", mode: "bass" });
  assert.deepEqual(parseEntry("param/amp/1/bass_amp"), { kind: "param", block: "amp", id: 1, group: "bass_amp" });
  assert.deepEqual(parseEntry("modes"), { kind: "section", section: "modes" });
  for (const bad of ["getPreset@", "getPreset@a@b", "@bass", "transport@bass", "param@bass", "linked@bass", "messages@bass", "status@bass", "param/amp/1/x/y", "param/amp/1/Bad-group"])
    assert.equal(parseEntry(bad), null, bad);
  assert.deepEqual(parseEntry("linked/bassAmp/gain_pair"), { kind: "linked", group: "bassAmp", set: "gain_pair" }, "a linked set's group is named as a param's is");

  const confirm: Change = { id: "c", entry: "getPreset@bass", action: "confirm", source: "read-back", evidence: [probeOk] };
  assert.match(messages(withChanges(confirm))[0], /must be seen in that mode/);
  assert.match(messages(withChanges({ ...confirm, mode: "guitar" }))[0], /must be seen in that mode/);
  assert.deepEqual(messages(withChanges({ ...confirm, mode: "bass" })), []);
  // a message in one mode is for marks: bass evidence never edits the message every mode shares
  const modeMsg: Change = { id: "c", entry: "fooBar@bass", action: "add", source: "wire", mode: "bass", ops: [{ op: "add", path: "/messages/fooBar", value: { cmd: "50", dir: "request" } }], evidence: [capture] };
  assert.ok(messages(withChanges(modeMsg)).some((m) => /is for marks/.test(m)));
  // a mode's entry can't stand beside a top-level key of its message's name
  const bassMode = { modes: { use: { bass: {} } } };
  const both = { ...seed(), ...bassMode, fooBar: {}, messages: { ...seed().messages, fooBar: { cmd: "50", dir: "request" } } };
  for (const entry of ["fooBar@bass", "fooBar/amp", "fooBar@bass/amp"])
    assert.match(applySeedPatch(both, withChanges({ ...confirm, entry, mode: "bass" })).results[0].why!, /both a message and a top-level section/, entry);

  // a map with a bass mode whose amp group stands in for the guitar one
  const map = seed();
  map.parameters.groups.bass_amp = { blocks: ["amp"], params: { gain: { id: 1, kind: "knob" } } };
  map.modes = { read: { message: "getMode", field: "mode" }, use: { bass: { groups: { amp: "bass_amp" } } } };
  const fw = example().unit.firmware;
  assert.deepEqual(entryPaths(map, "param/amp/1", fw), [["parameters", "groups", "amp", "params", "gain"]]);
  assert.deepEqual(entryPaths(map, "param/amp/1/bass_amp", fw), [["parameters", "groups", "bass_amp", "params", "gain"]]);
  assert.deepEqual(entryPaths(map, "param/amp/1/amp", fw), [], "the fourth part names a stand-in group");
  const selfMapped = { ...map, modes: { use: { guitar: { groups: { amp: "amp" } } } } };
  assert.deepEqual(entryPaths(selfMapped, "param/amp/1", fw)[0], ["parameters", "groups", "amp", "params", "gain"], "a group mapped to itself stands in for no other");
  const wrongGroup: Change = { id: "c", entry: "param/amp/1/bass_amp", action: "repair", source: "wire", mode: "bass", ops: [{ op: "replace", path: "/parameters/groups/amp/params/gain/kind", value: "slider", was: fingerprint("knob") }], evidence: [capture] };
  assert.match(messages(withChanges(wrongGroup))[0], /outside entry/);
  const rightGroup: Change = { ...wrongGroup, ops: [{ op: "replace", path: "/parameters/groups/bass_amp/params/gain/kind", value: "slider", was: fingerprint("knob") }] };
  assert.equal(applySeedPatch(map, withChanges(rightGroup)).results[0].status, "applied");

  // the mode is checked against the map
  assert.equal(applySeedPatch(seed(), withChanges({ ...confirm, mode: "bass" })).results[0].why, "the map has no mode bass");
  assert.equal(applySeedPatch({ ...seed(), ...bassMode }, withChanges({ ...confirm, mode: "bass" })).results[0].status, "marked");
  const { mode: _m, ...noMode } = rightGroup;
  assert.match(applySeedPatch(map, withChanges(noMode)).results[0].why!, /needs the mode it was seen in/);
  assert.match(messages(withChanges(noMode))[0], /needs the mode it was seen in/, "checked without a map too");
  map.modes.use.guitar = {};
  assert.match(applySeedPatch(map, withChanges({ ...rightGroup, mode: "guitar" })).results[0].why!, /stands in for none in mode guitar/);
  map.modes.use.guitar = { groups: { bass_amp: "bass_amp" } };
  assert.match(applySeedPatch(map, withChanges({ ...rightGroup, mode: "guitar" })).results[0].why!, /stands in for none in mode guitar/, "a group mapped to itself stands in for none");
  map.modes.use.guitar = {};
  const plainInBass: Change = { id: "c", entry: "param/amp/1", action: "confirm", source: "wire", mode: "bass", evidence: [capture] };
  assert.match(applySeedPatch(map, withChanges(plainInBass)).results[0].why!, /in mode bass, bass_amp stands in for group amp/);
  assert.equal(applySeedPatch(map, withChanges({ ...plainInBass, mode: "guitar" })).results[0].status, "marked");
  map.modes.use.bass.messages = { getPreset: "getPresetBass" };
  assert.match(applySeedPatch(map, withChanges({ ...plainInBass, entry: "getPreset", source: "read-back", evidence: [probeOk] })).results[0].why!, /getPresetBass stands in for getPreset/);
  const bassConfirm = { ...confirm, mode: "bass" };
  assert.match(applySeedPatch(map, withChanges(bassConfirm)).results[0].why!, /mode bass reads getPresetBass, not getPreset/);
  map.modes.use.bass.layouts = { patch: "bassPatch" };
  const layoutInBass: Change = { id: "c", entry: "layout/patch", action: "suspect", mode: "bass", evidence: [probeSilent] };
  assert.match(applySeedPatch({ ...map, layouts: { patch: { fields: [] } } }, withChanges(layoutInBass)).results[0].why!, /bassPatch stands in for patch/);
  assert.equal(applySeedPatch(seed(), withChanges({ ...plainInBass, entry: "getPreset", source: "read-back", evidence: [probeOk] })).results[0].status, "marked", "a map without modes ignores a plain entry's mode");

  const modes: Change = { id: "c", entry: "modes", action: "repair", source: "wire", ops: [{ op: "replace", path: "/modes/use/bass/groups/amp", value: "amp", was: fingerprint("bass_amp") }], evidence: [capture] };
  assert.deepEqual(reviewReasons(withChanges(modes), map).map((r) => r.reason), ["changes which entries a mode uses"]);
});
