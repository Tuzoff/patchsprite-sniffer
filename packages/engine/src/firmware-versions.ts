// Firmware versions as the device map compares them: dotted whole numbers ("4.00", "21", "20240101"), with or without
// a leading "V" ("V1.2.0"), compared part by part as numbers, a missing part counting as 0 ("4" = "4.0" = "4.00";
// "3.10" is after "3.9"). A version that is not dotted numbers ("1.2b", "unknown") matches only a firmware entry keyed
// by exactly it, never a range.

/** The text a version range bound takes: up to four dotted whole numbers of up to nine digits each, maybe after a V. */
export const VERSION_PATTERN = /^[Vv]?\d{1,9}(\.\d{1,9}){0,3}$/;

/** A version's parts as numbers, or undefined for one that is not dotted whole numbers. */
export function versionParts(v: string): number[] | undefined {
  return VERSION_PATTERN.test(v) ? v.replace(/^[Vv]/, "").split(".").map(Number) : undefined;
}

/** Negative when a is before b, 0 when they are the same version, positive when a is after b. */
export function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** A range of versions: from `from` (included) up to `below` (left out); a missing bound is open. */
export type VersionRange = { from?: string; below?: string };

/** Whether the range holds the version (parts from versionParts). */
export function inRange(v: number[], r: VersionRange): boolean {
  if (r.from !== undefined && compareVersions(v, versionParts(r.from)!) < 0) return false;
  if (r.below !== undefined && compareVersions(v, versionParts(r.below)!) >= 0) return false;
  return true;
}

/** Whether two ranges hold some version in common (an open end reaches every version on its side). */
export function rangesOverlap(a: VersionRange, b: VersionRange): boolean {
  // each must start before the other ends
  const startsBefore = (x: VersionRange, y: VersionRange) =>
    x.from === undefined || y.below === undefined || compareVersions(versionParts(x.from)!, versionParts(y.below)!) < 0;
  return startsBefore(a, b) && startsBefore(b, a);
}

/**
 * The firmware entry a version reads: the entry keyed by that version (exactly, else the same version written another
 * way), else the one entry whose range holds it (the map refuses overlapping ranges), else none.
 */
export function firmwareEntryKey(firmwares: Record<string, { range?: VersionRange }> | undefined, version: string | undefined): string | undefined {
  if (version === undefined || firmwares === undefined) return undefined;
  if (Object.hasOwn(firmwares, version)) return version;
  const v = versionParts(version);
  if (!v) return undefined;
  const keys = Object.keys(firmwares);
  // the same version written another way ("4.0" for an entry keyed "4.00") is still its own entry
  const same = keys.find((k) => {
    const kv = versionParts(k);
    return kv !== undefined && compareVersions(kv, v) === 0;
  });
  return same ?? keys.find((k) => firmwares[k].range !== undefined && inRange(v, firmwares[k].range!));
}
