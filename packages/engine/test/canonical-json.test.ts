import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { canonicalJson, fingerprint } from "../src/canonical-json.ts";
import { sha256Hex } from "../src/sha256.ts";

const vectors = JSON.parse(readFileSync(new URL("../../../test/fixtures/fingerprint/canonical-vectors.json", import.meta.url), "utf8"));

test("canonical JSON and fingerprints match the vectors shared with the app and cloud", () => {
  for (const c of vectors.canonical) {
    // the vectors' `skip` member is undefined, so it is left out
    const input = c.input !== null && typeof c.input === "object" && !Array.isArray(c.input) ? { ...c.input, skip: undefined } : c.input;
    assert.equal(canonicalJson(input), c.canonical);
    assert.equal(fingerprint(input), c.fp);
  }
});

test("canonical JSON refuses what JSON can't hold", () => {
  assert.throws(() => canonicalJson(Number.NaN), /NaN/);
  assert.throws(() => canonicalJson(Infinity), /Infinity/);
  assert.throws(() => canonicalJson(() => 1), /function/);
});

test("SHA-256 matches node:crypto and the NIST vectors", () => {
  const nist: [string, string][] = [
    ["", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
    ["abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
    ["a".repeat(1_000_000), "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0"],
  ];
  for (const [text, hex] of nist) assert.equal(sha256Hex(text), hex);
  for (const text of ["x".repeat(55), "x".repeat(56), "x".repeat(64), "é🎸".repeat(40)]) {
    assert.equal(sha256Hex(text), createHash("sha256").update(text, "utf8").digest("hex"));
  }
});
