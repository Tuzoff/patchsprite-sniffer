# patchsprite-sniffer

An open-source tool that records the MIDI and SysEx traffic between a hardware device (for example a guitar multi-effects pedal) and its vendor editor, so the messages can be studied and documented.

- **Records** the messages passed between the device and its editor while you use the editor as normal.
- **Sends captures to the Patchsprite cloud** under terms you accept the first time you use it. Observed data (the recorded messages and what they appear to control) is used to add support for your device. You keep a local copy.
- **TypeScript.** Code is coming soon, together with a shared engine package for reading device map files and decoding device messages.

This repository contains the sniffer and the shared engine package only. It does not contain device mappings, vendor files or vendor software.

## License

Copyright © 2026 Leadt Technology Inc. Licensed under AGPL-3.0; see [LICENSE](LICENSE).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). A signed [contributor license agreement](CLA.md) is required; CLA Assistant asks you to sign it on your first pull request.
