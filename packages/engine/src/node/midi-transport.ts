// A device's USB-MIDI ports through RtMidi. The RtMidi binding (@julusian/midi, or any module of the same shape) is
// the caller's, passed in, so the engine itself installs no native code. Ports are picked by the device's own name
// only (port-match.ts): a nameless-port fallback could grab another interface and send it the device's SysEx.

import { requestIdentity, type IdentityReply } from "../identity.ts";
import { bestMidiPortMatches, pairedOutputName } from "../port-match.ts";

/**
 * On Linux, RtMidi opens the ALSA sequencer non-blocking: a long write that fills the kernel's output pool is cut short
 * with no error. So a long frame goes out in spans of at most ALSA_SPAN bytes with a short wait between (RtMidi's ALSA
 * output takes a span without F0 or F7 and joins it to the open SysEx). Windows and Mac write a frame whole.
 */
export const ALSA_SPAN = 64;
const ALSA_PAUSE_MS = 1;

/** Writes `frame` through `write` whole when it fits one span, else span by span with a pause between; returns when the last span is written. */
export function sendInSpans(write: (bytes: number[]) => void, frame: Uint8Array, span: number, pauseMs: number): Promise<void> | void {
  if (frame.length <= span) {
    write(Array.from(frame));
    return;
  }
  return (async () => {
    for (let i = 0; i < frame.length; i += span) {
      if (i > 0) await new Promise((r) => setTimeout(r, pauseMs));
      try {
        write(Array.from(frame.subarray(i, i + span)));
      } catch (e) {
        // the spans already sent opened a SysEx the unit is still waiting to see the end of: close it with a bare F7,
        // if the port still takes a write, and report the failure as it was
        if (i > 0 && frame[0] === 0xf0) {
          try {
            write([0xf7]);
          } catch {
            // the port is gone: nothing more to send to
          }
        }
        throw e;
      }
    }
  })();
}

/** What a driver sends frames through and hears them on. A send on Linux may finish later (sendInSpans). */
export interface MidiTransport {
  send(frame: Uint8Array): Promise<void> | void;
  onData(cb: (chunk: Uint8Array) => void): void;
  close(): void;
}

/** The parts of an RtMidi binding this uses (@julusian/midi's default export has them). */
export interface RtMidiModule {
  Input: { new (): RtMidiInput; getPortNames(): string[] };
  Output: { new (): RtMidiOutput; getPortNames(): string[] };
}
export interface RtMidiInput {
  ignoreTypes(sysex: boolean, timing: boolean, activeSensing: boolean): void;
  on(event: "message", cb: (deltaTime: number, message: number[]) => void): unknown;
  openPort(port: number): void;
  destroy(): void;
}
export interface RtMidiOutput {
  sendMessage(message: number[]): void;
  openPort(port: number): void;
  destroy(): void;
}

export class PortNotFoundError extends Error {
  /** true when more than one port matched: replugging won't help, the message already says what will */
  readonly ambiguous: boolean;
  constructor(message: string, ambiguous = false) {
    super(message);
    this.name = "PortNotFoundError";
    this.ambiguous = ambiguous;
  }
}

export class PortBusyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PortBusyError";
  }
}

/** Every MIDI port the system reports, for diagnostics. */
export function listPorts(midi: RtMidiModule): { inputs: string[]; outputs: string[] } {
  return { inputs: midi.Input.getPortNames(), outputs: midi.Output.getPortNames() };
}

/** The one port that names `want` (see port-match.ts); none, or two equally good, is refused. */
export function findPort(names: string[], want: string, dir: string): number {
  const hits = bestMidiPortMatches(names, [want]);
  if (hits.length > 1) {
    // Windows names a second unit of the same model "2- X": the player's fix is to leave one connected
    throw new PortNotFoundError(
      `more than one MIDI ${dir} port matches "${want}" (${hits.map((h) => `"${names[h.port]}"`).join(", ")}). ` +
        "More than one unit of this model may be connected: unplug or switch off one unit so only one is left, then try again",
      true,
    );
  }
  if (!hits.length) {
    throw new PortNotFoundError(`no MIDI ${dir} port named "${want}" (ports: ${names.map((n) => `"${n}"`).join(", ") || "none"})`);
  }
  return hits[0].port;
}

/** The port named exactly `name`, as the system lists it (a port found by the unit's identity is opened this way). */
function exactPort(names: string[], name: string, dir: string): number {
  const i = names.indexOf(name);
  if (i < 0) throw new PortNotFoundError(`no MIDI ${dir} port named exactly "${name}" (ports: ${names.map((n) => `"${n}"`).join(", ") || "none"})`);
  return i;
}

/**
 * Opens the port the device's map names (`host.midiPort`), or with `exact`, the input port of exactly that name (one the
 * unit answered its identity on) and the one output that pairs with it (pairedOutputName): Windows numbers inputs and
 * outputs apart, so a unit's input "USB MIDI 1" pairs with its output "USB MIDI 2", and its second pair "MIDIIN2 (X)"
 * with "MIDIOUT2 (X)".
 */
export function openMidiTransport(midi: RtMidiModule, portName: string, opts: { exact?: boolean } = {}): MidiTransport {
  // find the ports first: RtMidi handles are only created once both exist, so a missing port leaks nothing
  const inIndex = (opts.exact ? exactPort : findPort)(midi.Input.getPortNames(), portName, "input");
  const outIndex = findPort(midi.Output.getPortNames(), opts.exact ? pairedOutputName(portName) : portName, "output");
  const input = new midi.Input();
  const output = new midi.Output();
  input.ignoreTypes(false, true, true); // SysEx is wanted
  let cb: (chunk: Uint8Array) => void = () => {};
  input.on("message", (_dt, msg) => cb(Uint8Array.from(msg)));
  // destroy, not closePort: it frees the RtMidi handles (closePort keeps them until GC), and the port is closed after
  // every idle spell. The output goes too when the input's destroy fails, so neither stays held.
  const destroyBoth = () => {
    try {
      input.destroy();
    } finally {
      output.destroy();
    }
  };
  try {
    input.openPort(inIndex);
    output.openPort(outIndex);
  } catch (e) {
    try {
      destroyBoth();
    } catch {
      // the port's own failure, explained below, is what the player needs
    }
    throw new PortBusyError(`could not open the "${portName}" MIDI port; another app (the device's own editor, for one) may be holding it: ${String(e)}`);
  }
  let pending: Promise<void> = Promise.resolve();
  return {
    send: (frame) => {
      if (process.platform !== "linux") return output.sendMessage(Array.from(frame));
      // one frame at a time, so the spans of two frames never interleave
      const done = pending.then(() => sendInSpans((b) => output.sendMessage(b), frame, ALSA_SPAN, ALSA_PAUSE_MS));
      pending = done.catch(() => {});
      return done;
    },
    onData: (f) => {
      cb = f;
    },
    close: destroyBoth,
  };
}

/**
 * Asks the unit on the port of exactly this name who it is (identity.ts), then closes the port. Null when the port is
 * gone or held by another app, or nothing answers in time.
 */
export async function askIdentityOn(midi: RtMidiModule, portName: string, timeoutMs: number): Promise<IdentityReply | null> {
  let t: MidiTransport;
  try {
    t = openMidiTransport(midi, portName, { exact: true });
  } catch {
    return null;
  }
  try {
    return await requestIdentity(t, timeoutMs);
  } finally {
    t.close();
  }
}
