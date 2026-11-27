// The frida-winmm agent and what the sniffer makes of its reports.

import assert from "node:assert/strict";
import { test } from "node:test";
import { agentRecord, spacedHex } from "../src/agent-records.ts";
import { winmmAgentSource } from "../src/capture-session.ts";

test("the agent only watches: it can't send to the device, open a port or take calls from outside (S2)", () => {
  const src = winmmAgentSource().replace(/\/\/.*$/gm, "");
  // calling into WinMM needs a NativeFunction; taking calls from the sniffer needs rpc.exports or recv
  for (const banned of ["NativeFunction", "rpc.exports", "recv(", "Memory.alloc", "writeByteArray", "Interceptor.replace", "midiOutPrepareHeader"]) {
    assert.ok(!src.includes(banned), `the agent uses ${banned}`);
  }
  // it hooks the calls with Interceptor.attach only, and reports with send()
  assert.match(src, /Interceptor\.attach/);
  assert.match(src, /\bsend\(o\)/);
});

test("agent reports become capture records, bytes spaced, the agent's time as hookT", () => {
  assert.deepEqual(agentRecord({ dir: "out", kind: "sysex", h: "0x1a2b", hex: "f07d01f7", t: 5 }, 9), { type: "midi", t: 9, hookT: 5, dir: "out", kind: "sysex", bytes: "f0 7d 01 f7", port: "0x1a2b" });
  assert.deepEqual(agentRecord({ dir: "in", kind: "sysexError", hex: "f07d", t: 9 }, 9), { type: "midi", t: 9, dir: "in", kind: "sysexError", bytes: "f0 7d" });
  assert.deepEqual(agentRecord({ dir: "in", kind: "close", h: "0x3c4d" }, 9), { type: "event", t: 9, kind: "portClose", dir: "in", port: "0x3c4d" });
  assert.deepEqual(agentRecord({ kind: "info", text: "hooks installed" }, 9), { type: "event", t: 9, kind: "info", text: "hooks installed" });
});

test("a report that doesn't fit becomes a warning, never a crash or a bad record", () => {
  for (const bad of [{ dir: "out", kind: "sysex", hex: "F07D" }, { dir: "out", kind: "sysex", hex: "f07" }, { kind: "sysex", hex: "f7" }, { dir: "sideways", kind: "open" }, { kind: "mystery" }, null, "text"]) {
    const r = agentRecord(bad, 1);
    assert.equal(r?.type === "event" && r.kind, "warning", JSON.stringify(bad));
  }
  // a handle that isn't one is left out, the message kept
  assert.equal((agentRecord({ dir: "out", kind: "short", h: "C:\\x", hex: "c001" }, 1) as { port?: string }).port, undefined);
  assert.equal(agentRecord({ kind: "info", text: "" }, 1), undefined);
});

test("spacedHex", () => {
  assert.equal(spacedHex("f0f7"), "f0 f7");
  assert.equal(spacedHex(""), undefined);
  assert.equal(spacedHex("f0f"), undefined);
});
