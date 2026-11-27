# @patchsprite/sniffer

The sniffer: it records a vendor editor's MIDI traffic while the editor is walked, one labelled step at a time.

## Walk tools (`src/walk/`)

The tools a model uses to walk the editor (S11). They run on Windows; tests use a fake window host, so they run
anywhere.

- `host.ps1` is one long-lived Windows PowerShell process the tools talk to over JSON lines (`host.ts` starts it). It
  finds the editor's window by its executable name, brings it to the front and takes its screenshot. No native npm
  module is needed.
- `shot.ts` takes an editor screenshot (S14): the editor's own window only, never the desktop, because shots go to a
  model. The window is brought to the front first, and the shot is saved at half the window's width by default.
  - It is drawn with `PrintWindow`, so nothing that overlaps the editor can show in it.
  - When that frame comes back blank (some editors draw on the GPU), it falls back to copying the window's area from
    the screen, but only while the editor is in front and no other window covers any part of it. Otherwise the shot
    is refused.
  - A blank frame (all white or all black) is retaken, three tries by default, and never handed to the model.
  - The result gives the window's rectangle and the scale, so a point read off the shot maps back to the screen
    (`shotToScreen`).
