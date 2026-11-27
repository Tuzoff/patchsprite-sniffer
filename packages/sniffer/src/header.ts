// A new capture's header (docs/formats/capture.md).

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { platform, release } from "node:os";
import { CAPTURE_FORMAT, CAPTURE_VERSION, CaptureHeaderSchema, type CaptureHeader } from "@patchsprite/engine/capture";

const VERSION: string = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

export interface HeaderOptions {
  editorExe: string;
  editorVersion?: string;
  device?: CaptureHeader["device"];
  note?: string;
  now?: Date;
}

/** The header for a new frida-winmm session on this computer; throws, naming the field, on a value the format refuses. */
export function captureHeader(o: HeaderOptions): CaptureHeader {
  const os = platform();
  const h = {
    type: "header",
    format: CAPTURE_FORMAT,
    version: CAPTURE_VERSION,
    session: randomUUID(),
    startedAt: (o.now ?? new Date()).toISOString(),
    tool: { name: "patchsprite-sniffer", version: VERSION },
    os: { platform: os, release: release().slice(0, 64) },
    method: "frida-winmm",
    ...(o.device ? { device: o.device } : {}),
    editor: { exe: o.editorExe, ...(o.editorVersion ? { version: o.editorVersion } : {}) },
    ...(o.note ? { note: o.note } : {}),
  };
  const r = CaptureHeaderSchema.safeParse(h);
  if (!r.success) throw new Error(r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  return r.data;
}

/** capture-<time>-<first part of the session id>.jsonl, a name safe on every OS. */
export const defaultCaptureName = (h: CaptureHeader): string => `capture-${h.startedAt.replace(/[:.]/g, "-")}-${h.session.slice(0, 8)}.jsonl`;
