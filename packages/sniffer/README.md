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
