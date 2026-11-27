// The capture's hold on the device: Patchsprite's pedal lock, kept in use while the session works. A lock unused for
// 15 minutes goes stale (the engine's PEDAL_LOCK_IDLE_MS), because nothing holds the device while waiting on a person.
// So the hold is renewed when the session does something (a step starts or ends, the editor talks to the device), at
// most once a minute, and never by a timer: a capture left alone lets the device go. If it went idle, the next use
// takes it again, unless someone else has it by then.

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
        this.lostTo = undefined;
        if (had) this.note("info", "the device's lock had gone idle; it is held again");
        return undefined;
      }
      if (!this.lostTo || this.lostTo.pid !== got.holder.pid) this.note("warning", `the device's lock went idle and ${describePedalLock(got.holder)} has it now`.slice(0, 1024));
      this.lostTo = got.holder;
      return `The device is in use: ${describePedalLock(got.holder)}. The capture left it alone for a while, so it went to them. Wait for it to finish, then go on.`;
    } catch {
      return undefined;
    }
  }

  /** Gives the lock back, if this hold still has it. */
  release(): void {
    if (this.lock) releasePedalLock(this.lock, this.env);
    this.lock = undefined;
  }
}
