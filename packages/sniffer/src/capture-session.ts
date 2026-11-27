// A passive capture session (S1, S2): waits for the vendor editor's process, attaches the frida-winmm agent to it as
// soon as it appears (after the attach delay, since attaching too early can leave an editor's window blank), writes
// what the agent reports to the capture, and attaches again whenever the editor restarts. It never opens the device's
// MIDI port and never sends anything: the editor keeps its port, and the device hears only the editor.
//
// Frida is reached through the small interfaces below, which Frida's Node bindings (the `frida` package) meet, so the
// session runs in tests on a fake.

import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import type { CaptureRecord } from "@patchsprite/engine/capture";
import { agentRecord } from "./agent-records.ts";

export interface Signal<H> {
  connect(handler: H): void;
  disconnect(handler: H): void;
}
export type ScriptMessage = { type: "send"; payload: unknown } | { type: "error"; description: string; stack?: string };
export interface FridaScript {
  message: Signal<(message: ScriptMessage, data: Buffer | null) => void>;
  load(): Promise<void>;
  unload(): Promise<void>;
}
export interface FridaSession {
  detached: Signal<(reason: string) => void>;
  createScript(source: string): Promise<FridaScript>;
  detach(): Promise<void>;
}
export interface FridaDevice {
  enumerateProcesses(): Promise<{ pid: number; name: string }[]>;
  attach(pid: number): Promise<FridaSession>;
}

/** The frida-winmm agent's source. */
export const winmmAgentSource = (): string => readFileSync(new URL("./agent/winmm.js", import.meta.url), "utf8");

export interface CaptureSessionOptions {
  device: FridaDevice;
  /** The editor's executable name, matched without case ("Editor.exe"). */
  editorExe: string;
  /** How long to wait after the editor appears before attaching. */
  attachDelayMs: number;
  /** Where records go (a CaptureWriter's write). */
  write: (record: CaptureRecord) => void;
  agentSource?: string;
  /** How often to look for the editor while it isn't running. */
  pollMs?: number;
  /** How long to wait after a failed attach before trying again. */
  retryMs?: number;
  now?: () => number;
}

/** Attach failures in a row on one process before the session waits for a new one (the editor restarting). */
const MAX_TRIES = 5;

export class CaptureSession {
  private readonly o: Required<CaptureSessionOptions>;
  private readonly exe: string;

  constructor(options: CaptureSessionOptions) {
    this.o = { agentSource: winmmAgentSource(), pollMs: 50, retryMs: 1000, now: Date.now, ...options };
    this.exe = options.editorExe.toLowerCase();
  }

  private event(kind: "attached" | "detached" | "info" | "warning" | "error", extra: { pid?: number; text?: string } = {}): void {
    this.o.write({ type: "event", t: this.o.now(), kind, ...extra });
  }

  private async findEditor(): Promise<number | undefined> {
    return (await this.o.device.enumerateProcesses()).find((p) => p.name.toLowerCase() === this.exe)?.pid;
  }

  /** Captures until `signal` aborts. Resolves once the agent is unloaded and the editor let go of. */
  async run(signal: AbortSignal): Promise<void> {
    const wait = (ms: number) => sleep(ms, undefined, { signal }).catch(() => undefined);
    let failedPid: number | undefined;
    let tries = 0;
    while (!signal.aborted) {
      const pid = await this.findEditor();
      if (pid === undefined || (pid === failedPid && tries >= MAX_TRIES)) {
        await wait(this.o.pollMs);
        continue;
      }
      if (pid !== failedPid) tries = 0;
      await wait(this.o.attachDelayMs);
      if (signal.aborted) break;
      try {
        await this.attached(pid, signal);
        failedPid = undefined;
      } catch (e) {
        failedPid = pid;
        tries++;
        this.event("error", { pid, text: `could not attach to the editor: ${(e as Error).message}`.slice(0, 1024) });
        if (tries >= MAX_TRIES) this.event("warning", { pid, text: "gave up on this editor process; waiting for it to restart" });
        await wait(this.o.retryMs);
      }
    }
  }

  /** One attachment: until the editor goes away or `signal` aborts. */
  private async attached(pid: number, signal: AbortSignal): Promise<void> {
    const session = await this.o.device.attach(pid);
    let detachedReason: string | undefined;
    let done!: () => void;
    const over = new Promise<void>((r) => (done = r));
    const onDetached = (reason: string) => {
      detachedReason = String(reason);
      done();
    };
    session.detached.connect(onDetached);
    const onAbort = () => done();
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) done(); // stopped while attaching
    let script: FridaScript | undefined;
    const onMessage = (m: ScriptMessage) => {
      if (m.type === "error") return this.event("error", { text: `capture agent: ${m.description}`.slice(0, 1024) });
      const r = agentRecord(m.payload, this.o.now());
      if (r) this.o.write(r);
    };
    try {
      script = await session.createScript(this.o.agentSource);
      script.message.connect(onMessage);
      await script.load();
      this.event("attached", { pid });
      await over;
    } finally {
      signal.removeEventListener("abort", onAbort);
      session.detached.disconnect(onDetached);
      if (detachedReason === undefined) {
        // stopping, or a failed load: let go of the editor, which keeps running
        await script?.unload().catch(() => undefined);
        await session.detach().catch(() => undefined);
      }
      script?.message.disconnect(onMessage);
    }
    if (detachedReason !== undefined) this.event("detached", { pid, text: detachedReason.slice(0, 1024) });
  }
}
