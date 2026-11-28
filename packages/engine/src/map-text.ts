// Text from a device map that reaches the chat, checked at load. Browser-safe, no device fact.

import { z } from "zod";

// Map text reaches the chat (names in answers, notes, reasons, refusals), and a map can come from anyone: a seed or a
// community map. No text may hide anything from the player that the model would still read: no control
// characters, no invisible or zero-width ones, no direction overrides, no Unicode tag characters, no variation
// selectors (which can carry hidden data) or blank fillers. Names are one line; notes and reasons may break lines.
// Unicode's default-ignorable code points cover the invisible, zero-width, direction, tag, variation-selector and
// blank-filler ones; the rest are controls, line and paragraph separators, the blank braille cell and interlinear
// annotation marks.
const HIDDEN = "\\x00-\\x08\\x0b-\\x1f\\x7f-\\x9f\\u2028\\u2029\\u2800\\ufff9-\\ufffb\\p{Default_Ignorable_Code_Point}";
const NO_HIDDEN = new RegExp(`^[^${HIDDEN}]*$`, "u");
const ONE_LINE = new RegExp(`^[^${HIDDEN}\\t\\n]*$`, "u");
/** Free text from a map (a note, a reason, a source): any printing characters and line breaks. */
export const text = () => z.string().regex(NO_HIDDEN, "text has no control, invisible or direction characters");
/** A name or label from a map, shown to the player: one line of printing characters. */
export const line = () => z.string().regex(ONE_LINE, "a name is one line with no control, invisible or direction characters");
