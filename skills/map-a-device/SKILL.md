---
name: map-a-device
description: Walk a device's vendor editor with the Patchsprite sniffer, one control at a time, so its MIDI traffic is recorded and labelled for a device map. Use when the user wants Patchsprite to support a pedal, amp or other device it doesn't know yet.
---

# Map a device

The Patchsprite sniffer records the MIDI between a device and its vendor editor while the editor is used as normal.
It only watches: everything the device hears comes from the editor. You walk the editor through the sniffer's tools
(screenshots, clicks, typed values), one control at a time, and label each change, so the capture shows which
messages each control sends. The capture stays on the user's computer.

This skill holds no device facts. Everything about the device comes from its editor on the user's screen and from the
user.

## Who clicks

- Where you can hand work to a small, fast model (a subagent), give it the clicking and keep planning and review for
  yourself. Everything inside the guardrails below is pre-approved for it: it doesn't stop to ask before each click.
- In a chat app without subagents, you click yourself. The sniffer does the mechanical checks (the quiet check, blank
  screenshots, label format).
- Dialog-heavy parts (backups, a long list of identical fields) can go faster driven directly by you.

## Before anything

1. Ask the user's consent. Say that the capture hooks the editor's MIDI calls, holds the device for the whole session
   (Patchsprite leaves it alone until the capture stops), and that you will click and type in the editor.
2. Ask which preset or slot is the scratch one you may change, and agree it is backed up first. You change nothing
   else.
3. Check the screen is unlocked: on a locked screen clicks go nowhere. Never type a password or PIN; ask the user.

## The session

1. `start_capture` with the editor's executable name and attach delay; wait until `capture_status` says attached.
   Open the editor after `start_capture`: Patchsprite may keep the device's port for a few more seconds once the
   capture holds the device, so if the editor says no device is connected, ask the user to close it, wait about
   5 s and open it again.
2. `record_idle` for about 10 s with nobody touching the editor, so its constant polling stops counting as traffic.
3. The self-test (see `help("session")`): one small change, and stop if it fails.
4. **Discovery pass.** Take `editor_screenshot`s of each screen, list the editor's blocks, controls and screens, and
   write a walk plan: which controls, in which order, in the scratch preset. Show it to the user and wait for their
   yes before walking.
5. **Walk.** For each control in the plan: `begin_step` with a label, change one control with `editor_input`,
   `end_step`. Labels say "control: before → after", such as "Drive gain: 5 → 6" or "Scene 2 tempo: 120 → 122".
6. `stop_capture`, then `summarize_capture`, and review it with the user: every step should have caught traffic.

## Tools

- `editor_screenshot`: the editor's window only, at half size. Read click points off the latest one. Take a new one
  whenever something opens or closes.
- `editor_input`: steps such as `click:X,Y`, `dclick:X,Y`, `wheel:X,Y,N`, `drag:X1,Y1,X2,Y2`, `key:enter`,
  `type:TEXT`, `wait:S`. Batch steps when the screen is predictable (fields in one open dialog), then one screenshot to
  confirm.
- `read_control`: a control's name and value through Windows UI Automation, where the editor exposes it.
- `list_dialogs` and `fill_dialog`: the editor's Open and Save dialogs, which screenshots can't show. When the editor
  seems stuck after a click, check `list_dialogs`. While a file dialog is open, `editor_input` only scrolls, presses
  Esc or clicks Cancel: give its file name and its Open or Save button to `fill_dialog`, with a path inside the
  capture's own files folder. A backup may be saved there as SysEx or MIDI, but such a file is never opened.

## Guardrails

- Change only the scratch preset the user named, once it is backed up. Never select, edit, move, store over or delete
  any other preset.
- Never press sign-in or account controls, firmware update, factory reset, the vendor's store or community, or anything
  that uploads or downloads. Close vendor popups. The tools refuse many of these by name; when one refuses, ask the
  user, and only with their yes repeat it with `hazardApproved`.
- Global settings: note the value from a screenshot, change it one step, restore it, and screenshot the restore. If a
  control can't be changed and restored cleanly, record it read-only.
- Never delete or import files the user owns (impulse responses, captures, presets). Dialogs only reach the capture's
  own folder.
- Vendor editors often ship one model catalog for a whole family of devices. Map only what the editor offers for the
  connected device and firmware. Assigning anything else can halt the device: if one must be tried, do it one at a time
  in the scratch preset, check the device still answers after each, stop at the first silence, ask the user to restart
  it, and record the error text.
- On an error dialog, a "no device" message or a freeze: stop and tell the user.
- After any read the editor does, check that the current preset and unsaved edits survived: on some devices reading a
  preset loads it.
- At the end, compare every preset with the backup and tell the user about anything outside the scratch preset.
