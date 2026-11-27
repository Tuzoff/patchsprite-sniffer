# Capture format

**Status: version 1, first draft.** The sniffer is the first thing that writes it. Field names may still change until
the sniffer has recorded a real session; after that, renaming or removing a key or a value needs version 2. Adding a
key, or a value to a list of values (a new `method`, `platform`, record `kind` or flag), doesn't: it stays version 1,
and a reader older than the addition refuses a file that uses it, naming the first such line.

A capture is what the sniffer records while a vendor editor talks to a device: every MIDI message in both directions,
with its time, the session's own events (attached to the editor, a port opened), and the steps the user or the walk
marks, each with the change it made ("Drive: off → on"). One file per session.

- Schema for one line: [`schemas/capture-line.v1.schema.json`](../../schemas/capture-line.v1.schema.json), generated
  from the zod schema in [`packages/engine/src/capture.ts`](../../packages/engine/src/capture.ts).
- Rules across lines, reading a whole file or one line at a time, and a step's messages: `parseCapture`,
  `CaptureReader` and `stepMessages` in the same file.
- Example on a made-up device: [`test/fixtures/capture/acme-fx-1.capture.jsonl`](../../test/fixtures/capture/acme-fx-1.capture.jsonl).

A capture holds wire bytes, the sniffer's own events and the user's labels only: no vendor software, firmware,
catalogs or decompiled code. It can still hold the device's own content, such as factory presets the editor read, so
a capture file is private. It stays on the user's computer, and later goes to the Patchsprite cloud only through the
sniffer's upload, never into this repository or a public issue. This repository holds the format and made-up
examples only.

## The file

JSON Lines: one JSON object per line, each line ending in a newline, UTF-8. A long session streams to disk, and a
file cut off by a crash still reads up to its last whole line (a last line with no newline is left out, and the
reader says the file was truncated). A line is at most 262,144 characters.

The first line is the header. Every other line is a record, in the order the sniffer wrote them. Nothing follows the
`end` record; a capture with no `end` was cut off.

Bytes are written as in maps: lowercase hex pairs separated by single spaces (`f0 7d 01 10 f7`), at most 64 KiB per
message. Times (`t`) are milliseconds since the Unix epoch on the capturing computer's clock, with fractions allowed.

## Header

| Key | Required | Value |
| --- | --- | --- |
| `type` | yes | `"header"` |
| `format` | yes | `"patchsprite-capture"` |
| `version` | yes | `1` |
| `session` | yes | a random lowercase UUID; evidence such as a seed patch's capture file names the session by it |
| `startedAt` | yes | ISO 8601 time with offset |
| `tool` | yes | `{name, version}` of the program that wrote it |
| `os` | yes | `{platform, release}`, `platform` one of `win32`, `darwin`, `linux` |
| `method` | yes | how messages were captured: `frida-winmm` (a Frida hook on the editor's WinMM calls, Windows) |
| `device.usb` | no | `{vid, pid}` of the device |
| `device.ports` | no | `{in, out}`: the device's MIDI port names exactly as the OS shows them; the map builder writes the map's bare port name from them |
| `editor` | yes | `{exe, version?}`: the executable the capture attached to, and its version as the editor reports it |
| `note` | no | free text |

## Records

Every record has a `type` and a time `t`.

### `midi`: one message

| Key | Required | Value |
| --- | --- | --- |
| `dir` | yes | `out`: the editor to the device; `in`: the device to the editor |
| `kind` | yes | `sysex`, `short` (a channel or system message of 1 to 3 bytes), or `sysexError` / `shortError` when the driver flagged it as incomplete or invalid |
| `bytes` | yes | the message |
| `hookT` | no | the time the hook saw it, when that differs from `t` |
| `port` | no | the MIDI handle the editor used, as the hook saw it, so two ports in one session are told apart |
| `flags` | no | why the message doesn't count as a step's traffic: `clock` (F8), `activeSensing` (FE), `short`, `poll` (the editor's own constant polling) |

Nothing is ever dropped. Flagged messages stay in the capture; a step is over once nothing unflagged has arrived for
a while, so a device that streams MIDI clock no longer keeps every step waiting. A message with no flags counts.

### `event`: the session itself

`kind` is `attached` or `detached` (the capture attached to or lost the editor; it re-attaches after a restart),
`portOpen` or `portClose` (the editor opened or closed a MIDI port, with `dir`, `port` and the OS's `device` index),
or `info`, `warning`, `error` (the sniffer's own notes, in `text`). `pid` is the editor's process id.

### `stepStart` and `stepEnd`: a marked step

A step is a time range over the capture: its messages are those timed from its start to its end, and are never copied
into the step. A step is written when it starts and closed when it ends, so a step cut off mid-way shows as
incomplete instead of vanishing. Steps never overlap, and each has a unique `id` (1 and up).

`stepStart`:

| Key | Required | Value |
| --- | --- | --- |
| `id` | yes | the step's number |
| `kind` | yes | `action` (one labelled change the editor makes), `idle` (the editor left alone, so what it sends is its poll set), `selfTest` (the session's opening check), or `manual` (a step the user performs by hand while the capture runs, for what automation can't do) |
| `label` | yes | what the step does, as `control: before → after` once the change is known (`Drive: off → on`) |
| `change` | no | the same change as `{control, before, after}` |
| `before` | no | the before-screenshot's file name beside the capture (a name, never a path) |

`stepEnd`:

| Key | Required | Value |
| --- | --- | --- |
| `id` | yes | the step it ends: the one open |
| `status` | yes | `quiet` (nothing counted arrived for the settle time), `timeout` (it never went quiet), or `aborted` |
| `label`, `change` | no | the label and change again, when they are only known at the end (the after-value) |
| `after` | no | the after-screenshot's file name |
| `note` | no | free text |

### `end`: the session ended

`reason` is `stopped`, `selfTestFailed` or `error`, with an optional `text`.
