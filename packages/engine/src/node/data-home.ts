// Patchsprite's data folder, where the pedal lock lives: PATCHSPRITE_HOME when set (an absolute path), otherwise
// <home>\Claude\Patchsprite on Windows and $XDG_DATA_HOME/patchsprite (or ~/.local/share/patchsprite) elsewhere. The
// Patchsprite app finds the same folder, so the sniffer and the app see one lock.

import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export interface DataHomeOptions {
  platform?: NodeJS.Platform;
  home?: string;
}

/**
 * The data folder PATCHSPRITE_HOME names, or the default one. A relative PATCHSPRITE_HOME is refused: processes started
 * in different folders would each find their own, splitting the data (and the lock).
 */
export function dataHome(env: NodeJS.ProcessEnv = process.env, opts: DataHomeOptions = {}): string {
  if (env.PATCHSPRITE_HOME) {
    if (!isAbsolute(env.PATCHSPRITE_HOME)) throw new Error("PATCHSPRITE_HOME must be an absolute path");
    return resolve(env.PATCHSPRITE_HOME);
  }
  return defaultDataHome(env, opts);
}

/** The data folder when PATCHSPRITE_HOME is not set. */
export function defaultDataHome(env: NodeJS.ProcessEnv = process.env, { platform = process.platform, home = homedir() }: DataHomeOptions = {}): string {
  if (platform === "win32") return join(home, "Claude", "Patchsprite");
  const xdg = env.XDG_DATA_HOME && isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : join(home, ".local", "share");
  return join(xdg, "patchsprite");
}
