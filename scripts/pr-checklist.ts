// The `checklist` check (.github/workflows/checklist.yml): a pull request's body has every box under "## Merge gate"
// ticked, and a "Requirements:" line under "## Requirements" that names ids from docs/requirements.md (or the
// Patchsprite app's F/N ids, which this repo doesn't describe) or says "none (why)". Reads the body from PR_BODY.
// Prints one line per problem and exits 1 when there is any.

import { readFileSync } from "node:fs";

const BOXES = ["Simplify", "Code review", "Security review", "Tests"];

/** The problems with a pull request body, given the ids docs/requirements.md lists. */
export function problems(body: string, ids: Set<string>): string[] {
  const out: string[] = [];
  // comments and fenced code say nothing, so a template's example can't tick a box or name an id
  const text = body.replace(/\r\n?/g, "\n").replace(/<!--[\s\S]*?-->/g, "").replace(/^```[\s\S]*?^```/gm, "");
  const section = (name: string) => {
    const m = new RegExp(`^## ${name}[ \\t]*$([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, "m").exec(text);
    return m ? m[1] : "";
  };
  const gate = section("Merge gate");
  for (const name of BOXES) {
    if (!new RegExp(`^[ \\t]*[-*] \\[[xX]\\] \\*\\*${name}\\*\\*`, "m").test(gate)) {
      out.push(`"${name}" is not ticked under "## Merge gate"`);
    }
  }
  const line = /^[ \t]*Requirements:[ \t]*(.*?)[ \t]*$/m.exec(section("Requirements"))?.[1];
  if (!line) {
    out.push('no "Requirements: S1, S4" line (or "Requirements: none (why)") under "## Requirements"');
  } else if (/^none\b/i.test(line)) {
    if (!/^none\s*\(\s*\S.*\)$/i.test(line)) out.push('say why no id fits, as "Requirements: none (why)"');
  } else {
    for (const id of line.split(/[\s,]+/).filter(Boolean)) {
      if (!ids.has(id) && !/^[FN]\d+$/.test(id)) out.push(`"${id}" is not an id in docs/requirements.md`);
    }
  }
  return out;
}

/** The ids in docs/requirements.md's table. */
export function requirementIds(markdown: string): Set<string> {
  return new Set([...markdown.matchAll(/^\| (S\d+) \|/gm)].map((m) => m[1]));
}

if (import.meta.main) {
  const ids = requirementIds(readFileSync(new URL("../docs/requirements.md", import.meta.url), "utf8"));
  const found = problems(process.env.PR_BODY ?? "", ids);
  for (const p of found) console.log(`::error::PR checklist: ${p}`);
  if (!found.length) console.log("PR checklist: every box is ticked and the Requirements line is in order.");
  process.exit(found.length ? 1 : 0);
}
