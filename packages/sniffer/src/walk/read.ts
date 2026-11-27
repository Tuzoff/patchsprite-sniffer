// Reading the editor without clicking (S11): the control at a point through Windows UI Automation (its name, type
// and value, where the editor exposes them), and the editor's standard file and folder dialogs, which its screenshot
// can't show. Filling a dialog gives the editor input, so it runs `beforeInput` (the pedal lock) first.
import type { DialogInfo, FillResult, Rect, UiElement, WindowHost } from "./host.ts";
import { editorWindow, InputError, toScreen } from "./input.ts";

export interface ReadDeps {
  host: WindowHost;
  app: string;
  /** The screenshots' scale (shot.ts; default 0.5). */
  scale?: number;
}

/** The control at a point on the shot, with its rectangle in shot coordinates too, or null when UI Automation
 * finds nothing of the editor's there (many editors draw their own controls, which it can't see). */
export async function readControl(d: ReadDeps, x: number, y: number): Promise<(UiElement & { shotRect: Rect }) | null> {
  const scale = d.scale ?? 0.5;
  const win = await editorWindow(d.host, d.app);
  const p = toScreen(win.rect, scale, x, y);
  const res = await d.host.element(win.pid, p.x, p.y);
  if (!res.found) return null;
  const r = res.element.rect;
  const shotRect = {
    left: Math.round((r.left - win.rect.left) * scale),
    top: Math.round((r.top - win.rect.top) * scale),
    width: Math.round(r.width * scale),
    height: Math.round(r.height * scale),
  };
  return { ...res.element, shotRect };
}

export async function listDialogs(d: ReadDeps): Promise<DialogInfo[]> {
  const win = await editorWindow(d.host, d.app);
  return (await d.host.dialogs(win.pid)).dialogs;
}

export interface FillDeps extends ReadDeps {
  beforeInput: () => Promise<void>;
}

/** Types `path` into the editor's dialog titled `title` and presses its `button` (by caption, "&" ignored).
 * Returns the dialogs still open afterwards. */
export async function fillDialog(d: FillDeps, title: string, path: string, button: string): Promise<string[]> {
  if (!title || !button) throw new InputError("a dialog fill needs the dialog's title and the button's caption");
  if (/[\r\n]/.test(path)) throw new InputError("a path is one line");
  await d.beforeInput();
  const win = await editorWindow(d.host, d.app);
  const res: FillResult = await d.host.fill(win.pid, title, path, button);
  if (!res.done) {
    const open = (await d.host.dialogs(win.pid)).dialogs.map((x) => x.title);
    throw new InputError(`couldn't fill the dialog: ${res.why}. Open dialogs: ${open.length ? open.map((t) => JSON.stringify(t)).join(", ") : "none"}`);
  }
  return res.remaining;
}
