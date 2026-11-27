// Self-healing maps, the engine's side: the unit is the referee and the map is a set of claims. Every check a session
// already makes (a reply the map decodes, a read-back after a switch, a block's parameter list) is an observation of
// one map entry. The app keeps them per unit and firmware; the engine only reports them and
// asks which entries the unit has contradicted. Nothing here sends a message or stores anything on the unit. The
// records an app keeps of them (a log line per check, a state file of marks) are in map-check-record.ts.

/**
 * What an observation says about a map entry:
 * - confirms: the unit did what the map claims (a reply the map decodes in a session, a change read back as asked, a
 *   write proven by an echo): the entry is `verified` on this unit, and no longer suspect or unsupported;
 * - decodes: the unit answered a request in the map's shape (size, consts, checksum, echo), as a read-only probe
 *   sees it, but nothing yet proves what the values mean: `shape-ok`;
 * - player-confirms: the player says a write the unit cannot read back did what was asked ("did the unit switch to
 *   preset 12?"): `player-confirmed`, weaker than a read-back;
 * - settles: the unit told apart the ways a map choice lists (its `observed.option` is the one that fits);
 * - contradicts: the unit did something else, or nothing (a request it never answers), and the entry turns suspect
 *   (after `strikes` in a row, default 1);
 * - reopens: a settled choice the unit's answer rules out while another option fits (another unit of the model may
 *   encode it the other way): unpinned, to be settled again;
 * - unsupported: this version of the app cannot do what the map says (an engine feature it lacks, or a fault in our
 *   own code): the entry is off until another version of the app runs, and retrying does nothing;
 * - disagrees: the unit did something else that no read-back can settle (a clamp, a label); logged, never acted on;
 * - skipped: an entry that was to be checked but nothing was sent (a probe's cap, a blocked message); logged only;
 * - retried: not the unit's word but the player's: a suspect entry is to be tried again, so it is no longer suspect
 *   and the unit checks it afresh (it turns suspect again after `strikes` more contradictions);
 * - answered-on-resend: the unit left a request unanswered, still answered a liveness probe, and answered the same
 *   request when it was sent again (a reply lost on the way): neither silence nor a plain decode. It changes no mark
 *   and adds no strike, so it never makes an entry suspect; the app counts them per entry in a session and lists an
 *   entry that needed it as flaky.
 */
export const OUTCOMES = [
  "confirms",
  "decodes",
  "player-confirms",
  "settles",
  "contradicts",
  "reopens",
  "unsupported",
  "disagrees",
  "skipped",
  "retried",
  "answered-on-resend",
] as const;
export type Outcome = (typeof OUTCOMES)[number];

/**
 * How far one unit (on one firmware) trusts a map entry, weakest first. A feature that needs several entries takes the
 * weakest of them (`weakest`), so one failed entry switches off one feature, not the device.
 * - blocked: the map blocks the entry's message on this firmware; nothing is sent;
 * - unsupported: this version of the app cannot do it (see the outcome);
 * - suspect: the unit contradicted it; writes are refused until it is settled, repaired or retried;
 * - unchecked: no evidence from this unit yet;
 * - shape-ok: a request the unit answered in the map's shape;
 * - player-confirmed: a write the player saw take effect;
 * - verified: the unit itself confirmed it (a decoded reply in a session, a read-back, an echo).
 */
export const TRUST_LEVELS = ["blocked", "unsupported", "suspect", "unchecked", "shape-ok", "player-confirmed", "verified"] as const;
export type TrustLevel = (typeof TRUST_LEVELS)[number];

/** The weakest of some trust levels: what a feature that needs all those entries can rely on (`verified` for none). */
export function weakest(levels: Iterable<TrustLevel>): TrustLevel {
  let out = TRUST_LEVELS.length - 1;
  for (const l of levels) out = Math.min(out, TRUST_LEVELS.indexOf(l));
  return TRUST_LEVELS[out];
}

/** An entry's trust on one unit, and for blocked, unsupported and suspect, why. */
export interface EntryTrust {
  level: TrustLevel;
  why?: string;
}

export interface Observation {
  /**
   * The map entry: a message ("getPreset"), a message on one block ("setBypass/amp1"), a block parameter
   * ("param/amp1/12") or a choice ("choice/presetOrder").
   */
  entry: string;
  outcome: Outcome;
  /** how the unit (or player) showed it, for the log: "read-back", "echo", "probe", "player", "list", ... */
  how?: string;
  /** what the map claims */
  claimed?: unknown;
  /** what the unit did */
  observed?: unknown;
  /** for a contradiction, an unsupported entry or a skipped one: why, in the player's words ("the unit reports scene 2") */
  why?: string;
  /** contradictions in a row in one session, with no confirmation between, before the entry turns suspect (default 1) */
  strikes?: number;
}

/** One unit's checks on one firmware, as the codec and the driver see them. */
export interface UnitChecks {
  /** Choices this unit has settled: choice name -> option. The codec adds a choice as the unit settles it. */
  readonly pins: Record<string, string>;
  /** Why the unit has made an entry suspect, or undefined: writes to a suspect entry are refused. */
  suspect(entry: string): string | undefined;
  /** How far this unit trusts an entry of the map. */
  trust(entry: string): EntryTrust;
  observe(o: Observation): void;
}

export const choiceEntry = (choice: string): string => `choice/${choice}`;
export const paramEntry = (block: string, id: number): string => `param/${block}/${id}`;
