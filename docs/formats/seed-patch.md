# Seed patch format

**Status: proposal.** Nothing reads or writes seed patches yet. The format, its JSON Schema and its checks are here so
the sniffer, the Patchsprite app and the cloud map builder agree on one shape before any of them builds it. Field names
may still change until the first-contact work is built.

A seed map is a device map made from public sources before anyone has tried it on a real unit. When a unit meets it
for the first time, the app's probe, the player and (when needed) a sniffer walk all produce evidence about the seed.
A **seed patch** is that evidence written as changes to the seed: one change per map entry, each carrying its own
evidence. Each change is reviewed, accepted or refused on its own, so the entries that passed keep their trust while
the ones that failed are fixed.

- Schema: [`schemas/seed-patch.v1.schema.json`](../../schemas/seed-patch.v1.schema.json), generated from the zod
  schema in [`packages/engine/src/seed-patch.ts`](../../packages/engine/src/seed-patch.ts).
- Checks the JSON Schema can't state, applying a patch and working out what needs review: `checkSeedPatch`,
  `applySeedPatch` and `reviewReasons` in the same file.
- Example on a made-up device: [`test/fixtures/seed-patch/`](../../test/fixtures/seed-patch/).

A patch file is data about one device, as private as the capture it came from. It goes to the Patchsprite cloud only,
never into this repository or a public issue. This repository holds the format and made-up examples only.

## The file

One JSON object, at most 4 MiB, nested at most 100 deep, with no `__proto__` key or op path segment anywhere
(JavaScript readers would take it for an object's prototype).

| Key | Required | Value |
| --- | --- | --- |
| `format` | yes | `"patchsprite-seed-patch"` |
| `version` | yes | `1` |
| `map` | yes | the seed it changes, `<make>/<device>` as the map folder names it (`acme/fx-1`) |
| `base.file` | yes | fingerprint of the seed file's JSON as written (see Fingerprints), so a draft that doesn't load yet still has one |
| `base.mapVersion` | no | the map's `mapVersion` as the app's map checks compute it, when the seed loads |
| `unit.firmware` | yes | the firmware the unit reports, as the map spells it |
| `unit.identity` | no | the MIDI universal identity reply, as received bytes |
| `unit.usb` | no | `{vid, pid}` |
| `producer` | yes | `{tool, version}`, where `tool` is `sniffer`, `app`, `cloud` or `manual` |
| `createdAt` | yes | ISO 8601 time with offset |
| `sources` | no | files the evidence points into, by id: `{kind, sha256?, note?}`, `kind` one of `capture`, `probe-log`, `map-checks`, `doc` |
| `changes` | yes | 1 to 4,096 changes |

A patch names a unit by model and firmware only. It holds no person, machine, file path, MIDI port name or serial
number, like the app's map-check records. One patch covers one unit and one firmware; the cloud counts units by
combining patches.

Bytes are written as in maps: lowercase hex pairs separated by single spaces (`f0 7d 01 10 f7`).

## Changes

| Key | Required | Value |
| --- | --- | --- |
| `id` | yes | unique in the patch (`name-length`), so a review can accept or refuse it by id |
| `entry` | yes | the entry it covers (see Entries) |
| `action` | yes | `add`, `repair`, `remove`, `confirm`, `suspect` or `block` |
| `entryFp` | no | the entry's map-check fingerprint in the base map (`null`: the base has no such entry, so only for `add` and `block`); only when the seed loads |
| `source` | for `add`, `repair`, `confirm` | the provenance the entry gets once the change is in (see Sources) |
| `mode` | for an `@<mode>` entry | the mode the unit was in when the evidence was seen, for a map with `modes`; an `@<mode>` entry needs that same mode, so one mode's evidence never marks another mode's entry |
| `ops` | for `add`, `repair`, `remove` | 1 to 64 edits to the map (see Ops) |
| `evidence` | yes | 1 to 64 pieces of evidence (see Evidence) |
| `note` | no | for the reviewer; never shown to the chat model |

The six actions:

| Action | Ops | Means |
| --- | --- | --- |
| `add` | `add` only | the seed lacks the entry and the unit has it |
| `repair` | any | the entry is wrong and the ops fix it |
| `remove` | `remove` only | the unit has no such thing (the editor never offers it, the unit's own list lacks it) |
| `confirm` | none | the entry is right as seeded |
| `suspect` | none | the unit contradicts the entry and there is no fix yet; the list of suspects is the plan for a targeted re-walk |
| `block` | none | never send it on this firmware (a freeze, or a hazard a document names) |

`confirm`, `suspect` and `block` are marks for the unit's firmware: they leave the map as it is, and whoever reads the
patch keeps them in its own store (the app's map-checks store, the cloud's per-firmware entry states).

## Entries

Entry names extend the ones the app's map checks already use (`docs/design/map-checks.md` in the app), so a patch and a
map-check record about the same entry use the same name.

| Entry | Covers | Its home in the map |
| --- | --- | --- |
| `<message>` | a message | `/messages/<message>`, `/firmwares/<fw>/messages/<message>` |
| `<message>/<block>` | a message on one block; marks only | (none: edits go to the message) |
| `<message>@<mode>`, `<message>@<mode>/<block>` | a message as a mode that stands in layouts or enums reads it | as for `<message>` (no whole-section home) |
| `param/<block>/<id>` | a block parameter by id, in a group that stands in for none | `/parameters/groups/*/params/*` |
| `param/<block>/<id>/<group>` | a block parameter in a group that stands in for another in some mode (`modes.use.<mode>.groups`) | `/parameters/groups/<group>/params/*` |
| `choice/<name>` | a choice | `/choices/<name>` |
| `layout/<name>` | a shared layout | `/layouts/<name>`, `/firmwares/<fw>/layouts/<name>` |
| `enum/<name>` | an enum | `/enums/<name>` |
| `constant/<name>` | a named constant | `/constants/<name>`, `/firmwares/<fw>/constants/<name>` |
| `control/<name>` | a MIDI channel control | `/controls/items/<name>` |
| `setting/<id>` | a global setting | `/settings/items/*` |
| `linked/<group>/<set>` | a set of paired parameters in a parameter group | `/parameters/groups/<group>/linked/<set>` |
| `measured/<field>` | a measured value, by its dotted path (`measured/transport.timing.compareToggle`), inside one of the known sections in the next row | the field's own path (`/transport/timing/compareToggle`) |
| `transport`, `host`, `identity`, `driver`, `session`, `hazards`, `scratch`, `audio`, `display`, `parameters`, `controls`, `settings`, `eq`, `addresses`, `editor`, `modes` | that whole section | `/<section>` |
| `safety`, `blocked` | that whole section | `/<section>`, `/firmwares/<fw>/<section>` |
| `<key>`, any other top-level key | that whole section, such as a draft's own `addressMap` | `/<key>` |

The first four kinds are the app's; the rest are new here. **Every top-level key of a map is an entry**: the sections
above by name, and any other key (a section a newer map or a draft has) by its key alone, when the key is a camelCase
name (`^[a-z][A-Za-z0-9]*$`, at most 64 characters) and not a word that starts another kind of entry. The exceptions are the keys
only ever covered by finer entries (`messages`, `layouts`, `enums`, `constants`, `choices`, `firmwares`, `schema`) and
a draft's own bookkeeping (`status`, `gaps`, `provenance`), which are never entries. `identity` is the proposed key for
the unit's identity reply, `session` for what is sent when a port opens (`onConnect`), `hazards` for the seed's hazard
list, `addresses` for address-based framings and `modes` for modes whose entries live apart (the mode and
grouped-parameter forms follow the app's map-check names for modes). The whole `parameters` section covers a parameter group that doesn't
say which blocks it serves, and the whole `controls` section covers the channel and preset settings outside
`controls.items`.

A bare name is a message or, when the map has a top-level key of that name, that section. So no message is named
like a section or a word that starts another kind of entry (`param`, `setting`, `measured`, `linked`, `choice`, `layout`,
`enum`, `constant`, `control`), nor like any top-level key of its own map; when a map breaks that, a change naming
it is `refused` as ambiguous, and so is a change whose ops would make a map break it. A change to a top-level section this engine doesn't know always needs review.

A change's ops stay inside its entry's homes. `<fw>` is the unit's own firmware: evidence from one firmware changes
the base map or that firmware's delta, never another firmware's. After the ops run, the applier checks that the entry
is there (`add`, `repair`) or gone (`remove`). A parameter or setting is found by its id, so the applier also checks
that the ops landed on that one (where it was for a `repair` or `remove`, where it is for an `add`) and not on another
in the same table; `checkSeedPatch` has no map, so this check happens only when the patch is applied.

A firmware delta's message, layout or constant replaces the base one whole for that firmware, as the app's engine
reads it (map-checks.md, "Fingerprints"); it is not merged into the base one.

## Ops

An op is a JSON Patch (RFC 6902) operation with a guard:

| Op | Keys | Applies when |
| --- | --- | --- |
| `add` | `path`, `value` | nothing is at `path` (objects on the way that are missing are created, such as a new firmware's delta), or `path` ends in `-` to append to an array |
| `replace` | `path`, `value`, `was` | the value at `path` has fingerprint `was` |
| `remove` | `path`, `was` | the value at `path` has fingerprint `was` |

`path` is a JSON Pointer (RFC 6901) below the map's root. `was` makes each edit say what it replaces, so an edit made
against another version of the entry is refused instead of applied blind. `add` never inserts into the middle of an
array: replace the array whole instead. Values are at most 256 KiB as JSON.

No two changes in a patch edit the same place: no op path of one change is the same as, or lies inside, an op path of
another. Appends to one array (`-`) are each a new place, so two changes may both append to it.

## Evidence

| Kind | Keys | Is |
| --- | --- | --- |
| `capture` | `source`, `action?`, `label?`, `records?`, `frames?` | traffic the sniffer recorded between the vendor editor and the unit: the labelled step, record numbers in the capture file (from 0), and the frames copied (`{dir, bytes}`, `dir` `out` to the device, `in` from it) so the change can be reviewed without the capture |
| `probe` | `at`, `request`, `sent`, `replies`, `result`, `detail?` | a read-only request sent once on first contact; `result` is `shape-ok` (decoded as the seed says), `mismatch` (answered, but not as the seed says) or `silent` (no answer in time); `detail` is the decoder's difference ("cmd 31 has 16 name bytes; the seed says 12") |
| `read-back` | `at`, `sent`, `readBack`, `result`, `echo`, `detail?` | a write, then a read of the same value; `result` `match` or `differs`; `echo` when the write sent back the value its paired read had just returned, so the sound didn't change |
| `replay` | `at`, `result`, `source?`, `detail?` | the rebuilt entry replayed on the unit (sniffer spec S18, verify before it goes live) |
| `device-list` | `at`, `request`, `replies`, `source?` | a list the unit gave about itself when asked: blocks, a block's parameters, models (S17) |
| `player` | `at`, `question`, `answer` | the player's answer where nothing can be read back ("Did the unit switch to preset 12?"), `yes`, `no` or `unsure` |
| `freeze` | `at`, `sent`, `errorText?`, `recovery` | the unit stopped answering after a send; `recovery` `power-cycle`, `replug` or `none` |
| `map-check` | `at`, `fp`, `outcome`, `claimed?`, `observed?`, `why?` | a line of the app's map-check log, less what the patch already says (map, firmware, entry) |
| `doc` | `citation`, `quote?` | a vendor or third-party document; the weakest evidence |

A `source` names an entry of the patch's `sources`.

**Who may be probed.** The app's probe runner decides which requests first contact sends to an unknown unit, never
the patch: only messages whose `dir` is `request`, whose command appears in a list the unit reported or in the
editor's own capture, and never a command the same seed also uses for a send. Once maps mark safe reads (`safeRead`),
only those. Probes run under the pedal lock, like any other traffic to the unit. When a patch is applied, a change
whose `probe` evidence names a request that breaks the parts of this rule the map shows (not a request, not marked
`safeRead` in a map that marks them, or a command a send also uses) is `refused`. The applier judges this against the
map as it was before the patch, with the unit's firmware delta standing in for the messages it names, so an earlier
change in the same patch can't make a probe look safe.

Evidence **against** the entry as the seed has it: a probe that is `mismatch` or `silent`, a read-back or replay that
`differs`, a map check that `contradicts`, `disagrees` or `reopens`, a player's `no`, and any freeze. A `confirm` may
carry none of it, a `suspect` needs some, and a `block` needs a freeze or a document.

## Sources

The provenance words a change can give its entry, each backed by at least one piece of its evidence. A change claims
no more trust than its evidence shows.

| `source` | Backed by |
| --- | --- |
| `wire` | a `capture` |
| `device-reported` | a `device-list` |
| `read-back` | a `probe` that is `shape-ok`, a `read-back` that matches, or a map check that `confirms` or `settles` |
| `replay-verified` | a `replay` that matches |
| `player-confirmed` | a player's `yes` |
| `doc` | a `doc` |

These are the map's provenance words (sniffer spec, Map format) plus `player-confirmed`, which is new here, from the
first-contact design. The map's `test` provenance is for the app's own test maps and never appears in a patch.

## Applying a patch

1. Check it: the schema, then `checkSeedPatch`. A patch that fails is refused whole.
2. Work out what needs a person (`reviewReasons`, below) and which changes a review accepted.
3. Apply the accepted changes in order, each all or nothing, to a copy of the map (`applySeedPatch`). A change whose
   ops no longer fit (an `add` where something is, an `add` change whose entry the map already has, a `was` that
   doesn't match) is left out as `stale`, and the rest
   still land, so a patch made against an older seed is still useful wherever its entries didn't change. When
   `base.file` doesn't match the map, the result says `rebased`. A change is `refused` when its ops ran but don't do
   what its action says, when they edit another parameter or setting than its entry names, when a `confirm` or
   `suspect` names an entry the map lacks (a `block` may name one), or when its probe evidence breaks the probe rule.
4. Keep the marks (`confirm`, `suspect`, `block`) in the reader's own per-firmware store.

No op writes `provenance` (anywhere, in a path or a value) or a draft's top-level `status` and `gaps`:
`checkSeedPatch` refuses them, so a change can't claim more trust than its `source` and evidence give it. Giving the
changed entries the change's `source` as their provenance is the reader's job; `applySeedPatch` doesn't do it yet,
because where a map keeps per-entry provenance isn't settled.

## What needs review

Whatever the producer says, the reader works out from the ops and the base map (`reviewReasons(patch, map)`) which
changes a person must review before they reach any player other than the unit's owner (live updates design,
"Versions, rollback and trust"). A key counts wherever it appears: in the op's path, in the value it puts in, in
the value a `replace` or `remove` takes out of the base map, or in the base map's entry that an edit to the unit's
firmware delta covers, so dropping a limit by replacing its parent, or by a delta without it, counts too.

- removing an entry;
- a `replace` or `remove` whose `was` isn't the base map's value at its path (an earlier op moved an array's items, or
  the patch was made against another map), since then what it takes out isn't known;
- `safety`, `blocked` or `hazards`;
- what may be written: `allowed`, `writable`, `min`, `max`, `saturate`, `readOnly`, and `linked` sets, whose rules
  limit the values written together;
- what first contact may send and what verifies a write: `safeRead`, `readBack` (neither changes an entry's
  fingerprint, so only review catches them);
- the framing (`/transport` and `/addresses`), which every message depends on; a `measured/...` change in them is exempt
  only when both what it puts in and what it takes out are measured values (`{value, unit, measuredOn, date, source}`);
- any top-level section this engine doesn't know, since its risks can't be judged;
- `/session`, which is sent every time a port opens;
- `/modes`, which decides which entries each mode reads and writes through;
- a control's target: anything under `/controls` above an item, or an item's `type`, `cc`, `pc`, `nrpn`, `number`,
  `msb`, `lsb`, `channel` or `bits`, since a changed number retargets every write through it;
- anything new that writes to the unit: a value that makes a message's `dir` `send` where it wasn't, or a new
  control;
- text a model reads: `agentNotes`, which reaches the player's chat model, and `safety.notes`, which the sniffer's walk
  prints for the model driving the vendor editor.

A repair of the bytes a known send writes (its `cmd`, a layout's offsets, an enum's values) isn't on this list on
purpose: fixing those is what a seed patch is for. It reaches other players the way any unit's evidence does, through
the trust levels: verified on the owner's unit by read-back, then confirmed by a second unit or by review.

## Fingerprints

A fingerprint is the first 16 hex digits of the SHA-256 of a JSON value in RFC 8785 canonical form, the same form as
the app's map-check fingerprints, checked against the same vectors
([`test/fixtures/fingerprint/canonical-vectors.json`](../../test/fixtures/fingerprint/canonical-vectors.json)).
`base.file` and `was` fingerprint JSON as written in the file, so they work on a draft the engine can't load yet.
`entryFp` and `base.mapVersion` are the app's map-check forms, which read the map through the engine and so exist only
for a seed that loads; they move into this package with the engine.
