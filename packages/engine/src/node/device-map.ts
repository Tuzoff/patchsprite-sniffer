// Loading device maps from a folder: <dir>/<make>/<device>/<firmware>.json for a firmware's model map, and the
// device's protocol in <dir>/<make>/<device>/protocol.json beside them (one per device, with per-firmware changes
// inside). Where the folder is, is the app's business.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadMapping, type DeviceMapping } from "../mapping.ts";
import { parseProtocol } from "../protocol-schema.ts";

const SAFE_PART = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Refuses a name part (make, device, firmware) that could steer a path out of its folder. */
export function checkNameParts(...parts: string[]): void {
  for (const part of parts) {
    if (!SAFE_PART.test(part) || part.includes("..")) throw new Error(`not a valid device map name part: ${JSON.stringify(part)}`);
  }
}

/** A firmware's model map in the maps folder `dir`. */
export function deviceMapPathIn(dir: string, make: string, device: string, firmware: string): string {
  // the firmware string comes from the device, so never let it steer the path
  checkNameParts(make, device, firmware);
  return join(dir, make, device, `${firmware}.json`);
}

/** The device's protocol file in the maps folder `dir`: one per device, beside its per-firmware model maps. */
export function protocolPathIn(dir: string, make: string, device: string): string {
  checkNameParts(make, device);
  return join(dir, make, device, "protocol.json");
}

/** A draft protocol no real unit has confirmed yet, beside where protocol.json would be (draft-map.ts). */
export function draftProtocolPathIn(dir: string, make: string, device: string): string {
  checkNameParts(make, device);
  return join(dir, make, device, "protocol.draft.json");
}

function readJson(path: string, what: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new Error(`no ${what}; expected it at ${path}`);
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`${what} at ${path} is not valid JSON: ${(e as Error).message}`);
  }
}

/**
 * The model map for a firmware in the maps folder `dir`, with the device's protocol attached when the map does not
 * carry its own. `parse` reads the protocol (parseProtocol by default).
 */
export function loadDeviceMapIn(
  dir: string,
  make: string,
  device: string,
  firmware: string,
  parse: (json: unknown) => DeviceMapping["protocol"] = parseProtocol,
): DeviceMapping {
  const map = loadMapping(readJson(deviceMapPathIn(dir, make, device, firmware), `device map for ${make} ${device} ${firmware}`));
  if (map.protocol) return map;
  const path = protocolPathIn(dir, make, device);
  if (!existsSync(path)) return map;
  const json = readJson(path, "protocol");
  try {
    return { ...map, protocol: parse(json) };
  } catch (e) {
    throw new Error(`the protocol at ${path} is invalid: ${(e as Error).message}`);
  }
}

/**
 * The model maps in a device's folder, beside its protocol.json: every <firmware>.json that loads as one. A file that
 * does not (a backup, notes) is skipped.
 */
export function modelMapsIn(folder: string): DeviceMapping[] {
  const out: DeviceMapping[] = [];
  for (const f of readdirSync(folder).filter((f) => SAFE_PART.test(f) && f.endsWith(".json") && f !== "protocol.json").sort()) {
    try {
      out.push(loadMapping(JSON.parse(readFileSync(join(folder, f), "utf8"))));
    } catch {
      // not a model map
    }
  }
  return out;
}
