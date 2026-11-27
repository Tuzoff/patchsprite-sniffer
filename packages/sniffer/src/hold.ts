// The capture's hold on the device: Patchsprite's pedal lock, kept in use while the session works. A lock unused for
// 15 minutes goes stale (the engine's PEDAL_LOCK_IDLE_MS), because nothing holds the device while waiting on a person.
// So the hold is renewed when the session does something (a step starts or ends, the editor talks to the device), at
// most once a minute, and never by a timer: a capture left alone lets the device go. If it went idle, the next use
// takes it again, unless someone else has it by then.

import type { MidiRecord } from "@patchsprite/engine/capture";
import { acquirePedalLock, describePedalLock, releasePedalLock, touchPedalLock, type PedalLock } from "@patchsprite/engine/pedal-lock";

/** How often a working session renews its hold. */
const RENEW_EVERY_MS = 60_000;

export const OWNER = "sniffer capture";

export class DeviceHold {
  private lock?: PedalLock;
  private readonly env: NodeJS.ProcessEnv;
  private readonly note: (kind: "info" | "warning", text: string) => void;
  private renewedAt: number;
  /** The holder that took the device after this hold went idle, until it is had again. */
  private lostTo?: PedalLock;
  /** While lost: the refusal to give, and when the device was last tried, so it is tried again at most once a minute. */
  private refusal?: string;
  private triedAt = 0;
  private failedOnce = false;
  /** Messages the editor has sent so far: a repeat is its own polling, not the user at work. */
  private readonly sent = new Set<string>();
  private readonly now: () => number;

  /** Takes the lock; refuses, in words, when someone else holds it. Throws if the lock file can't be handled. */
  static take(env: NodeJS.ProcessEnv, note: DeviceHold["note"], now: () => number = Date.now): DeviceHold {
    const got = acquirePedalLock(OWNER, { env });
    if (!got.ok) throw new Error(`The device is in use: ${describePedalLock(got.holder)}. Wait for it to finish, then start again.`);
    return new DeviceHold(got.lock, env, note, now);
  }

  private constructor(lock: PedalLock, env: NodeJS.ProcessEnv, note: DeviceHold["note"], now: () => number) {
    this.lock = lock;
    this.env = env;
    this.note = note;
    this.now = now;
    this.renewedAt = now();
  }

  /**
   * The session is working: renews the hold (at most once a minute unless `force`), or takes it again if it went idle.
   * Returns undefined while held, or what to tell the user when someone else has the device. Never throws: a missed
   * renewal only lets the hold go idle sooner.
   */
  use(force = false): string | undefined {
    if (!force && this.lock && this.now() - this.renewedAt < RENEW_EVERY_MS) return undefined;
    if (!force && !this.lock && this.refusal && this.now() - this.triedAt < RENEW_EVERY_MS) return this.refusal;
    try {
      if (this.lock && touchPedalLock(this.lock, this.env)) {
        this.renewedAt = this.now();
        return undefined;
      }
      // gone idle (left alone for 15 minutes), maybe taken over since: take it again if it's free
      const had = this.lock !== undefined;
      this.lock = undefined;
      const got = acquirePedalLock(OWNER, { env: this.env });
      if (got.ok) {
        this.lock = got.lock;
        this.renewedAt = this.now();
        this.lostTo = this.refusal = undefined;
        if (had) this.note("info", "the device's lock had gone idle; it is held again");
        return undefined;
      }
      if (!this.lostTo || this.lostTo.pid !== got.holder.pid) this.note("warning", `the device's lock went idle and ${describePedalLock(got.holder)} has it now`.slice(0, 1024));
      this.lostTo = got.holder;
      this.triedAt = this.now();
      this.refusal = `The device is in use: ${describePedalLock(got.holder)}. The capture left it alone for a while, so it went to them. Wait for it to finish, then go on.`;
      return this.refusal;
    } catch (e) {
      // the lock file can't be handled: say so once, since the hold now lapses on its own
      if (!this.failedOnce) this.note("warning", `could not renew the device's lock: ${(e as Error).message}`.slice(0, 1024));
      this.failedOnce = true;
      return undefined;
    }
  }

  /**
   * A message the capture saw: the editor sending something it hasn't sent before (the user changing something) is the
   * session at work, and renews the hold. Its own polls (repeating, or matching the poll set an idle recording found), clock, active sensing and the device's answers don't.
   */
  heard(r: MidiRecord): void {
    if (r.dir !== "out" || r.flags?.includes("poll") || r.bytes === "f8" || r.bytes === "fe" || this.sent.has(r.bytes)) return;
    // past the cap, nothing new can be told from a poll whose bytes vary, so traffic renews nothing more (steps still do)
    if (this.sent.size >= 4096) return;
    this.sent.add(r.bytes);
    this.use();
  }

  /** Gives the lock back, if this hold still has it. */
  release(): void {
    if (this.lock) releasePedalLock(this.lock, this.env);
    this.lock = undefined;
  }
}
