// The pedal lock: one file, pedal.lock in Patchsprite's data folder (dataHome in data-home.ts, or the folder an app
// sets with setPedalLockHome), that says a session owns the pedal for longer than one MIDI connection. An editor walk
// closes and reopens the vendor editor between steps, so the pedal's MIDI port is free in the gaps; the lock keeps
// another process (an unattended hardware run, the Patchsprite app) off the pedal in them. The format is shared: the
// Patchsprite app and the sniffer read and take the same file.
//
// The file holds JSON {owner, pid, startedAt}, plus tokenHash when the holder has a token: the sha256 of the secret in
// PATCHSPRITE_PEDAL_LOCK_TOKEN, which lets the holder's own MCP server (one hardware-check spawns, say) use the pedal
// that the lock keeps every other server off. It is created whole and exclusively (a finished temp file hard-linked
// into place, which fails if the lock exists), so two takers can't both win and a reader never sees it half written.
// A lock is stale, and taken over, when it is older than six hours, when its process is gone, or when it isn't a lock
// at all. Removing a stale lock, and releasing one's own, happen under a short guard file, so a taker can't delete a
// lock someone else has just created.

import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { linkSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { dataHome } from "./data-home.ts";

export interface PedalLock {
  /** who holds it, e.g. "editor walk" */
  owner: string;
  /** the holding process; the lock is stale once it is gone */
  pid: number;
  /** ISO time it was taken */
  startedAt: string;
  /** sha256 (hex) of the holder's token, when it has one; a process whose PEDAL_LOCK_TOKEN_ENV hashes to it is the holder */
  tokenHash?: string;
}

export type PedalLockResult = { ok: true; lock: PedalLock } | { ok: false; holder: PedalLock };

/** A lock older than this is stale whatever its process. */
export const PEDAL_LOCK_MAX_AGE_MS = 6 * 60 * 60 * 1000;
/** A guard file older than this was left by a process that died holding it. */
const GUARD_MAX_AGE_MS = 10_000;
/** Owner names are cut to this length. */
const OWNER_MAX = 200;

/** The environment variable that carries a holder's token to the processes it starts. */
export const PEDAL_LOCK_TOKEN_ENV = "PATCHSPRITE_PEDAL_LOCK_TOKEN";

const TOKEN_HASH = /^[0-9a-f]{64}$/;
const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

let lockHome: (env: NodeJS.ProcessEnv) => string = dataHome;

/** Sets the folder the lock is kept in, for this process (an app's own data folder, with its own checks). */
export function setPedalLockHome(home: (env: NodeJS.ProcessEnv) => string): void {
  lockHome = home;
}

export const pedalLockPath = (env: NodeJS.ProcessEnv = process.env) => join(lockHome(env), "pedal.lock");

/** Whether process `pid` is running. EPERM means it runs as someone else. */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function parse(text: string | undefined): PedalLock | undefined {
  if (text === undefined) return undefined;
  try {
    const v = JSON.parse(text);
    if (typeof v?.owner !== "string" || !Number.isSafeInteger(v.pid) || v.pid <= 0) return undefined;
    if (typeof v.startedAt !== "string" || Number.isNaN(Date.parse(v.startedAt))) return undefined;
    const lock: PedalLock = { owner: v.owner, pid: v.pid, startedAt: v.startedAt };
    if (v.tokenHash !== undefined) {
      if (typeof v.tokenHash !== "string" || !TOKEN_HASH.test(v.tokenHash)) return undefined;
      lock.tokenHash = v.tokenHash;
    }
    return lock;
  } catch {
    return undefined;
  }
}

function isLive(lock: PedalLock | undefined): lock is PedalLock {
  return !!lock && Date.now() - Date.parse(lock.startedAt) < PEDAL_LOCK_MAX_AGE_MS && processAlive(lock.pid);
}

/** Windows sharing errors that pass: a file being deleted (EPERM), or held open by a virus scanner or indexer. */
const SHARING = new Set(["EPERM", "EBUSY", "EACCES"]);
const sharing = (e: unknown) => SHARING.has((e as NodeJS.ErrnoException | undefined)?.code ?? "");
/** Whether `e` is a passing Windows sharing error (a read that may work a moment later). */
export const isSharingError = sharing;

const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Runs `io`, retrying Windows sharing errors for up to about a second. */
function patiently<T>(io: () => T): T {
  for (let tries = 0; ; tries++) {
    try {
      return io();
    } catch (e) {
      if (!sharing(e) || tries >= 50) throw e;
      pause(20);
    }
  }
}

/** How a lock is read: `once` reads without waiting out Windows sharing errors (a poll that simply tries again later). */
export type LockRead = { once?: boolean };

/** The lock file's text, or undefined when there is none. */
function readText(path: string, how: LockRead = {}): string | undefined {
  try {
    return how.once ? readFileSync(path, "utf8") : patiently(() => readFileSync(path, "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
}

/** Runs `fn` under the guard file beside the lock and returns its result; throws if the guard can't be had. */
function withGuard<T>(path: string, fn: () => T): T {
  const guard = `${path}.guard`;
  const start = Date.now();
  while (Date.now() - start < GUARD_MAX_AGE_MS + 1000) {
    try {
      writeFileSync(guard, String(process.pid), { flag: "wx" });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST" && !sharing(e)) throw e;
      try {
        if (Date.now() - statSync(guard).mtimeMs > GUARD_MAX_AGE_MS) rmSync(guard, { force: true });
      } catch {
        // gone already
      }
      pause(10);
      continue;
    }
    try {
      return fn();
    } finally {
      try {
        patiently(() => rmSync(guard, { force: true }));
      } catch {
        // fn's work is done; a guard left behind is cleared as dead after GUARD_MAX_AGE_MS
      }
    }
  }
  throw new Error(`Could not get the pedal lock's guard file (${guard}); try again.`);
}

/** Under the guard, removes the lock file unless `keep` holds for its text; returns whether it removed it. */
function removeUnless(path: string, keep: (text: string | undefined) => boolean): boolean {
  return withGuard(path, () => {
    if (keep(readText(path))) return false;
    patiently(() => rmSync(path, { force: true }));
    return true;
  });
}

/** Whether `a` is the very taking `b`: same owner, process and start. */
export function samePedalLock(a: PedalLock | undefined, b: PedalLock): boolean {
  return a?.pid === b.pid && a.startedAt === b.startedAt && a.owner === b.owner;
}

/** The live lock, or undefined when the pedal is free (no lock, or only a stale one). */
export function readPedalLock(env: NodeJS.ProcessEnv = process.env, how: LockRead = {}): PedalLock | undefined {
  const lock = parse(readText(pedalLockPath(env), how));
  return isLive(lock) ? lock : undefined;
}

/**
 * The live lock held by someone other than the process with `env`, or undefined when the pedal is free or the lock is
 * its own: `env` carries the token (PEDAL_LOCK_TOKEN_ENV) whose hash the lock holds.
 */
export function foreignPedalLock(env: NodeJS.ProcessEnv = process.env, how: LockRead = {}): PedalLock | undefined {
  const lock = readPedalLock(env, how);
  if (!lock) return undefined;
  const token = env[PEDAL_LOCK_TOKEN_ENV];
  if (lock.tokenHash && token && timingSafeEqual(Buffer.from(hashToken(token)), Buffer.from(lock.tokenHash))) return undefined;
  return lock;
}

/**
 * Takes the lock for `owner` and process `pid` (this one by default), with the hash of `token` when given. Refuses,
 * naming the holder, when someone else holds a live lock; a stale one is removed and taken over.
 */
export function acquirePedalLock(owner: string, opts: { env?: NodeJS.ProcessEnv; pid?: number; token?: string } = {}): PedalLockResult {
  const path = pedalLockPath(opts.env);
  mkdirSync(dirname(path), { recursive: true });
  const lock: PedalLock = { owner: owner.slice(0, OWNER_MAX), pid: opts.pid ?? process.pid, startedAt: new Date().toISOString() };
  if (opts.token) lock.tokenHash = hashToken(opts.token);
  const tmp = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(lock));
    for (let tries = 0; tries < 50; tries++) {
      try {
        patiently(() => linkSync(tmp, path));
        return { ok: true, lock };
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      }
      const seen = readText(path);
      if (seen === undefined) {
        pause(10); // released meanwhile, or being deleted
        continue;
      }
      const holder = parse(seen);
      if (isLive(holder)) return { ok: false, holder };
      // stale: remove it, but only if it is still the very lock judged stale
      removeUnless(path, (text) => text !== seen);
    }
    throw new Error("The pedal lock kept changing while it was being taken; try again.");
  } finally {
    try {
      patiently(() => rmSync(tmp, { force: true }));
    } catch {
      // a leftover temp file is harmless, and must not undo a lock already taken
    }
  }
}

/** Removes the lock if it is still `lock` (never someone else's). Returns whether it did; throws if the guard can't be had. */
export function releasePedalLock(lock: PedalLock, env: NodeJS.ProcessEnv = process.env): boolean {
  return removeUnless(pedalLockPath(env), (text) => !samePedalLock(parse(text), lock));
}

/**
 * Ends `owner`'s hold: releases a live lock held under that name, or removes a lock file that isn't live (a killed
 * holder's), so a reused pid can't bring it back. Refuses, naming the holder, when someone else holds a live lock.
 */
export function stopPedalLock(owner: string, env: NodeJS.ProcessEnv = process.env): { ok: true } | { ok: false; holder: PedalLock } {
  const path = pedalLockPath(env);
  const seen = readText(path);
  if (seen === undefined) return { ok: true };
  const lock = parse(seen);
  if (isLive(lock) && lock.owner !== owner.slice(0, OWNER_MAX)) return { ok: false, holder: lock };
  if (!removeUnless(path, (text) => text !== undefined && text !== seen)) throw new Error("The pedal lock changed meanwhile; try again.");
  return { ok: true };
}

/** What the file said, fit for a line of output: control and format characters dropped. */
const clean = (text: string) => text.replace(/[\p{Cc}\p{Cf}]/gu, "");
const ownerName = (lock: PedalLock) => clean(lock.owner).slice(0, OWNER_MAX) || "someone";

/** One line for a refusal: who holds the pedal and since when. */
export function describePedalLock(lock: PedalLock): string {
  return `${ownerName(lock)} (process ${lock.pid}) has held the pedal since ${clean(lock.startedAt)}`;
}

/**
 * When the lock was taken: startedAt as the file has it (what parse() checked), or with control and format characters
 * dropped when only that reads as a time. Dropping them can also break a time that parsed, so the raw text comes first.
 */
function startOf(lock: PedalLock): Date {
  const raw = new Date(lock.startedAt);
  return Number.isNaN(raw.getTime()) ? new Date(clean(lock.startedAt)) : raw;
}

/** How long since `start`, as said aloud: whole minutes, or "less than a minute". */
function heldFor(start: Date, now: Date): string {
  const minutes = Math.floor((now.getTime() - start.getTime()) / 60_000);
  if (minutes < 1) return "less than a minute";
  return minutes === 1 ? "1 minute" : `${minutes} minutes`;
}

/** `t` as HH:MM in this machine's local time (fixed digits, whatever the locale). */
function localClock(t: Date): string {
  return `${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}`;
}

/**
 * What the MCP server answers instead of touching the pedal while someone else holds the lock, in the chat voice (read
 * aloud, so no ISO time: the holder and its start go to structuredContent as `owner` and `since`).
 */
export function pedalBusyText(lock: PedalLock, now: Date = new Date()): string {
  const start = startOf(lock);
  return `The pedal is busy with ${ownerName(lock)} for ${heldFor(start, now)}, since ${localClock(start)}. Try again when it finishes.`;
}

/** Who holds the pedal, for structuredContent: the owner's name and the ISO time it took the lock. */
export type PedalBusyHolder = { owner: string; since: string };
export function pedalBusyHolder(lock: PedalLock): PedalBusyHolder {
  const start = startOf(lock);
  return { owner: ownerName(lock), since: Number.isNaN(start.getTime()) ? clean(lock.startedAt) : start.toISOString() };
}

/**
 * Thrown before a tool touches the pedal while someone else holds the lock, or while the lock can't be read; its
 * message is the answer to give, and `holder` says who holds it (absent when the lock can't be read).
 */
export class PedalBusyError extends Error {
  readonly holder: PedalBusyHolder | undefined;
  constructor(message: string, holder?: PedalBusyHolder, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "PedalBusyError";
    this.holder = holder;
  }
}

/**
 * Throws PedalBusyError when someone other than the process with `env` holds a live lock. A lock that can't be read
 * fails closed: it may be someone's, so the pedal counts as busy (a PedalBusyError without a holder).
 */
export function assertPedalFree(env: NodeJS.ProcessEnv = process.env, how: LockRead = {}): void {
  let holder: PedalLock | undefined;
  try {
    holder = foreignPedalLock(env, how);
  } catch (e) {
    throw new PedalBusyError(`The pedal lock can't be read (${(e as Error).message}), so the pedal may be in use. Try again in a moment.`, undefined, e);
  }
  if (holder) throw new PedalBusyError(pedalBusyText(holder), pedalBusyHolder(holder));
}
