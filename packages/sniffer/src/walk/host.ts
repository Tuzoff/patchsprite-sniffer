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

/** What the walk tools need from the window system. */
export interface WindowHost {
  /** The editor's main window. `app` names the editor: its executable name on Windows (such as "Editor.exe"); a
   * macOS host would take its bundle id. */
  find(app: string): Promise<FoundWindow | { found: false }>;
  front(hwnd: number): Promise<{ front: boolean }>;
  shot(hwnd: number, path: string, scale: number, minSpread: number): Promise<ShotResult>;
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

  close() {
    this.#child.stdin.end();
  }
}
