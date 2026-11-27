// A device's USB-MIDI ports through RtMidi. The RtMidi binding (@julusian/midi, or any module of the same shape) is
// the caller's, passed in, so the engine itself installs no native code. Ports are picked by the device's own name
// only (port-match.ts): a nameless-port fallback could grab another interface and send it the device's SysEx.

import { bestMidiPortMatches } from "../port-match.ts";

/** What a driver sends frames through and hears them on. */
export interface MidiTransport {
  send(frame: Uint8Array): void;
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

/** Opens the port the device's map names (`host.midiPort`). */
export function openMidiTransport(midi: RtMidiModule, portName: string): MidiTransport {
  // find the ports first: RtMidi handles are only created once both exist, so a missing port leaks nothing
  const inIndex = findPort(midi.Input.getPortNames(), portName, "input");
  const outIndex = findPort(midi.Output.getPortNames(), portName, "output");
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
  return {
    send: (frame) => output.sendMessage(Array.from(frame)),
    onData: (f) => {
      cb = f;
    },
    close: destroyBoth,
  };
}
