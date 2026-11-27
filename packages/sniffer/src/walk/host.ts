// The walk tools talk to Windows through one long-lived PowerShell process (host.ps1), over JSON lines. No native
// npm module is needed, and tests swap in a fake host.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface FoundWindow {
  found: true;
  hwnd: number;
  pid: number;
  rect: Rect;
  minimized: boolean;
}

export interface ShotResult {
  /** False when PrintWindow failed and the screen fallback wasn't allowed (the editor was covered or behind). */
  saved: boolean;
  /** Luminance range over a small sample of the frame: near 0 means blank. */
  spread: number;
  source?: "window" | "screen";
  rect: Rect;
  /** Width of the saved image, in px. */
  width?: number;
}

/** Input either landed (done) or was refused because the point or the window in front isn't the editor's. */
export type InputResult = { done: true } | { done: false; owner: string };

export interface UiElement {
  name: string;
  controlType: string;
  automationId: string;
  className: string;
  enabled: boolean;
  rect: Rect;
  value?: string;
  readOnly?: boolean;
  range?: { value: number; min: number; max: number; step: number };
  toggle?: string;
  selected?: boolean;
}

export interface DialogInfo {
  title: string;
  /** Whether it has a file-name box a fill can type into. */
  fileBox: boolean;
  buttons: string[];
}

export type FillResult = { done: true; remaining: string[] } | { done: false; why: string };

/** What the walk tools need from the window system. Input and reads take the editor's process id: the host refuses
 * input at a point, or into a window in front, that isn't one of the editor's windows. Points are screen px. */
export interface WindowHost {
  /** The editor's main window. `app` names the editor: its executable name on Windows (such as "Editor.exe"); a
   * macOS host would take its bundle id. */
  find(app: string): Promise<FoundWindow | { found: false }>;
  front(hwnd: number): Promise<{ front: boolean }>;
  shot(hwnd: number, path: string, scale: number, minSpread: number): Promise<ShotResult>;
  click(pid: number, x: number, y: number, button: "left" | "right", count: number): Promise<InputResult>;
  wheel(pid: number, x: number, y: number, notches: number): Promise<InputResult>;
  drag(pid: number, x: number, y: number, x1: number, y1: number, steps: number, holdMs: number): Promise<InputResult>;
  /** Virtual-key codes pressed in order and released in reverse (a combination such as ctrl+z). */
  keys(pid: number, vks: number[]): Promise<InputResult>;
  type(pid: number, text: string): Promise<InputResult>;
  /** The UI Automation element at a point, when it is the editor's. */
  element(pid: number, x: number, y: number): Promise<{ found: false } | { found: true; element: UiElement }>;
  /** The editor's standard Windows file and folder dialogs. */
  dialogs(pid: number): Promise<{ dialogs: DialogInfo[] }>;
  /** Types a path into a dialog's edit box and presses the button with that caption. */
  fill(pid: number, title: string, path: string, button: string): Promise<FillResult>;
  close(): void;
}

type Pending = { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void };

/** The real host: host.ps1 in Windows PowerShell. */
export class PowerShellHost implements WindowHost {
  #child: ChildProcessWithoutNullStreams;
  #next = 1;
  #pending = new Map<number, Pending>();
  #stderr = "";
  #dead = "";

  /** `shotRoot`: the session's screenshot folder; the host saves shots only as .png files under it. */
  constructor(shotRoot: string, exe = "powershell.exe") {
    const script = fileURLToPath(new URL("./host.ps1", import.meta.url));
    const args = ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, "-ShotRoot", resolve(shotRoot)];
    this.#child = spawn(exe, args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.#child.stderr.setEncoding("utf8").on("data", (d: string) => {
      this.#stderr = (this.#stderr + d).slice(-2000);
    });
    createInterface({ input: this.#child.stdout }).on("line", (line) => this.#answer(line));
    const fail = (why: string) => {
      this.#dead ||= `window host stopped: ${why}`;
      for (const p of this.#pending.values()) p.reject(new Error(`window host stopped: ${why}${this.#stderr ? `: ${this.#stderr.trim()}` : ""}`));
      this.#pending.clear();
    };
    this.#child.on("error", (e) => fail(e.message));
    this.#child.on("exit", (code) => fail(`exit ${code}`));
  }

  #answer(line: string) {
    let res: Record<string, unknown>;
    try {
      res = JSON.parse(line);
    } catch {
      return; // not ours: PowerShell may print a stray line while loading
    }
    const p = this.#pending.get(res.id as number);
    if (!p) return;
    this.#pending.delete(res.id as number);
    const { id: _id, ok, error, ...rest } = res;
    if (ok) p.resolve(rest);
    else p.reject(new Error(String(error ?? "window host error")));
  }

  #call(op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = this.#next++;
    return new Promise((resolve, reject) => {
      if (this.#dead) return reject(new Error(this.#dead));
      this.#pending.set(id, { resolve, reject });
      this.#child.stdin.write(JSON.stringify({ id, op, ...args }) + "\n");
    });
  }

  async find(app: string) {
    return (await this.#call("find", { app })) as unknown as FoundWindow | { found: false };
  }

  async front(hwnd: number) {
    return (await this.#call("front", { hwnd })) as unknown as { front: boolean };
  }

  async shot(hwnd: number, path: string, scale: number, minSpread: number) {
    return (await this.#call("shot", { hwnd, path, scale, minSpread })) as unknown as ShotResult;
  }

  async click(pid: number, x: number, y: number, button: "left" | "right", count: number) {
    return (await this.#call("click", { pid, x, y, button, count })) as unknown as InputResult;
  }

  async wheel(pid: number, x: number, y: number, notches: number) {
    return (await this.#call("wheel", { pid, x, y, notches })) as unknown as InputResult;
  }

  async drag(pid: number, x: number, y: number, x1: number, y1: number, steps: number, holdMs: number) {
    return (await this.#call("drag", { pid, x, y, x1, y1, steps, holdMs })) as unknown as InputResult;
  }

  async keys(pid: number, vks: number[]) {
    return (await this.#call("keys", { pid, vks })) as unknown as InputResult;
  }

  async type(pid: number, text: string) {
    return (await this.#call("keys", { pid, text })) as unknown as InputResult;
  }

  async element(pid: number, x: number, y: number) {
    return (await this.#call("element", { pid, x, y })) as unknown as { found: false } | { found: true; element: UiElement };
  }

  async dialogs(pid: number) {
    return (await this.#call("dialogs", { pid })) as unknown as { dialogs: DialogInfo[] };
  }

  async fill(pid: number, title: string, path: string, button: string) {
    return (await this.#call("fill", { pid, title, path, button })) as unknown as FillResult;
  }

  close() {
    this.#child.stdin.end();
  }
}
