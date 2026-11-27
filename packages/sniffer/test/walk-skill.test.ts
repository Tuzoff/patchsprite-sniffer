// The "map a device" skill: one text for skill-loading clients and for the server's help("walk").
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, walkGuide } from "../src/mcp/server.ts";
import { Recorder } from "../src/recorder.ts";
import { registerWalkTools } from "../src/walk/tools.ts";
import { FakeDevice } from "./fake-frida.ts";

const SKILL = readFileSync(new URL("../../../skills/map-a-device/SKILL.md", import.meta.url), "utf8").replace(/\r\n/g, "\n");

test("the skill folder has frontmatter with its name and a description", () => {
  const fm = /^---\n([\s\S]*?)\n---\n/.exec(SKILL)?.[1] ?? "";
  assert.match(fm, /^name: map-a-device$/m);
  const desc = /^description: (.+)$/m.exec(fm)?.[1] ?? "";
  assert.ok(desc.length > 40 && desc.length < 1024, desc);
});

test("the skill holds no device facts: no SysEx bytes, hex codes or model numbers", () => {
  assert.doesNotMatch(SKILL, /\b[fF]0(?:\s?[0-9a-fA-F]{2}){2,}/, "SysEx bytes");
  assert.doesNotMatch(SKILL, /\b0x[0-9a-fA-F]+\b/, "hex codes");
  assert.doesNotMatch(SKILL, /\b[A-Z]{2,}-?\d{2,}\b/, "a model-number-like word");
});

test("help('walk') serves the skill's text, and every tool it names exists on the server", async () => {
  const recorder = new Recorder({ getDevice: async () => new FakeDevice() });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createServer(recorder, [registerWalkTools]).connect(a);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(b);
  const r = (await client.callTool({ name: "help", arguments: { topic: "walk" } })) as { content: { text: string }[] };
  assert.equal(r.content[0].text, walkGuide());
  assert.ok(SKILL.endsWith(walkGuide() + "\n"), "help('walk') is the skill body, not a copy");
  const tools = new Set((await client.listTools()).tools.map((t) => t.name));
  for (const [, name] of walkGuide().matchAll(/`([a-z]+_[a-z_]+)`/g)) assert.ok(tools.has(name), `the skill names ${name}`);
  await client.close();
});
