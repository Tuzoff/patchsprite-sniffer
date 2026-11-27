// The pedal lock module (src/pedal-lock.ts), each test in its own temp PATCHSPRITE_HOME.

import { mock, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import {
  acquirePedalLock,
  assertPedalFree,
  describePedalLock,
  foreignPedalLock,
  keepPedalLockInUse,
  PEDAL_LOCK_IDLE_MS,
  PEDAL_LOCK_MAX_AGE_MS,
  PEDAL_LOCK_TOKEN_ENV,
  PedalBusyError,
  pedalBusyHolder,
  pedalBusyText,
  pedalLockPath,
  processAlive,
  readPedalLock,
  releasePedalLock,
  renewOwnPedalLock,
  stopPedalLock,
  touchPedalLock,
} from "../src/pedal-lock.ts";

const env = () => ({ PATCHSPRITE_HOME: mkdtempSync(join(tmpdir(), "patchsprite-lock-")) });

function writeLock(e: NodeJS.ProcessEnv, text: string) {
  const path = pedalLockPath(e);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

/** A pid no process has: a child that has already exited. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""]);
  await new Promise((r) => child.on("exit", r));
  return child.pid!;
}

test("acquire writes {owner, pid, startedAt} under PATCHSPRITE_HOME and release removes it", () => {
  const e = env();
  const got = acquirePedalLock("editor walk", { env: e });
  assert.ok(got.ok);
  assert.equal(pedalLockPath(e), join(e.PATCHSPRITE_HOME, "pedal.lock"));
  const onDisk = JSON.parse(readFileSync(pedalLockPath(e), "utf8"));
  assert.deepEqual(Object.keys(onDisk).sort(), ["owner", "pid", "startedAt"]);
  assert.deepEqual(onDisk, got.lock);
  assert.equal(onDisk.pid, process.pid);
  assert.deepEqual(readPedalLock(e), got.lock);
  assert.equal(releasePedalLock(got.lock, e), true);
  assert.equal(existsSync(pedalLockPath(e)), false);
  assert.equal(readPedalLock(e), undefined);
  // and it can be taken again
  assert.ok(acquirePedalLock("editor walk", { env: e }).ok);
});

test("a second taker is refused while the lock is live, and can't release it", () => {
  const e = env();
  const first = acquirePedalLock("editor walk", { env: e });
  assert.ok(first.ok);
  const second = acquirePedalLock("hardware check", { env: e });
  assert.equal(second.ok, false);
  assert.deepEqual(!second.ok && second.holder, first.lock);
  assert.equal(releasePedalLock({ ...first.lock, owner: "hardware check" }, e), false);
  assert.deepEqual(readPedalLock(e), first.lock);
  assert.match(describePedalLock(first.lock), /^editor walk \(process \d+\) has held the pedal since /);
});

test("a lock older than six hours is stale and taken over", () => {
  const e = env();
  const old = new Date(Date.now() - PEDAL_LOCK_MAX_AGE_MS - 60_000).toISOString();
  writeLock(e, JSON.stringify({ owner: "old walk", pid: process.pid, startedAt: old }));
  assert.equal(readPedalLock(e), undefined);
  const got = acquirePedalLock("editor walk", { env: e });
  assert.ok(got.ok);
  assert.equal(JSON.parse(readFileSync(pedalLockPath(e), "utf8")).owner, "editor walk");
});

test("a lock whose process is gone is stale and taken over", async () => {
  const e = env();
  writeLock(e, JSON.stringify({ owner: "crashed walk", pid: await deadPid(), startedAt: new Date().toISOString() }));
  assert.equal(readPedalLock(e), undefined);
  assert.ok(acquirePedalLock("editor walk", { env: e }).ok);
});

test("stop releases its owner's live lock, removes a dead holder's file, and leaves someone else's lock alone", async () => {
  const e = env();
  assert.deepEqual(stopPedalLock("editor walk", e), { ok: true });
  writeLock(e, JSON.stringify({ owner: "crashed walk", pid: await deadPid(), startedAt: new Date().toISOString() }));
  assert.deepEqual(stopPedalLock("editor walk", e), { ok: true });
  assert.equal(existsSync(pedalLockPath(e)), false);
  const got = acquirePedalLock("editor walk", { env: e });
  assert.ok(got.ok);
  assert.deepEqual(stopPedalLock("hardware check", e), { ok: false, holder: got.lock });
  assert.deepEqual(readPedalLock(e), got.lock);
  assert.deepEqual(stopPedalLock("editor walk", e), { ok: true });
  assert.equal(existsSync(pedalLockPath(e)), false);
  const long = "w".repeat(250);
  assert.ok(acquirePedalLock(long, { env: e }).ok);
  assert.deepEqual(stopPedalLock(long, e), { ok: true }, "a name cut when taken still matches");
});

test("an empty PATCHSPRITE_HOME still puts the lock at an absolute path, so every process finds the same one", () => {
  // a temp LOCALAPPDATA, so the old-place probe never looks at this PC's real one
  const local = mkdtempSync(join(tmpdir(), "patchsprite-lock-"));
  assert.ok(isAbsolute(pedalLockPath({ PATCHSPRITE_HOME: "", LOCALAPPDATA: local })));
});

test("a file that isn't a lock counts as stale", () => {
  const e = env();
  for (const text of ["", "{", JSON.stringify({ owner: "x", pid: -1, startedAt: new Date().toISOString() }), JSON.stringify({ owner: "x", pid: 1, startedAt: "never" })]) {
    writeLock(e, text);
    assert.equal(readPedalLock(e), undefined, text);
    const got = acquirePedalLock("editor walk", { env: e });
    assert.ok(got.ok, text);
    releasePedalLock(got.lock, e);
  }
});

test("control characters in the owner never reach a refusal", () => {
  assert.equal(describePedalLock({ owner: "walk\x1b[2J\r\n", pid: 7, startedAt: "2026-11-23T00:00:00.000Z" }), "walk[2J (process 7) has held the pedal since 2026-11-23T00:00:00.000Z");
});

/** Starts `n` processes that each try to take the lock at the same moment; returns how many got it. */
async function race(e: NodeJS.ProcessEnv, n: number): Promise<number> {
  const mod = new URL("../src/pedal-lock.ts", import.meta.url).href;
  const go = join(e.PATCHSPRITE_HOME!, "go");
  const done = join(e.PATCHSPRITE_HOME!, "done");
  const until = (file: string) => `while (!existsSync(${JSON.stringify(file)})) await new Promise((r) => setTimeout(r, 2));`;
  // each racer says when it is loaded, races on "go", and stays (the winner keeping its lock live) until "done"
  const code = `
    import { existsSync } from "node:fs";
    import { acquirePedalLock } from ${JSON.stringify(mod)};
    console.log("ready");
    ${until(go)}
    const got = acquirePedalLock("racer");
    console.log(got.ok ? "won" : "lost");
    ${until(done)}
  `;
  let ready = 0;
  const results: string[] = [];
  const markReady = () => ++ready === n && writeFileSync(go, "");
  const result = (r: string) => results.push(r) === n && writeFileSync(done, "");
  const runs = Array.from({ length: n }, () => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", code], { env: { ...process.env, ...e } });
    let said = 0; // lines said so far: "ready", then the result
    let partial = ""; // a line not yet ended
    let err = "";
    child.stderr.on("data", (d) => (err += d));
    child.stdout.setEncoding("utf8").on("data", (d: string) => {
      const lines = (partial + d).split(/\r?\n/);
      partial = lines.pop()!;
      for (const line of lines.filter(Boolean)) {
        if (said++ === 0) markReady();
        else result(line);
      }
    });
    // a racer that dies early still counts, so the others aren't left waiting and the assertions show why
    return new Promise((r) =>
      child.on("close", (code) => {
        if (said === 0) markReady();
        if (said < 2) result(`exited ${code}: ${err.trim()}`);
        r(code);
      }),
    );
  });
  await Promise.all(runs);
  assert.equal(results.length, n, results.join(","));
  assert.equal(results.filter((r) => r !== "won" && r !== "lost").length, 0, results.join(","));
  return results.filter((r) => r === "won").length;
}

test("of many processes racing for a free lock, exactly one wins", async () => {
  assert.equal(await race(env(), 8), 1);
});

test("of many processes racing to take over a stale lock, exactly one wins", async () => {
  const e = env();
  writeLock(e, JSON.stringify({ owner: "crashed walk", pid: await deadPid(), startedAt: new Date().toISOString() }));
  assert.equal(await race(e, 8), 1);
});

test("processAlive: true for a running process, false once it has exited", async () => {
  assert.equal(processAlive(process.pid), true);
  assert.equal(processAlive(await deadPid()), false);
});

test("a token is kept only as its sha256, and lets its holder's processes through while everyone else sees the lock", () => {
  const e = env();
  const got = acquirePedalLock("hardware check", { env: e, token: "s3cret" });
  assert.ok(got.ok);
  const onDisk = readFileSync(pedalLockPath(e), "utf8");
  assert.equal(onDisk.includes("s3cret"), false, "the token itself never reaches the file");
  assert.match(JSON.parse(onDisk).tokenHash, /^[0-9a-f]{64}$/);
  assert.deepEqual(readPedalLock(e), got.lock);
  assert.equal(foreignPedalLock({ ...e, [PEDAL_LOCK_TOKEN_ENV]: "s3cret" }), undefined, "the holder's own server passes");
  assert.deepEqual(foreignPedalLock({ ...e, [PEDAL_LOCK_TOKEN_ENV]: "guess" }), got.lock);
  assert.deepEqual(foreignPedalLock(e), got.lock, "no token: someone else");
  assert.doesNotThrow(() => assertPedalFree({ ...e, [PEDAL_LOCK_TOKEN_ENV]: "s3cret" }));
  assert.throws(() => assertPedalFree(e), (err: unknown) => err instanceof PedalBusyError && /^The pedal is busy with hardware check for less than a minute, since \d\d:\d\d\. /.test(err.message) && err.holder?.owner === "hardware check" && err.holder.since === got.lock.startedAt);
  releasePedalLock(got.lock, e);
  assert.equal(foreignPedalLock(e), undefined, "a free pedal is no one's");
});

test("a lock taken without a token lets no process through, whatever token it has", () => {
  const e = env();
  const got = acquirePedalLock("editor walk", { env: e });
  assert.ok(got.ok);
  assert.deepEqual(foreignPedalLock({ ...e, [PEDAL_LOCK_TOKEN_ENV]: "anything" }), got.lock);
});

test("a lock with a malformed tokenHash isn't a lock", () => {
  const e = env();
  writeLock(e, JSON.stringify({ owner: "x", pid: process.pid, startedAt: new Date().toISOString(), tokenHash: "zz" }));
  assert.equal(readPedalLock(e), undefined);
});

test("the busy answer names the holder, how long and since when in local time, without control characters", () => {
  const startedAt = "2026-11-23T10:00:00.000Z";
  const at = new Date(startedAt);
  const clock = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
  const lock = { owner: "editor[2J walk", pid: 7, startedAt: `${startedAt}‮` };
  const after = (ms: number) => new Date(at.getTime() + ms);
  assert.equal(pedalBusyText(lock, after(42 * 60_000 + 30_000)), `The pedal is busy with editor[2J walk for 42 minutes, since ${clock}. Try again when it finishes.`);
  assert.equal(pedalBusyText(lock, after(90_000)), `The pedal is busy with editor[2J walk for 1 minute, since ${clock}. Try again when it finishes.`);
  assert.equal(pedalBusyText(lock, after(20_000)), `The pedal is busy with editor[2J walk for less than a minute, since ${clock}. Try again when it finishes.`);
  assert.doesNotMatch(pedalBusyText(lock), /\d{4}-\d\d-\d\dT/, "no ISO time in the spoken text");
  assert.deepEqual(pedalBusyHolder(lock), { owner: "editor[2J walk", since: startedAt });
});

test("a start time that parses only with its control characters in still gives the busy answer, never another error", () => {
  const e = env();
  // V8 reads this as is (it stops at the NUL); with the NUL dropped, "...ZZ" doesn't parse
  const startedAt = `${new Date().toISOString()}\u0000Z`;
  assert.ok(!Number.isNaN(Date.parse(startedAt)));
  writeLock(e, JSON.stringify({ owner: "editor walk", pid: process.pid, startedAt }));
  assert.throws(
    () => assertPedalFree(e),
    (err: unknown) => err instanceof PedalBusyError && !/NaN/.test(err.message) && err.holder?.since === new Date(startedAt).toISOString(),
  );
});

/** Sets the lock file's modification time (its last use) `ms` ago. */
function idleFor(e: NodeJS.ProcessEnv, ms: number) {
  const then = new Date(Date.now() - ms);
  utimesSync(pedalLockPath(e), then, then);
}

test("a lock unused for 15 minutes is stale and taken over; one used since is not", () => {
  assert.equal(PEDAL_LOCK_IDLE_MS, 15 * 60 * 1000);
  const e = env();
  const first = acquirePedalLock("editor walk", { env: e });
  assert.ok(first.ok);
  idleFor(e, PEDAL_LOCK_IDLE_MS - 60_000);
  assert.deepEqual(readPedalLock(e), first.lock, "used 14 minutes ago: still held");
  assert.equal(acquirePedalLock("hardware check", { env: e }).ok, false);
  idleFor(e, PEDAL_LOCK_IDLE_MS + 60_000);
  assert.equal(readPedalLock(e), undefined, "unused for 16 minutes: free");
  assert.equal(touchPedalLock(first.lock, e), false, "an idle lock can't be brought back");
  const second = acquirePedalLock("hardware check", { env: e });
  assert.ok(second.ok, "and someone else takes it over");
  assert.equal(releasePedalLock(first.lock, e), false, "the first holder's release leaves the new lock alone");
});

test("touch keeps the holder's lock in use; it never touches someone else's", () => {
  const e = env();
  const got = acquirePedalLock("editor walk", { env: e });
  assert.ok(got.ok);
  idleFor(e, PEDAL_LOCK_IDLE_MS - 1000);
  assert.equal(touchPedalLock(got.lock, e), true);
  idleFor(e, 0);
  assert.deepEqual(readPedalLock(e), got.lock);
  assert.equal(touchPedalLock({ ...got.lock, owner: "someone else" }, e), false);
});

test("the holder's own processes renew the lock when they use the device; another process doesn't", () => {
  const e = env();
  const got = acquirePedalLock("demo run", { env: e, token: "secret-a" });
  assert.ok(got.ok);
  const usedAt = () => statSync(pedalLockPath(e)).mtimeMs;
  idleFor(e, PEDAL_LOCK_IDLE_MS - 60_000);
  const old = usedAt();
  renewOwnPedalLock({ ...e, [PEDAL_LOCK_TOKEN_ENV]: "secret-b" });
  renewOwnPedalLock(e);
  assert.equal(usedAt(), old, "no token, or another's: not renewed");
  renewOwnPedalLock({ ...e, [PEDAL_LOCK_TOKEN_ENV]: "secret-a" });
  assert.ok(usedAt() > old + 30_000, "its holder's token: renewed");
  assert.deepEqual(readPedalLock(e), got.lock);
});

test("a running command's lock is touched every minute, and the loss is reported once when it goes idle", () => {
  mock.timers.enable({ apis: ["setInterval"] });
  try {
    const e = env();
    const got = acquirePedalLock("scripted walk", { env: e });
    assert.ok(got.ok);
    let lost = 0;
    const timer = keepPedalLockInUse(got.lock, e, () => lost++);
    idleFor(e, PEDAL_LOCK_IDLE_MS - 1000);
    mock.timers.tick(60_000);
    assert.ok(Date.now() - statSync(pedalLockPath(e)).mtimeMs < 5_000, "touched");
    assert.equal(lost, 0);
    idleFor(e, PEDAL_LOCK_IDLE_MS + 1000); // the machine slept
    mock.timers.tick(60_000);
    mock.timers.tick(60_000);
    assert.equal(lost, 1, "reported once, then the timer stops");
    clearInterval(timer);
  } finally {
    mock.timers.reset();
  }
});
