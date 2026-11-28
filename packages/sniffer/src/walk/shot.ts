// Editor-window screenshots for the walk (S14, S11): the editor's window only, never the desktop, at half size by
// default so the model's turns stay short. The window is brought to the front first, and a blank frame (all white
// when the editor was behind, black after a native dialog) is retaken before it reaches the model.
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Rect, WindowHost } from "./host.ts";

export interface ShotOptions {
  /** The editor, as the window host names it (on Windows its executable name, such as "Editor.exe"). */
  app: string;
  /** Folder the screenshots go to. */
  dir: string;
  /** Name of the shot, without extension; made safe for a file name. */
  name: string;
  /** Saved width as a fraction of the window's width (default 0.5). */
  scale?: number;
  /** Tries in all, including the first (default 3). */
  tries?: number;
  /** Below this luminance range the frame counts as blank (default 16, as the prototype). */
  minSpread?: number;
  /** Wait between tries, in ms (default 400). */
  retryDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface Shot {
  path: string;
  /** The window's rectangle on screen when the shot was taken, in physical px. */
  window: Rect;
  /** Saved width / window width: a point (x, y) on the shot is (left + x / scale, top + y / scale) on screen. */
  scale: number;
  width: number;
  height: number;
  tries: number;
}

export class ShotError extends Error {}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** A shot name made safe for a file name: lower case, letters, digits and dashes, at most 60 characters. */
export function shotFileName(name: string): string {
  // Runs of anything else become one dash, then the dashes at either end go (split and join: no backtracking regex).
  const slug = name.toLowerCase().split(/[^a-z0-9]/).filter(Boolean).join("-").slice(0, 60).replace(/-$/, "");
  if (!slug) throw new ShotError("a shot needs a name with a letter or digit");
  return `${slug}.png`;
}

/** Maps a point read off a shot to the screen, for clicks (PR 7 uses this). */
export function shotToScreen(shot: Pick<Shot, "window" | "scale">, x: number, y: number): { x: number; y: number } {
  return { x: Math.round(shot.window.left + x / shot.scale), y: Math.round(shot.window.top + y / shot.scale) };
}

export async function takeEditorShot(host: WindowHost, o: ShotOptions): Promise<Shot> {
  const scale = o.scale ?? 0.5;
  if (!(scale > 0 && scale <= 1)) throw new ShotError("scale must be above 0 and at most 1");
  const tries = Math.max(1, o.tries ?? 3);
  const minSpread = o.minSpread ?? 16;
  const sleep = o.sleep ?? wait;
  const path = join(o.dir, shotFileName(o.name));
  await mkdir(o.dir, { recursive: true });
  let last = "";
  for (let i = 1; i <= tries; i++) {
    if (i > 1) await sleep(o.retryDelayMs ?? 400);
    const win = await host.find(o.app);
    if (!win.found) throw new ShotError(`no window of ${o.app}: is the editor running?`);
    await host.front(win.hwnd);
    const res = await host.shot(win.hwnd, path, scale, minSpread);
    if (res.saved && res.spread >= minSpread && res.width) {
      const s = res.width / res.rect.width;
      return { path, window: res.rect, scale: s, width: res.width, height: Math.round(res.rect.height * s), tries: i };
    }
    last = res.saved ? "the frame came back blank" : "the editor is covered by another window or not in front";
  }
  await rm(path, { force: true }); // a blank frame never reaches the model
  throw new ShotError(`no usable screenshot after ${tries} tries: ${last}. Bring the editor to the front and try again`);
}
