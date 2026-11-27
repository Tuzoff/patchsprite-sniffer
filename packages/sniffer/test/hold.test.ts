// The capture's hold on the device (src/hold.ts), each test in its own temp PATCHSPRITE_HOME.

import assert from "node:assert/strict";
import { mkdtempSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { acquirePedalLock, PEDAL_LOCK_IDLE_MS, pedalLockPath, readPedalLock, releasePedalLock } from "@patchsprite/engine/pedal-lock";
import { DeviceHold, OWNER } from "../src/hold.ts";

const env = () => ({ PATCHSPRITE_HOME: mkdtempSync(join(tmpdir(), "sniff-hold-")) });
const idleFor = (e: NodeJS.ProcessEnv, ms: number) => {
  const then = new Date(Date.now() - ms);
  utimesSync(pedalLockPath(e), then, then);
};
const usedAgo = (e: NodeJS.ProcessEnv) => Date.now() - statSync(pedalLockPath(e)).mtimeMs;

test("a working session renews its hold at most once a minute, or at once when asked", () => {
  const e = env();
  let t = 1_000_000;
  const hold = DeviceHold.take(e, () => assert.fail("no notes"), () => t);
  idleFor(e, 10 * 60_000);
  t += 30_000;
  assert.equal(hold.use(), undefined);
  assert.ok(usedAgo(e) > 9 * 60_000, "renewed less than a minute ago: left alone");
  t += 31_000;
  assert.equal(hold.use(), undefined);
  assert.ok(usedAgo(e) < 5_000, "a minute on: renewed");
  idleFor(e, 10 * 60_000);
  assert.equal(hold.use(true), undefined);
  assert.ok(usedAgo(e) < 5_000, "asked to: renewed at once");
  hold.release();
  assert.equal(readPedalLock(e), undefined);
});

test("someone else holding the device: the session never starts", () => {
  const e = env();
  const other = acquirePedalLock("hardware check", { env: e });
  assert.ok(other.ok);
  assert.throws(() => DeviceHold.take(e, () => {}), /^Error: The device is in use: hardware check \(process \d+\)/);
  releasePedalLock(other.lock, e);
});

test("a session left alone lets the device go; its next use takes it again, or says who has it now", () => {
  const e = env();
  const notes: string[] = [];
  const hold = DeviceHold.take(e, (kind, text) => notes.push(`${kind}: ${text}`));
  idleFor(e, PEDAL_LOCK_IDLE_MS + 60_000); // nobody used it for 16 minutes
  assert.equal(readPedalLock(e), undefined, "idle: the device is free for others");
  assert.equal(hold.use(true), undefined);
  assert.equal(readPedalLock(e)?.owner, OWNER, "taken again");
  assert.deepEqual(notes, ["info: the device's lock had gone idle; it is held again"]);

  idleFor(e, PEDAL_LOCK_IDLE_MS + 60_000);
  const other = acquirePedalLock("hardware check", { env: e });
  assert.ok(other.ok, "someone else takes the idle device");
  assert.match(hold.use(true)!, /^The device is in use: hardware check \(process \d+\).*\. The capture left it alone/);
  assert.ok(hold.use(true), "still theirs");
  assert.equal(notes.filter((n) => n.startsWith("warning")).length, 1, "said once");
  hold.release();
  assert.equal(readPedalLock(e)?.owner, "hardware check", "release leaves their lock alone");
  releasePedalLock(other.lock, e);
  assert.equal(hold.use(true), undefined, "free again: taken again");
  assert.equal(readPedalLock(e)?.owner, OWNER);
  hold.release();
});
