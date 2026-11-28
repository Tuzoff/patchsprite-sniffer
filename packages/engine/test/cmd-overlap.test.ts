import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { BlockedCmds, cmdsOverlap, MAX_CMD_TOKENS } from "../src/cmd-overlap.ts";

const vectors: { pairs: { a: string; b: string; overlap: boolean }[] } = JSON.parse(readFileSync(new URL("../vectors/cmd-overlap.json", import.meta.url), "utf8"));

test("cmdsOverlap and BlockedCmds give the shared vectors' answer, both ways round", () => {
  for (const { a, b, overlap } of vectors.pairs) {
    for (const [x, y] of [[a, b], [b, a]]) {
      assert.equal(cmdsOverlap(x, y), overlap, `cmdsOverlap(${x}, ${y})`);
      const blocked = new BlockedCmds();
      blocked.add(x);
      assert.equal(blocked.hits(y), overlap, `BlockedCmds {${x}} hits ${y}`);
    }
  }
});

test("BlockedCmds holds many cmds, keeps answering after more are added, and a cmd too long to load overlaps everything", () => {
  const blocked = new BlockedCmds();
  blocked.add("10 {n}");
  assert.equal(blocked.hits("11 00"), false);
  blocked.add("11 00");
  assert.equal(blocked.hits("11 00"), true, "a cmd added after a lookup is found");
  assert.equal(blocked.hits("10 7f"), true);
  assert.equal(blocked.hits("12 00"), false);
  const long = Array(MAX_CMD_TOKENS + 1).fill("01").join(" ");
  assert.equal(blocked.hits(long), true, "a cmd past the longest a map loads is judged by nothing");
  blocked.add(long);
  assert.equal(blocked.hits("7e"), true);
});
