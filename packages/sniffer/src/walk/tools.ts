// The walk tools in the sniffer's MCP server (S11): an editor screenshot, input (click, type, keys, wheel, drag),
// reading a control through UI Automation, and the editor's file dialogs. They work only while a capture runs: the
// capture names the editor, holds the pedal lock for the whole session and records what every input makes the
// editor send. Shots are saved beside the capture, in a folder of its own.
import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { RegisterTools } from "../mcp/server.ts";
import type { Recorder } from "../recorder.ts";
import { PowerShellHost, type WindowHost } from "./host.ts";
import { parseStep, runSteps } from "./input.ts";
import { fillDialog, listDialogs, readControl } from "./read.ts";
import { takeEditorShot } from "./shot.ts";

const ro = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
// Input can change or overwrite what the editor holds, so it is marked destructive.
const input = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };

const text = (t: string, structured?: Record<string, unknown>) => ({ content: [{ type: "text" as const, text: t }], ...(structured ? { structuredContent: structured } : {}) });
const refused = (e: unknown) => ({ content: [{ type: "text" as const, text: (e as Error).message }], isError: true });

/** A capture's screenshot folder: beside the capture file, named after it. */
export const shotsDir = (captureFile: string): string => captureFile.replace(/\.jsonl$/, "") + ".shots";

export interface WalkToolOptions {
  /** Makes the window host for a capture's shot folder (default: PowerShell on Windows). */
  makeHost?: (shotRoot: string) => WindowHost;
  /** The screenshots' scale (default 0.5). */
  scale?: number;
  sleep?: (ms: number) => Promise<void>;
}

export function walkTools(o: WalkToolOptions = {}): RegisterTools {
  const makeHost = o.makeHost ?? ((root) => new PowerShellHost(root));
  const scale = o.scale ?? 0.5;
  return (server, { recorder }) => {
    let current: { file: string; host: WindowHost } | undefined;
    /** The running capture's editor and window host; refuses when no capture runs. */
    const session = (r: Recorder) => {
      const file = r.file;
      const app = r.editor;
      if (!r.active || !file || !app) throw new Error("No capture is running. The walk tools work only during a capture: start_capture first, so every input is recorded and the device is held.");
      if (current?.file !== file) {
        current?.host.close();
        current = { file, host: makeHost(shotsDir(file)) };
      }
      return { app, host: current.host, dir: shotsDir(file) };
    };
    // The capture holds the pedal lock from start to stop; input needs it still running at the moment it is sent.
    const beforeInput = async () => {
      if (!recorder.active) throw new Error("The capture stopped, so the input was not sent.");
    };

    server.registerTool(
      "editor_screenshot",
      {
        description: "A screenshot of the editor's window only (never the desktop), at half size, after bringing the editor to the front. Read click points off the latest shot. Take a new one whenever something opens or closes.",
        inputSchema: { name: z.string().min(1).max(80).describe("what the shot shows, such as \"amp block open\"") },
        annotations: ro,
      },
      async ({ name }) => {
        try {
          const s = session(recorder);
          const shot = await takeEditorShot(s.host, { app: s.app, dir: s.dir, name, scale, sleep: o.sleep });
          const data = (await readFile(shot.path)).toString("base64");
          return {
            content: [
              { type: "image" as const, data, mimeType: "image/png" },
              { type: "text" as const, text: `${shot.width} × ${shot.height}, saved to ${shot.path}. Points on this image go to editor_input and read_control as they are.` },
            ],
            structuredContent: { path: shot.path, width: shot.width, height: shot.height },
          };
        } catch (e) {
          return refused(e);
        }
      },
    );

    server.registerTool(
      "editor_input",
      {
        description: "Input to the editor, at points on the latest editor_screenshot. Steps run in order: click:X,Y dclick:X,Y rclick:X,Y wheel:X,Y,N drag:X,Y,X1,Y1 slowdrag:X,Y,X1,Y1 key:enter (or esc, tab, delete, ctrl+z, a letter...) type:TEXT wait:S. Input lands only on the editor's windows: a point covered by another window is retried for 30 s, then refused. Use it inside a step (begin_step, input, end_step) so the change is labelled.",
        inputSchema: { steps: z.array(z.string().min(1).max(500)).min(1).max(30) },
        annotations: input,
      },
      async ({ steps }) => {
        try {
          const s = session(recorder);
          const parsed = steps.map(parseStep);
          await runSteps({ host: s.host, app: s.app, beforeInput, scale, sleep: o.sleep }, parsed);
          return text(`Done: ${steps.length} step${steps.length === 1 ? "" : "s"}.`);
        } catch (e) {
          return refused(e);
        }
      },
    );

    server.registerTool(
      "read_control",
      {
        description: "The control at a point on the latest editor_screenshot, read through Windows UI Automation: its name, type and value where the editor exposes them. Many editors draw their own controls, which it can't see: then it says nothing is there, and the screenshot is the source.",
        inputSchema: { x: z.number().min(0), y: z.number().min(0) },
        annotations: ro,
      },
      async ({ x, y }) => {
        try {
          const s = session(recorder);
          const c = await readControl({ host: s.host, app: s.app, scale }, x, y);
          if (!c) return text("UI Automation sees no control of the editor's there.", { found: false });
          return text(JSON.stringify(c), { found: true, control: c });
        } catch (e) {
          return refused(e);
        }
      },
    );

    server.registerTool(
      "list_dialogs",
      {
        description: "The editor's open Windows file and folder dialogs (Open, Save As, Select Folder), with their edit boxes and buttons. Those dialogs don't show in editor_screenshot, so check here when the editor seems stuck after a click.",
        annotations: ro,
      },
      async () => {
        try {
          const s = session(recorder);
          const d = await listDialogs({ host: s.host, app: s.app, scale });
          return text(d.length ? JSON.stringify(d) : "No dialog is open.", { dialogs: d });
        } catch (e) {
          return refused(e);
        }
      },
    );

    server.registerTool(
      "fill_dialog",
      {
        description: "Types a path into one of the editor's file or folder dialogs (by its title, from list_dialogs) and presses a button by its caption, such as Save or Open. Only for files the walk plan names, such as a backup, never an import of the user's files.",
        inputSchema: { title: z.string().min(1).max(200), path: z.string().min(1).max(1024), button: z.string().min(1).max(100) },
        annotations: input,
      },
      async ({ title, path, button }) => {
        try {
          const s = session(recorder);
          const left = await fillDialog({ host: s.host, app: s.app, scale, beforeInput }, title, path, button);
          return text(left.length ? `Done. Still open: ${left.map((t) => JSON.stringify(t)).join(", ")}.` : "Done. No dialog is open now.", { remaining: left });
        } catch (e) {
          return refused(e);
        }
      },
    );
  };
}

/** The walk tools with the real Windows host. */
export const registerWalkTools: RegisterTools = walkTools();
