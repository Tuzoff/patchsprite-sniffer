// Click, type and the other walk input (S11), in the coordinates of the walk's screenshots (shot.ts), so the model
// reads a point off the latest shot and passes it as it is. Input lands only on the editor: the host refuses a point
// on any other window, and keys while another window is in front. A covered point is retried for a while (a chat
// app's overlay may sit there), then refused. The caller's `beforeInput` runs first: the walk uses it to make sure it
// holds the pedal lock.
import type { ElementResult, FoundWindow, InputResult, Rect, WindowHost } from "./host.ts";

export type Step =
  | { op: "click" | "dclick" | "rclick"; x: number; y: number }
  | { op: "wheel"; x: number; y: number; notches: number }
  | { op: "drag" | "slowdrag"; x: number; y: number; x1: number; y1: number }
  | { op: "key"; combo: string }
  | { op: "type"; text: string }
  | { op: "wait"; seconds: number };

/** Key names a step may use; one letter or digit also works on its own. */
export const KEYS: Readonly<Record<string, number>> = {
  enter: 0x0d, esc: 0x1b, tab: 0x09, backspace: 0x08, delete: 0x2e, space: 0x20,
  up: 0x26, down: 0x28, left: 0x25, right: 0x27, home: 0x24, end: 0x23, pgup: 0x21, pgdn: 0x22,
  ctrl: 0x11, shift: 0x10, alt: 0x12, plus: 0xbb, minus: 0xbd,
  f1: 0x70, f2: 0x71, f3: 0x72, f4: 0x73, f5: 0x74, f6: 0x75, f7: 0x76, f8: 0x77, f9: 0x78, f10: 0x79, f11: 0x7a, f12: 0x7b,
};

/** Keys that press or delete the focused control. */
const PRESS_KEYS = [KEYS.enter, KEYS.space, KEYS.delete, KEYS.backspace];

export class InputError extends Error {}

/** Controls a click never reaches without the user's say-so: firmware and updates, factory reset, storing or
 * deleting presets, accounts, uploads. Matched on the control's name as Windows UI Automation reports it; an editor
 * that draws its own controls hides them from it, so the walk prompt's guardrails still apply. */
export const HAZARD = /firmware|update|upgrade|factory|reset|initiali[sz]e|restore|\bstore\b|delete|erase|format|sign[ -]?in|log[ -]?in|account|upload|download|cloud|share|\bwrite\b|flash|install|overwrite|import/i;

/** The virtual-key codes of a combination such as "ctrl+z". */
export function keyCodes(combo: string): number[] {
  const names = combo.toLowerCase().split("+").map((k) => k.trim());
  return names.map((k) => {
    if (KEYS[k] !== undefined) return KEYS[k];
    if (/^[a-z0-9]$/.test(k)) return k.toUpperCase().charCodeAt(0);
    throw new InputError(`unknown key "${k}"; use one letter or digit, or one of: ${Object.keys(KEYS).join(", ")}`);
  });
}

/** One step in the short form the walk prompt uses: click:X,Y dclick:X,Y rclick:X,Y wheel:X,Y,N drag:X,Y,X1,Y1
 * slowdrag:X,Y,X1,Y1 key:ctrl+z type:TEXT wait:S. */
export function parseStep(s: string): Step {
  const i = s.indexOf(":");
  const op = i < 0 ? s : s.slice(0, i);
  const arg = i < 0 ? "" : s.slice(i + 1);
  const nums = (n: number) => {
    const v = arg.split(",").map((x) => Number(x.trim()));
    if (v.length !== n || v.some((x) => !Number.isFinite(x))) throw new InputError(`"${s}": ${op} takes ${n} numbers`);
    return v;
  };
  switch (op) {
    case "click":
    case "dclick":
    case "rclick": {
      const [x, y] = nums(2);
      return { op, x, y };
    }
    case "wheel": {
      const [x, y, notches] = nums(3);
      if (!Number.isInteger(notches) || notches === 0 || Math.abs(notches) > 50) throw new InputError(`"${s}": notches is a whole number from -50 to 50, not 0`);
      return { op, x, y, notches };
    }
    case "drag":
    case "slowdrag": {
      const [x, y, x1, y1] = nums(4);
      return { op, x, y, x1, y1 };
    }
    case "key":
      keyCodes(arg);
      return { op, combo: arg };
    case "type":
      if (!arg) throw new InputError(`"${s}": type needs text`);
      // A typed line break, tab or other control character can press a button, move the focus onto one or delete;
      // use key:enter, key:tab or key:backspace for those.
      if (/[\x00-\x1f\x7f]/.test(arg)) throw new InputError(`"${s}": type takes one line of text; use key:enter or key:tab between steps`);
      return { op, text: arg };
    case "wait": {
      const [seconds] = nums(1);
      if (seconds < 0 || seconds > 30) throw new InputError(`"${s}": wait is 0 to 30 seconds`);
      return { op, seconds };
    }
    default:
      throw new InputError(`unknown step "${s}"`);
  }
}

export interface InputDeps {
  host: WindowHost;
  /** The editor, as the host names it. */
  app: string;
  /** Runs before any input; the walk makes sure it holds the pedal lock here, and throws to stop. */
  beforeInput: () => Promise<void>;
  /** The screenshots' scale (shot.ts; default 0.5). */
  scale?: number;
  /** The user has approved clicking a control whose name matches HAZARD, for this call only. */
  hazardApproved?: boolean;
  /** How long a covered point is retried before the input is refused, in ms (default 30 s). */
  coveredTimeoutMs?: number;
  /** Wait between those tries, in ms (default 1 s). */
  retryMs?: number;
  /** Wait before a key or typed text that follows other input, so a dialog that input opened shows first (default 600 ms). */
  dialogSettleMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function editorWindow(host: WindowHost, app: string): Promise<FoundWindow> {
  const win = await host.find(app);
  if (!win.found) throw new InputError(`no window of ${app}: is the editor running?`);
  return win;
}

/** A point on a shot of the window, as screen px; refused if it falls outside the window. */
export function toScreen(rect: Rect, scale: number, x: number, y: number): { x: number; y: number } {
  if (x < 0 || y < 0 || x >= rect.width * scale || y >= rect.height * scale) {
    throw new InputError(`(${x}, ${y}) is outside the editor's window on the shot (${Math.round(rect.width * scale)} × ${Math.round(rect.height * scale)})`);
  }
  return { x: Math.round(rect.left + x / scale), y: Math.round(rect.top + y / scale) };
}

/** Runs the steps in order, each try after `beforeInput`, so input stops the moment the capture does. Stops at the
 * first refused step and says which. */
export async function runSteps(d: InputDeps, steps: Step[]): Promise<void> {
  const scale = d.scale ?? 0.5;
  const sleep = d.sleep ?? wait;
  const settle = d.dialogSettleMs ?? 600;
  let afterInput = false;
  for (const [n, step] of steps.entries()) {
    // A click or key may open a dialog, which takes a moment to show. Keys sent before then would queue up and land in
    // it unchecked, so they wait for it to appear and be seen by the dialog check.
    if (afterInput && (step.op === "key" || step.op === "type")) await sleep(settle);
    // A wait step at least that long gives the dialog its time (a shorter one, such as wait:0, doesn't); a wheel step
    // neither opens one nor gives it time.
    if (step.op === "wait") afterInput &&= step.seconds * 1000 < settle;
    else if (step.op !== "wheel") afterInput = true;
    if (step.op === "wait") {
      await sleep(step.seconds * 1000);
      continue;
    }
    const deadline = Date.now() + (d.coveredTimeoutMs ?? 30_000);
    for (;;) {
      // Look the window up again on every try: the editor may have moved or come back to the front.
      await d.beforeInput();
      const win = await editorWindow(d.host, d.app);
      await d.host.front(win.hwnd);
      await refuseDialogBypass(d, win, scale, step, n);
      if (!d.hazardApproved) {
        // A drag presses and releases like a click, so both its ends are checked too.
        if (step.op === "click" || step.op === "dclick" || step.op === "rclick" || step.op === "drag" || step.op === "slowdrag") await refuseHazard(d.host, win, scale, step, n);
        if (step.op === "drag" || step.op === "slowdrag") await refuseHazard(d.host, win, scale, { op: step.op, x: step.x1, y: step.y1 }, n);
        // Enter, space, delete and backspace act on whatever control has the focus, so they are checked like a click on it.
        const codes = step.op === "key" ? keyCodes(step.combo) : [];
        if (step.op === "key" && PRESS_KEYS.some((k) => codes.includes(k))) await refuseFocusedHazard(d.host, win.pid, `key:${step.combo}`, codes.includes(KEYS.enter), n);
        // A typed space presses a focused button too.
        if (step.op === "type" && step.text.includes(" ")) await refuseFocusedHazard(d.host, win.pid, "type", false, n);
        // In an open menu a letter picks the item it underlines, unseen; arrows and Enter (checked above) or a click
        // reach the same item with its name checked.
        if ((step.op === "type" || (step.op === "key" && !codes.includes(KEYS.ctrl) && codes.some(isLetterOrDigit))) && (await menuOpen(d.host, win.pid))) {
          throw new InputError(`step ${n + 1} (${step.op === "key" ? `key:${step.combo}` : "type"}) refused: a menu is open, and a letter there picks an item unseen. Click the item, or move to it with the arrow keys and press Enter`);
        }
      }
      const res = await send(d.host, win, scale, step);
      if (res.done) break;
      if (Date.now() >= deadline) {
        throw new InputError(`step ${n + 1} (${step.op}) refused: the point is on another window (${JSON.stringify(res.owner)}), not the editor`);
      }
      await sleep(d.retryMs ?? 1000);
    }
    await sleep(50);
  }
}

function refuseIfHazard(at: ElementResult, what: string) {
  if (at.found) refuseIfHazardName(at.element.name, what);
}

function refuseIfHazardName(name: string, what: string) {
  if (HAZARD.test(name)) {
    throw new InputError(`${what} "${name}", which can update firmware, reset, store over or delete. Ask the user first; only with their say-so, repeat it with hazardApproved.`);
  }
}

/** Buttons that only close a file dialog, which a click may press while one is open. */
const CLOSE_BUTTON = /^(cancel|close|no)$/i;

/** While one of the editor's standard file dialogs is open, its file name and its Open or Save button are fill_dialog's
 * alone, which keeps a file inside the capture's folder and checks its extension: input may only scroll, press Esc
 * or click Cancel. And an Alt shortcut presses a dialog's button unseen, so it is refused while any of the editor's dialogs
 * shows a hazard button. */
async function refuseDialogBypass(d: InputDeps, win: FoundWindow, scale: number, step: Exclude<Step, { op: "wait" }>, n: number) {
  if (step.op === "wheel") return;
  const { dialogs } = await d.host.dialogs(win.pid);
  if (!dialogs.length) return;
  const codes = step.op === "key" ? keyCodes(step.combo) : [];
  if (dialogs.some((x) => x.fileBox)) {
    // Esc alone only cancels.
    if (codes.length === 1 && codes[0] === KEYS.esc) return;
    if (step.op === "click") {
      const p = toScreen(win.rect, scale, step.x, step.y);
      const at = await d.host.element(win.pid, p.x, p.y);
      if (at.found && at.element.controlType === "Button" && CLOSE_BUTTON.test(at.element.name.replace(/&/g, "").trim())) return;
    }
    throw new InputError(`step ${n + 1} (${step.op}) refused: a file dialog is open. Use fill_dialog for its file name and its Open or Save button; editor_input may only scroll, press Esc or click Cancel there`);
  }
  if (d.hazardApproved || (step.op !== "key" && step.op !== "type")) return;
  const hazard = dialogs.flatMap((x) => x.buttons).find((b) => HAZARD.test(b));
  if (!hazard) return;
  // A dialog's mnemonic presses its button on Alt plus the letter, and on the bare letter too whenever the focus isn't
  // in a text box; typed text is only safe inside one.
  const mnemonic = step.op === "key" && (codes.includes(KEYS.alt) || (!codes.includes(KEYS.ctrl) && codes.some(isLetterOrDigit)));
  const typedOutsideBox = step.op === "type" && !(await focusedInTextBox(d.host, win.pid));
  if (mnemonic || typedOutsideBox) {
    throw new InputError(`step ${n + 1} (${step.op === "key" ? `key:${step.combo}` : "type"}) refused: it can press the dialog's "${hazard}" button through its shortcut letter, which can update firmware, reset, store over or delete. Ask the user first; only with their say-so, repeat it with hazardApproved.`);
  }
}

const isLetterOrDigit = (vk: number) => (vk >= 0x30 && vk <= 0x39) || (vk >= 0x41 && vk <= 0x5a);

async function menuOpen(host: WindowHost, pid: number): Promise<boolean> {
  const at = await host.focused(pid);
  return at.found && (at.element.controlType === "MenuItem" || at.element.controlType === "Menu" || at.element.controlType === "MenuBar");
}

async function focusedInTextBox(host: WindowHost, pid: number): Promise<boolean> {
  const at = await host.focused(pid);
  return at.found && (at.element.controlType === "Edit" || at.element.controlType === "Document") && at.element.readOnly !== true;
}

async function refuseFocusedHazard(host: WindowHost, pid: number, what: string, enter: boolean, n: number) {
  const at = await host.focused(pid);
  refuseIfHazard(at, `step ${n + 1} (${what}) refused: the focused control is`);
  // Enter in a dialog presses its default button, whichever control has the focus.
  if (enter && at.dialogHung) throw new InputError(`step ${n + 1} (${what}) refused: the dialog in front isn't answering, so what Enter would press is unknown. Take a screenshot and try again`);
  if (enter && at.defaultButton) refuseIfHazardName(at.defaultButton, `step ${n + 1} (${what}) refused: Enter would press the dialog's default button`);
}

async function refuseHazard(host: WindowHost, win: FoundWindow, scale: number, step: { op: string; x: number; y: number }, n: number) {
  const p = toScreen(win.rect, scale, step.x, step.y);
  refuseIfHazard(await host.element(win.pid, p.x, p.y), `step ${n + 1} (${step.op}) refused: it would press`);
}

function send(host: WindowHost, win: FoundWindow, scale: number, s: Exclude<Step, { op: "wait" }>): Promise<InputResult> {
  const at = (x: number, y: number) => toScreen(win.rect, scale, x, y);
  switch (s.op) {
    case "click":
    case "dclick":
    case "rclick": {
      const p = at(s.x, s.y);
      return host.click(win.pid, p.x, p.y, s.op === "rclick" ? "right" : "left", s.op === "dclick" ? 2 : 1);
    }
    case "wheel": {
      const p = at(s.x, s.y);
      return host.wheel(win.pid, p.x, p.y, s.notches);
    }
    case "drag":
    case "slowdrag": {
      const p = at(s.x, s.y);
      const q = at(s.x1, s.y1);
      // a slow drag holds before and after moving: list widgets that need a long press to start dragging
      return s.op === "drag" ? host.drag(win.pid, p.x, p.y, q.x, q.y, 12, 30) : host.drag(win.pid, p.x, p.y, q.x, q.y, 40, 700);
    }
    case "key":
      return host.keys(win.pid, keyCodes(s.combo));
    case "type":
      return host.type(win.pid, s.text);
  }
}
