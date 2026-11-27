// Turns what the frida-winmm agent (src/agent/winmm.js) reports into capture records (docs/formats/capture.md). The
// agent's reports are checked here, never trusted: a report that doesn't fit becomes a warning event, not a crash.

import type { CaptureRecord, EventRecord, MidiRecord } from "@patchsprite/engine/capture";

/** "f07d01f7" as capture bytes: "f0 7d 01 f7". */
export function spacedHex(hex: string): string | undefined {
  if (!/^(?:[0-9a-f]{2})+$/.test(hex) || hex.length > 2 * 65536) return undefined;
  return hex.match(/../g)!.join(" ");
}

const HANDLE = /^0x[0-9a-f]{1,16}$/;
const KINDS: Record<string, MidiRecord["kind"]> = { sysex: "sysex", sysexError: "sysexError", short: "short", shortError: "shortError" };

/**
 * One agent report as a capture record, timed `now` (when the sniffer got it); the agent's own time becomes `hookT`.
 * Undefined for a report the capture doesn't keep.
 */
export function agentRecord(payload: unknown, now: number): CaptureRecord | undefined {
  const p = (payload ?? {}) as Record<string, unknown>;
  const hookT = typeof p.t === "number" && Number.isFinite(p.t) && p.t >= 0 ? p.t : undefined;
  const dir = p.dir === "in" || p.dir === "out" ? p.dir : undefined;
  const port = typeof p.h === "string" && HANDLE.test(p.h) ? p.h : undefined;
  const warn = (text: string): EventRecord => ({ type: "event", t: now, kind: "warning", text });
  const kind = typeof p.kind === "string" ? p.kind : "";
  if (kind in KINDS) {
    const bytes = typeof p.hex === "string" ? spacedHex(p.hex) : undefined;
    if (!dir || !bytes) return warn(`the capture agent reported a ${kind} message it could not read`);
    const r: MidiRecord = { type: "midi", t: now, dir, kind: KINDS[kind], bytes };
    if (hookT !== undefined && hookT !== now) r.hookT = hookT;
    if (port) r.port = port;
    return r;
  }
  if (kind === "open" || kind === "close") {
    if (!dir) return warn(`the capture agent reported a port ${kind} without a direction`);
    const r: EventRecord = { type: "event", t: now, kind: kind === "open" ? "portOpen" : "portClose", dir };
    if (port) r.port = port;
    if (typeof p.dev === "number" && Number.isInteger(p.dev) && p.dev >= 0 && p.dev <= 255) r.device = p.dev;
    return r;
  }
  if (kind === "info" || kind === "warning") {
    const text = typeof p.text === "string" && p.text.length > 0 ? p.text.slice(0, 1024) : undefined;
    return text ? { type: "event", t: now, kind, text } : undefined;
  }
  return warn(`the capture agent sent a report of an unknown kind`);
}
