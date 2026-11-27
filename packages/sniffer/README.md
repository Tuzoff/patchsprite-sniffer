# Sniffer

Records the MIDI traffic between a device and its vendor editor while you use the editor as normal, into a capture
file in the [capture format](../../docs/formats/capture.md). It only watches: it never opens the device's MIDI port
and never sends anything to the device, so the editor keeps its port and the device hears only the editor.

Windows only today. Capture uses Frida's Node bindings (the `frida` package, installed with `npm install`) to hook
the editor's Windows MIDI calls. Some antivirus tools flag this kind of hook, since it runs code inside the editor.

```powershell
npm install
node packages/sniffer/bin/sniff.ts capture --editor AcmeEdit.exe --attach-delay 2
```

`--editor` is the editor's executable file name as Task Manager shows it. Start the capture before or after the
editor: it waits for the editor, attaches `--attach-delay` seconds after it appears (attaching too early can leave an
editor's window blank), and attaches again if the editor restarts. Press Ctrl+C to stop. The capture goes to
`capture-<time>-<id>.jsonl` in the current folder, or to `--out FILE`, and is never written over.

A capture can hold your device's own content, such as presets the editor read from it. Keep it to yourself: don't
attach it to a public issue.

## Walk tools (`src/walk/`)

The tools a model uses to walk the editor (S11), served by `sniff mcp` beside the capture tools. They work only while
a capture runs: the capture names the editor, holds the pedal lock for the whole session and records what every
input makes the editor send. They run on Windows; tests use a fake window host, so they run anywhere.

- `editor_screenshot` (`shot.ts`, S14): the editor's own window only, never the desktop, because shots go to a model.
  The window is brought to the front first, and the shot is saved at half the window's width, in a `.shots` folder
  beside the capture.
  - It is drawn with `PrintWindow`, so nothing that overlaps the editor can show in it.
  - When that frame comes back blank (some editors draw on the GPU), it falls back to copying the window's area from
    the screen, but only while the editor is in front and no other window covers any part of it. Otherwise the shot
    is refused.
  - A blank frame (all white or all black) is retaken, three tries by default, and never handed to the model.
- `editor_input` (`input.ts`): click, double-click, right-click, wheel, drag, keys and typed text, at points on the
  latest shot. Input lands only on the editor's own windows: a point covered by another window (a chat app's
  overlay, say) is retried for 30 s and then refused, and keys are sent only while one of the editor's windows is in
  front.
- `read_control` (`read.ts`): the control at a point, through Windows UI Automation (name, type, value, range,
  toggle state), where the editor exposes it.
- `list_dialogs` and `fill_dialog` (`read.ts`): the editor's standard Open, Save As and Select Folder dialogs, which
  its screenshot can't show. A fill types the path into the dialog's file-name box and presses a button by caption.
- `host.ps1` is one long-lived Windows PowerShell process the tools talk to over JSON lines (`host.ts` starts it), so
  no native npm module is needed. It saves shots only as `.png` files under the capture's shot folder.
