// The sniffer's local MCP server (no views): start and stop a capture, mark the steps of a walk, record the editor
// idle, and summarize what was captured, so a chat app can run a capture session instead of a terminal. Short
// instructions hold the safety and consent rules; the rest is in help(topic). Every tool carries the read-only,
// destructive, idempotent and open-world annotations. GA MCP features only.

import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type MidiRecord, parseCapture, stepMessages } from "@patchsprite/engine/capture";
import { z } from "zod";
import type { Recorder } from "../recorder.ts";

export const INSTRUCTIONS = `Patchsprite sniffer: records the MIDI between a device and its vendor editor while the editor is used as normal. It only watches: it never sends anything to the device. All the changes come from the editor.

Rules:
- Ask the user before starting a capture. Say that it hooks the editor's MIDI calls and holds the device while the session works, so the Patchsprite app leaves it alone meanwhile (after 15 minutes unused it lets the device go, and takes it back on the next step if it is free).
- Change things only in a scratch preset the user names. Never save over or store a preset they didn't name, never run a firmware update or a factory reset, and never try a model the editor doesn't offer for this device.
- Begin each step before changing one control, and end it after. Label it "control: before → after" (for example "Drive gain: 5 → 6").
- A capture can hold the user's presets. It stays on their computer: never paste capture bytes into a public place.
- If the self-test fails, stop and tell the user what it said.

Call help("session") for the order of a session, help("steps") for step labels, and help("walk") for walking the editor with the walk tools (the "map a device" skill).`;

/** The "map a device" skill (skills/map-a-device/SKILL.md at the repo root), without its frontmatter: one text for
 * clients that load skills and for help("walk"). */
export function walkGuide(): string {
  const md = readFileSync(new URL("../../../../skills/map-a-device/SKILL.md", import.meta.url), "utf8");
  // A Windows checkout may turn the line ends into CRLF.
  return md.replace(/\r\n/g, "\n").replace(/^---\n[\s\S]*?\n---\n+/, "").trim();
}

const HELP: Record<string, string> = {
  session: `A capture session:
1. start_capture with the editor's executable file name (as Task Manager shows it) and the attach delay. The editor can already be open, or be started after.
2. Wait until capture_status says it is attached, then record_idle (about 10 s, with nobody touching the editor), so the editor's constant polling stops counting as traffic.
3. The self-test: begin_step with kind "selfTest" and a label like "Preset: 1 → 2", make that change in the editor, then end_step. If it fails, the capture has stopped, so tell the user why.
4. One step per change: begin_step, change one control, end_step. Things automation can't do (a drag, an import) are kind "manual": the user does them while the step is open.
5. stop_capture when done. summarize_capture shows what each step caught.`,
  steps: `Labels say what changed: "control: before → after". "Drive gain: 5 → 6" is good; "Drive gain" alone isn't, and end_step refuses an action until its label says what changed (give the label to end_step when the after-value is known only then). A step ends once nothing counted has arrived for 0.6 s, or after 8 s ("timeout": something kept streaming). Clock, active sensing, short channel messages and the editor's polls are kept, flagged, and never counted. Set mode when the device has operating modes and you know which one it is in.`,
};

export const ro = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const rw = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

export const text = (t: string, structured?: Record<string, unknown>) => ({ content: [{ type: "text" as const, text: t }], ...(structured ? { structuredContent: structured } : {}) });
export const refused = (e: unknown) => ({ content: [{ type: "text" as const, text: (e as Error).message }], isError: true });

/** Summarizes a capture file: its steps, each with its status and counted messages both ways. */
export function summarize(file: string, maxSteps = 200): string {
  const r = parseCapture(readFileSync(file, "utf8"));
  if (!r.ok) return `The capture can't be read: line ${r.issues[0].line}: ${r.issues[0].message}`;
  const c = r.capture;
  const midi = c.records.filter((x): x is MidiRecord => x.type === "midi");
  const lines = [
    `Capture of ${c.header.editor.exe}, started ${c.header.startedAt}: ${midi.length} messages, ${midi.filter((m) => m.flags).length} of them flagged (clock, polls and the like). ${c.end ? `Ended: ${c.end.reason}.` : "Not ended (still running or cut off)."}`,
  ];
  for (const s of c.steps.slice(0, maxSteps)) {
    const msgs = stepMessages(c, s).filter((m) => !m.flags);
    const out = msgs.filter((m) => m.dir === "out").length;
    lines.push(`${s.start.id}. [${s.start.kind}] ${s.end?.label ?? s.start.label}: ${s.end ? s.end.status : "incomplete"}, ${out} sent, ${msgs.length - out} received`);
  }
  if (c.steps.length > maxSteps) lines.push(`… and ${c.steps.length - maxSteps} more steps.`);
  return lines.join("\n");
}

/** Extra tools from elsewhere in the sniffer (the walk tools) register through this. */
export type RegisterTools = (server: McpServer, deps: { recorder: Recorder }) => void;

export function createServer(recorder: Recorder, extra: RegisterTools[] = []): McpServer {
  const server = new McpServer({ name: "patchsprite-sniffer", version: "0.0.0" }, { instructions: INSTRUCTIONS });
  let lastFile: string | undefined;

  server.registerTool("help", { description: "More on a topic: session (the order of a capture session), steps (labels and the quiet check) or walk (walking the editor with the walk tools: consent, the walk plan, guardrails).", inputSchema: { topic: z.enum(["session", "steps", "walk"]) }, annotations: ro }, async ({ topic }) => text(topic === "walk" ? walkGuide() : HELP[topic]));

  server.registerTool(
    "start_capture",
    {
      description: "Starts recording the editor's MIDI, after asking the user (see the instructions). Holds the device while the session works. See help('session').",
      inputSchema: { editor: z.string().min(1).max(128).describe("the editor's executable file name, as Task Manager shows it"), attachDelaySeconds: z.number().min(0).max(60).describe("how long to wait after the editor starts before attaching"), channelMessages: z.boolean().optional().describe("true for a device driven by MIDI channel messages (CC, PC, NRPN) rather than SysEx, so they count as traffic"), note: z.string().max(1024).optional() },
      annotations: rw,
    },
    async ({ editor, attachDelaySeconds, channelMessages, note }) => {
      try {
        const file = await recorder.start({ editorExe: editor, attachDelayS: attachDelaySeconds, channelMessages, note });
        lastFile = file;
        return text(`Capturing to ${file}. Waiting for ${editor}; check capture_status until it is attached.`, { file });
      } catch (e) {
        return refused(e);
      }
    },
  );

  server.registerTool("capture_status", { description: "Whether a capture runs, whether it is attached to the editor, and what it has seen so far.", annotations: ro }, async () => {
    const c = recorder.counts;
    if (!c) return text("No capture is running.", { running: false });
    if (recorder.failed) return text(`${recorder.failed}. Stop it with stop_capture.`, { running: true, failed: true, ...c });
    return text(`Capturing to ${recorder.file}: ${c.attached ? "attached to the editor" : "waiting for the editor"}; ${c.out} messages sent, ${c.in} received (${c.flagged} flagged); ${c.steps} steps.`, { running: true, ...c });
  });

  server.registerTool(
    "record_idle",
    { description: "Records the editor left alone (nobody touching it) so its constant polling stops counting as traffic. Do this once, after attaching and before the self-test.", inputSchema: { seconds: z.number().min(3).max(30).default(10) }, annotations: rw },
    async ({ seconds }) => {
      try {
        const set = await recorder.idle(seconds);
        return text(`Recorded ${seconds} s idle: ${set.length} polled message kinds will not count as traffic.`, { polls: set.length });
      } catch (e) {
        return refused(e);
      }
    },
  );

  server.registerTool(
    "begin_step",
    {
      description: "Marks the start of one step, before changing one control in the editor. See help('steps').",
      inputSchema: { label: z.string().min(1).max(200).describe('"control: before → after"'), kind: z.enum(["action", "manual", "selfTest"]).default("action"), mode: z.string().max(64).regex(/^[a-z][A-Za-z0-9]*$/, "a mode is its camelCase key").optional() },
      annotations: rw,
    },
    async ({ label, kind, mode }) => {
      try {
        return text(`Step ${recorder.begin(kind, label, mode)} started: make the change now, then end_step.`);
      } catch (e) {
        return refused(e);
      }
    },
  );

  server.registerTool(
    "end_step",
    { description: "Ends the open step once the MIDI has gone quiet. Give the label here if the after-value is known only now.", inputSchema: { label: z.string().min(1).max(200).optional(), note: z.string().max(1024).optional(), aborted: z.boolean().optional() }, annotations: rw },
    async ({ label, note, aborted }) => {
      try {
        const r = await recorder.end({ label, note, aborted });
        const counts = { id: r.id, status: r.status, counted: r.counted };
        if (r.selfTest) return text(r.selfTest.ok ? r.selfTest.text : `${r.selfTest.text} The capture has stopped.`, { ...counts, selfTest: r.selfTest.ok });
        return text(`Step ${r.id} ended (${r.status}): ${r.counted} counted messages.`, counts);
      } catch (e) {
        return refused(e);
      }
    },
  );

  server.registerTool("stop_capture", { description: "Stops the capture, saves it, and gives the device back to the Patchsprite app.", annotations: { ...rw, idempotentHint: true } }, async () => {
    if (!recorder.active) return text("No capture is running.");
    const file = await recorder.stop();
    return text(`Stopped. Saved ${file}.`, { file });
  });

  server.registerTool("summarize_capture", { description: "Summarizes the last capture: each step with its status and the messages it caught both ways.", annotations: ro }, async () => {
    const file = recorder.file ?? lastFile;
    if (!file) return text("There is no capture yet.");
    return text(summarize(file));
  });

  for (const register of extra) register(server, { recorder });
  return server;
}
