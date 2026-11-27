// Frida agent for the sniffer's frida-winmm capture method (S1): runs inside a vendor editor on Windows and reports
// every MIDI message the editor sends or receives through WinMM, with the ports it opens and closes. It only watches:
// it never sends, opens or changes anything (S2), so the editor keeps its port and the device hears only the editor.
// Each report goes to the sniffer with send(); src/agent-records.ts turns it into capture records.
//
// Plain JavaScript for Frida's own runtime, which has no Node and no TypeScript.

const CALLBACK_TYPEMASK = 0x70000;
const CALLBACK_FUNCTION = 0x30000;
const MIM_OPEN = 0x3c1, MIM_CLOSE = 0x3c2, MIM_DATA = 0x3c3, MIM_LONGDATA = 0x3c4, MIM_ERROR = 0x3c5, MIM_LONGERROR = 0x3c6;
/** The longest message reported, in bytes. */
const MAX_BYTES = 65536;
const MIDIHDR_BUFFER_LENGTH = Process.pointerSize; // after lpData
const MIDIHDR_BYTES_RECORDED = Process.pointerSize + 4;

/** A MIDIHDR's data as hex: the bytes recorded (input) or the buffer's length (output). */
function hdrData(hdr, recorded) {
  const lp = hdr.readPointer();
  const len = hdr.add(recorded ? MIDIHDR_BYTES_RECORDED : MIDIHDR_BUFFER_LENGTH).readU32();
  if (lp.isNull() || len === 0) return "";
  return hex(lp.readByteArray(Math.min(len, MAX_BYTES)));
}

function hex(buf) {
  const u = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < u.length; i++) s += (u[i] < 16 ? "0" : "") + u[i].toString(16);
  return s;
}

/** A short message packed in a DWORD, as hex: two bytes for program change and channel pressure, else three. */
function shortHex(dw) {
  const v = dw.toUInt32();
  const st = v & 0xff, d1 = (v >> 8) & 0xff, d2 = (v >> 16) & 0xff;
  const n = st >= 0xf0 ? (st === 0xf1 || st === 0xf3 ? 2 : st === 0xf2 ? 3 : 1) : st >= 0xc0 && st < 0xe0 ? 2 : 3;
  return [st, d1, d2].slice(0, n).map((b) => (b < 16 ? "0" : "") + b.toString(16)).join("");
}

// The same call can pass through a WINMM.dll thunk and its winmmbase.dll implementation (both hooked): an identical
// message seen again within 3 ms is that one call twice.
let lastKey = "", lastT = 0;
function emit(o) {
  o.t = Date.now();
  const key = (o.dir || "") + (o.kind || "") + (o.hex || o.text || "");
  if (o.hex && key === lastKey && o.t - lastT < 3) return;
  lastKey = key;
  lastT = o.t;
  send(o);
}

const hookedAddrs = new Set();
const hookedCallbacks = new Set();
const driverCbHooked = new Set();
let inputViaCallback = false;

function onInput(handle, msg, param) {
  if (msg === MIM_LONGDATA || msg === MIM_LONGERROR) {
    const data = hdrData(param, true);
    if (data) {
      inputViaCallback = true;
      emit({ dir: "in", kind: msg === MIM_LONGDATA ? "sysex" : "sysexError", h: handle.toString(), hex: data });
    }
  } else if (msg === MIM_DATA || msg === MIM_ERROR) {
    inputViaCallback = true;
    emit({ dir: "in", kind: msg === MIM_DATA ? "short" : "shortError", h: handle.toString(), hex: shortHex(param) });
  }
}

/** The editor's own input callback, for when DriverCallback isn't there to hook. */
function hookInputCallback(cb) {
  const key = cb.toString();
  if (hookedCallbacks.has(key) || driverCbHooked.size > 0) return; // DriverCallback already sees all input
  hookedCallbacks.add(key);
  Interceptor.attach(cb, {
    onEnter(args) {
      const msg = args[1].toUInt32();
      if (msg === MIM_OPEN || msg === MIM_CLOSE) return;
      onInput(args[0], msg, args[3]);
    },
  });
  emit({ kind: "info", text: "hooked the editor's MIDI input callback" });
}

function install(winmm) {
  const at = (name, handlers) => {
    const a = winmm.findExportByName(name);
    if (!a || hookedAddrs.has(a.toString())) return;
    hookedAddrs.add(a.toString());
    Interceptor.attach(a, handlers);
  };
  const opened = (dir) => ({
    onEnter(a) {
      this.ph = a[0];
      this.dev = a[1].toUInt32();
      if (dir === "in" && (a[4].toUInt32() & CALLBACK_TYPEMASK) === CALLBACK_FUNCTION && !a[2].isNull()) hookInputCallback(a[2]);
    },
    onLeave(r) {
      if (r.toUInt32() !== 0) return emit({ kind: "warning", text: `the editor could not open MIDI ${dir} port ${this.dev} (error ${r.toUInt32()})` });
      emit({ dir, kind: "open", dev: this.dev, h: this.ph.readPointer().toString() });
    },
  });
  at("midiOutOpen", opened("out"));
  at("midiInOpen", opened("in"));
  at("midiOutClose", { onEnter(a) { emit({ dir: "out", kind: "close", h: a[0].toString() }); } });
  at("midiInClose", { onEnter(a) { emit({ dir: "in", kind: "close", h: a[0].toString() }); } });
  at("midiOutShortMsg", { onEnter(a) { emit({ dir: "out", kind: "short", h: a[0].toString(), hex: shortHex(a[1]) }); } });
  at("midiOutLongMsg", {
    onEnter(a) { this.h = a[0].toString(); this.data = hdrData(a[1], false); },
    onLeave(r) { if (r.toUInt32() === 0 && this.data) emit({ dir: "out", kind: "sysex", h: this.h, hex: this.data }); },
  });
  // Input when the callback isn't a plain function, or the port was opened before attaching: a buffer handed back to
  // the driver still holds what it last recorded.
  at("midiInAddBuffer", {
    onEnter(a) {
      if (inputViaCallback) return;
      const data = a[1].add(MIDIHDR_BYTES_RECORDED).readU32() > 0 ? hdrData(a[1], true) : "";
      if (data) emit({ dir: "in", kind: "sysex", h: a[0].toString(), hex: data });
    },
  });
  emit({ kind: "info", text: `MIDI hooks installed in ${winmm.name}` });
}

// Every MIDI-in delivery, whatever callback type the editor chose and whenever it opened the port, goes through
// DriverCallback(dwCallback, dwFlags, hDevice, dwMsg, dwUser, dwParam1, dwParam2).
function hookDriverCallback(mod) {
  const a = mod.findExportByName("DriverCallback");
  if (!a || driverCbHooked.has(a.toString())) return;
  driverCbHooked.add(a.toString());
  Interceptor.attach(a, { onEnter(args) { onInput(args[2], args[3].toUInt32(), args[5]); } });
  emit({ kind: "info", text: `DriverCallback hooked in ${mod.name}` });
}

// WINMM.dll forwards the midi* calls to winmmbase.dll, which may load after attaching: hook both, now and on load.
const MIDI_DLLS = ["winmm.dll", "winmmbase.dll"];
for (const n of MIDI_DLLS) {
  const m = Process.findModuleByName(n);
  if (m) {
    hookDriverCallback(m);
    install(m);
  }
}
Process.attachModuleObserver({
  onAdded(m) {
    if (MIDI_DLLS.includes(m.name.toLowerCase())) {
      hookDriverCallback(m);
      install(m);
    }
  },
});
