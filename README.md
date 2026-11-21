# patchsprite-sniffer

An open-source tool that records the MIDI and SysEx traffic between a hardware device (for example a guitar multi-effects pedal) and its vendor editor, so the messages can be studied and documented.

- **Records** the messages passed between the device and its editor while you use the editor as normal.
- **Uploads only if you opt in.** Observed data (the recorded messages and what they appear to control) can be sent to the Patchsprite cloud. Nothing is uploaded unless you turn this on.
- **Python.** Code is coming soon.

This repository contains the sniffer only. It does not contain device mappings, vendor files or vendor software.

## License

AGPL-3.0. See [LICENSE](LICENSE).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). A contributor license agreement (CLA) is required.
