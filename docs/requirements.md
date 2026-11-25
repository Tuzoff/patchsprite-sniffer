# Requirements

The sniffer's requirements, by id. A pull request names the ones it serves on its `Requirements:` line (see the
pull request template), or says `none (why)` for tooling and housekeeping.

A change to the shared engine package may also name the Patchsprite app's requirement ids it serves (such as
`F39`). Those are tracked privately, so this repo lists no descriptions for them.

| Id | Requirement |
| --- | --- |
| S1 | Capture both directions passively, with timestamps, without opening the device's MIDI port, so the editor keeps it |
| S2 | The sniffer sends nothing to the device; the commands it records come from the vendor editor |
| S3 | Action labels: each step is marked ("Drive gain 5 to 6") so messages pair with what changed |
| S4 | Generic decoders and diff tools, driven by a map's framing section, with no device constants in code |
| S5 | Captures are written in the open capture format, one file per session, kept locally |
| S7 | Never bundle, fetch or upload vendor software, firmware, catalogs or decompiled code; a capture holds wire bytes and the user's labels only |
| S8 | Windows first, macOS next |
| S9 | TypeScript on Node, built on the open engine package; capture through Frida's Node bindings |
| S10 | Editor walks are clicked by a small, fast model; the main chat model plans the walk and reviews the capture |
| S11 | Walk tools in the sniffer's MCP server (editor screenshot, click, type, read a control, dialogs), and a walk plan the user approves first |
| S12 | In chat apps without subagents, the user's own chat model drives the clicks and the server does the mechanical checks |
| S13 | About 10 s of idle traffic is recorded before a walk and flagged as the editor's poll set |
| S14 | Screenshots show the editor window only, never the desktop |
| S15 | A short self-test opens each session and stops it if the capture sees no traffic both ways |
| S17 | Replies where the device reports its own lists are marked as device-reported map sources |
| S18 | Targeted re-walks gather the evidence to repair a map entry the device contradicts |
| S19 | Every built map states its driver, and the validator refuses one without it |

Bugs are GitHub issues labelled `bug`. The pull request that fixes one says `Fixes #N`.
