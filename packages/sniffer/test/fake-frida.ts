// A fake of Frida's Node bindings for the capture session: processes come and go, an attached script's agent is a
// function the test drives, and detaching is the test's call.

import type { FridaDevice, FridaScript, FridaSession, ScriptMessage, Signal } from "../src/capture-session.ts";

class FakeSignal<H extends (...a: never[]) => void> implements Signal<H> {
  readonly handlers = new Set<H>();
  connect(h: H) {
    this.handlers.add(h);
  }
  disconnect(h: H) {
    this.handlers.delete(h);
  }
  emit(...a: Parameters<H>) {
    for (const h of this.handlers) h(...a);
  }
}

export class FakeScript implements FridaScript {
  readonly message = new FakeSignal<(m: ScriptMessage, d: Buffer | null) => void>();
  loaded = false;
  unloaded = false;
  readonly source: string;
  private readonly failLoad: boolean;
  constructor(source: string, failLoad = false) {
    this.source = source;
    this.failLoad = failLoad;
  }
  async load() {
    if (this.failLoad) throw new Error("load failed");
    this.loaded = true;
  }
  async unload() {
    this.unloaded = true;
  }
  /** What the agent would send(). */
  send(payload: unknown) {
    this.message.emit({ type: "send", payload }, null);
  }
}

export class FakeSession implements FridaSession {
  readonly detached = new FakeSignal<(reason: string) => void>();
  readonly scripts: FakeScript[] = [];
  detachedByUs = false;
  readonly pid: number;
  private readonly failLoad: boolean;
  constructor(pid: number, failLoad = false) {
    this.pid = pid;
    this.failLoad = failLoad;
  }
  async createScript(source: string) {
    const s = new FakeScript(source, this.failLoad);
    this.scripts.push(s);
    return s;
  }
  async detach() {
    this.detachedByUs = true;
  }
  /** The editor quits or crashes. */
  gone(reason = "process-terminated") {
    this.detached.emit(reason);
  }
}

export class FakeDevice implements FridaDevice {
  processes: { pid: number; name: string }[] = [];
  readonly sessions: FakeSession[] = [];
  attachFails = 0;
  failLoad = false;
  private waiters: ((s: FakeSession) => void)[] = [];
  async enumerateProcesses() {
    return [...this.processes];
  }
  async attach(pid: number) {
    if (this.attachFails > 0) {
      this.attachFails--;
      throw new Error("unable to access process");
    }
    const s = new FakeSession(pid, this.failLoad);
    this.sessions.push(s);
    this.waiters.splice(0).forEach((w) => w(s));
    return s;
  }
  /** The next session attached (or the last one, if already there and unused). */
  nextSession(): Promise<FakeSession> {
    return new Promise((r) => this.waiters.push(r));
  }
}
