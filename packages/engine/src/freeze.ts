// Freezes for any driver, the engine's side: which message a silence may be pinned on, and the error a confirmed
// freeze is reported with. A driver tells the watch each message it sends and each one it hears; when a request goes
// unanswered, the watch names the first message the unit has not answered since. The driver then confirms the freeze
// (a liveness request, asked again after a pause, unanswered too, the unit still on USB) and the app blocks that entry
// on the unit's firmware (the app's map checks). Nothing here sends a message or retries one.

/**
 * A silence counts as a freeze we caused only when the request that met it went out this soon after the first message
 * the unit has not answered. Anything later may be the player's doing (unplugged, switched off).
 */
export const FREEZE_WINDOW_MS = 2000;

/** A message sent to the unit: its map entry (as the map checks spell it) and when it went out. */
export interface Outgoing {
  entry: string;
  at: number;
}

/** The first message sent since the unit last answered. */
export class SilenceWatch {
  private first: Outgoing | null = null;

  /** A message went out. One unanswered for longer than the window no longer counts: the newer one takes its place. */
  sent(entry: string, now = Date.now()): void {
    if (!this.first || now - this.first.at > FREEZE_WINDOW_MS) this.first = { entry, at: now };
  }

  /** The unit said something: whatever was sent before has been survived. */
  heard(): void {
    this.first = null;
  }

  /**
   * The message a silence met by a request sent at `sentAt` may be pinned on: the first one the unit has not answered
   * since, sent no more than FREEZE_WINDOW_MS before. Taken once, so one freeze is decided once however many requests
   * then go unanswered.
   */
  take(sentAt: number): Outgoing | null {
    const f = this.first;
    this.first = null;
    return f && sentAt - f.at <= FREEZE_WINDOW_MS ? f : null;
  }
}

/** The unit stopped answering right after a message of ours and still does not answer while on USB: it froze. */
export class DeviceFrozenError extends Error {
  /** the map entry it is pinned on */
  readonly entry: string;

  constructor(message: string, entry: string) {
    super(message);
    this.name = "DeviceFrozenError";
    this.entry = entry;
  }
}

/**
 * An entry as the player hears it, where the caller has no better name: "setBypass for amp", "parameter 12 of amp",
 * "control gain", "preset select (12)" (the preset's index as the map counts it).
 */
export function entryText(entry: string): string {
  const [kind, a, b] = entry.split("/");
  if (kind === "param") return `parameter ${b} of ${a}`;
  if (kind === "control") return `control ${a}`;
  if (kind === "presets") return a === undefined ? "preset select" : `preset select (${a})`;
  if (a === undefined) return kind;
  return b === undefined ? `${kind} for ${a}` : `${kind} for ${a}, parameter ${b}`;
}
