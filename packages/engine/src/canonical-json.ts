// Canonical JSON and fingerprints, the form the app, the sniffer and the cloud share: JSON in RFC 8785 form (JCS:
// object keys sorted by UTF-16 code units, no whitespace, numbers as ECMAScript prints them, members whose value is
// undefined left out), and a fingerprint is the first 16 hex digits of the SHA-256 of that text as UTF-8. The same
// form as the closed app's map fingerprints, checked against the same test vectors
// (test/fixtures/fingerprint/canonical-vectors.json); the map-entry fingerprints join it when the engine moves here.

import { sha256Hex } from "./sha256.ts";

/** JSON in RFC 8785's canonical form. Non-finite numbers, which JSON can't hold, are refused. */
export function canonicalJson(x: unknown): string {
  if (x === null || x === undefined) return "null";
  if (typeof x === "number") {
    if (!Number.isFinite(x)) throw new Error("canonical JSON holds no NaN or Infinity");
    return JSON.stringify(x);
  }
  if (typeof x === "string" || typeof x === "boolean") return JSON.stringify(x);
  if (Array.isArray(x)) return `[${Array.from(x, (v) => canonicalJson(v)).join(",")}]`;
  if (typeof x === "object") {
    const keys = Object.keys(x).filter((k) => (x as Record<string, unknown>)[k] !== undefined);
    keys.sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson((x as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  throw new Error(`canonical JSON holds no ${typeof x}`);
}

/** The fingerprint of any JSON value: 16 hex digits. */
export const fingerprint = (x: unknown): string => sha256Hex(canonicalJson(x)).slice(0, 16);
