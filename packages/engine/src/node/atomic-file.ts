// Replacing a file another process reads while it changes (a simulated device's state, a map being rewritten): a
// temp file in the same folder, then a rename over it, so a reader never sees it half written.

import { renameSync, rmSync, writeFileSync } from "node:fs";

/**
 * Write `text` to `path` in one step. Windows refuses the rename for a moment while another process has the file
 * open, so that is retried briefly. A failed write leaves no temp file behind.
 */
export function writeFileAtomic(path: string, text: string): void {
  const tmp = `${path}.tmp-${process.pid}`; // one writer per process at a time: the write is synchronous
  try {
    writeFileSync(tmp, text);
    for (let tries = 0; ; tries++) {
      try {
        renameSync(tmp, path);
        return;
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (tries >= 50 || (code !== "EPERM" && code !== "EACCES" && code !== "EBUSY")) throw e;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    }
  } catch (e) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // the original error matters more than a leftover temp file
    }
    throw e;
  }
}
