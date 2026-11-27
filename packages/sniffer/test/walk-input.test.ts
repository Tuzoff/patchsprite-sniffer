import assert from "node:assert/strict";
import test from "node:test";
import type { InputResult, WindowHost } from "../src/walk/host.ts";
import { InputError, keyCodes, parseStep, runSteps, toScreen } from "../src/walk/input.ts";
import { checkDialogPath, fillDialog, listDialogs, readControl } from "../src/walk/read.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeWindowHost } from "./fake-window-host.ts";

const RECT = { left: 100, top: 50, width: 1600, height: 900 };
const WIN = { found: true as const, hwnd: 7, pid: 42, rect: RECT, minimized: false };

/** A host that logs input and refuses the first `covered` input calls, as when an overlay sits on the point. */
function inputHost(covered = 0, over: Partial<WindowHost> = {}) {
  const log: string[] = [];
  const answer = (line: string): InputResult => {
    if (covered > 0) {
      covered--;
      log.push(`refused ${line}`);
      return { done: false, owner: "Overlay" };
    }
    log.push(line);
    return { done: true };
  };
  const host = fakeWindowHost({
    find: async () => WIN,
    front: async (h) => {
      log.push(`front ${h}`);
      return { front: true };
    },
    click: async (pid, x, y, b, n) => answer(`click ${pid} ${x},${y} ${b} x${n}`),
    wheel: async (pid, x, y, n) => answer(`wheel ${pid} ${x},${y} ${n}`),
    drag: async (pid, x, y, x1, y1, steps, hold) => answer(`drag ${pid} ${x},${y} ${x1},${y1} ${steps} ${hold}`),
    keys: async (pid, vks) => answer(`keys ${pid} ${vks.join(",")}`),
    type: async (pid, t) => answer(`type ${pid} ${t}`),
    element: async () => ({ found: false }),
    ...over,
  });
  return { host, log };
}

const noSleep = async () => {};

test("steps parse in the walk prompt's short form", () => {
  assert.deepEqual(parseStep("click:10,20"), { op: "click", x: 10, y: 20 });
  assert.deepEqual(parseStep("wheel:10,20,-3"), { op: "wheel", x: 10, y: 20, notches: -3 });
  assert.deepEqual(parseStep("slowdrag:1,2,3,4"), { op: "slowdrag", x: 1, y: 2, x1: 3, y1: 4 });
  assert.deepEqual(parseStep("type:a:b,c"), { op: "type", text: "a:b,c" });
  assert.deepEqual(parseStep("key:ctrl+z"), { op: "key", combo: "ctrl+z" });
  assert.deepEqual(parseStep("wait:1.5"), { op: "wait", seconds: 1.5 });
  for (const bad of ["click:1", "click:a,b", "wheel:1,2,0", "key:hyper", "type:", "wait:99", "press:1,2"]) {
    assert.throws(() => parseStep(bad), InputError, bad);
  }
});

test("key combinations become virtual-key codes", () => {
  assert.deepEqual(keyCodes("ctrl+shift+z"), [0x11, 0x10, 0x5a]);
  assert.deepEqual(keyCodes("enter"), [0x0d]);
  assert.deepEqual(keyCodes("ctrl+plus"), [0x11, 0xbb]);
  assert.deepEqual(keyCodes("7"), [0x37]);
});

test("points on a half-size shot land on the editor's window, and points off it are refused", () => {
  assert.deepEqual(toScreen(RECT, 0.5, 10, 20), { x: 120, y: 90 });
  assert.throws(() => toScreen(RECT, 0.5, 800, 10), /outside the editor's window/);
  assert.throws(() => toScreen(RECT, 0.5, -1, 10), /outside/);
});

test("steps run in order, after the pedal-lock check, with the editor brought to the front", async () => {
  const { host, log } = inputHost();
  let locked = 0;
  await runSteps({ host, app: "Editor.exe", beforeInput: async () => void locked++, sleep: noSleep },
    ["click:10,20", "dclick:0,0", "rclick:1,1", "wheel:5,5,2", "drag:0,0,10,10", "key:ctrl+z", "type:Lead", "wait:1"].map(parseStep));
  assert.equal(locked, 7, "the lock is checked before every input step");
  assert.deepEqual(log.filter((l) => !l.startsWith("front")), [
    "click 42 120,90 left x1",
    "click 42 100,50 left x2",
    "click 42 102,52 right x1",
    "wheel 42 110,60 2",
    "drag 42 100,50 120,70 12 30",
    "keys 42 17,90",
    "type 42 Lead",
  ]);
  assert.equal(log.filter((l) => l.startsWith("front")).length, 7);
});

test("a lock refusal stops the walk before any input", async () => {
  const { host, log } = inputHost();
  await assert.rejects(
    runSteps({ host, app: "Editor.exe", beforeInput: async () => { throw new Error("the pedal is locked"); }, sleep: noSleep }, [parseStep("click:1,1")]),
    /pedal is locked/,
  );
  assert.deepEqual(log, []);
});

test("a covered point is retried, then lands", async () => {
  const { host, log } = inputHost(2);
  await runSteps({ host, app: "Editor.exe", beforeInput: async () => {}, sleep: noSleep }, [parseStep("click:1,1")]);
  assert.deepEqual(log.filter((l) => !l.startsWith("front")), ["refused click 42 102,52 left x1", "refused click 42 102,52 left x1", "click 42 102,52 left x1"]);
});

test("a point that stays covered is refused with the other window's title, and later steps don't run", async () => {
  const { host, log } = inputHost(1000);
  await assert.rejects(
    runSteps({ host, app: "Editor.exe", beforeInput: async () => {}, sleep: noSleep, coveredTimeoutMs: 0 }, ["click:1,1", "click:2,2"].map(parseStep)),
    /step 1 \(click\) refused: the point is on another window \("Overlay"\)/,
  );
  assert.equal(log.filter((l) => l.includes("2,2") || l.includes("104,54")).length, 0);
});

test("a click on a firmware, reset or store control is refused until the user approves it", async () => {
  const named = (name: string) => async () => ({ found: true as const, element: { name, controlType: "Button", automationId: "", className: "", enabled: true, rect: RECT } });
  for (const name of ["Firmware Update", "Factory Reset", "Store", "Delete preset", "Sign in"]) {
    const { host, log } = inputHost(0, { element: named(name) });
    await assert.rejects(runSteps({ host, app: "Editor.exe", beforeInput: async () => {}, sleep: noSleep }, [parseStep("click:1,1")]), /refused: it would press .*Ask the user first/, name);
    assert.equal(log.filter((l) => l.startsWith("click")).length, 0, name);
    await runSteps({ host, app: "Editor.exe", beforeInput: async () => {}, sleep: noSleep, hazardApproved: true }, [parseStep("click:1,1")]);
    assert.equal(log.filter((l) => l.startsWith("click")).length, 1, name);
  }
  {
    // a drag presses and releases too, so it is checked like a click
    const { host, log } = inputHost(0, { element: named("Firmware Update") });
    await assert.rejects(runSteps({ host, app: "Editor.exe", beforeInput: async () => {}, sleep: noSleep }, [parseStep("drag:1,1,1,1")]), /refused: it would press/);
    assert.equal(log.filter((l) => l.startsWith("drag")).length, 0);
  }
  for (const name of ["Gain", "Storage"]) {
    const { host, log } = inputHost(0, { element: named(name) });
    await runSteps({ host, app: "Editor.exe", beforeInput: async () => {}, sleep: noSleep }, [parseStep("click:1,1")]);
    assert.equal(log.filter((l) => l.startsWith("click")).length, 1, name);
  }
});

test("enter, space, delete and backspace on a focused hazard control are refused until the user approves", async () => {
  const focusedOn = (name: string) => async () => ({ found: true as const, element: { name, controlType: "Button", automationId: "", className: "", enabled: true, rect: RECT } });
  for (const combo of ["enter", "space", "delete", "backspace", "ctrl+enter"]) {
    const { host, log } = inputHost(0, { focused: focusedOn("Factory Reset") });
    await assert.rejects(runSteps({ host, app: "Editor.exe", beforeInput: async () => {}, sleep: noSleep }, [parseStep(`key:${combo}`)]), /focused control is "Factory Reset"/, combo);
    assert.equal(log.filter((l) => l.startsWith("keys")).length, 0, combo);
    await runSteps({ host, app: "Editor.exe", beforeInput: async () => {}, sleep: noSleep, hazardApproved: true }, [parseStep(`key:${combo}`)]);
    assert.equal(log.filter((l) => l.startsWith("keys")).length, 1, combo);
  }
  const { host, log } = inputHost(0, { focused: focusedOn("Factory Reset") });
  await runSteps({ host, app: "Editor.exe", beforeInput: async () => {}, sleep: noSleep }, ["key:tab", "key:ctrl+z", "type:abc"].map(parseStep));
  assert.equal(log.filter((l) => !l.startsWith("front")).length, 3, "other keys don't press the focused control");
  const ok = inputHost(0, { focused: focusedOn("Gain") });
  await runSteps({ host: ok.host, app: "Editor.exe", beforeInput: async () => {}, sleep: noSleep }, [parseStep("key:enter")]);
});

test("enter is refused when the dialog in front would press a hazard default button, and typed spaces or line breaks are checked", async () => {
  const gain = { found: true as const, element: { name: "Gain", controlType: "Edit", automationId: "", className: "", enabled: true, rect: RECT } };
  const run = (host: WindowHost, steps: string[], hazardApproved = false) => runSteps({ host, app: "Editor.exe", beforeInput: async () => {}, sleep: noSleep, hazardApproved }, steps.map(parseStep));
  const dlg = inputHost(0, { focused: async () => ({ ...gain, defaultButton: "Update Firmware" }) });
  await assert.rejects(run(dlg.host, ["key:enter"]), /default button "Update Firmware"/);
  await run(dlg.host, ["key:space", "key:tab"]);
  await run(dlg.host, ["key:enter"], true);
  const hung = inputHost(0, { focused: async () => ({ ...gain, dialogHung: true }) });
  await assert.rejects(run(hung.host, ["key:enter"]), /isn't answering/);
  assert.equal(dlg.log.filter((l) => l.startsWith("keys")).length, 3, "space and tab press the focused control, not the default button");
  const btn = inputHost(0, { focused: async () => ({ found: true as const, element: { ...gain.element, name: "Delete", controlType: "Button" } }) });
  await assert.rejects(run(btn.host, ["type:a b"]), /focused control is "Delete"/);
  await run(btn.host, ["type:ab"]);
  assert.throws(() => parseStep("type:a\nb"), /one line of text/);
  assert.throws(() => parseStep("type:a\tb"), /one line of text/);
  assert.throws(() => parseStep("type:a\bb"), /one line of text/);
});

test("while a file dialog is open, input may only scroll or press Cancel; Alt shortcuts are refused beside a hazard button", async () => {
  const run = (host: WindowHost, steps: string[], hazardApproved = false) => runSteps({ host, app: "Editor.exe", beforeInput: async () => {}, sleep: noSleep, hazardApproved }, steps.map(parseStep));
  const button = (name: string) => async () => ({ found: true as const, element: { name, controlType: "Button", automationId: "", className: "", enabled: true, rect: RECT } });
  const fileDialog = async () => ({ dialogs: [{ title: "Open", fileBox: true, buttons: ["&Open", "Cancel"] }] });
  for (const step of ["type:C:\\x.syx", "key:enter", "key:alt+o", "dclick:1,1", "drag:1,1,2,2"]) {
    const { host, log } = inputHost(0, { dialogs: fileDialog, element: button("Open") });
    await assert.rejects(run(host, [step], true), /a file dialog is open/, step);
    assert.equal(log.filter((l) => !l.startsWith("front")).length, 0, step);
  }
  const open = inputHost(0, { dialogs: fileDialog, element: button("Open") });
  await assert.rejects(run(open.host, ["click:1,1"]), /a file dialog is open/);
  const cancel = inputHost(0, { dialogs: fileDialog, element: button("&Cancel") });
  await run(cancel.host, ["click:1,1", "wheel:1,1,-2"]);
  assert.equal(cancel.log.filter((l) => !l.startsWith("front")).length, 2, "Cancel and scrolling still work");

  const store = async () => ({ dialogs: [{ title: "Preset", fileBox: false, buttons: ["Store", "Cancel"] }] });
  const s1 = inputHost(0, { dialogs: store });
  await assert.rejects(run(s1.host, ["key:alt+s"]), /Alt shortcut can press the dialog's "Store" button/);
  await run(s1.host, ["key:alt+s"], true);
  await run(s1.host, ["key:ctrl+z"]);
  const plain = inputHost(0, { dialogs: async () => ({ dialogs: [{ title: "Preset", fileBox: false, buttons: ["OK", "Cancel"] }] }) });
  await run(plain.host, ["key:alt+o"]);
});

test("no editor window: input is refused", async () => {
  const host = fakeWindowHost({ find: async () => ({ found: false }) });
  await assert.rejects(runSteps({ host, app: "Editor.exe", beforeInput: async () => {}, sleep: noSleep }, [parseStep("click:1,1")]), /is the editor running/);
});

test("reading a control gives its UI Automation facts and its place on the shot", async () => {
  const element = { name: "Gain", controlType: "Slider", automationId: "gain", className: "Knob", enabled: true,
    rect: { left: 300, top: 250, width: 40, height: 40 }, range: { value: 5, min: 0, max: 10, step: 1 } };
  let asked = "";
  const host = fakeWindowHost({ find: async () => WIN, element: async (pid, x, y) => { asked = `${pid} ${x},${y}`; return { found: true, element }; } });
  const c = await readControl({ host, app: "Editor.exe" }, 110, 110);
  assert.equal(asked, "42 320,270");
  assert.deepEqual(c?.shotRect, { left: 100, top: 100, width: 20, height: 20 });
  assert.equal(c?.range?.value, 5);
  const none = await readControl({ host: fakeWindowHost({ find: async () => WIN, element: async () => ({ found: false }) }), app: "Editor.exe" }, 1, 1);
  assert.equal(none, null);
});

test("the file-dialog helper lists the editor's dialogs and fills one after the lock check", async () => {
  const calls: string[] = [];
  const host = fakeWindowHost({
    find: async () => WIN,
    dialogs: async () => ({ dialogs: [{ title: "Save As", fileBox: true, buttons: ["Save", "Cancel"] }] }),
    fill: async (pid, title, path, button) => {
      calls.push(`fill ${pid} ${title} ${path} ${button}`);
      return { done: true, remaining: [] };
    },
  });
  assert.deepEqual(await listDialogs({ host, app: "Editor.exe" }), [{ title: "Save As", fileBox: true, buttons: ["Save", "Cancel"] }]);
  let locked = false;
  const root = join(tmpdir(), "walk-capture");
  const remaining = await fillDialog({ host, app: "Editor.exe", allowedRoot: root, beforeInput: async () => void (locked = true) }, "Save As", join(root, "backup.prst"), "Save");
  assert.ok(locked);
  assert.deepEqual(remaining, []);
  assert.deepEqual(calls, [`fill 42 Save As ${join(root, "backup.prst")} Save`]);
});

test("a dialog fill that can't find its dialog or button says what is open", async () => {
  const host = fakeWindowHost({
    find: async () => WIN,
    dialogs: async () => ({ dialogs: [{ title: "Open", fileBox: false, buttons: [] }] }),
    fill: async () => ({ done: false, why: "0 dialogs titled 'Save As'" }),
  });
  const root = join(tmpdir(), "walk-capture");
  await assert.rejects(fillDialog({ host, app: "Editor.exe", allowedRoot: root, beforeInput: async () => {} }, "Save As", join(root, "x.prst"), "Save"), /0 dialogs titled 'Save As'\. Open dialogs: "Open"/);
  await assert.rejects(fillDialog({ host, app: "Editor.exe", allowedRoot: root, beforeInput: async () => {} }, "Save As", join(root, "a\nb"), "Save"), /one line/);
});

test("a dialog is pointed only inside the capture's folder, and never at firmware, updates or programs", async () => {
  let filled = 0;
  const host = fakeWindowHost({ find: async () => WIN, fill: async () => (filled++, { done: true, remaining: [] }) });
  const root = join(tmpdir(), "walk-capture");
  const d = { host, app: "Editor.exe", allowedRoot: root, beforeInput: async () => {} };
  for (const [path, why] of [
    [join(root, "..", "elsewhere.prst"), /inside the capture's folder/],
    [join(tmpdir(), "user-presets", "mine.prst"), /inside the capture's folder/],
    ["relative.prst", /full path/],
    [join(root, "update.BIN"), /\.bin file/],
    [join(root, "fw.syx"), /\.syx file may be saved, never opened/],
    [join(root, "song.mid"), /\.mid file may be saved, never opened/],
    [join(root, "setup.exe"), /\.exe file/],
    [join(root, "update.bin."), /dot or space/],
    [join(root, "update.bin "), /dot or space/],
    [join(root, "notes.prst:update.bin"), /colon/],
    [`${join(root, "a.prst")}" "${join(tmpdir(), "mine.prst")}`, /may not hold/],
  ] as const) {
    await assert.rejects(fillDialog(d, "Open", path, "Open"), why, path);
  }
  await assert.rejects(fillDialog(d, "Open", join(root, "ok.prst"), "Update"), /never presses "Update"/);
  assert.equal(filled, 0);
  await fillDialog(d, "Save As", join(root, "backup.syx"), "Save");
  await fillDialog(d, "Export", join(root, "backup.syx"), "Save");
  await fillDialog(d, "Export", join(root, "backup.syx"), "&Save");
  await assert.rejects(fillDialog(d, "Export", join(root, "backup.syx"), "Save to device"), /saved, never opened/);
  assert.equal(filled, 3, "a backup may be saved as SysEx");
  await assert.rejects(fillDialog(d, "Open saved backup", join(root, "backup.syx"), "Open"), /may be saved, never opened/, "the title alone doesn't make a save");
  await assert.rejects(fillDialog(d, "Save As", join(root, "x.bin"), "Save"), /\.bin file/);
  assert.equal(checkDialogPath(root, join(root, "sub", "..", "ok.prst")), join(root, "ok.prst"));
  assert.equal(checkDialogPath(root, root), root, "a folder picker may be pointed at the folder itself");
  assert.throws(() => checkDialogPath(root, join(root, "UPDATE~1.FIR")), /short 8\.3 name/);
});
