#!/usr/bin/env node
// The pedal lock (src/pedal-lock.ts) for sessions that own a device across several MIDI connections, such as an editor
// walk, which closes and reopens the vendor editor between steps. While the lock is held, the Patchsprite app and any
// unattended check leave the device alone, so neither starts in a gap.
//
//   pedal-lock status                          prints "free", or who holds the pedal
//   pedal-lock run [--owner NAME] -- CMD ARGS  holds the lock while CMD runs; exits with its code
//   pedal-lock hold [--owner NAME] [--parent PID] [--print-token]
//                                              holds the lock until stopped; prints "held" once it has it, and exits
//                                              once the lock is no longer its own or, with --parent, within a second
//                                              of process PID ending (refused, exit 2, if PID isn't running)
//   pedal-lock stop [--owner NAME]             releases a live lock held under NAME, which ends its hold; exit 3 if
//                                              someone else holds the pedal
//   pedal-lock touch [--owner NAME]            marks the live lock held under NAME as in use now; exit 3 if it isn't
//                                              held under NAME
//
// Idle timeout: nothing holds the device while waiting on a person. A lock unused for 15 minutes is stale
// (src/pedal-lock.ts), and a hold then ends on its own. run keeps it in use while its command runs (a scripted walk:
// never wrap a command that waits on a person); a hold is kept in use by its holder each time that uses the device, or
// by touch as each step of a walk starts.
//
// When someone else holds a live lock, run and hold take nothing, print who holds it and exit with code 3; when the
// lock file can't be handled at all, every command prints why and exits with code 4 (run passes its command's own
// code through, 3 and 4 included: tell them apart by stderr; and run stops its command and exits 4 if the lock goes
// idle or is taken over while it runs, say after the machine slept). The lock is released when the command ends, on errors
// and on Ctrl+C; a process killed outright leaves a lock that is stale at once, since its process is gone (but a
// reused pid can keep it alive, so end a hold with stop, not a kill). NAME defaults to "editor walk". stop knows a
// hold only by NAME: run it only after your own hold printed "held".
//
// The holder's token: the Patchsprite app refuses to touch the device under someone else's lock, but lets through
// a process whose PATCHSPRITE_PEDAL_LOCK_TOKEN matches the one the lock was taken with. run and hold use that variable
// from their own environment, or make a random token; run passes it to CMD, and hold --print-token prints
// "token <hex>" on the line before "held", for the holder to give the processes it starts.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  acquirePedalLock,
  describePedalLock,
  keepPedalLockInUse,
  OWNER_MAX,
  PEDAL_LOCK_TOKEN_ENV,
  processAlive,
  readPedalLock,
  releasePedalLock,
  samePedalLock,
  stopPedalLock,
  touchPedalLock,
  type PedalLock,
} from "../src/pedal-lock.ts";

const HELD = 3;
const FAILED = 4;
const STOP_SIGNALS = ["SIGINT", "SIGTERM", "SIGBREAK", "SIGHUP"];
const [cmd, ...rest] = process.argv.slice(2);

const USAGE =
  "usage: pedal-lock status | run [--owner NAME] -- CMD [ARGS...] | hold [--owner NAME] [--parent PID] [--print-token] | stop [--owner NAME] | touch [--owner NAME]";

function help() {
  console.log(USAGE);
  process.exit(0);
}

function usage() {
  console.error(USAGE);
  process.exit(2);
}

/** Runs `fn`; if the lock file can't be handled, prints why and exits 4 (never 1, which a walk command can return). */
function orFail<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    console.error(`The pedal lock: ${(e as Error).message}`);
    process.exit(FAILED);
  }
}

/** Takes the lock for this process, with `token`, and releases it whenever the process exits; refuses (exit 3) when it is held. */
function take(owner: string, token: string): PedalLock {
  const got = orFail(() => acquirePedalLock(owner, { token }));
  if (!got.ok) {
    console.error(`The pedal is locked: ${describePedalLock(got.holder)}. Wait for it to finish, then try again.`);
    process.exit(HELD);
  }
  process.on("exit", () => {
    try {
      releasePedalLock(got.lock);
    } catch (e) {
      // a throw here would replace the exit code; a lock left behind is stale once this process is gone
      console.error(`Could not release the pedal lock: ${(e as Error).message}`);
    }
  });
  return got.lock;
}

if (cmd === "status") {
  const lock = orFail(() => readPedalLock());
  console.log(lock ? describePedalLock(lock) : "free");
  process.exit(0);
}
if (cmd === "help" || cmd === "--help") help();
if (cmd !== "run" && cmd !== "hold" && cmd !== "stop" && cmd !== "touch") usage();

// options, up to "--" (run) or the end
let owner = "editor walk";
let parent: number | undefined;
let printToken = false;
let args = rest;
while (args.length && args[0] !== "--") {
  const [opt, value] = args;
  if (opt === "--help") {
    help();
  } else if (opt === "--owner" && args.length >= 2) {
    owner = value;
    args = args.slice(2);
  } else if (opt === "--parent" && cmd === "hold" && /^[1-9]\d{0,9}$/.test(value ?? "") && Number(value) < 2 ** 31) {
    // (process.kill takes an int32 pid: a larger one is a usage error, not a process that isn't running)
    parent = Number(value);
    args = args.slice(2);
  } else if (opt === "--print-token" && cmd === "hold") {
    printToken = true;
    args = args.slice(1);
  } else {
    usage();
  }
}
if (cmd !== "run" && args.length) usage();
// the holder's token (see the header), for run and hold
const secret = process.env[PEDAL_LOCK_TOKEN_ENV] || randomBytes(32).toString("hex");

if (cmd === "touch") {
  const lock = orFail(() => readPedalLock());
  if (!lock || lock.owner !== owner.slice(0, OWNER_MAX)) {
    console.error(lock ? `Not touched: ${describePedalLock(lock)}, not ${owner}.` : "Not touched: the pedal is free.");
    process.exit(HELD);
  }
  if (!orFail(() => touchPedalLock(lock))) {
    console.error("Not touched: the lock went idle or was taken over meanwhile.");
    process.exit(HELD);
  }
  console.log("held");
} else if (cmd === "stop") {
  const stopped = orFail(() => stopPedalLock(owner));
  if (!stopped.ok) {
    console.error(`Not stopped: ${describePedalLock(stopped.holder)}, not ${owner}.`);
    process.exit(HELD);
  }
  console.log("free");
} else if (cmd === "hold") {
  // a parent that is already gone would release the lock at the first check: take nothing
  if (parent !== undefined && !processAlive(parent)) {
    console.error(`Not held: process ${parent} (--parent) isn't running.`);
    process.exit(2);
  }
  for (const sig of STOP_SIGNALS) process.on(sig, () => process.exit(0));
  const mine = take(owner, secret);
  if (printToken) console.log(`token ${secret}`);
  console.log("held");
  // stop released it (or it went stale and was taken over), or the parent is gone: nothing left to hold
  // (a failed read, say a virus scanner holding the file, keeps holding: crashing here would release the lock)
  setInterval(() => {
    if (parent !== undefined && !processAlive(parent)) process.exit(0);
    try {
      // stopped, taken over, or unused for 15 minutes (the exit handler then removes the idle file)
      if (!samePedalLock(readPedalLock(), mine)) process.exit(0);
    } catch {}
  }, 500);
} else {
  if (args[0] !== "--" || args.length < 2) usage();
  // a running command is in use (never wrap one that waits on a person): keep the lock from going idle
  const held = take(owner, secret);
  // the command, and the MCP server it may start, pass the lock with its token
  const child = spawn(args[1], args.slice(2), { stdio: "inherit", env: { ...process.env, [PEDAL_LOCK_TOKEN_ENV]: secret } });
  // lost (gone idle while the machine slept, say, and maybe taken over): the command must not drive the pedal on
  // under someone else's lock, so it is stopped and run exits 4
  let lost = false;
  keepPedalLockInUse(held, process.env, () => {
    lost = true;
    console.error(`The pedal lock went idle or was taken over while ${args[1]} ran; stopping it.`);
    child.kill();
  });
  // Ctrl+C, Ctrl+Break and closing the console reach the command too: let it stop and clean up on its own (killing it
  // here would be TerminateProcess on Windows) and keep the lock until it has exited
  for (const sig of STOP_SIGNALS) process.on(sig, () => sig === "SIGTERM" && child.kill());
  child.on("error", (e) => {
    // also emitted when a kill fails: then the command still runs, and keeps the lock until its own exit
    if (child.pid !== undefined) return console.error(`Could not stop ${args[1]}: ${e.message}`);
    console.error(`Could not start ${args[1]}: ${e.message}`);
    process.exit(1);
  });
  child.on("exit", (code, signal) => process.exit(lost ? FAILED : (code ?? (signal ? 1 : 0))));
}
