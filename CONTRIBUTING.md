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
  maintainer has approved its current commit, so it can't be used to test guesses at private content. A failure says
  only that something matched, never what; a maintainer will tell you what to change. It also looks for Patchsprite's
  private plans: this repository has no milestones and no labels starting `stage`, and its files, commit and tag
  messages, labels, and issue and pull request titles and bodies may cite a private requirement id (such as `F39`) but
  never describe it. Our own ids, `S1` and up, are listed in `docs/requirements.md`.
- **`checklist`**: the pull request body's `## Merge gate` boxes are ticked and its `Requirements:` line names ids from
  `docs/requirements.md` (or says `none (why)`), as the template lays out. For a pull request from outside the team, a
  maintainer runs the reviews and ticks the boxes.
- **CLA**: CLA Assistant, as above.
- **`spec-review`**: maintainers check the change against the sniffer's spec and the Patchsprite app's scope, and add
  `spec-ok: sniffer` and `spec-ok: scope` once both are OK (or `spec-review: not needed` for CI and tooling
  changes). Each of these labels counts only if it was added after the pull request's last push, so a push after a
  review asks both reviewers again. It fails until then; a maintainer will tell you if anything needs changing.
- **`gate-approval`**: a pull request that changes how pull requests are checked or merged (anything under `.github/`
  or `.claude/`, the check scripts in `scripts/`, `CLA.md`, `LICENSE`) needs a maintainer's `gate-approved` label added
  after its last push; every other pull request passes it at once. Only maintainers decide on these changes.

Issue and pull request text is public, and only titles and bodies are checked, for the plans above; comments are not
read at all. Don't paste captures, SysEx dumps or vendor files into any of it. Use the sniffer's upload to share a
capture with us.
