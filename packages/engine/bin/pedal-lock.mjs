#!/usr/bin/env node
// The pedal lock for sessions that own the device across several MIDI connections, such as an editor walk, which
// closes and reopens the vendor editor between steps. While the lock is held, the Patchsprite app keeps off the device
// (its MCP server answers "busy" and releases the MIDI port within about a second), so the walk has the port in the
// gaps. The lock file is pedal.lock in Patchsprite's data folder (PATCHSPRITE_HOME when set; see src/node/data-home.ts),
// the same file the app reads. Build the package first (npm run build): this runs the compiled engine.
//
//   pedal-lock.mjs status                          prints "free", or who holds the pedal
//   pedal-lock.mjs run [--owner NAME] -- CMD ARGS  holds the lock while CMD runs; exits with its code
//   pedal-lock.mjs hold [--owner NAME] [--parent PID] [--print-token]
//                                                  holds the lock until stopped; prints "held" once it has it, and
//                                                  exits once the lock is no longer its own or, with --parent, within
//                                                  a second of process PID ending (refused, exit 2, if PID isn't running)
//   pedal-lock.mjs stop [--owner NAME]             releases a live lock held under NAME, which ends its hold; exit 3
//                                                  if someone else holds the pedal
//
// When someone else holds a live lock, run and hold take nothing, print who holds it and exit with code 3; when the
// lock file can't be handled at all, every command prints why and exits with code 4 (run passes its command's own
// code through, 3 and 4 included: tell them apart by stderr). The lock is released when the command ends, on errors
// and on Ctrl+C; a process killed outright leaves a lock that is stale at once, since its process is gone (but a
// reused pid can keep it alive, so end a hold with stop, not a kill). NAME defaults to "editor walk". stop knows a
// hold only by NAME: run it only after your own hold printed "held".
//
// The holder's token: the app refuses to touch the pedal under someone else's lock, but lets through a process whose
// PATCHSPRITE_PEDAL_LOCK_TOKEN matches the one the lock was taken with. run and hold use that variable from their own
// environment, or make a random token; run passes it to CMD, and hold --print-token prints "token <hex>" on the line
// before "held", for the holder to give the processes it starts.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  acquirePedalLock,
  describePedalLock,
  PEDAL_LOCK_TOKEN_ENV,
  processAlive,
  readPedalLock,
  releasePedalLock,
  samePedalLock,
  stopPedalLock,
} from "../dist/node/pedal-lock.js";

const HELD = 3;
const FAILED = 4;
const STOP_SIGNALS = ["SIGINT", "SIGTERM", "SIGBREAK", "SIGHUP"];
const [cmd, ...rest] = process.argv.slice(2);

const USAGE =
  "usage: pedal-lock.mjs status | run [--owner NAME] -- CMD [ARGS...] | hold [--owner NAME] [--parent PID] [--print-token] | stop [--owner NAME]";

function help() {
  console.log(USAGE);
  process.exit(0);
}

function usage() {
  console.error(USAGE);
  process.exit(2);
}

/** Runs `fn`; if the lock file can't be handled, prints why and exits 4 (never 1, which a walk command can return). */
function orFail(fn) {
  try {
    return fn();
  } catch (e) {
    console.error(`The pedal lock: ${e.message}`);
    process.exit(FAILED);
  }
}

/** Takes the lock for this process, with `token`, and releases it whenever the process exits; refuses (exit 3) when it is held. */
function take(owner, token) {
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
      console.error(`Could not release the pedal lock: ${e.message}`);
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
if (cmd !== "run" && cmd !== "hold" && cmd !== "stop") usage();

// options, up to "--" (run) or the end
let owner = "editor walk";
let parent;
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

if (cmd === "stop") {
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
      if (!samePedalLock(readPedalLock(), mine)) process.exit(0);
    } catch {}
  }, 500);
} else {
  if (args[0] !== "--" || args.length < 2) usage();
  take(owner, secret);
  // the command, and the MCP server it may start, pass the lock with its token
  const child = spawn(args[1], args.slice(2), { stdio: "inherit", env: { ...process.env, [PEDAL_LOCK_TOKEN_ENV]: secret } });
  // Ctrl+C, Ctrl+Break and closing the console reach the command too: let it stop and clean up on its own (killing it
  // here would be TerminateProcess on Windows) and keep the lock until it has exited
  for (const sig of STOP_SIGNALS) process.on(sig, () => sig === "SIGTERM" && child.kill());
  child.on("error", (e) => {
    // also emitted when a kill fails: then the command still runs, and keeps the lock until its own exit
    if (child.pid !== undefined) return console.error(`Could not stop ${args[1]}: ${e.message}`);
    console.error(`Could not start ${args[1]}: ${e.message}`);
    process.exit(1);
  });
  child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
}
