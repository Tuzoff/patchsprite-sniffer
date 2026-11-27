// One capture session with everything around it: the pedal lock (held for the whole session, so the Patchsprite app
// and unattended checks leave the device alone while the editor has it), the capture file, the quiet check and the
// marked steps. The MCP server and any other front end drive the sniffer through this.

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { dataHome } from "@patchsprite/engine/data-dir";
import { acquirePedalLock, describePedalLock, releasePedalLock, type PedalLock } from "@patchsprite/engine/pedal-lock";
import type { CaptureRecord, EndRecord } from "@patchsprite/engine/capture";
import { CaptureSession, type FridaDevice } from "./capture-session.ts";
import { CaptureWriter } from "./capture-writer.ts";
import { captureHeader, defaultCaptureName } from "./header.ts";
import { judgeSelfTest, type SelfTestResult } from "./self-test.ts";
import { Steps, type StepResult } from "./steps.ts";

/** Where captures go unless told otherwise: `sniffer/captures` in Patchsprite's data folder, never synced. */
export const capturesDir = (env: NodeJS.ProcessEnv = process.env): string => join(dataHome(env), "sniffer", "captures");

export interface RecorderOptions {
  getDevice: () => Promise<FridaDevice>;
  env?: NodeJS.ProcessEnv;
  /** Quiet-check timing, for tests. */
  settleMs?: number;
  maxMs?: number;
  pollMs?: number;
}

export interface Counts {
  out: number;
  in: number;
  flagged: number;
  attached: boolean;
  steps: number;
}

export class Recorder {
  private readonly o: RecorderOptions;
  private live?: {
    writer: CaptureWriter;
    steps: Steps;
    lock: PedalLock;
    stop: AbortController;
    running: Promise<void>;
    counts: Counts;
    file: string;
    editor: string;
    /** Why the capture stopped on its own, if it did. */
    failed?: string;
  };

  constructor(o: RecorderOptions) {
    this.o = o;
  }

  get active(): boolean {
    return this.live !== undefined;
  }

  get file(): string | undefined {
    return this.live?.file;
  }

  /** The running capture's editor executable, for tools that find its window. */
  get editor(): string | undefined {
    return this.live?.editor;
  }

  /** Why the running capture stopped on its own, if it did: steps then see nothing, so a caller should stop. */
  get failed(): string | undefined {
    return this.live?.failed;
  }

  get counts(): Counts | undefined {
    return this.live && { ...this.live.counts };
  }

  /** Starts a session: takes the pedal lock, creates the capture, and waits for the editor. */
  /**
   * `channelMessages`: the device is driven by MIDI channel messages (CC, PC, NRPN), not SysEx, so those count as a
   * step's traffic instead of being flagged short.
   */
  async start(o: { editorExe: string; attachDelayS: number; note?: string; channelMessages?: boolean }): Promise<string> {
    if (this.live) throw new Error(`a capture is already running (${this.live.file}); stop it first`);
    const env = this.o.env ?? process.env;
    const header = captureHeader({ editorExe: o.editorExe, note: o.note });
    const device = await this.o.getDevice();
    const got = acquirePedalLock("sniffer capture", { env });
    if (!got.ok) throw new Error(`The device is in use: ${describePedalLock(got.holder)}. Wait for it to finish, then start again.`);
    let writer: CaptureWriter | undefined;
    try {
      const dir = capturesDir(env);
      mkdirSync(dir, { recursive: true });
      const file = join(dir, defaultCaptureName(header));
      writer = new CaptureWriter(file, header);
      const counts: Counts = { out: 0, in: 0, flagged: 0, attached: false, steps: 0 };
      const write = (r: CaptureRecord) => {
        writer!.write(r);
        if (r.type === "midi") {
          counts[r.dir]++;
          if (r.flags) counts.flagged++;
        } else if (r.type === "event" && (r.kind === "attached" || r.kind === "detached")) counts.attached = r.kind === "attached";
        else if (r.type === "stepStart") counts.steps++;
        if (r.type === "stepEnd") writer!.sync();
      };
      const steps = new Steps({ write, rules: o.channelMessages ? { shortMax: 0 } : {}, settleMs: this.o.settleMs, maxMs: this.o.maxMs, pollMs: this.o.pollMs });
      const stop = new AbortController();
      const session = new CaptureSession({ device, editorExe: o.editorExe, attachDelayMs: o.attachDelayS * 1000, write: steps.record });
      const live = { writer, steps, lock: got.lock, stop, running: Promise.resolve(), counts, file, editor: o.editorExe, failed: undefined as string | undefined };
      // a capture that fails (Frida lost, the hook refused) is noted in the file; stop then ends it as an error
      live.running = session.run(stop.signal).catch((e: unknown) => {
        live.failed = `The capture stopped: ${(e as Error).message}`.slice(0, 1024);
        try {
          write({ type: "event", t: Date.now(), kind: "error", text: live.failed });
        } catch {} // the file itself failed; stop still releases the lock
      });
      this.live = live;
      return file;
    } catch (e) {
      writer?.close();
      releasePedalLock(got.lock, env);
      throw e;
    }
  }

  private need() {
    if (!this.live) throw new Error("no capture is running: start one first");
    return this.live;
  }

  begin(kind: "action" | "manual" | "selfTest", label: string, mode?: string): number {
    return this.need().steps.begin(kind, label, { mode });
  }

  async end(extra: { label?: string; note?: string; aborted?: boolean } = {}): Promise<StepResult & { selfTest?: SelfTestResult }> {
    const live = this.need();
    const kind = live.steps.openKind;
    const r = await live.steps.end(extra);
    if (kind !== "selfTest" || extra.aborted) return r;
    const selfTest = judgeSelfTest(r.messages);
    if (!selfTest.ok) await this.stop("selfTestFailed", selfTest.text);
    return { ...r, selfTest };
  }

  async idle(seconds: number): Promise<string[]> {
    return this.need().steps.idle(seconds * 1000);
  }

  /** Ends the session: closes any open step, writes the end record, and gives the pedal lock back. */
  async stop(reason: EndRecord["reason"] = "stopped", text?: string): Promise<string> {
    const live = this.need();
    this.live = undefined;
    live.stop.abort();
    try {
      await live.running;
      if (live.steps.openKind) await live.steps.end({ aborted: true, note: "the capture stopped" }).catch(() => undefined);
      if (live.failed && reason === "stopped") [reason, text] = ["error", live.failed];
      live.writer.write({ type: "end", t: Date.now(), reason, ...(text ? { text: text.slice(0, 1024) } : {}) });
    } finally {
      live.writer.close();
      releasePedalLock(live.lock, this.o.env ?? process.env);
    }
    return live.file;
  }
}
