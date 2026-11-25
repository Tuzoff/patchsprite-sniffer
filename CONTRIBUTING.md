# Contributing

Thanks for your interest in patchsprite-sniffer.

## Contributor license agreement (CLA)

A signed [Contributor License Agreement](CLA.md) is required before a pull request can be merged. CLA Assistant asks you to sign it on your first pull request; one signature covers all your contributions. Under it you assign the copyright in your contributions to the project's copyright holder, Leadt Technology Inc., and keep a broad licence to use them yourself.

The CLA applies to every part of this repository, including the shared engine package (`packages/engine`, coming soon). Leadt Technology Inc. also uses that package in its own products, which the CLA allows. Pull requests to it are not merged without a signed CLA.

## What not to submit

- No vendor files, firmware, or vendor software.
- No device mappings (parameter maps, offset tables, or similar).

## Checks on your pull request

- **`test`**: type check and unit tests, on GitHub's runners (`npm ci && npm run typecheck && npm test`).
- **`leak-check`**: Patchsprite's closed CI scans this repository for private content (device maps and their
  recordings, protocol codes, vendor files) and posts the result here. It runs on a schedule, so a new push gets its
  status within about 15 minutes, and sometimes later. On a pull request from a fork it stays pending until a
  maintainer has reviewed the current commit, so it can't be used to test guesses at private content. A failure says
  only that something matched, never what; a maintainer will tell you what to change.
- **CLA**: CLA Assistant, as above.

Pull request titles, descriptions, comments and issues are public but not scanned, so don't paste captures, SysEx
dumps or vendor files into them. Use the sniffer's upload to share a capture with us.
