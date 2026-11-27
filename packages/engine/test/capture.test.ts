import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { CaptureReader, captureLine, counts, parseCapture, stepMessages, type Capture, type CaptureRecord } from "../src/capture.ts";

const fixture = () => readFileSync(new URL("../../../test/fixtures/capture/acme-fx-1.capture.jsonl", import.meta.url), "utf8");
const lines = () => fixture().trimEnd().split("\n");
const parsed = (text: string): Capture => {
  const r = parseCapture(text);
  assert.ok(r.ok, JSON.stringify(!r.ok && r.issues));
  return r.capture;
};
const issues = (text: string) => {
  const r = parseCapture(text);
  return r.ok ? [] : r.issues.map((i) => `${i.line}: ${i.message}`);
};
const join = (ls: string[]) => `${ls.join("\n")}\n`;

test("the example capture reads, with its steps as time ranges", () => {
  const c = parsed(fixture());
  assert.equal(c.header.editor.exe, "AcmeEdit.exe");
  assert.equal(c.truncated, false);
  assert.equal(c.end?.reason, "stopped");
  assert.deepEqual(c.steps.map((s) => [s.start.id, s.start.kind, s.end?.status]), [[1, "idle", "quiet"], [2, "selfTest", "quiet"], [3, "action", "quiet"], [4, "manual", "timeout"]]);
  const drive = c.steps[2];
  assert.equal(drive.end?.label, "Drive: off → on");
  const msgs = stepMessages(c, drive);
  assert.deepEqual(msgs.map((m) => m.bytes), ["f0 7d 01 22 02 01 f7", "f8"]);
  assert.deepEqual(msgs.filter(counts).map((m) => m.bytes), ["f0 7d 01 22 02 01 f7"]);
  // the idle step's traffic is all flagged: clock and the editor's poll set
  assert.equal(stepMessages(c, c.steps[0]).filter(counts).length, 0);
});

test("a cut-off capture reads up to its last whole line, and its open step shows as incomplete", () => {
  const ls = lines();
  const cut = ls.slice(0, 18).join("\n") + "\n" + ls[18].slice(0, 20); // inside step 3, mid-write
  const c = parsed(cut);
  assert.equal(c.truncated, true);
  assert.equal(c.end, undefined);
  const last = c.steps.at(-1)!;
  assert.equal(last.start.id, 3);
  assert.equal(last.end, undefined);
  assert.deepEqual(stepMessages(c, last).map((m) => m.bytes), ["f0 7d 01 22 02 01 f7"]);
});

test("CRLF line ends read the same", () => {
  assert.deepEqual(parsed(fixture().replaceAll("\n", "\r\n")).records, parsed(fixture()).records);
});

test("the header comes first and once", () => {
  const ls = lines();
  assert.deepEqual(issues(join(ls.slice(1))), ["1: the first record is the header"]);
  assert.deepEqual(issues(join([ls[0], ls[0], ...ls.slice(1)])), ["2: a capture has one header"]);
  assert.deepEqual(issues(""), ["1: the capture is empty"]);
});

test("steps don't overlap, ids are unique, an end follows its own start", () => {
  const ls = lines();
  const start = (id: number, t: number) => JSON.stringify({ type: "stepStart", t, id, kind: "action", label: "x" });
  const end = (id: number, t: number) => JSON.stringify({ type: "stepEnd", t, id, status: "quiet" });
  const h = ls[0];
  assert.deepEqual(issues(join([h, start(1, 1), start(2, 2)])), ["3: step 2 starts while step 1 is open"]);
  assert.deepEqual(issues(join([h, start(1, 1), end(1, 2), start(1, 3)])), ["4: step id 1 is used twice"]);
  assert.deepEqual(issues(join([h, end(1, 2)])), ["2: step 1 ends but isn't open"]);
  assert.deepEqual(issues(join([h, start(1, 5), end(1, 2)])), ["3: step 1 ends before it starts"]);
});

test("nothing follows the end record", () => {
  const ls = lines();
  assert.deepEqual(issues(join([...ls, ls[1]])), [`${ls.length + 1}: nothing follows the end record`]);
});

test("records are checked against the schema, with the line and the field", () => {
  const h = lines()[0];
  const midi = (o: object) => JSON.stringify({ type: "midi", t: 1, dir: "in", kind: "sysex", bytes: "f0 f7", ...o });
  assert.deepEqual(issues(join([h, midi({ bytes: "F0 F7" })])), ["2: bytes: bytes are lowercase hex pairs separated by single spaces"]);
  assert.match(issues(join([h, midi({ dir: "both" })]))[0], /^2: dir: /);
  assert.match(issues(join([h, midi({ extra: 1 })]))[0], /^2: .*extra/);
  assert.deepEqual(issues(join([h, "{"])), ["2: not JSON"]);
  assert.match(issues(join([h, JSON.stringify({ type: "other", t: 1 })]))[0], /^2: /);
  // a screenshot is a file name beside the capture, never a path
  assert.match(issues(join([h, JSON.stringify({ type: "stepStart", t: 1, id: 1, kind: "action", label: "x", before: "..\\x.png" })]))[0], /^2: before: /);
  // the editor is a file name: a path could hold the user's name
  const header = JSON.parse(h);
  for (const exe of ["C:\\Users\\someone\\Editor.exe", "/home/someone/editor", "Editor.exe"]) {
    const got = issues(join([JSON.stringify({ ...header, editor: { exe } })]));
    assert.deepEqual(got, exe === "Editor.exe" ? [] : ["1: editor.exe: the editor is a file name, not a path"], exe);
  }
  assert.match(issues(join([h, JSON.stringify({ type: "stepStart", t: 1, id: 1, kind: "action", label: "x", mode: "Bass Mode" })]))[0], /^2: mode: a mode is its camelCase key/);
});

test("an overlong line is refused before it is parsed", () => {
  const h = lines()[0];
  assert.deepEqual(issues(join([h, " ".repeat((256 << 10) + 1)])), [`2: a line is at most ${256 << 10} characters`]);
});

test("captureLine writes what parseCapture reads, and refuses a record the schema doesn't", () => {
  const c = parsed(fixture());
  const again = parsed(join([captureLine(c.header), ...c.records.map(captureLine)]));
  assert.deepEqual(again.records, c.records);
  assert.throws(() => captureLine({ type: "midi", t: -1, dir: "in", kind: "sysex", bytes: "f0 f7" } as CaptureRecord));
});

test("CaptureReader reads line by line like parseCapture", () => {
  const r = new CaptureReader();
  lines().forEach((l, i) => r.line(l, i + 1));
  const res = r.finish();
  assert.ok(res.ok);
  assert.deepEqual(res.capture.records, parsed(fixture()).records);
});
