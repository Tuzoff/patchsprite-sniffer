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
  "driver": "param-change", // "patch-dump" or "param-change"
  "transport": {...},       // framing, checksum, nibbles, chunking, compression, timing
  "messages":  {...},       // named messages: cmd, direction, payload layout, reply/ack pairing
  "layouts":   {...},       // shared record layouts: stored records, file formats, list replies
  "enums":     {...},       // named value tables
  "constants": {...},       // counts, first ids, sentinels, ranges
  "settings":  {...},       // device-wide setting groups and items
  "eq":        {...},       // global EQ parameters
  "blocked":   [...],       // messages never sent
  "safety":    {...},       // rules checked before anything is sent
  "display":   {...},       // how the device names things for the player
  "audio":     {...},       // audio facts measured on the device
  "host":      {...},       // how the computer finds the device
  "parameters": {...},      // block parameter tables (param-change devices)
  "choices":   {...},       // encodings the docs disagree on, settled per unit
  "scratch":   {...},       // patch slots that may be used as scratch
  "firmwares": {...}        // per-firmware replacements and extra blocks
}
```

Unknown keys are refused anywhere in the section.

`parseProtocol(json)` validates it and throws one `ProtocolError` listing every problem. `new ProtocolCodec(protocol,
firmware)` resolves the protocol for the connected firmware, and the driver asks it for everything by name.

## `driver`

How the device is driven, so code reads it rather than guessing from the framing:

- `"patch-dump"`: the unit hands over and takes a whole patch as one record that the map lays out. The Patchsprite app
  keeps a full copy, so it can build a patch, put any model in a slot and save the patch to the unit.
- `"param-change"`: the unit is addressed one message at a time: which preset and scene is on, each block's bypass
  and channel, one parameter per message. The Patchsprite app never holds or writes a whole preset. Scenes, block channels and
  the unit's own parameter list are optional, and a change may be a `send`, or answered by an acknowledgement only.

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
carry the data from that address on and are not acknowledged (a write is confirmed by reading it back). Payload
bytes are 7-bit; wide values use `septets` or `nibbles`. Keys:

- `frame.header`: `f0`, the manufacturer, the device ID and the model ID, as the host sends them.
- `frame.deviceIdAt` (optional, 1 to 15, inside the header): the header byte holding the device ID. The ID is set per
  unit, so the map's byte there is only a default (such as the broadcast `7f`): until the unit's own ID is known,
  that default is sent and any ID is heard. `AddressFramer.deviceIdOf` reads the ID from a message; the driver learns
  it from the unit's first answer to one of its own requests, never from other traffic, and `messageFramer`'s
  `deviceIdOf` gives nothing for the broadcast ID `7f`. The ID is
  kept outside the map, for the connection only; `new AddressFramer(transport, { deviceId })` then sends to that ID
  and hears only it. Omitted: incoming messages must carry the header as it is, and no ID can be set.
- `frame.terminator`: `f7`.
- `frame.checksum`: `{ "algo": "roland-sum", "verify" }`. The checksum makes the address and payload bytes (not the
  header or command) sum to 0 modulo 128: `(128 - sum mod 128) & 7f`.
- `frame.maxData` (optional): the most data bytes one message carries; `encodePieces` sends a longer write in pieces
  at successive addresses.
- `inner.cmdLength` (2 to 8) and `inner.addressBytes` (1 to 7, fewer than `cmdLength`): how many of the cmd's last
  bytes are the address. An address is 7-bit digits, most significant first (`00 00 7f` + 1 is `00 01 00`).
- `endian` and `timing`, as above.

A unit may answer one read in several messages at successive addresses. `AddressFramer.reassembler(answerCmd, size)`
joins them in any order (a piece sent again must carry the same bytes); anything else is left for its own handler. A
dropped piece leaves the read unanswered; a piece running past the size is refused. At most 65536 bytes
(`MAX_RECORD`) are joined.

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
  exactly, then one that pins more payload bytes, then the map's order. The map tells them apart with what it pins: a
  byte only one of them has (a `const` in one, a different `const` or a `not` of that value in the other), a length
  (`size`, `minSize`, `maxSize`), or the side. `codec.lookalikes()` lists the pairs nothing pinned tells apart. A
  lookalike is not a load error: a capture settles it.
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
  - `pieces`: `{ "offset", "size"?, "layout"?, "maxPiece"?, "deadlineMs"? }`, for a request the device answers in
    several messages that are joined into one value before it is read. Not with `list`, only on a `request` whose
    reply is a message of its own, and only in a map whose `driver` is `param-change`. Each piece says where its bytes
    go:
    - `"offset": "address"` (`roland-address` only): the pieces are the reply's command at successive addresses, the
      first at the reply's own cmd. Each piece's payload is all data, and the joined value is read with the reply
      message's own layout, so `layout` is refused here.
    - `"offset": { "field": "at" }` (any framing): each piece is the reply message, read with its layout (consts and
      `echo` included), with its byte offset in that field (one number); its bytes are the payload after the reply's
      layout. The reply's layout then has a fixed size (no `minSize`, `maxSize` or open string), and `layout` is
      required.

    `size` is the joined value's bytes: `{ "request": "size" }` (a field of the request), `{ "constant": "recordSize" }`,
    or a number (1 to 65536); without it, the size of the layout the value is read with, which must then have one.
    `maxPiece` is the most bytes one piece carries. `deadlineMs` (at most and by default 60000) bounds the whole
    answer, while the reply timeout counts from the request to the first piece and from each piece to the next.
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
- **`source`** and **`note`**: see [`source`](#source).

### Field types

Every field has a `name`, a `type` and an optional `offset`. Without an offset, a field starts right after the
furthest byte any earlier field reaches.

| `type` | Extra keys |
|---|---|
| `u8` `i8` `u16` `i16` `u32` `i32` `f32` | `endian`, `const`, `not`, `default`, `copyOf`, `scale`, `bias`, `min`, `max`, `saturate`, `nullAs`, `enum`, `allowed`, `checksum`, `septets`, `nibbles`, `bits`, `invert`, `choice` |
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
| `allowed` | the only values `encode` writes: "only values known to be safe", made data |
| `checksum` | `{ "algo": "sum", "from", "to": "self" \| "end", "mask" }`, on an unsigned field that does not repeat. `"self"` sums from `from` up to the field; `"end"` from `from` to the end of the payload, and must not cover the field. Written after every other field, checked on decode |
| `septets` | 1 to 5: the value goes out as that many 7-bit bytes, least significant first, or most significant first when the field's own `endian` is `be` (the map's default endian never orders septets). Unsigned type, no checksum; decode refuses a byte with the high bit set |
| `nibbles` | 1 to 8: the value goes out as that many bytes of 4 bits each, ordered as for `septets`. Not with `septets`. Unsigned type, no checksum; decode refuses a byte above `0f` |
| `bits` | `{ "shift", "width" }`: only these bits of the element, `(raw >> shift) & (2^width - 1)`. Fields that share a byte name their bits at the same `offset`; encode writes only its own bits. Unsigned type, no checksum. With `septets` or `nibbles`, the bits count across the joined groups |
| `invert` | with `bits` only: the stored bits are the complement of the value. `const`, `nullAs`, `default`, `min` and `max` name the value before it is inverted |
| `choice` | the name of a protocol choice (see [`choices`](#choices)): the field takes the keys the option in force sets (today `endian`), so it sets no `endian` itself. A single scalar of two bytes or more, with no `repeat`, `bits` or `checksum` |

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
  because they are shown to the player.
- `constants`: named numbers: counts, first ids, sentinels, ranges (`codec.constant("presetCount")`).
  `referenceScene` (0-based) is the scene a loaded patch starts in and that never-used scenes are filled from; builds
  put models there, so it must be one of the scenes model changes are allowed in, on every firmware.

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

## `display`

How the device names things for the player:

- `deviceName`;
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

## `parameters`

For devices that read and set block parameters one by one. Optional.

- `knobMax`: the raw value of a knob or slider at full travel. The device's own labels say what a position shows.
- `groups`: keyed by a group name, each `{ blocks, params }` or `{ types, params }`. `blocks` are keys of the `block`
  enum that share one table. `types` are keys of the `type` enum (effect types) that share one, on a device whose
  slots can each hold any effect: a slot's table is then the one of the effect type in it. A block's own table wins
  over its type's. `params` is keyed by the name the player uses, each
  `{ id, kind, options?, min?, max?, step?, default?, source?, note? }`. `kind` is `knob` or `slider` (a position
  0..`knobMax`, or 0..`max`), `select` or `switch` (one of `options`, keyed by the number the device takes; a `select`
  without `options` is set by number), or `range` (`min`..`max` in steps of `step`). `default` is the raw value the
  device gives the parameter when the effect is put in.

A parameter the device lists but no table names is still read and set by its id. Checked at load: every group has
`blocks` or `types`, not both; each block or type is a key of its enum (which the map must then have), in one group
only, and no key is both; ids are unique within a group; `min <= max`; a `range` has both; a `switch` has `options`;
only a `select` or `switch` has `options`; a knob's or slider's own `max` is within 1..`knobMax`; a `default` is one
of the options or within the range. Caps: 256 groups, 1024 parameters per group, 1024 options per parameter, ids up to
16383, and 16384 parameters and 65536 options across the whole table, counted before it is parsed.

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

Only messages, parameters and choices carry it, because only they are entries a unit checks. A layout, enum or
constant is vouched for by the entries that use it. How far one unit trusts an entry is kept outside the map.
`source` and `note` are left out of fingerprints (see [Fingerprints](#fingerprints)).

A measured value's `source` (see [Measured values](#measured-values)) is a different thing: how a number was measured.

## `audio`

Audio facts measured on the device:

- `volumeLaw`: `{ kind: "amplitude", unity, min, max, quietest, calibrated, calibratedOn?, toleranceDb?, evidence? }`.
  `amplitude` is dB = 20 log10(v / unity); `quietest` is the lowest volume that is not muted. The schema refuses a law
  without `min <= quietest <= max` and `min < max`.
- `reamp`: the audio endpoint name (or part of it), sample rate and channel count; `send`, the USB output a reamp sends
  the DI on (an output from 3 to `channels`); `inputs`, the USB inputs it records (needing `wet` and `di`, each within
  `channels`); the send gain (`gainDb`); the lowest latency confidence that is trusted; the chain input sources for a
  reamp and for live playing (`source`, `liveSource`: keys of the `inputSource` enum) with the names the player reads
  for them (`sourceNames`).
  - `overhead` (optional): what one reamp takes on top of its audio, a measured value in `s`.
  - `bypassOutputs` (optional): the USB outputs (numbered from 1) that join the device's outputs after its effects
    chain, like an AUX input, where audio plays clean through the device. One or two outputs, each listed once, never
    the `send` output (which feeds the chain), and each within `channels`; the schema refuses a map that breaks any of
    these. A MIDI walk can't observe it, so it comes from the device's docs or from the player, and a map built by an
    editor walk leaves it out. Without it, playing through the device past its chain is refused; no output is ever
    guessed.

A capture whose rate or channel count is not the map's is refused.

## `host`

How the computer finds the device:

- `midiPort`: the MIDI port's name, or part of it;
- `usb`: `{ vid, pid }`, 4 uppercase hex digits each;
- `vendorApps`: up to 16 `[process name prefix, name to show]` pairs, the device's own apps that may hold its port;
- `editor` (optional): the vendor's editor, for editor walks: `exe`, its executable's file name (printable ASCII, no
  folder), and `attachDelay` (optional), how long to wait after the editor starts before attaching to it, a measured
  value in `s`.

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

- `messages`, `layouts`, `constants`: whole entries replaced by name. There is no field-level merge, so a partial edit
  can never leave a half-old layout.
- `blocked`: messages refused on that firmware, added to the base `blocked`; a firmware can never lift a base block.
- `safety`: a stricter floor on that firmware (see [`safety`](#safety)).

Enums, timing, settings and EQ are per device.

`new ProtocolCodec(protocol, firmware)` applies them. `encode` of a blocked message throws `BlockedMessageError`, a
refusal that is never sent. An unknown firmware gets the base protocol (`codec.firmwareListed` is false).

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
  or a `const` in one and a `not` of it in the other) or by lengths that cannot meet;
- a const, default or sentinel that does not fit its type, `min > max`, a bytes const longer than its field, and a
  checksum whose range is wrong, covers its own field or covers another checksum.

## The map is untrusted input

A map may come from a server, so the schema treats it as hostile:

- Every table has a cap: 64 firmwares, 256 blocked messages per list and 512 across the base and all firmwares, 4096
  entries per named table and per layout, and 4096 bytes per string field. Tables over their cap are refused before
  their entries are parsed.
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
    reply's or null]`;
  - `param/<owner>/<id>`: the parameter's definition in the first parameter group that lists the owner (a block, or an
    effect type) and has the id;
  - `choice/<name>`: `[the choice, [[where, field], ...] for every field that names it (by message, then by layout as
    "layout <name>", each in the map's order), the enums those fields name]`.

  The enums are an object of each enum a field names to its definition, so a repaired enum value repairs every entry
  that reads it. `source` and `note`, on the message, parameter or choice and on each field, are left out: a map that
  only records better evidence for a claim, or rewords a note, has not repaired it. An entry the map does not have
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
- **A simulator's behaviour:** a simulator binds by message name (it knows which names save, read and select); its byte
  facts come from the map, so tests drive it with a made-up map.
