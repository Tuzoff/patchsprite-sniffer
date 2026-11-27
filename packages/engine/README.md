# @patchsprite/engine

The shared engine of [Patchsprite](https://github.com/patchsprite-app/patchsprite-sniffer): device maps for MIDI and
SysEx devices, and the code that reads them.

- `@patchsprite/engine` (runs in Node and in a browser): the map schema (`parseProtocol`, `parseDeviceMap`), the codec
  (`ProtocolCodec`), the framing engines (`messageFramer`, `AddressFramer`), LZO, 8-to-7 packing, labels, port-name
  matching, canonical JSON and SHA-256 fingerprints, map-check records, and the measured-value shape.
- `@patchsprite/engine/node`: map loading from a folder, atomic file writes, the pedal lock, and an RtMidi transport
  (pass in your own RtMidi binding, such as `@julusian/midi`).
- `patchsprite-pedal-lock`: holds the pedal lock while an editor walk runs, so the Patchsprite app keeps off the device.

Formats: [device map](../../docs/formats/device-map.md), [seed patch](../../docs/formats/seed-patch.md); JSON Schemas in
[`schemas/`](../../schemas). Build with `npm run build` (compiled JS and `.d.ts` in `dist/`).

Copyright © 2026 Leadt Technology Inc. Licensed under AGPL-3.0; see [LICENSE](LICENSE).
