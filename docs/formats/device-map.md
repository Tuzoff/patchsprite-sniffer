# Device map: the protocol section

Status: in use by @patchsprite/engine (packages/engine)

A device map holds everything learnt about a device as data: framing, command codes, payload layouts, record
offsets, setting tables, file formats, enums, timing and the safety floor. Code keeps only generic engines that read
it (S4). This page describes the map's protocol section.

- Schema and codec: [`packages/engine/src/protocol-schema.ts`](../../packages/engine/src/protocol-schema.ts)
  (`ProtocolSchema`, `parseProtocol`, `DeviceMapSchema`, `parseDeviceMap`, `ProtocolCodec`). Where this page and the
  code differ, the code is right.
- Framing engines: [`packages/engine/src/framing.ts`](../../packages/engine/src/framing.ts); records in pieces:
  [`packages/engine/src/record-pieces.ts`](../../packages/engine/src/record-pieces.ts); fingerprints:
  [`packages/engine/src/map-fingerprint.ts`](../../packages/engine/src/map-fingerprint.ts).

A real device's map is private data. This repository holds the format and made-up examples only. Every example below
is a made-up device, `acme/fx-1`, under the non-commercial manufacturer id `7d`.

## Where it sits

One protocol per device, with per-firmware changes. The protocol is one JSON object per device (`protocol.json` in
the map's `<make>/<device>/` folder, beside the per-firmware model files). Protocols change less often than model
lists, so a firmware carries only what it changes (see [Versioning per firmware](#versioning-per-firmware)).

```jsonc
{
  "schema": 1,
  "driver": "param-change", // "patch-dump", "param-change" or "control-only"
  "transport": {...},       // framing, checksum, nibbles, chunking, compression, timing
  "messages":  {...},       // named messages: cmd, direction, payload layout, reply/ack pairing
  "layouts":   {...},       // shared record layouts: stored records, file formats, list replies
  "enums":     {...},       // named value tables
  "constants": {...},       // counts, first ids, sentinels, ranges
  "settings":  {...},       // device-wide setting groups and items
  "eq":        {...},       // global EQ parameters
  "blocked":   [...],       // messages never sent
  "addresses": {...},       // address offset tables (roland-address)
  "safety":    {...},       // rules checked before anything is sent
  "hazards":   {...},       // what the sources warn about: refused until a unit has verified the map
  "cautions":  [...],       // what the sources warn about that no single write names
  "display":   {...},       // how the device names things for the player
  "audio":     {...},       // audio facts measured on the device
  "host":      {...},       // how the computer finds the device
  "identity":  {...},       // what the unit answers to the MIDI identity request
  "parameters": {...},      // block parameter tables (param-change devices)
  "controls":  {...},       // MIDI channel messages (CC, PC, NRPN)
  "choices":   {...},       // encodings the docs disagree on, settled per unit
  "scratch":   {...},       // patch slots that may be used as scratch
  "modes":     {...},       // entries that live apart per mode of the unit
  "session":   {...},       // steps the unit needs when its port opens
  "firmwares": {...}        // per-firmware replacements and extra blocks
}
```

Unknown keys are refused anywhere in the section.

`parseProtocol(json)` validates it and throws one `ProtocolError` listing every problem. A map no real unit has
confirmed yet is a draft, `protocol.draft.json`, and loads in part (see [Draft maps](#draft-maps)). `new
ProtocolCodec(protocol, firmware)` resolves the protocol for the connected firmware, and the driver asks it for
everything by name.

## `driver`

How the device is driven, so code reads it rather than guessing from the framing:

- `"patch-dump"`: the unit hands over and takes a whole patch as one record that the map lays out. The Patchsprite app
  keeps a full copy, so it can build a patch, put any model in a slot and save the patch to the unit.
- `"param-change"`: the unit is addressed one message at a time: which preset and scene is on, each block's bypass
  and channel, one parameter per message. The Patchsprite app never holds or writes a whole preset. Scenes, block channels and
  the unit's own parameter list are optional, and a change may be a `send`, or answered by an acknowledgement only.
- `"control-only"`: the unit takes the MIDI channel messages its `controls` name (presets, scenes, footswitches,
  expression, parameters by CC or NRPN) and answers none of them; nothing is read back. See `controls`.

`parseProtocol` reads a map without `driver` as `"patch-dump"`. A map the sniffer builds must state it:
`DeviceMapSchema` and `parseDeviceMap` refuse one without it (S19). The old names `"patch"` and `"rig"` are refused
with the new name to use.

The param-change driver runs on any framing whose engine carries each message in one SysEx message (`messageFramer`
in `packages/engine/src/framing.ts`: `sysex-xor`, `sysex-plain` and `roland-address`). A param-change map on another
framing is refused when the framer is made.

## `transport`

`framing` selects one of the generic framing engines in code; the rest configures it (S4). Integers may be written
as JSON numbers or `"0x.."` strings. Byte strings are lowercase hex pairs separated by single spaces
(`"f0 7d 13 37"`). A header starts with `f0` and its other bytes are 7-bit.

### `"sysex-nibbles"` (`Framer`)

SysEx frames that carry the inner message split into nibbles.

| Key | Meaning |
|---|---|
| `frame.header` | opening bytes (`"f0 7d 13 37"`) |
| `frame.preamble` | fixed 7-bit bytes between the header and the frame fields |
| `frame.fields` | order of the `checksum`, `kind`, `total` and `offset` fields, each once |
| `frame.terminator` | `f7` |
| `frame.kinds` | frame kind byte per direction: `request`, `send`, optional `reply`, `notify` |
| `frame.checksum` | `{ "algo": "nibble-sum", "mask" }`: sum of the data nibbles, masked |
| `frame.nibbles` | `"hi-lo"` or `"lo-hi"`: the order of each byte's two nibbles |
| `frame.chunk` | inner-message bytes per frame; longer messages span frames, with `offset` advancing |
| `frame.lengthBits` | width of `total` and `offset`, 7 to 28 (sending refuses longer messages) |
| `inner.cmdLength` | bytes of a command code, 1 to 8 (every message's `cmd` is checked against it) |
| `inner.length` | `{ "type": "u16" \| "u32", "endian" }`: the payload length field after the cmd |
| `inner.compression` | `"none"` or `"lzo1x-literal"` (send as literal runs, decompress any LZO1X stream) |
| `endian` | default endianness of payload fields |
| `timing.frameGapMs` | pause between frames of a send |
| `timing.replyTimeoutMs`, `ackTimeoutMs` | default waits; a message's `reply.timeoutMs` / `ack.timeoutMs` overrides them |
| `timing.pauses` | named fixed pauses the driver takes between steps |
| `timing.measured`, `timing.compareToggle` | measured values (see [Measured values](#measured-values)) |

### `"sysex-xor"` (`XorFramer`)

One SysEx message per inner message, `header | cmd | payload | checksum | f7`, with no nibbles, chunks or length
field. Payload bytes are sent as they are, so they must be 7-bit: the map is refused when a field could carry a byte
with the high bit set, and fields wider than 7 bits use `septets`. Keys: `frame.header`, `frame.terminator`,
`frame.checksum` (`{ "algo": "xor", "mask", "verify" }`: the XOR of every byte from the header's `f0` to the last
payload byte, masked; `verify` refuses an incoming message whose checksum does not match), `inner.cmdLength`,
`endian` and `timing`, as above. A device whose model is a byte of every message puts it at the end of
`frame.header`.

### `"sysex-plain"` (`PlainFramer`)

One SysEx message per inner message with nothing added, `header | cmd | payload | f7`: no checksum, nibbles, chunks
or length field. Payload bytes are 7-bit, as for `sysex-xor`. Keys: `frame.header`, `frame.terminator`,
`inner.cmdLength`, `endian` and `timing`, plus:

- `inner.cmdLength` may be `{ "min", "max" }` (each 1 to 8) for a device whose cmds differ in length (`"0a"`,
  `"3c 01"`, `"3c 02 7f"`). An incoming message is read with the longest cmd of the map (`codec.knownCmds()`) that its
  bytes start with, or with `min` bytes when none fits. So no cmd may begin another under the same header, a
  placeholder matching any byte; the map is refused otherwise. Cmds of the same length may repeat. This also makes
  `blocked` exact: a blocked `"3c 02 7f"` blocks only itself. At most 64 templated cmds across the base and all
  firmwares.
- `frame.headers` (optional, at most 8): other headers, by name, that some messages use instead of the device's,
  such as the universal non-realtime `"f0 7e"` of the MIDI identity request and reply. A message picks one with
  `header`. No header (the device's included) may begin another.

### `"roland-address"` (`AddressFramer`)

Address-based SysEx, one message per inner message, `header | cmd | payload | checksum | f7`, where the cmd is a
command (one byte or more) followed by an address. Reads name an address and carry a size as their payload; writes
carry the data from that address on and are not acknowledged (a write is confirmed by reading it back). So every
`send` on this framing must say how it is checked: its `readBack`, or `"readBack": false` where the unit has no read
for it (see [`safeRead` and `readBack`](#saferead-and-readback)); a map that leaves it unsaid is refused at load,
except for a blocked send, which is never sent. A unit's parameter and patch addresses go in address fields (see
[Address fields](#address-fields)), not as consts baked into each message's cmd: an `addresses` table for areas that
don't sit a stride apart, a `stride` for a parameter or patch index, and a cmd that holds only the areas' base
address. Payload bytes are 7-bit; wide values use `septets` or `nibbles`. Keys:

- `frame.header`: `f0`, the manufacturer, the device ID and the model ID, as the host sends them.
- `frame.deviceIdAt` (optional, 1 to 15, inside the header): the header byte holding the device ID. The ID is set per
  unit, so the map's byte there is only a default (such as the broadcast `7f`): until the unit's own ID is known,
  that default is sent and any ID is heard. `AddressFramer.deviceIdOf` reads the ID from a message; the driver learns
  it from the unit's first answer to one of its own requests, never from other traffic, and `messageFramer`'s
  `deviceIdOf` gives nothing for the broadcast ID `7f`, which SysEx reserves for every unit (a broadcast request
  echoed back by a MIDI thru carries it). A map default that is a real ID reaches only a unit set to it, so a map
  should default to the broadcast unless the units it covers ship at that ID. The ID is kept outside the map, for the
  connection only; `new AddressFramer(transport, { deviceId })` then sends to that ID and hears only it. If a unit at
  another ID also answers that first request within the reply timeout (two units of the model on one port), the
  driver refuses every later message rather than drive whichever answered first. Omitted: incoming messages must
  carry the header as it is, and no ID can be set.
- `frame.identityDeviceId` (optional): `{ "source": {...} }`, citing where the vendor documents that the unit's MIDI
  identity reply (`f0 7e <id> 06 02 ...`) carries the same device ID as this header. It needs `deviceIdAt` and the
  map's [`identity`](#identity). Where no ID is kept yet and the unit does not answer at the map's default, the
  session connects once more at the reply's ID (never the broadcast `7f`, nor the default it already tried). The ID
  is taken only from a reply whose maker, family and model match the map's `identity`. The key is part of
  `transport`, which a draft can't do without, so in a draft too a key without a valid source refuses the whole map:
  a sniffer-made draft leaves it out unless it can cite the vendor's documentation. Learning the ID from the first
  answer still comes first, since it can tell two units apart and the identity reply can't.
- `frame.terminator`: `f7`.
- `frame.checksum`: `{ "algo": "roland-sum", "verify" }`. The checksum makes the address and payload bytes (not the
  header or command) sum to 0 modulo 128: `(128 - sum mod 128) & 7f`.
- `frame.maxData` (optional): the most data bytes one message carries; `encodePieces` sends a longer write in pieces
  at successive addresses.
- `inner.cmdLength` (2 to 8) and `inner.addressBytes` (1 to 7, fewer than `cmdLength`): how many of the cmd's last
  bytes are the address. An address is 7-bit digits, most significant first (`00 00 7f` + 1 is `00 01 00`).
- `endian` and `timing`, as above.

A unit may answer one read in several messages at successive addresses. `AddressFramer.reassembler(answerCmd, size)`
joins them in any order (a piece sent again must carry the same bytes); anything else, such as a change the unit
reports meanwhile, is left for its own handler. With a `step` (the map's `reply.pieces.step`: the size the unit
splits an answer into), a piece is only a message at an address that split puts one, and not shorter than that piece
(the last runs to the end of the read), so a change the unit reports inside the read's range is left alone too,
unless it starts where a piece would and is as long. Without one, any message of the command inside the range is a
piece. A dropped piece leaves the read unanswered; a piece running past the size is refused. At most 65536 bytes
(`MAX_RECORD`) are joined.

### `"midi-channel"` (no SysEx)

The unit takes only the channel messages in `controls`, so `messages` and `layouts` stay empty, there are no
`firmwares`, and `driver` must be `"control-only"`. Its keys are `endian` (default `"le"`, unused) and `timing`
(default all 0), whose `frameGapMs` is the pause between two channel messages. A unit that takes SysEx and channel
messages both keeps its SysEx framing and adds `controls`.

## `messages`

Each entry is keyed by a camelCase name, which is the only thing the driver knows a message by.

```json
"renamePreset": {
  "cmd": "21 {bank}",
  "dir": "send",
  "payload": { "fields": [ { "name": "preset", "type": "u16" }, { "name": "name", "type": "string", "length": 16 } ] },
  "ack": { "message": "ack", "cmdField": "cmd", "statusField": "status", "okStatus": 1, "idField": "id", "requestIdField": "preset" }
}
```

- **`cmd`**: the command bytes. A byte may be an `{arg}` placeholder filled per call, for families of commands built
  from arguments.
- **`dir`**: who sends it.

  | `dir` | Meaning |
  |---|---|
  | `request` | the host asks; the device answers |
  | `send` | the host writes |
  | `reply` | the device answers a request |
  | `notify` | the device speaks unasked |

  `encode` refuses `reply` and `notify` messages.
- **`payload`**: an inline layout, or the name of a shared one in `layouts`. Omit it when there is no payload.
- **A request and its reply may share a cmd.** `codec.messagesForCmd(bytes)` lists candidates for an incoming cmd,
  `reply` and `notify` first.
- **Messages that share a cmd are told apart by their payloads.** `codec.identify(cmd, payload, side)` names the
  messages from one side (`"device"`: replies and notifies; `"host"`: requests and sends) that a payload reads as, by
  their sizes, consts and `not`s: the one with more fixed cmd bytes first, then one whose layout the payload fills
  exactly, then one that pins more payload bytes, then by name (not the map's key order, which a canonical JSON round
  trip re-sorts). The map tells them apart with what it pins:
  - a byte only one of them has: a `const` in one, and a different `const` or a `not` of that value in the other.
    Only a whole-byte field pins a byte: a `not` on a `u8` or `i8`, a `const` on `bytes` or on a scalar other than
    `f32`. A `not` on a wider scalar, anything under `bits`, a checksum, a `choice` field and a byte two fields cover
    pin nothing, so separate messages with a `u8` at the byte that differs;
  - a length (`size`, `minSize`, `maxSize`);
  - a packed tail read with a `layout`: that layout's consts, as the packed bytes carry them whole (a nibble pair for
    each, or the low seven bits of an `8to7` data byte; a `not` there pins nothing), and its sizes, packed, which set
    the payload's length;
  - the side: a host's set and the device's reply may carry the same bytes;
  - the header (`sysex-plain`): a message under another `header` is never another's lookalike.

  `codec.lookalikes()` lists the pairs nothing pinned tells apart (on cmds that can be the same bytes, as their
  address fields move them). A lookalike is not a load error: a capture settles it.
- **"None" is a sentinel per field (`nullAs`), not a second message.** A command with an "off" form is one message
  whose fields take `null`.
- **`reply`** pairs a request with its answer:
  - `message`: the answering message; the default is the request itself.
  - `echo`: `[{ "reply": "id", "request": "preset" }]` (at most 16), fields whose wire values must match, before
    sentinels, scale or enums are applied.
  - `timeoutMs`.
  - `list`: `{ "start"?, "end", "maxItems", "maxBytes", "deadlineMs" }`, for a request answered by an optional `start`
    message, any number of `message` items, then the `end` message. Start and end must be `reply` or `notify`
    messages, each on a cmd that neither the item nor the other can produce. `maxItems` (at most 4096) caps the items,
    `maxBytes` (at most 1 MiB) their payload bytes together, and `deadlineMs` (at most 60000) bounds the whole list
    from the request; the reply timeout counts from the last message received. Items are matched to the request by
    `echo`, the start and end by cmd only. A refused list's remaining messages are swallowed until its end, a quiet
    timeout or the deadline.
  - `pieces`: `{ "offset", "size"?, "layout"?, "maxPiece"?, "deadlineMs"?, "step"? }`, for a request the device
    answers in several messages that are joined into one value before it is read. Not with `list`, only on a
    `request` whose reply is a message of its own, and only in a map whose `driver` is `param-change`. Each piece says
    where its bytes go:
    - `"offset": "address"` (`roland-address` only): the pieces are the reply's command at successive addresses, the
      first at the reply's own cmd. Each piece's payload is all data, and the joined value is read with the reply
      message's own layout, so `layout` is refused here. `step` (optional, by address only, at most `maxPiece`) says
      the unit splits the answer every that many bytes from the read's start, so a change it reports of its own inside
      the read's range is not taken for a piece. Set it only from a capture (a decoded capture shows the size of each
      joined answer's pieces): a unit that splits otherwise would never complete a read.
    - `"offset": { "field": "at" }` (any framing): each piece is the reply message, read with its layout (consts and
      `echo` included), with its byte offset in that field (one number); its bytes are the payload after the reply's
      layout. The reply's layout then has a fixed size (no `minSize`, `maxSize` or open string), and `layout` is
      required.

    A change the unit reports that starts where a piece would and is as long is still taken for that piece. When the
    real piece then disagrees with it, the driver drains the rest and asks the read once more (a write is never sent
    twice), failing only if the second answer disagrees too. Until the unit's own device ID is learned, the pieces of
    one answer all come from the ID of its first piece, so a second unit's pieces are never joined into the first
    one's answer.

    `size` is the joined value's bytes: `{ "request": "size" }` (a field of the request), `{ "constant": "recordSize" }`,
    or a number (1 to 65536); without it, the size of the layout the value is read with, which must then have one.
    `maxPiece` is the most bytes one piece carries. `deadlineMs` (at most and by default 60000) bounds the whole
    answer each time it is asked (a read asked once more may take up to twice that, with the drain between), while
    the reply timeout counts from the request to the first piece and from each piece to the next.
    Pieces may come in any order; a piece sent again must carry the same bytes; an empty piece, a piece past the
    size, or more than twice the size received in all fails the read. Nothing is ever read in part. After a failed
    read only its own pieces are swallowed, until the line is quiet for the reply timeout.

  `codec.acceptsReply(sent, bytes)` decodes the reply (sizes, consts, checksums) and compares the echoed fields with
  the sent payload, so a late answer to an earlier request is never taken for this one. A request without a `reply`
  rule is answered by the same message, unfiltered.
- **`ack`** pairs a send with an acknowledgement message: `message`, `timeoutMs`, `cmdField` (the ack field that
  echoes the cmd: `bytes` of the cmd's length), `statusField` and `okStatus`, and `idField` with `requestIdField`
  (both or neither: the ack's id, matched by wire value against a field of the sent message).
  `codec.readAck(sent, bytes)` returns `{ answers, ok, id?, status? }`.
- **`header`** (`sysex-plain` only): an entry of `transport.frame.headers` the message is sent and received under.
  `codec.messagesForCmd(cmd, header)` looks a cmd up under it.
- **`noChecksum`** (`sysex-xor` only): `true` on a `reply` or `notify` with a fixed cmd that the device sends without
  the frame checksum. The host always sends the checksum. Nothing else the device sends with a checksum may share
  such a cmd, and neither may a request answered on its own cmd; at most 64 such messages across the base and all
  firmwares. `codec.noChecksumCmds()` lists the cmds for the framer.
- **`poll`** (optional): `true` on a `request` or `send` with a fixed cmd that the vendor's editor sends on its own,
  all the time (a status poll, S13). The driver ignores it; an editor walk leaves it and the device's answer to it out
  of what counts as an action's traffic. Refused on a reply or notify, on a templated cmd, on any other message on
  the cmd of a poll or its answer, and on any message answered or acknowledged by a poll's answer. Each message, in
  the base and every firmware, is checked against the polls of all of them.
- **`safeRead`** and **`readBack`**: see [`safeRead` and `readBack`](#saferead-and-readback).
- **`source`** and **`note`**: see [`source`](#source).

### `safeRead` and `readBack`

First contact with a map no unit has confirmed goes through reads before writes
([`packages/engine/src/probe.ts`](../../packages/engine/src/probe.ts),
[`packages/engine/src/first-write.ts`](../../packages/engine/src/first-write.ts)).

- **`safeRead`** (optional): on a `request` with no side effect on the unit, which the read-only probe may send once.
  `true`, or `{ "fields": {...}, "args": {...} }` with the values to send it with: every payload field that has no
  `const`, `default` or `copyOf`, and every cmd placeholder. A map may write with a request (a set answered by its
  read-back), so `dir` alone never says a message is safe. Checked at load: a request, not acknowledged, and its
  values name only fields and placeholders it has.
- **`readBack`** (optional): on a write (a `send`, or a request that is not a `safeRead`), the `safeRead` request that
  reads back what it wrote. A name alone pairs fields by name, only fields that carry a value in both (never a const
  or checksum): the read's own payload fields the write also has are its inputs (its address: block, parameter), and
  the read's reply fields the write also has are compared. The long form
  `{ "request", "inputs": [{ "request", "send" }], "compare": [{ "reply", "send" }] }` names the pairs, each list
  replacing what the name alone would infer. Checked at load: the read is a `safeRead` with a fixed cmd and one reply
  (no list), the pairs name real fields, the write fills every field the read needs, something is compared, and the
  inputs and compared fields cover every value the write carries, so the echo write can rebuild it. Compared as
  decoded values. `"readBack": false` says the unit has no read for the write: only the player can confirm it lands,
  so its entry stays `unverifiable` until they do. On a `roland-address` transport every unblocked `send` must have
  one or the other.
- A driver that reads a parameter change back through `readBack` (in place of its own parameter read) needs the
  read's reply to carry the parameter id, compared in the pair or echoed as the read's parameter input; otherwise an
  answer about another parameter can't be told from the one asked for. The pair must also compare the value.
- Both keys say how to test an entry, not what the unit does, so no fingerprint covers them.

The first write to an unconfirmed map is proven by an echo: before the player's change goes out, the driver writes
back the value the paired read has just returned, so the sound does not change, and reads again. An unchanged
read-back proves the message and its framing. A write whose encoding depends on a choice this unit has not settled is
refused before the echo.

**Liveness.** A driver that needs a sign of life from a unit (to tell a freeze from a lost reply, say) asks a request
the map marks `safeRead` that takes no fields; where the map has none, it asks the MIDI identity request
(`f0 7e 7f 06 01 f7`). Neither changes anything on the unit.

### Field types

Every field has a `name`, a `type`, an optional `offset` and an optional `note` (free text the codec ignores).
Without an offset, a field starts right after the furthest byte any earlier field reaches.

| `type` | Extra keys |
|---|---|
| `u8` `i8` `u16` `i16` `u32` `i32` `f32` | `endian`, `const`, `not`, `default`, `copyOf`, `scale`, `bias`, `min`, `max`, `saturate`, `nullAs`, `enum`, `enumBy`, `allowed`, `checksum`, `septets`, `nibbles`, `bits`, `invert`, `choice`, `address` |
| `bytes` | `length`, `fill`, `const` (hex) |
| `string` | `length` (1 to 4096): latin1, NUL-padded, at most `length - 1` characters; `free`; `open` |
| `pad` | `length`, `fill`; written, never returned |

The scalar keys:

| Key | Meaning |
|---|---|
| `const` | always this raw value: written whatever the caller passes, and checked on decode. Must fit the type exactly |
| `not` | raw values the field never has (1 to 4096): `encode` refuses them, and `decode` refuses a payload that holds one, so it is not read as this message. Not with `const` or `checksum`, and never the field's own `nullAs` or `default` |
| `default` | written when the caller passes nothing; within `min`..`max`, and fits the type after scale and bias unless the field saturates |
| `copyOf` | written as the value given for another single scalar field of the layout when the caller passes nothing |
| `scale`, `bias` | the wire value is `round(value * scale + bias)`; `scale` is positive |
| `min`, `max` | the value range, checked before scale and bias; `min <= max` |
| `saturate` | clamp to `min`/`max` and the type's range instead of refusing |
| `nullAs` | the raw value that means "none": `null` encodes as it, and it decodes as `null` |
| `enum` | `encode` accepts the enum's keys as well as numbers, `decode` returns keys for known values; other values stay numbers |
| `enumBy` | `{ "field", "enums": { "<key>": "<enum>" } }`: the enum this field reads is chosen by another single field of the same payload or layout that reads an enum, one per key of that field's enum (each block's effect type numbered in a list of the block's own). The other field may be an address field. Where `enums` names none for its value, this field reads and takes numbers; a key the chosen enum lacks is refused on encode. Not with `enum`, not on a repeat or an address field, and not in a packed tail's layout. Parameter tables keyed by effect type still need the map's `type` enum, so a map with per-block type lists keys its tables by block. `codec.fieldEnum(name, field, values)` says which enum is in force |
| `allowed` | the only values `encode` writes: "only values known to be safe", made data |
| `checksum` | `{ "algo": "sum", "from", "to": "self" \| "end", "mask" }`, on an unsigned field that does not repeat. `"self"` sums from `from` up to the field; `"end"` from `from` to the end of the payload, and must not cover the field. Written after every other field, checked on decode |
| `septets` | 1 to 5: the value goes out as that many 7-bit bytes, least significant first, or most significant first when the field's own `endian` is `be` (the map's default endian never orders septets). Unsigned type, no checksum; decode refuses a byte with the high bit set |
| `nibbles` | 1 to 8: the value goes out as that many bytes of 4 bits each, ordered as for `septets`. Not with `septets`. Unsigned type, no checksum; decode refuses a byte above `0f` |
| `bits` | `{ "shift", "width" }`: only these bits of the element, `(raw >> shift) & (2^width - 1)`. Fields that share a byte name their bits at the same `offset`; encode writes only its own bits. Unsigned type, no checksum. With `septets` or `nibbles`, the bits count across the joined groups |
| `invert` | with `bits` only: the stored bits are the complement of the value. `const`, `nullAs`, `default`, `min` and `max` name the value before it is inverted |
| `choice` | the name of a protocol choice (see [`choices`](#choices)): the field takes the keys the option in force sets (today `endian`), so it sets no `endian` itself. A single scalar of two bytes or more, with no `repeat`, `bits` or `checksum` |
| `address` | `roland-address` only: `{ "stride" }` or `{ "table" }`, not both; the field takes no payload bytes and moves the message's address (see [Address fields](#address-fields)) |

An **open string** (`"open": true`) is a label the device ends with a NUL or the end of the payload: decode takes
the bytes up to the first NUL, and `length` still caps what is read. It is the payload's last field, does not repeat,
and has no `free`.

**Repeated groups.** `repeat: { "dims": [2, 3], "strides": [20, 4] }` (1 to 4 dimensions, at most 65536 elements)
makes a field nested arrays, row-major. Strides may exceed the data, for gaps between groups; by default the data is
packed.

`encode` refuses a value name the layout does not have, arrays of the wrong shape at every level, values out of
range, and missing values that have no default. A one-dimensional list shorter than its count is filled with the
field's `default`, if it has one. `decode` checks sizes, consts, `not`s and checksums.

**Overlay.** `codec.encodeLayout(name, values, base)`, and `codec.encode(name, values, args, base)` for a message, copy
`base` and rewrite only the fields passed (plus checksums and consts). Every other byte stays as it was.

### Address fields

On a `roland-address` transport, a scalar of a message's own payload (not a shared layout) with
`"address": { "table": "<name>" }` or `"address": { "stride": "<digits>" }` takes no payload bytes: its value moves
the message's address. `stride` adds the wire value times that many address units (7-bit digits, most significant
first: `"01 00"` is 128; a stride of 0 is refused); `table` adds the offset the top-level `addresses` table of that
name gives the field's enum key, for areas that do not sit a stride apart (where each block's parameters start).
`addresses` holds at most 64 tables, each enum key to an offset of at most 7 digits. Several address fields add up,
so a block's parameter is `{ block: table }` plus `{ param: stride "01" }` on a cmd that holds the areas' base
address:

```json
"addresses": { "blockAreas": { "drive": "00 00", "delay": "01 00", "reverb": "02 00" } },
"setParam": { "cmd": "32 01 00 00", "dir": "send", "readBack": "getParam", "payload": { "fields": [
  { "name": "block", "type": "u8", "enum": "block", "address": { "table": "blockAreas" } },
  { "name": "param", "type": "u8", "min": 0, "max": 63, "address": { "stride": "01" } },
  { "name": "value", "type": "u16", "nibbles": 4, "endian": "be" } ] } }
```

- A field keeps its `enum`, `min`, `max`, `allowed`, `default`, `const`, `scale` and `bias`, so no address outside
  them is sent; a key the table has no entry for is refused before anything is sent.
- An address field is an unsigned integer with none of `offset`, `repeat`, `bits`, `invert`, `septets`, `nibbles`,
  `checksum`, `choice`, `nullAs`, `copyOf` or `saturate` (a clamped value would go to an address the caller never
  named), on a message with a fixed cmd (no `{arg}` placeholders); table keys must be keys of the field's enum. A
  list's start and end take none: they are heard at their fixed cmd.
- A reply to a request with address fields carries the same ones, and no others, each with the request's type,
  `address`, `enum`, `scale` and `bias`: its address moves with the request's (`codec.replyCmd(sent)`), and they read
  as the request's, so `echo` may name them. `encode` puts their wire values on `Encoded.address`;
  `codec.cmdFor(name, values)` gives the moved cmd; `decode(name, payload, cmd)` and `messagesForCmd(cmd)` read them
  back from an address, which only one set of values may reach.
- Checked at load: no address field can move a message past its last address digit; areas never run into each other,
  so that two sets of values could reach one address (each field's smallest step between its own offsets must be
  wider than all the fields with smaller steps can spread, so a parameter range that runs into the next block's area,
  or two table keys at one offset, is refused); and no send or request can be moved onto a blocked message's bytes
  with the same command, comparing any address it can reach, with its write's span, against the blocked message's
  span (its whole area where it has address fields itself). An `{arg}` digit in either cmd counts as every digit from
  `00` to `7f`. A search that cannot settle that within its step budget is refused too, asking for `min` and `max` on
  the fields.

## `layouts`

Shared named layouts, with these keys besides `fields`:

- `size`: encode pads to it.
- `minSize`: decode accepts a payload this long or longer.
- `maxSize`: decode refuses anything longer, so a record of another length is refused rather than read with stale
  offsets.
- `eightBit`: `true` on an 8-bit record that never goes on the wire as it is (a file format, or a record a device only
  ever sends packed). It is left out of the 7-bit check, and a message that names it as its payload is refused.
- `packed`: packed data after the fields (below).

The layouts a map typically holds:

- **Stored records** (a patch): named offsets and repeated groups, such as per block, per scene, block and parameter,
  and per controller. `codec.offset("preset", "levels", row, column)` gives a byte offset.
- **File formats**: an id, a name, data and a checksum. Moving a file to another slot is an overlay of its bytes with a
  new id: every other byte is kept, and the checksum is recomputed.
- **List replies**: fixed entries of names, where an entry of all `free` bytes is a free slot (`null`).

### Packed data

Some devices send 8-bit data inside SysEx by packing it 8-to-7: each group of up to 7 data bytes is preceded by one
byte holding their top bits. Others send it as nibble pairs. A layout's `packed` tail is that data, after the layout's
fields and up to the end of the payload. Its value is the unpacked bytes, or, with `layout`, the fields that layout
reads from them.

```json
"payload": {
  "fields": [{ "name": "slot", "type": "u8" }, { "name": "length", "type": "u16", "septets": 2 }],
  "packed": { "name": "patch", "packing": "8to7", "topBits": "first-in-bit6", "lengthField": "length",
              "maxLength": 1000, "crc": { "algo": "crc32", "finalXor": true } }
}
```

| Key | Meaning |
|---|---|
| `name` | the value's name; no field of the layout may have it. With `layout`, it only names the tail in errors |
| `packing` | `"8to7"`, `"nibbles-hi-lo"` or `"nibbles-lo-hi"` |
| `topBits` | required with `8to7`, refused with a nibble packing: `"first-in-bit6"` (then bit 5 for the second, down to bit 0) or `"first-in-bit0"` (then bit 1, up to bit 6) |
| `lengthField` | optional: a plain unsigned field of the layout that holds the unpacked byte count and can hold `maxLength`. Encode writes it; decode refuses a payload whose packed bytes are not exactly that count packed. Omitted: the packed bytes run to the CRC, or to the end |
| `maxLength` | the most unpacked bytes encode or decode accepts; decode checks it before unpacking |
| `crc` | optional: `{ "algo": "crc32", "finalXor" }`, after the packed bytes. CRC-32 (reflected, polynomial edb88320, initial value ffffffff) of the unpacked bytes, with or without the final XOR, sent as 5 septets least significant first. Decode refuses a mismatch |
| `layout` | optional: a shared layout, with no packed tail of its own and no `choice` field, that reads the unpacked bytes (it must fit `maxLength`). Its fields join the layout's own by name, and may use all 8 bits. A `checksum` inside it covers the unpacked bytes |
| `pieces` | optional, not with `layout`: the tail is one piece of a record that comes in several messages (below) |
| `note` | optional free text |

A layout with packed data has no `minSize`, `maxSize`, open string or checksum to the end, and no fixed size
(`codec.size` refuses it). With `base`, the overlay covers the fields only, except for a tail read with a `layout`,
whose fields not passed keep their bytes. A device that wants the data padded to a fixed size before it is packed has
the caller pad it.

A device that sends a few bytes as they are and the rest as nibbles puts the raw bytes in the layout's fields and the
rest in a nibble tail read with a layout:

```json
"payload": {
  "fields": [{ "name": "block", "type": "u8", "max": 9 }],
  "packed": { "name": "param", "packing": "nibbles-lo-hi", "maxLength": 4, "layout": "param" }
}
```

### Records in pieces

A device that sends a whole record as several messages, each with an offset and a packed tail, and no total or end
message, states each piece message's tail as a piece of the record:

```json
"recordPiece": { "cmd": "30", "dir": "reply", "payload": {
  "fields": [{ "name": "slot", "type": "u8", "max": 99 }, { "name": "at", "type": "u16", "septets": 2 }],
  "packed": { "name": "data", "packing": "nibbles-hi-lo", "maxLength": 100, "pieces": { "offset": { "field": "at" }, "layout": "preset" } } } }
```

- `pieces` has one shape (`PiecesSchema`), shared with a request's `reply.pieces`. On a tail, only
  `offset: { "field" }` and a required `layout` are allowed; `size`, `maxPiece`, `deadlineMs` and `"address"` are a
  reply's only. The offset field is a plain unsigned field that can hold the last piece's offset, and is not the
  `lengthField`. The record layout has one fixed size (no `minSize` or open string, a `maxSize` equal to its size),
  at most 65536 bytes, no packed tail and no `choice`; its fields may use all 8 bits.
- One piece: `codec.pieceOf(message, payload)` gives `{ offset, bytes, key }`, `key` being its other fields.
  `codec.pieceSpec(message)` gives the tail, the record's layout and size, and the offset field.
- Reading: `new RecordJoiner(codec, "recordPiece", expect?)` takes pieces in any order and returns the record's fields
  once every byte has come. A piece belongs to the record when its key has the values in `expect`, otherwise the
  first piece's. A piece past the record, a piece that repeats bytes with other values, and a record sent again and
  again without completing (more than twice its size) are refused. `ByteJoiner(size)` is the map-free part.
- Writing: `recordPieces(codec, "writePiece", record, fields)` cuts the encoded record into pieces of the tail's
  `maxLength`, each with its offset and the same `fields`. Every piece is encoded before any is returned, so a refusal
  sends nothing.

## `settings` and `eq`

Device-wide settings keep a table shape, because each row carries more than a byte layout.

- `settings.groups`: group id to the message that reads it and its cmd arguments.
- `settings.items[]`:

  | Key | Meaning |
  |---|---|
  | `id`, `label`, `group` | identity and the group it lives in |
  | `read` | `{ offset, type }`: where the value sits in the group read-back |
  | `write` | `{ message, args }`: a message with a field named `value`, and the cmd arguments it needs |
  | `options` | value to name, for the values known |
  | `writable` | values known to be safe, the only ones written |
  | `readOnly` | shown, never written |
  | `channel` | `{ first, count }`: a MIDI channel setting, the `count` raw values from `first` being channels 1..count |

- `eq`: the settings group, the power switch (write message and read position), and the parameter rule (written by a
  message with fields `param` and `value`, read at `base + stride * p`). It also holds the bands (`on`, `freq`, `q`,
  optional `gain` parameter numbers), the level parameter and the accepted ranges.

The map gives values and option names. How a value without an option is shown (units, channel numbering) stays in
code.

## `enums` and `constants`

- `enums`: named key-to-number tables (footswitch functions, input sources and the like). Keys are snake_case,
  because they are shown to the player. A firmware entry may replace one whole (see
  [Versioning per firmware](#versioning-per-firmware)).
- `constants`: named numbers: counts, first ids, sentinels, ranges (`codec.constant("presetCount")`).
  `referenceScene` (0-based) is the scene a loaded patch starts in and that never-used scenes are filled from; builds
  put models there, so it must be one of the scenes model changes are allowed in, on every firmware.

A unit may store its never-used scenes as copies of the reference scene, so a patch read back can differ from the
bytes written in those scenes only. A read-back check therefore compares content (the decoded values of the scenes
in use), never a hash of the bytes.

## `safety`

The safety floor: rules the driver checks before anything is sent, whatever the caller asks. Each rule carries the
reason the player is told when it refuses.

- `modelChange`: `{ scenes, reason }`. A block's model may change only in these scenes (0-based).
- `haltingModels`: `{ typeShift, types, reason }`. A model whose type (its code shifted right by `typeShift`) is in
  `types` is never assigned. The model map's known-bad types add to these.
- `notes` (optional): up to 16 short texts (200 characters each, with a printing character) on how the device behaves
  that anyone driving it by hand must know. No code parses them and the driver checks none of them; an editor walk
  prints them at start. A note that should become a guard moves to a structured rule here.

The code keeps only the engine (`packages/engine/src/safety.ts`). A firmware entry may make the floor stricter, never
looser: its `safety` has only `modelChangeScenes`, a subset of the base scenes, and `haltingTypes`, which add to the
base types. No key removes a rule, and a firmware `safety` without a base `safety` is refused.

## `hazards` and `cautions`

`hazards` holds what the map's sources warn crashed a unit or hurt someone's ears, by the entry names map checks use,
each with why:

```json
"hazards": { "param/drive/7": { "why": "source comment: causes loud feedback", "values": [5] } }
```

With `values` (1 to 256 raw values or keys), only writes of those values are hazards; without, every write to the
entry. While no unit has verified the map on its firmware (a draft, or a confirmed map that lists no check of that
firmware), those writes are refused before anything is sent (`gateWrite` and `mapHazards` in
[`packages/engine/src/first-write.ts`](../../packages/engine/src/first-write.ts)). Entry ids are the map-check names,
which the [seed-patch format](seed-patch.md) shares: a bare message name (`setParam`), `<message>/<block>`,
`param/<block>/<id>`, and any other id the seed-patch format defines (`control/<name>`). The gate checks a write's
message and the entry it changes; a hazard on an id no driver writes yet waits for the driver that does.

`cautions` holds what the sources warn about that no single write names (a timing rule, a mode, how a save must be
sent): `[{ "why": "...", "about"?: ["<entry>", ...] }]`, at most 256. While the map is a draft the player is told;
code never enforces a caution. One that code can enforce becomes data instead: a pause in `transport.timing`, a
hazard on an entry.

Both are about the map as a whole, like `source`: no entry's fingerprint covers them.

## `display`

How the device names things for the player:

- `deviceName`: letters, digits, spaces and `. , ! ' & + ( ) / _ - ® ™`, and `:` only between two non-spaces
  (`FX-1:Mini`, never `Acme: do this`), starting with a letter or digit, at most 64 characters. It reaches the chat
  model, and a seed or community map may come from anyone, so it can carry no line break, markup or punctuation that
  would make it read as more than a name. Where it goes into instructions it is quoted, as a name, never an
  instruction;
- `patchLabel`: `{ pattern, bankSize, firstBank?, firstSlot?, firstIndex? }`. The pattern uses `{bank}`, `{slot}` and
  `{index}`, each optionally zero-padded (`{index:3}`). `LabelFormat` (`packages/engine/src/labels.ts`) formats and
  parses with it;
- `rows`: how many rows the block slots are laid out in on the device's screen;
- `emptyPatchName`;
- `defaultSceneName` and `sceneLabel`, each with `{n}` for the scene number from 1 (`"Scene {n}"`);
- `channelNames`: one character per channel in order (`"XY"`, `"ABCD"`), letters or digits, no two the same ignoring
  case. The default is A, B, C, ...

`rows` and `emptyPatchName` are needed on a patch-dump device. `defaultSceneName` and `sceneLabel` are needed on a
device with scenes (a patch-dump map, or one with a `scenes` constant in the base or any firmware).

### Text a map may hold

Text in a map reaches the chat (names in answers, notes, reasons, refusals), and a map can come from anyone, so it is
checked at load ([`packages/engine/src/map-text.ts`](../../packages/engine/src/map-text.ts)). Every name or label
(block, parameter and option names, setting and band labels, scene names, the `sourceNames`, vendor apps, scratch
slots, a control's `label` and `where`) is one line. Every note, reason, `why` or source reference may break lines.
None may hold a control character, an invisible or zero-width one, a line or paragraph separator, a direction
override, a Unicode tag character, a variation selector, a blank filler or any other default-ignorable code point,
which would show the model text the player can't see. The identity's `source`, `firmwareSource` and `note`, and a
draft's `why`s, are checked the same way.

## `parameters`

For devices that read and set block parameters one by one. Optional.

- `knobMax`: the raw value of a knob or slider at full travel. The device's own labels say what a position shows.
- `groups`: keyed by a group name, each `{ blocks, params, linked? }` or `{ types, params, linked? }`. `blocks` are
  keys of the `block` enum that share one table. `types` are keys of the `type` enum (effect types) that share one, on a device whose
  slots can each hold any effect: a slot's table is then the one of the effect type in it. A block's own table wins
  over its type's. `params` is keyed by the name the player uses, each
  `{ id, kind, options?, min?, max?, step?, default?, source?, note? }`. `kind` is `knob` or `slider` (a position
  0..`knobMax`, or 0..`max`), `select` or `switch` (one of `options`, keyed by the number the device takes; a `select`
  without `options` is set by number), or `range` (`min`..`max` in steps of `step`). `default` is the raw value the
  device gives the parameter when the effect is put in.

A parameter the device lists but no table names is still read and set by its id. Checked at load: every group has
`blocks` or `types`, not both; each block or type is a key of its enum (which the map must then have; a key some
firmware's replacement of the enum has counts, see [Versioning per firmware](#versioning-per-firmware)), in one group
only, and no key is both; ids are unique within a group; `min <= max`; a `range` has both; a `switch` has `options`;
only a `select` or `switch` has `options`; a knob's or slider's own `max` is within 1..`knobMax`; a `default` is one
of the options or within the range. Caps: 256 groups, 1024 parameters per group, 1024 options per parameter, ids up to
16383, and 16384 parameters and 65536 options across the whole table, counted before it is parsed.

### Linked parameters

`linked` (optional, per group): parameters the device checks together, keyed by a set name, each
`{ params, commit, rules?, note? }`. `params` names parameters of the group's table in the order the device takes
them. `commit` says how the device takes a write to one of them:

- `"last"`: it holds each write pending until the set's last parameter is written, then applies them all if they keep
  its rules, and keeps the old values otherwise (a read of a pending parameter returns the value from before). The
  driver writes every parameter of the set, in the set's order, so the last one commits them, then reads them back.
- `"each"`: it applies each write at once and refuses one that breaks a rule. The driver writes only the parameters
  that change, each once, in an order that keeps the rules after every write (for an ascending pair moving up, the
  upper one first). A change no such order reaches, such as a swap within a distinct set, is refused before anything
  is sent.

`rules` are what the device checks, over the whole set or over `params`, a run of it in the set's order:
`{ "kind": "ascending", "strict"? }` (each raw value at or below the next, or below it with `strict`: a min and max
pair) and `{ "kind": "distinct", "repeatable"? }` (no raw value twice, except the `repeatable` ones: an order of
effects where a split may repeat). A set with no rules is only written together. A change that breaks a rule is
refused before anything is sent, in the player's words ("Low (25) must stay below High (20)").

Each set is a map-check entry, `linked/<owner>/<set>`: confirmed when a `"last"` set reads back as written,
contradicted when it moves off what it held and holds otherwise than asked although the rules allow the new values.
Checked at load: every name in `params` is a parameter of the table and in one set only; a rule's `params` are a run
of the set's in its order; a `repeatable` value is one the rule's parameters can take; and, on a map with `modes`, no
group a mode stands in for, or that stands in for one, has linked sets. Caps: 64 sets per group, 2 to 256 parameters
per set, 16 rules per set. [`packages/engine/src/linked-params.ts`](../../packages/engine/src/linked-params.ts) plans
the writes; no device fact lives in code.

The enums `blockChannels` (a block's channel count when the block list does not carry it) and `noBypass` (blocks that
are always on) are read by the param-change driver where a map has them; their keys must be keys of the `block` enum.

## `choices`

Where the docs disagree on how a field is encoded, the map says so instead of guessing, and the unit settles it:

```jsonc
"choices": {
  "presetOrder": {
    "what": "how this unit numbers presets",          // for the player
    "readBy": "getPreset",                            // optional: a read whose reply can settle it
    "settle": "Switch to any preset on the unit itself, then ask again.",
    "options": { "msbFirst": { "endian": "be" }, "lsbFirst": { "endian": "le" } }
  }
}
```

- A value the unit reports on a field that names the choice is read every way the options allow. A way that reads it
  outside the field's `min`..`max` (or as no key of its `enum`) is ruled out; when one option is left, the choice is
  settled for that unit and firmware. A read-back of what the host itself sent never settles a byte-order choice.
- Until then, a message whose bytes differ between the options is not sent. With a `readBy`, the driver first reads
  it. A message whose bytes are the same under every option goes out.
- Every answer is read every way, settled or not. An answer that rules out the settled option while another fits
  reopens it; an answer no option reads is a contradiction, and two in a row turn the choice suspect until the map is
  fixed.
- Checked at load: two to four options, at most 16 choices, at most two in one layout. Some field naming the choice
  sits in a reply or notify and has a range or an enum. A `readBy` is a request whose reply carries such a field.

Which option a unit has settled on is kept by the Patchsprite app, not in the map.

## `source`

A message, a parameter or a choice may say where its claim comes from. Optional.

```jsonc
"getScene": { "cmd": "4e", "dir": "request", "source": { "kind": "doc", "ref": "Owner's manual p. 12" } }
```

- `kind`, ranked weakest first: `doc` (vendor or third-party docs, unconfirmed on a unit), `player-confirmed` (a
  player saw a write the unit cannot read back take effect), `wire` (seen in a capture of the vendor's editor),
  `device-reported` (a list the unit itself reports, such as a block's parameters; S17), `read-back` (a change read
  back on a unit), `replay-verified` (replayed and the unit did it); and `test`, for test maps only, never in a patch.
  These are the [seed-patch format](seed-patch.md)'s words; its Sources section says how applying a patch sets and
  raises an entry's `source`.
- `ref` (optional, 1 to 512 characters): what it was read from, such as a document and page, or a capture or action
  id. No other key.

Only messages, parameters and choices carry it, because only they are entries a unit checks, and
`transport.frame.identityDeviceId`, whose `source` takes these same kinds (not the identity's own, see
[`identity`](#identity)). A layout, enum or
constant is vouched for by the entries that use it. How far one unit trusts an entry is kept outside the map.
`source` and `note` are left out of fingerprints (see [Fingerprints](#fingerprints)).

A measured value's `source` (see [Measured values](#measured-values)) is a different thing: how a number was measured.

## `audio`

Audio facts measured on the device:

- `volumeLaw`: `{ kind: "amplitude", unity, min, max, quietest, calibrated, calibratedOn?, toleranceDb?, evidence? }`.
  `amplitude` is dB = 20 log10(v / unity); `quietest` is the lowest volume that is not muted. The schema refuses a law
  without `min <= quietest <= max` and `min < max`. `calibratedOn` says what it was calibrated on, `toleranceDb` how
  far the measurements sit from the law, and `evidence` (at most 64) the measured `{ volume, lufs }` pairs.
- `reamp`: the audio endpoint name (or part of it), sample rate and channel count (`endpoint`, `sampleRate`,
  `channels`); `send`, the USB output a reamp sends the DI on (an output from 3 to `channels`); `inputs`, the USB
  inputs it records (needing `wet` and `di`, each within `channels`); the send gain (`gainDb`); the lowest latency
  confidence that is trusted (`minLatencyConfidence`, 0 to 1); the chain input sources for a reamp and for live
  playing (`source`, `liveSource`: keys of the `inputSource` enum) with the names the player reads
  for them (`sourceNames`).
  - `overhead` (optional): what one reamp takes on top of its audio, a measured value in `s`.
  - `bypassOutputs` (optional): the USB outputs (numbered from 1) that join the device's outputs after its effects
    chain, like an AUX input, where audio plays clean through the device. One or two outputs, each listed once, never
    the `send` output (which feeds the chain), and each within `channels`; the schema refuses a map that breaks any of
    these. A MIDI walk can't observe it, so it comes from the device's docs or from the player, and a map built by an
    editor walk leaves it out. Without it, playing through the device past its chain is refused; no output is ever
    guessed. The numbers are channels of the playback endpoint (`audio.reamp.endpoint`), counted the way the
    interface lists them. An app may rely on this field for ordinary playback too (where it names both 1 and 2, the
    pair every OS plays a stereo file on, the computer's default device may be the unit itself), so a wrong value is
    not harmless: it would play audio back through the patch.

A capture whose rate or channel count is not the map's is refused.

## `host`

How the computer finds the device:

- `midiPort`: the MIDI port's name, or part of it;
- `usb`: `{ vid, pid }`, 4 uppercase hex digits each;
- `vendorApps`: up to 16 `[process name prefix, name to show]` pairs, the device's own apps that may hold its port;
- `editor` (optional): the vendor's editor, for editor walks: `exe`, its executable's file name (printable ASCII, no
  folder), and `attachDelay` (optional), how long to wait after the editor starts before attaching to it, a measured
  value in `s`.

## `identity`

What the unit answers to the MIDI universal identity request (`f0 7e 7f 06 01 f7`; reply
`f0 7e <id> 06 02 <maker> <family> <model> <version> f7`). Optional; when a map states it, it is checked before
anything else is sent to the unit ([`packages/engine/src/identity.ts`](../../packages/engine/src/identity.ts)).

```jsonc
"identity": {
  "manufacturer": "7d",                                    // 1 byte (not 00, 7e or 7f), or 3 starting with 00
  "family": "01 00",                                       // 2 bytes, as the unit sends them (low byte first)
  "model": "02 00",                                        // optional: left out when the family alone names the unit
  "firmware": { "major": [1], "minor": [2] },              // optional: how the version bytes give the firmware
  "source": { "kind": "capture", "ref": "fx-1 capture 1" }, // where the bytes come from
  "firmwareSource": { "kind": "capture", "ref": "..." },   // where `firmware` comes from, with `firmware` only
  "note": "..."
}
```

All bytes are 7-bit lowercase hex pairs. The reply's version bytes are never matched: their meaning is the maker's.

- **Firmware from the reply** (`firmware`, optional). Where a source says how the 4 version bytes carry the
  firmware, `{ "major": [i], "minor": [j] }` names the version bytes (0 to 3, one or two each, never the same byte in
  both) holding each number, read most significant first at 7 bits a byte, giving "major.minor" with the minor
  zero-padded to 2 digits (`00 01 02 00` with major [1] and minor [2] is "1.02"); `"ascii"` is for bytes that spell
  it (`31 2e 32 30` is "1.20", kept as spelled). Firmware keys and ranges compare each dotted part as a number, so
  "1.2" is not "1.20": a map whose unit spells its version writes its `firmwares` keys the way the unit spells them.
  A firmware read message of the map's own wins where the driver has one (a disagreement between the two is logged
  in the map checks against the identity); the identity reply stands in where it has none. Left out where the bytes'
  meaning isn't known: the unit is then on an unknown firmware.
- **Source** (`source`, and `firmwareSource` for `firmware`). `{ kind, ref }`, `kind` strongest first: `capture` (a
  reply from a real unit), `device-reported` (a mismatch reply a player's unit gave, sent in), `vendor-doc` (the
  maker's documents), `community-table` (a table other people compiled). `ref` (1 to 512 characters) names the
  capture, report, document or table. A guess, or bytes carried over from a sibling model, is none of these and never
  goes in a map. These are the identity's own kinds, apart from an entry's [`source`](#source). A confirmed map
  (`protocol.json`) whose `identity` has no `source`, or has `firmware` with no `firmwareSource`, does not load; a
  draft's loads without them, unchecked until a unit answers. Where nobody has seen a unit give the map's bytes (a
  `community-table` source, or a draft's with none), the identity is unconfirmed.
- **Session check.** On opening the unit's port, a session sends the identity request before anything else and waits
  for the reply, at least 1 s or the map's `replyTimeoutMs` when longer. A reply that differs, or none, refuses the
  connection, and nothing else is sent. There is no "warn only" mode. A map with no `identity` is opened without the
  check (many channel-only units don't answer the request).
- **Evidence.** The answer is a map check on the entry `identity`: a match confirms it; a mismatch is logged as
  `disagrees` with the map's bytes as `claimed` and the unit's answer as `observed`, and marks nothing, since another
  unit on the port says nothing against the map.
- **Device choice.** Where port names can't pick a map, an app may ask the unit who it is and pick the map whose
  `identity` fits. Two maps that state the same maker, family and model can't be told apart this way.

## `session` (on-connect steps)

For a unit that needs its host to send something when the port opens, before it answers or before it takes edits (an
edit mode, a handshake). Optional; the param-change and control-only drivers run it.

- `onConnect`: 1 to 16 steps, run in order each time the port opens (and again after the unit went silent or was
  unplugged), before the firmware is read. Each step is `{ message?, values?, pauseMs?, note? }`: the message is sent
  with `values` for its payload fields (a request's reply, or its list, is waited for), then the step pauses for
  `pauseMs` (at most 10000). A step sends a message, pauses, or both; `values` go only with a message. All pauses
  together are at most 30000 ms.
- The steps use the base map's messages: they go out before the firmware is known, so a firmware's own definitions do
  not apply to them.
- A request the unit leaves unanswered fails the connection as a silent unit does.
- So every step must be safe to repeat: the steps go out again on every open, a replug or a retry after silence
  included. A handshake the unit accepts only once doesn't fit here.
- On a control-only map the steps run too, before the first control or preset goes out. Such a unit answers nothing,
  so a step only sends: a request as a step is refused at load, and so is a message step on a `sysex-nibbles`
  transport, whose frames that driver doesn't build. On a `midi-channel` transport, which carries no SysEx, a step is
  only a pause. A step whose values don't encode refuses the connection before anything is sent.

Checked at load: each message is one the map has, a `request` or `send`, neither blocked nor redefined (nor its named
layout) on any firmware, nor blocked in the base map; each `values` key is a field of its payload; and no payload field
names a choice (settling it would ask the unit, which answers nothing until the steps have gone out).

## `modes`

Some units keep their patches and settings at other addresses depending on a mode set at the unit (set up for one
instrument or another, say), each with its own system area, edit buffer and layouts. The map says how the mode is
read and, per mode, which of its entries stand in for the names the driver asks for
([`packages/engine/src/modes.ts`](../../packages/engine/src/modes.ts)):

```jsonc
"modes": {
  "read": { "message": "getMode", "field": "mode" },   // a request; its reply's field reads an enum whose keys are the modes
  "use": {
    "alt": {                                           // a key of that enum; a mode not listed uses the map's own entries
      "messages":  { "getPreset": "getPresetAlt", "setPreset": "setPresetAlt", "tuner": null },
      "layouts":   { "blockStatus": "blockStatusAlt" },
      "enums":     { "block": "blockAlt" },
      "constants": { "presetCount": "presetCountAlt" },
      "groups":    { "drive": "drive_alt" }
    }
  },
  "note": "..."
}
```

- `ProtocolCodec(protocol, firmware, checks, mode)` reads every name through the mode: a name the mode lists reads as
  its stand-in (the firmware's delta applied first), and one it maps to `null` is gone (the driver's optional feature
  is then off in that mode; a required one makes the map refused, naming the mode). A name standing in for a blocked
  message is blocked in that mode.
- Parameter groups are found by the blocks and types they list, so a group that stands in for another in some mode
  is left out of every mode's view but through the name it stands in for; a map read without a mode keeps to its own
  groups.
- A driver reads the mode before it acts, so a mode switched at the unit is followed before anything is sent, and
  forgets edits and undo made in the old mode. A mode read that fails (no answer, a reply that fits none of the map's
  reads) says nothing about the mode. A value the mode enum does not name is refused, and nothing is sent until the
  unit is back in a mode the map knows.
- Map checks: in a mode, what the unit confirms or contradicts is filed under the entry the mode uses (`getPresetAlt`,
  `param/<owner>/<id>/<group>` for a stand-in group's parameter); in a mode that stands in layouts or enums, message
  entries are tagged with the mode (`getPreset@alt`), so one mode's answers never mark another's.
- Checked at load: the read is a request whose reply carries the field, reading an enum (inline or in a named
  layout); each mode listed is a key of that enum, at most 16; a stand-in and the name it stands in for are both the
  map's own entries of that kind, a message stands in only for one in the same direction, nothing stands in for
  itself, and no name both stands in and is stood in for. The read, its reply and the mode enum are the same in every
  mode (they are read before the mode is known), and so are the `session.onConnect` steps' messages, what answers
  them, their layouts and the enums those read. The read is never blocked, and a block on the
  map's own message holds in every mode, even one that stands an unblocked entry in for it. Each mode's parameter
  groups give a block or type one table and list keys of that mode's enums.
- A mode is device data like everything else: no mode name, address or count is in code.

## `controls` (channel messages)

MIDI channel messages, which need no framing engine: Control Change, Program Change with Bank Select, and NRPN. They
are fire-and-forget. The engine is `ChannelCodec` in `packages/engine/src/channel-messages.ts`. Any map may have
`controls`: a `"control-only"` map is driven by them alone, and a SysEx map can carry them too.

```jsonc
"controls": {
  "channel": { "default": 1, "omni": true, "where": "Settings > MIDI > Channel" },
  "items": {
    "sceneSelect": { "type": "cc", "cc": 20, "label": "Scene", "group": "scene", "enum": "scene" },
    "footswitch1": { "type": "cc", "cc": 21, "label": "Footswitch 1", "group": "stomp", "press": { "value": 127, "release": 0 } },
    "drive":       { "type": "nrpn", "msb": 1, "lsb": 2, "bits": 14, "max": 16383 },
    "looperState": { "type": "cc", "cc": 22, "dir": "notify" }
  },
  "presets": { "count": 200, "bank": "msb", "perBank": 100, "settleMs": 500 }
}
```

- `channel`: the unit's receive channel is a setting on the unit, which no message reads back. `default` (1-16) is its
  factory setting, `omni` that it can listen on every channel, `where` where the player changes it. The player's own
  channel is kept per unit by the app, which puts it in each status byte.
- `items`, keyed by camelCase name (at most 4096):
  - `type`: `"cc"` (`cc` 0-119; 120-127 are channel mode messages and never sent), `"pc"`, or `"nrpn"` (`msb` and
    `lsb` the parameter number, sent as CC99 then CC98; `bits` 7 sends the value as CC6, 14 as CC6 with its top 7
    bits then CC38 with its low 7).
  - `min`, `max`: the range sent (default the whole range: 0-127, or 0-16383 for a 14-bit NRPN). `enum`: an enum in
    `enums` whose keys are accepted. `allowed`: the only values ever sent. `press`: `{ "value", "release"? }` for a
    footswitch-like control: a press sends `value`, then `release` when given.
  - `label` (how the player names it) and `group` (what kind of control: "scene", "stomp", "tuner") are for listing.
  - `dir`: `"send"` (default), `"notify"` (the unit sends it unasked; never sent) or `"both"`. An NRPN is `"send"`
    only.
- `presets` (optional): preset select. Preset *n* (0-based) is bank *n* / `perBank` (default 128) and program
  *n* % `perBank`, sent as Bank Select then Program Change. `bank` says which Bank Select controllers carry the bank:
  `"none"`, `"msb"` (CC0), `"lsb"` (CC32), or `"msb-lsb"` (CC0 the bank's top 7 bits, CC32 its low 7). `count`
  presets must fit the banks. `settleMs`: how long nothing is sent after a preset change.

Checked at load: ranges, enum keys, and allowed and press values the control can carry; two controls that would send
the same message; a plain CC on a controller NRPN writes use (6, 38, 96-101) when the map has NRPN controls; a plain
CC on a Bank Select controller `presets` uses; a `"pc"` control beside `presets`. A `"control-only"` map needs
`items` or `presets`.

## `scratch`

`{ slots }`: one to eight patch slots, as the device spells their labels, best first, that may be used as scratch.
Whatever a player keeps there is backed up before first use.

## Measured values

Every figure measured on the device takes one shape, `MeasuredValueSchema` in
`packages/engine/src/protocol-schema.ts`:

```json
{ "value": 100, "unit": "ms", "measuredOn": "acme/fx-1 firmware 1.0.0", "date": "2026-01-01", "source": "hardware-check" }
```

- `value`: the number, in `unit`; each field fixes its unit and range, so a reader never converts.
- `unit`: one of `ms`, `s`, `dB`, `LUFS`, `Hz`, `%`.
- `measuredOn`: what it was measured on (device and firmware), up to 256 characters.
- `date`: when, an ISO date (`2026-01-01`) or a date-time with a zone (`2026-01-01T00:00:00Z`).
- `source`: how: `hardware-check` (a hardware check run), `sniffer-capture` (read off a capture of the device's own
  traffic) or `manual` (measured or entered by hand).

No other key is accepted. The fields in this shape (`MEASURED_FIELDS` in `packages/engine/src/measured-fields.ts`):

| Field | Unit | Range |
|---|---|---|
| `audio.reamp.overhead` | `s` | 0 to 60 |
| `transport.timing.compareToggle` | `ms` | 0 to 600000 |
| `host.editor.attachDelay` | `s` | 0 to 60 |
| `transport.timing.measured.roundTripMedianMs` | `ms` | above 0, to 60000 |
| `transport.timing.measured.roundTripP95Ms` | `ms` | above 0, to 60000 |

`transport.timing.measured` is the round trip of one request (median and 95th percentile), from which timeouts and
pauses are set. `transport.timing.compareToggle` is the median time of one switch between a patch and its edit.

## Versioning per firmware

`firmwares["<version>"]` (keyed by the version string the device reports, at most 64 firmwares) holds what that
firmware changes, and nothing else:

- `messages`, `layouts`, `enums`, `constants`: whole entries replaced by name. There is no field-level merge, so a
  partial edit can never leave a half-old layout. An enum is replaced whole too: a firmware that adds models lists
  every model it has, which is also how it drops or renumbers one. It may also add an enum of its own that only its
  own messages and layouts name (a base entry naming it is refused: the base must stand alone).
- `blocked`: messages refused on that firmware, added to the base `blocked`; a firmware can never lift a base block.
- `safety`: a stricter floor on that firmware (see [`safety`](#safety)).
- `range`: `{ from?, below? }`, the versions the entry covers besides its own key: from `from` (included) up to
  `below` (left out), either end open, at least one given, `from` before `below`. Versions are dotted whole numbers
  (`2.00`, `7`, `20260101`, up to four parts of up to nine digits), maybe after a `V` (`V1.2.0`), compared part by
  part as numbers, a missing part counting as 0 (`2` = `2.00`; `1.10` is after `1.9`). Two entry keys that are one
  version written two ways (`2.0` and `2.00`) refuse the map, and so do ranges that overlap. An entry with only a
  range and a `note` says the map's own entries hold for those versions (`"before-2.00": { "range": { "below":
  "2.00" } }`).
- `note`: free text.

Timing, settings and EQ are per device. A firmware that changes them needs a schema change first.

**A version reads one entry**
([`packages/engine/src/firmware-versions.ts`](../../packages/engine/src/firmware-versions.ts)): the entry keyed by
the version the unit reports (exactly, else the same version written another way: `2.0` reads `2.00`), else the one
entry whose `range` holds it. A version that is not dotted numbers matches only its own key. `codec.firmwareEntry`
names that entry and `codec.firmwareListed` is true for it, a range match included: the map's author vouches for the
whole range. What the unit confirms, contradicts or freezes is kept under the exact version it reports, never under
the range's entry, so a later firmware in the same range starts afresh.

`new ProtocolCodec(protocol, firmware)` applies the entry. `encode` of a blocked message throws `BlockedMessageError`,
a refusal that is never sent. An unknown firmware gets the base protocol (`codec.firmwareListed` is false), with one
exception: an enum some firmware entry replaces (`codec.enumsInDoubt`, the base's own enums only). The map can't say
which list this firmware has, so it reads as empty rather than as the base's guess: a value the unit reports stays a
number and a key is never sent. `noBypass` in doubt holds every block the base or any firmware keeps on, since a
firmware may only add to it; `blockChannels` in doubt gives every block one channel. A driver that needs an enum in
doubt (the `block` list, say) refuses the unit at connect. Give such firmwares a `range` (or an entry) to lift the
doubt. The firmware and on-connect messages always come from the base protocol, since they are sent before the
firmware is known.

A firmware's enums are checked as its messages will use them: on a `sysex-xor` transport, every value of an enum it
replaces must fit each field naming it, in the base entries it keeps as well as its own; `audio.reamp`'s sources must
be keys of its `inputSource` where it replaces that; and a `block` or `type` key it gives may not be the other too
where parameter tables are keyed by type. A parameter table may name a block or type that only some firmwares have:
each key must be in the base enum or in some firmware's, as the key's mode reads them. On a firmware without it the
table is never picked, and a value the unit reports that its firmware's enum lacks stays a number. A firmware that
replaces an enum a mode reads through a stand-in must give that stand-in too, or the map is refused. A firmware's
`noBypass` may add blocks that are always on, never drop one the base has.

The schema validates the base, and each firmware as the codec will see it (base plus its replacements). These fail at
load, not on the device:

- a reference to a missing message, layout, enum or constant;
- a pairing or write rule that names a field the message lacks, or a pad (`echo`, `cmdField`, `statusField`,
  `idField`, `requestIdField`, a setting's `value`, the EQ's `param` and `value`), and an ack `cmdField` that is not
  `bytes` of the cmd's length;
- a cmd placeholder that no `args` fill, and a cmd whose length the transport does not allow;
- a `send` or `request` whose cmd can produce the bytes of a blocked message (a placeholder matches any byte) and whose
  payload can be the blocked message's, so a block cannot be bypassed under another name. A safe send that shares a
  blocked message's cmd loads when the map pins them apart, by a byte both pin to different values (a `const` in each,
  or a `const` in one and a whole-byte `not` of it in the other) or by lengths that cannot meet (a packed tail's
  layout counts too, as for `identify`). A send under another `header` (`sysex-plain`) never sends a blocked one's
  bytes. On `roland-address`, address fields are searched as described under [Address fields](#address-fields). The
  check runs in each mode too, as the codec sees it there: a name standing in for a blocked message is blocked, and a
  blocked message whose name a mode stands in for, or drops, is still held against every send there, laid out as
  that mode lays it out. Data can lift a block this way (a const or `not` added to a send, a size narrowed, the
  blocked message re-laid out), and a blocked message is half-known, so a byte it pins may really be a parameter:
  `blockSeparations(protocol)` lists every send kept apart from a blocked message and what that rests on ("byte 2:
  05 vs 06", for the base map, each firmware and each mode where it differs; a byte a packed tail's layout pins is
  marked as such, the least-known part of a map). A walk or a capture should confirm that byte, and a review of a map
  change compares the lists: a new pair lifts a block, a changed one moves it;
- a const, default or sentinel that does not fit its type, `min > max`, a bytes const longer than its field, and a
  checksum whose range is wrong, covers its own field or covers another checksum.

## The map is untrusted input

A map may come from a server, so the schema treats it as hostile:

- Every table has a cap: 64 firmwares, 256 blocked messages per list and 512 across the base and all firmwares, 4096
  entries per named table and per layout, and 4096 bytes per string field; 64 address tables, 16 modes, 16 choices,
  16 on-connect steps, 256 cautions, 64 linked sets per parameter group. Tables over their cap are refused before
  their entries are parsed.
- Text that reaches the chat hides nothing from the player (see [Text a map may hold](#text-a-map-may-hold)).
- A repeated field's element count is checked before anything is enumerated (at most 65536), and so is the total per
  layout. Sizes are computed arithmetically, without enumerating elements.
- Every lookup by name uses own keys only (`Object.hasOwn`), so `"constructor"` or `"toString"` never resolves to an
  inherited property.
- Strings decode in chunks, so a long string cannot overflow the call stack.
- Validation stops listing problems after 100.

## How a driver looks things up

```ts
const p = new ProtocolCodec(protocol, firmware);
const sent = p.encode("setKnob", { slot, knob, value });                 // the framing engine frames it
const reply = await device.request(p.encode("readPreset", { preset })); // pairing and timeout from the map
const preset = p.decodeLayout("preset", reply);                         // nested arrays by field name
const at = p.offset("preset", "levels", row, column);
const fs = p.enumValue("footswitch", "looper");
const pause = p.timing.pauses?.afterSelect;
```

Message names are the contract between a driver and the map. A driver declares the names it needs, required and
optional. Loading a map that lacks a required name fails with the list of missing names; a missing optional name only
switches that feature off, and the player is told the feature is not mapped for this firmware.

## Draft maps

A map that no real unit has confirmed, and that may need engine features an app does not have yet, is a draft:
`protocol.draft.json` beside where `protocol.json` would be. `loadDraftProtocol(json, options)`
([`packages/engine/src/draft-map.ts`](../../packages/engine/src/draft-map.ts)) loads what the app can run, and
lists every entry it cannot run as unsupported, with one line of why. A draft has two keys of its own besides the
protocol's:

- `requires` (at most 512): engine features the map needs, each `area:name` in lower case (`framing:roland-address`,
  `driver:param-change`, `transport:midi`). A bare id is needed by the whole map: without it nothing loads. An item
  `{ "feature", "entries", "why"? }` is needed by those entries only: without it they are unsupported and the rest
  loads. The framing and driver the map names count as needed by the whole map, listed or not. An app's features are
  read from the schema itself (every framing and driver it accepts), so an engine that adds a framing adds its feature.
- `gaps` (at most 512): what the map does not know yet. A string is a note for people; an item
  `{ "entries", "why" }` makes those entries unsupported, whatever the app can do.

Entries are named as map checks name them: `<message>`, `layout/<name>`, `enum/<name>`, `constant/<name>`,
`choice/<name>`, `control/<name>`, `setting/<id>`, `param/<block>/<id>`, `linked/<block>/<set>`, or a section's name
(`eq`, `audio`); 1 to 3 names joined by `/`, at most 256 per item. Other top-level keys the protocol does not have are
ignored and reported.

What loads: entries a missing feature or the map's own gaps name are left out first (a message from every firmware
that has its own version too); then every entry that still does not validate is left out with its problem as the
reason, and the entries that depend on it with it, until the rest validates (at most 64 rounds). The result is a
valid protocol, marked as a draft. What keeps the unit safe or decides how it is driven is never left out: `blocked`,
`safety`, `driver`, `firmwares`, `host`, `display`, `session`, `modes`, `identity`, `hazards` and `cautions`, plus
`schema`, `transport`, `messages` and `layouts` as a whole. A draft where one of those does not load is refused
whole (`DraftMapError`). A blocked message that does not load in full is kept as its cmd and direction alone, which
still blocks; on `roland-address`, where a block's payload is part of what it blocks, it is never cut, and the draft is
refused. A linked set's parameters go with the set.

Until a unit has verified it, a draft's writes go through the first-write gate (see
[`safeRead` and `readBack`](#saferead-and-readback) and [`hazards` and `cautions`](#hazards-and-cautions)): a write
the map pairs with no read is refused, and so are saves, resets and anything else that outlives the edit buffer.

## Map checks

Every check a session makes (a reply the map decodes, a read-back, a block's parameter list) is an observation of
one map entry ([`packages/engine/src/map-checks.ts`](../../packages/engine/src/map-checks.ts)). An app keeps them per
unit and firmware, outside the map. Entries are named as for fingerprints: a message, `<message>/<block>`,
`param/<owner>/<id>`, `choice/<name>`, `control/<name>`, `presets/<index>`, `linked/<owner>/<set>`, `identity`, and
`<message>@<mode>` in a mode. The outcomes (`OUTCOMES`): `confirms`, `decodes`, `player-confirms`, `unverifiable`
(a write went out that this unit cannot confirm; it changes no level), `settles`, `contradicts`, `reopens`,
`unsupported`, `disagrees`, `skipped`, `retried`, `answered-on-resend` (a request left unanswered, a liveness probe answered, and the same request answered when sent again: no mark and no strike, but
the entry is listed as flaky), `froze` (the unit stopped answering right after the entry went out and a second request
went unanswered too while it was still connected: the entry is blocked on this firmware) and `unblocked` (the player
lets a blocked entry be sent again). The trust levels, weakest first: `blocked`, `unsupported`, `suspect`, `unchecked`,
`shape-ok`, `player-confirmed`, `verified`. A feature that needs several entries takes the weakest of them, so one
failed entry switches off one feature, not the device. A mark holds until the entry's fingerprint changes (see
[Fingerprints](#fingerprints)).

The records an app keeps (one log line per check, and a state file of the marks each entry holds per firmware) are
in [`packages/engine/src/map-check-record.ts`](../../packages/engine/src/map-check-record.ts), and published as JSON
Schemas: [`schemas/map-check-record.v1.schema.json`](../../schemas/map-check-record.v1.schema.json) and
[`schemas/map-check-state.v2.schema.json`](../../schemas/map-check-state.v2.schema.json). A sniffer capture or a seed
patch can carry the same records as evidence. A record names the device by make and model and the firmware the unit
reports, never a person, machine or path.

## Fingerprints

An entry's fingerprint lets the Patchsprite app, the sniffer and a map server tell whether an entry changed, so a
unit's marks on an entry (confirmed, suspect) hold until the entry is repaired. The form is pinned in the
engine they share:

- **Canonical JSON** (`canonicalJson` in `packages/engine/src/canonical-json.ts`): RFC 8785 (JCS): object keys sorted
  by UTF-16 code units, no whitespace, numbers as ECMAScript prints them, members whose value is undefined left out.
  NaN and Infinity are refused.
- **Fingerprint** (`fingerprint`): the first 16 hex digits of the SHA-256 of that text as UTF-8.
- **Entry fingerprint** (`entryFingerprint(protocol, firmware, entry)` in `packages/engine/src/map-fingerprint.ts`):
  the fingerprint of the entry's definition, taken from the map as `parseProtocol` reads it (`"0x.."` numbers as
  numbers, no defaults added) for one firmware (its delta merged). The entries and their definitions:
  - a message, or a message on one block (`setBypass/amp`): `[message, its payload layout, [reply message, its payload
    layout] or null, the enums their fields name, the transport's endian]`, followed, only when either payload layout
    has a packed tail read with a shared layout or joined into a record, by `[the message's tail layout or null, the
    reply's or null]`, and, only when its address fields read `addresses` tables, by an object of those tables;
  - `<message>@<mode>` (and on one block): the message as that mode reads it, where the mode stands in layouts or
    enums;
  - `param/<owner>/<id>`: the parameter's definition in the first parameter group that lists the owner (a block, or an
    effect type) and has the id, of the groups that stand in for no other in a mode; `param/<owner>/<id>/<group>`: in
    that group, one that stands in for another in some mode;
  - `linked/<owner>/<set>`: `[the linked set, its parameters' definitions in its order]`;
  - `choice/<name>`: `[the choice, [[where, field], ...] for every field that names it (by message, then by layout as
    "layout <name>", each in the map's order), the enums those fields name]`;
  - `control/<name>`: `[the control's definition in controls.items, the enum it names or null]`;
  - `presets/<index>`: the map's `controls.presets`, whatever the index;
  - `identity`: the map's `identity`, without `source`, `firmwareSource` and `note`.

  The enums are an object of each enum a field names (by `enum`, and those its `enumBy` picks from) to its definition,
  so a repaired enum value repairs every entry that reads it. `source` and `note`, on the message, parameter or choice
  and on each field, and a message's `safeRead` and `readBack`, are left out: a map that only records better evidence
  for a claim, rewords a note or changes how an entry is tested has not repaired it. An entry the map does not have
  has the definition `null`.

The seed-patch format uses the same canonical JSON and fingerprint for whole files (its Fingerprints section).

## What stays in code

- **The generic engines:** the codec (`protocol-schema.ts`); the framing engines (frame encode and decode, reassembly,
  SysEx splitting), parameterised by `transport`; LZO1X; records in pieces; the request and ack waiter mechanics (the
  timeouts themselves come from the map).
- **Safety engines:** the guard that applies the map's `safety` rules, owned-slot and overwrite rules, backups, and
  range checks of player input (with the ranges from the map).
- **Meaning that is not a device fact:** when a scene counts as used, the rebuild order, which bytes count as "same
  content", and display text for values. The label format, row layout and default names are the map's (`display`).
  On some units a full-patch rebuild (reload the saved patch, then write every field) can change settings outside the
  mapped fields, so a driver's put-backs write only the changed fields where they can.
- **A simulator's behaviour:** a simulator binds by message name (it knows which names save, read and select); its byte
  facts come from the map, so tests drive it with a made-up map.
