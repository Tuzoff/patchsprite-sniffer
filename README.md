# patchsprite-sniffer

An open-source tool that records the MIDI and SysEx traffic between a hardware device (for example a guitar multi-effects pedal) and its vendor editor, so the messages can be studied and documented.

- **Records** the messages passed between the device and its editor while you use the editor as normal.
- **Sends captures to the Patchsprite cloud** under terms you accept the first time you use it. Observed data (the recorded messages and what they appear to control) is used to add support for your device. You keep a local copy.
- **TypeScript.** The sniffer is coming soon. Its shared engine package, [`@patchsprite/engine`](packages/engine), reads device map files and decodes device messages: a browser-safe main entry, and Node-only parts (map loading, an RtMidi transport) under `@patchsprite/engine/node`. Build it with `npm run build`.

## Formats

- [Device map](docs/formats/device-map.md): the protocol section of a device map (`schemas/device-map.v1.schema.json`), which the engine reads.
- [Seed patch](docs/formats/seed-patch.md) (proposal): changes a unit's evidence makes to a seed device map, one change per entry, each with its evidence.

Run the tests with `npm ci && npm test` (Node 22.18 or newer).

This repo holds no secrets, and none may ever be added: no Actions secrets, no keys or tokens in files, and no device mappings or captures. Checks that need private data (such as the leak check) run from Patchsprite's closed CI, not here.

This repository contains the sniffer and the shared engine package only. It does not contain device mappings, vendor files or vendor software.

## License

Copyright © 2026 Leadt Technology Inc. Licensed under AGPL-3.0; see [LICENSE](LICENSE).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). A signed [contributor license agreement](CLA.md) is required; CLA Assistant asks you to sign it on your first pull request.
