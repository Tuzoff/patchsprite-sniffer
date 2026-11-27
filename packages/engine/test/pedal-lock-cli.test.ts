// The pedal-lock command (bin/pedal-lock.ts), the entry point an editor walk holds the lock with. Each test has its own
// temp PATCHSPRITE_HOME, so the real lock is never taken or stopped.

import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const LOCK = fileURLToPath(new URL("../bin/pedal-lock.ts", import.meta.url));
// a token from the environment running the tests (a run under pedal-lock run) would let these through
delete process.env.PATCHSPRITE_PEDAL_LOCK_TOKEN;

function home() {
  const dir = mkdtempSync(join(tmpdir(), "patchsprite-lock-"));
  return { ...process.env, TEMP_ROOT: dir, PATCHSPRITE_HOME: join(dir, "Patchsprite") } as NodeJS.ProcessEnv;
}
const lockFile = (env: NodeJS.ProcessEnv) => join(env.PATCHSPRITE_HOME!, "pedal.lock");

function node(env: NodeJS.ProcessEnv, script: string, ...args: string[]): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [script, ...args], { env }, (e, out, err) => resolve({ code: e ? (e.code as number) : 0, out: out.trim(), err: err.trim() }));
  });
}
/** "free", or "held" when status names a holder. */
const state = async (env: NodeJS.ProcessEnv) => ((await node(env, LOCK, "status")).out === "free" ? "free" : "held");

/** `pedal-lock hold` in the background, once it says "held" (or the refusal it printed instead). */
function hold(env: NodeJS.ProcessEnv, owner = "editor walk", ...more: string[]): Promise<{ child: ChildProcess; held: boolean; out: string; err: string; exited: Promise<number> }> {
  const child = spawn(process.execPath, [LOCK, "hold", "--owner", owner, ...more], { env });
  // "close", not "exit": all of its stderr has arrived by then
  const exited = new Promise<number>((r) => child.on("close", (code) => r(code ?? -1)));
  let out = "";
  let err = "";
  child.stderr!.on("data", (d) => (err += d));
  return new Promise((resolve) => {
    child.stdout!.on("data", (d) => {
      out += d;
      if (/^held$/m.test(out)) resolve({ child, held: true, out, err, exited });
    });
    exited.then(() => resolve({ child, held: false, out, err: err.trim(), exited }));
  });
}

function writeLock(env: NodeJS.ProcessEnv, lock: object) {
  mkdirSync(env.PATCHSPRITE_HOME!, { recursive: true });
  writeFileSync(lockFile(env), JSON.stringify(lock));
}

test("a walk session holds the lock across its steps: status says who holds it, then free once it stops", async () => {
  const env = home();
  assert.equal(await state(env), "free");
  const walk = await hold(env);
  assert.ok(walk.held, walk.err);
  try {
    // the command that took the lock has long returned control; between steps the lock stays
    for (let step = 0; step < 2; step++) assert.equal(await state(env), "held");
    assert.match((await node(env, LOCK, "status")).out, /^editor walk \(process \d+\) has held the pedal since /);
  } finally {
    walk.child.kill();
    await walk.exited;
  }
  assert.equal(await state(env), "free");
  assert.equal((await node(env, LOCK, "status")).out, "free");
});

test("run holds the lock while its command runs and releases it after", async () => {
  const env = home();
  const r = await node(env, LOCK, "run", "--owner", "scripted walk", "--", process.execPath, LOCK, "status");
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^scripted walk \(process \d+\) has held the pedal since /, "status, run inside the walk, sees the walk's lock");
  assert.equal(existsSync(lockFile(env)), false);
  assert.equal(await state(env), "free");
});

test("a walk refuses to start under a foreign lock, and its command never runs", async () => {
  const env = home();
  const other = await hold(env, "hardware check");
  assert.ok(other.held, other.err);
  try {
    const marker = join(env.TEMP_ROOT!, "ran");
    const r = await node(env, LOCK, "run", "--", process.execPath, "-e", `require("fs").writeFileSync(${JSON.stringify(marker)}, "")`);
    assert.equal(r.code, 3);
    assert.match(r.err, /^The pedal is locked: hardware check \(process \d+\) has held the pedal since .+\. Wait for it to finish, then try again\.$/);
    assert.equal(existsSync(marker), false);
    const h = await hold(env);
    assert.equal(h.held, false);
    assert.equal(await h.exited, 3);
    assert.match(h.err, /^The pedal is locked: hardware check/);
    assert.equal(await state(env), "held", "the refused walk left the other lock alone");
  } finally {
    other.child.kill();
    await other.exited;
  }
});

test("two walks starting at once: one holds the pedal, the other is refused", async () => {
  const env = home();
  const both = await Promise.all([hold(env, "walk A"), hold(env, "walk B")]);
  try {
    assert.equal(both.filter((h) => h.held).length, 1, both.map((h) => h.err).join(" | "));
    const loser = both.find((h) => !h.held)!;
    assert.equal(await loser.exited, 3);
    assert.match(loser.err, /^The pedal is locked: walk [AB] /);
  } finally {
    for (const h of both) h.child.kill();
    await Promise.all(both.map((h) => h.exited));
  }
});

test("a lock older than six hours doesn't block: status says free and a walk takes it over", async () => {
  const env = home();
  writeLock(env, { owner: "forgotten walk", pid: process.pid, startedAt: new Date(Date.now() - 6 * 3600_000 - 60_000).toISOString() });
  assert.equal(await state(env), "free");
  const r = await node(env, LOCK, "run", "--", process.execPath, LOCK, "status");
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^editor walk \(process \d+\) has held the pedal since /);
  assert.equal(existsSync(lockFile(env)), false);
});

test("a walk killed outright leaves a lock that doesn't block, since its process is gone", async () => {
  const env = home();
  const walk = await hold(env);
  assert.ok(walk.held, walk.err);
  walk.child.kill("SIGKILL");
  await walk.exited;
  assert.equal(existsSync(lockFile(env)), true, "a hard kill runs no clean-up");
  assert.equal(await state(env), "free");
  const next = await hold(env, "next walk");
  assert.ok(next.held, next.err);
  next.child.kill();
  await next.exited;
});

test("a walk command that fails or can't start still releases the lock, and its exit code comes through", async () => {
  const env = home();
  const failed = await node(env, LOCK, "run", "--", process.execPath, "-e", "process.exit(7)");
  assert.equal(failed.code, 7);
  assert.equal(existsSync(lockFile(env)), false);
  const missing = await node(env, LOCK, "run", "--", join(env.TEMP_ROOT!, "no-such-walker.exe"));
  assert.equal(missing.code, 1);
  assert.match(missing.err, /^Could not start /);
  assert.equal(existsSync(lockFile(env)), false);
  assert.equal(await state(env), "free");
});

test("stop ends a walk's hold cleanly, and refuses to stop someone else's", async () => {
  const env = home();
  const walk = await hold(env);
  assert.ok(walk.held, walk.err);
  try {
    const foreign = await node(env, LOCK, "stop", "--owner", "hardware check");
    assert.equal(foreign.code, 3);
    assert.match(foreign.err, /^Not stopped: editor walk \(process \d+\) has held the pedal since .+, not hardware check\.$/);
    assert.equal(await state(env), "held");
    const r = await node(env, LOCK, "stop");
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out, "free");
    assert.equal(await walk.exited, 0, "the hold sees its lock gone and exits");
  } finally {
    walk.child.kill();
  }
  assert.equal(existsSync(lockFile(env)), false, "no lock left for a reused pid to keep alive");
  assert.equal(await state(env), "free");
  assert.equal((await node(env, LOCK, "stop")).out, "free", "stopping a free pedal is fine");
  // a hold killed outright leaves its file; stop clears it, so a reused pid can't bring it back
  const killed = await hold(env);
  assert.ok(killed.held, killed.err);
  killed.child.kill("SIGKILL");
  await killed.exited;
  assert.equal(existsSync(lockFile(env)), true);
  assert.equal((await node(env, LOCK, "stop")).out, "free");
  assert.equal(existsSync(lockFile(env)), false, "stop removed the killed hold's file");
});

test("a lock that can't be taken at all: hold and run say why and exit 4, and run's command never runs", async () => {
  const env = home();
  const notAFolder = join(env.TEMP_ROOT!, "not-a-folder");
  writeFileSync(notAFolder, "");
  const broken = { ...env, PATCHSPRITE_HOME: join(notAFolder, "Patchsprite") };
  const marker = join(env.TEMP_ROOT!, "ran");
  for (const args of [["hold"], ["run", "--", process.execPath, "-e", `require("fs").writeFileSync(${JSON.stringify(marker)}, "")`]]) {
    const r = await node(broken, LOCK, ...args);
    assert.equal(r.code, 4, `${args[0]}: ${r.err}`);
    assert.match(r.err, /^The pedal lock: /, args[0]);
  }
  assert.equal(existsSync(marker), false);
});

/** A process for a hold to watch with --parent: it runs until killed. */
function parentProcess(): { child: ChildProcess; exited: Promise<unknown> } {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
  return { child, exited: new Promise((r) => child.on("exit", r)) };
}

test("hold --parent releases the lock within a second of its parent ending", async () => {
  const env = home();
  const parent = parentProcess();
  try {
    const walk = await hold(env, "editor walk", "--parent", String(parent.child.pid));
    assert.ok(walk.held, walk.err);
    assert.equal(await state(env), "held");
    // while the parent runs, the lock stays
    await new Promise((r) => setTimeout(r, 1200));
    assert.equal(existsSync(lockFile(env)), true);
    const killedAt = Date.now();
    parent.child.kill();
    assert.equal(await walk.exited, 0, walk.err);
    const took = Date.now() - killedAt;
    assert.ok(took < 1500, `the hold took ${took} ms to see its parent gone`);
    assert.equal(existsSync(lockFile(env)), false, "released, not left for a reused pid");
    assert.equal(await state(env), "free");
  } finally {
    parent.child.kill();
  }
});

test("hold --parent refuses a parent that isn't running, and takes nothing", async () => {
  const env = home();
  const parent = parentProcess();
  parent.child.kill();
  await parent.exited;
  const walk = await hold(env, "editor walk", "--parent", String(parent.child.pid));
  assert.equal(walk.held, false);
  assert.equal(await walk.exited, 2);
  assert.equal(walk.err, `Not held: process ${parent.child.pid} (--parent) isn't running.`);
  assert.equal(existsSync(lockFile(env)), false);
  assert.equal(await state(env), "free");
  // --help shows the option and takes nothing, so a walk can probe for it
  const help = await node(env, LOCK, "hold", "--help");
  assert.equal(help.code, 0);
  assert.match(help.out, /hold \[--owner NAME\] \[--parent PID\]/);
  assert.equal(existsSync(lockFile(env)), false);
});
