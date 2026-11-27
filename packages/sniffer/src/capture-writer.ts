// Writes a capture file (docs/formats/capture.md) as the session goes: the header first, then one line per record,
// each written whole and at once, so a crash leaves every record before it readable. A new file only: an existing
// capture is never overwritten or appended to.

import { closeSync, fsyncSync, openSync, writeSync } from "node:fs";
import { captureLine, type CaptureHeader, type CaptureRecord } from "@patchsprite/engine/capture";

export class CaptureWriter {
  readonly path: string;
  private fd: number | undefined;
  private ended = false;

  /** Creates `path` (refused if it exists) and writes the header. */
  constructor(path: string, header: CaptureHeader) {
    this.path = path;
    const line = captureLine(header);
    this.fd = openSync(path, "wx");
    writeSync(this.fd, `${line}\n`);
  }

  /** Appends one record; a record the format refuses throws, and nothing is written. */
  write(record: CaptureRecord): void {
    if (this.fd === undefined || this.ended) throw new Error("the capture is closed");
    const line = captureLine(record);
    writeSync(this.fd, `${line}\n`);
    if (record.type === "end") this.ended = true;
  }

  /** Flushes to disk; call at step ends, so a finished step survives a power cut. */
  sync(): void {
    if (this.fd !== undefined) fsyncSync(this.fd);
  }

  close(): void {
    if (this.fd === undefined) return;
    try {
      fsyncSync(this.fd);
    } finally {
      closeSync(this.fd);
      this.fd = undefined;
    }
  }
}
