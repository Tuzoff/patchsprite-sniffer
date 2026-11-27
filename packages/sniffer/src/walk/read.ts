// Reading the editor without clicking (S11): the control at a point through Windows UI Automation (its name, type
// and value, where the editor exposes them), and the editor's standard file and folder dialogs, which its screenshot
// can't show. Filling a dialog gives the editor input, so it runs `beforeInput` (the pedal lock) first.
import { extname, isAbsolute, relative, resolve } from "node:path";
import type { DialogInfo, FillResult, Rect, UiElement, WindowHost } from "./host.ts";
import { editorWindow, HAZARD, InputError, toScreen } from "./input.ts";

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
  /** The only folder a dialog may be pointed at: the capture's own folder. Nothing else can be opened or saved over,
   * so a walk can't load a firmware file, an update or the user's own files through a dialog. */
  allowedRoot: string;
}

/** Extensions a dialog fill refuses even inside the allowed folder: firmware, updates and programs. */
export const REFUSED_EXTENSIONS: readonly string[] = [
  ".bin", ".fw", ".dfu", ".hex", ".img", ".upd", ".update", ".firmware",
  ".exe", ".msi", ".msix", ".dll", ".bat", ".cmd", ".ps1", ".vbs", ".js", ".zip",
];

/** SysEx and MIDI files can carry firmware, so they are refused for Open and import, but many editors save their
 * backups only as these, so a save may write one. */
export const SAVE_ONLY_EXTENSIONS: readonly string[] = [".syx", ".mid"];

/** A fill saves when the button it presses says Save; the title alone doesn't count, since an Open dialog may be
 * titled "Open saved backup". */
export const isSave = (button: string): boolean => /save/i.test(button);

/** Refuses a dialog path outside `root` or with a refused extension; returns the resolved path. */
export function checkDialogPath(root: string, path: string, save = false): string {
  if (/[\r\n]/.test(path)) throw new InputError("a path is one line");
  // Characters no Windows file name holds: a dialog's box reads quotes as a list of files and * ? as a filter.
  if (/["*?<>|]/.test(path)) throw new InputError('a dialog path may not hold " * ? < > or |');
  if (!isAbsolute(path)) throw new InputError("give the dialog a full path, inside the capture's folder");
  const full = resolve(path);
  const rel = relative(resolve(root), full);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new InputError(`a dialog may only be pointed inside the capture's folder (${resolve(root)}), so nothing else on the computer can be opened or overwritten`);
  }
  // Windows drops a name's trailing dots and spaces ("update.bin." opens update.bin) and reads "name:stream" as a
  // stream of that file, so neither can hide an extension.
  if (full.split(/[\\/]/).some((seg) => /[. ]$/.test(seg)) || full.replace(/^[a-z]:/i, "").includes(":")) {
    throw new InputError("a dialog path may not end a name in a dot or space, or hold a colon after the drive");
  }
  const ext = extname(full).toLowerCase();
  if (REFUSED_EXTENSIONS.includes(ext)) throw new InputError(`a dialog fill never uses a ${ext} file: firmware, updates and programs are refused`);
  if (!save && SAVE_ONLY_EXTENSIONS.includes(ext)) throw new InputError(`a ${ext} file may be saved, never opened or imported: it can carry firmware`);
  return full;
}

/** Types `path` into the editor's dialog titled `title` and presses its `button` (by caption, "&" ignored).
 * Returns the dialogs still open afterwards. */
export async function fillDialog(d: FillDeps, title: string, path: string, button: string): Promise<string[]> {
  if (!title || !button) throw new InputError("a dialog fill needs the dialog's title and the button's caption");
  // Every #32770 window of the editor counts as a dialog, its own ones too, so a fill never presses a button that
  // a click would need the user's say-so for.
  if (HAZARD.test(button)) throw new InputError(`a dialog fill never presses "${button}": ask the user, and press it with editor_input if they say yes`);
  const full = checkDialogPath(d.allowedRoot, path, isSave(button));
  await d.beforeInput();
  const win = await editorWindow(d.host, d.app);
  const res: FillResult = await d.host.fill(win.pid, title, full, button);
  if (!res.done) {
    const open = (await d.host.dialogs(win.pid)).dialogs.map((x) => x.title);
    throw new InputError(`couldn't fill the dialog: ${res.why}. Open dialogs: ${open.length ? open.map((t) => JSON.stringify(t)).join(", ") : "none"}`);
  }
  return res.remaining;
}
