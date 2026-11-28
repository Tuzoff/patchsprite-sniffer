// Matching MIDI port names against a map's port name (`host.midiPort`). One rule for the device choice and for opening
// the ports, so a name that picks a device is the name that opens it.
//
// A name matches as a whole name only: "Unit 2" is in "Unit 2 MIDI" and "2- Unit 2", never in "Unit 20".
// A port that is the name itself, or the name with Windows' "N- " instance prefix or a trailing " N" number, is an
// exact match and beats one that only holds the name. Among several names, the longest that matches wins.

// a combining mark belongs to the letter before it: "Cafe" is not a whole name in a decomposed "Café"
const WORD = /[\p{L}\p{M}\p{N}]/u;

/** A port name without Windows' "N- " instance prefix and trailing " N" number: "2- Acme FX-1 3" is "Acme FX-1". */
export function bareMidiPortName(portName: string): string {
  return portName.replace(/^\d+- /, "").replace(/ \d+$/, "");
}

/**
 * The output port name that pairs with a unit's input port: its bare name ("USB MIDI 1" pairs with "USB MIDI 2"), with
 * Windows' numbered second pairs named apart by direction ("MIDIIN2 (X)" pairs with "MIDIOUT2 (X)").
 */
export function pairedOutputName(inputName: string): string {
  return bareMidiPortName(inputName).replace(/^MIDIIN(\d+) \(/, "MIDIOUT$1 (");
}

/** How a port's name holds `want`: 2 is the name itself (instance numbers aside), 1 holds it as a whole name, 0 not at all. */
export function midiPortMatch(portName: string, want: string): 0 | 1 | 2 {
  if (!want) return 0;
  if (portName === want || bareMidiPortName(portName) === want) return 2;
  for (let i = portName.indexOf(want); i >= 0; i = portName.indexOf(want, i + 1)) {
    const before = portName[i - 1];
    const after = portName[i + want.length];
    if ((before === undefined || !WORD.test(before)) && (after === undefined || !WORD.test(after))) return 1;
  }
  return 0;
}

export interface MidiPortHit {
  /** index into the port names */
  port: number;
  /** index into the wanted names */
  want: number;
}

/**
 * The best matches of any wanted name among the ports. The longest wanted name that matches wins; two names of that
 * length that both match are a tie. For one name, exact matches beat whole-name ones. Every equally good hit is
 * returned, so more than one means the choice is ambiguous; none, no match.
 */
export function bestMidiPortMatches(portNames: readonly string[], wants: readonly string[]): MidiPortHit[] {
  const hits = wants.flatMap((want, w) => portNames.map((name, p) => ({ port: p, want: w, kind: midiPortMatch(name, want) })));
  const matched = hits.filter((h) => h.kind > 0);
  if (!matched.length) return [];
  const longest = Math.max(...matched.map((h) => wants[h.want].length));
  const top = matched.filter((h) => wants[h.want].length === longest);
  const oneName = top.every((h) => h.want === top[0].want);
  const kind = Math.max(...top.map((h) => h.kind));
  return top.filter((h) => !oneName || h.kind === kind).map(({ port, want }) => ({ port, want }));
}
