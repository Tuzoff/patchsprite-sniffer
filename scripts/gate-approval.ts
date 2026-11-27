// The `gate-approval` commit status (.github/workflows/gate-approval.yml). A pull request that changes how this repo's
// pull requests are checked or merged (anything under .github/ or .claude/, this script, the checklist script, the
// CLA and the licence) needs a maintainer's approval: the `gate-approved` label, added after the pull request's last
// push. The reviewer's `ai-gate-approved` label may stand in for it, except on a change only a maintainer may approve
// (human-only below): a workflow line that adds write access, removes a permissions key, or touches secrets, the job's
// token, persist-credentials or the pull_request_target, workflow_run and issue_comment triggers; a YAML anchor, alias or
// escape the rule can't follow; this check's own files; or a diff GitHub doesn't show. Read-only and narrowing
// permission lines are the reviewer's: they can be undone (27 Nov 2026). Every other pull request passes at once.
//
// A push is dated by the start of this pull request's latest unbroken streak of runs on the head, or a later force-push,
// reopen, branch restore or change of base branch; a label added before it is stale. Only people with triage rights or more can label, so the labels are their word.

const GATE_DIRS = [".github/", ".claude/"];
const GATE_FILES = new Set(["scripts/gate-approval.ts", "scripts/pr-checklist.ts", "CLA.md", "LICENSE"]);
/** this check's own files: only a maintainer may approve a change to them */
const SELF = new Set([".github/workflows/gate-approval.yml", "scripts/gate-approval.ts"]);
/** a changed workflow line, added or removed, that only a maintainer may approve */
const RISKY_LINE = /\bsecrets\b|github\.token|GITHUB_TOKEN|persist-credentials|pull_request_target|workflow_run|issue_comment/i;
/** an added line granting write, quotes and tags set aside: `scope: write`, `write-all`, or write as a value on its own line */
const WRITE = /:\s*write\b|\bwrite-all\b|^\s*(-\s*)?write\s*[,\]}]*\s*(#.*)?$/i;
/** a line as YAML reads its words: quotes and tags (`!!str write`) set aside */
const bare = (l: string) => l.replace(/["']/g, "").replace(/(^|[\s:,[{])![^\s,\]}]*/g, "$1");
/** a removed permissions key: without it the job or workflow falls back to a wider default */
const PERMISSIONS_KEY = /\bpermissions["']?\s*:/i;
/** a workflow GitHub runs, and a top-level permissions key in it */
const WORKFLOW = /^\.github\/workflows\/[^/]+\.ya?ml$/;
const TOP_PERMISSIONS = /^["']?permissions["']?\s*:/;
/** YAML anchors, aliases and escapes can carry a grant or trigger from elsewhere, which line reading can't follow */
const OPAQUE = /(^|[\s:,[{]|^\s*-)\s*[&*][A-Za-z_][\w-]*(?=\s|$|[,\]}])|\\[xuU][0-9A-Fa-f]{2}/;

export type ChangedFile = { filename: string; previous_filename?: string; status?: string; patch?: string };
export type LabelEvent = { event: string; created_at: string; label?: { name: string }; actor?: { login: string } };

const names = (f: ChangedFile) => [f.filename, f.previous_filename].filter((n): n is string => !!n);
const isGate = (name: string) => GATE_FILES.has(name) || GATE_DIRS.some((d) => name.startsWith(d));

/** the changed files that are part of the gate */
export function gateFiles(files: ChangedFile[]): ChangedFile[] {
  return files.filter((f) => names(f).some(isGate));
}

/**
 * A line ending in \ continues on the next (a double-quoted YAML value, or a shell command): the new file's lines joined
 * across each such break that an added line is part of, context lines included, so a word split across them is seen.
 */
function continued(patch: string): string[] {
  const out: string[] = [];
  let run: { text: string; n: number; add: boolean } | null = null;
  for (const p of patch.split("\n")) {
    if (p[0] !== "+" && p[0] !== " ") {
      if (p[0] !== "-") run = null;
      continue;
    }
    const l = p.slice(1);
    run = run ? { text: run.text.replace(/\\\s*$/, "") + l.trimStart(), n: run.n + 1, add: run.add || p[0] === "+" } : { text: l, n: 1, add: p[0] === "+" };
    if (!/\\\s*$/.test(run.text)) {
      if (run.n > 1 && run.add) out.push(run.text);
      run = null;
    }
  }
  return out;
}

/** why only a maintainer may approve these gate changes, or "" when the reviewer's label may stand in */
export function humanOnly(gate: ChangedFile[]): string {
  for (const f of gate) {
    if (names(f).some((n) => SELF.has(n) || n.startsWith(".claude/"))) return `${f.filename} is part of this check`;
    if (f.patch === undefined) return `GitHub shows no diff for ${f.filename}`;
    // the files API's patch has no ---/+++ headers: every line after its sign is the file's
    const lines = f.patch.split("\n");
    const added = [...lines.filter((l) => l[0] === "+").map((l) => l.slice(1)), ...continued(f.patch)];
    const removed = lines.filter((l) => l[0] === "-").map((l) => l.slice(1));
    if ([...added, ...removed].some((l) => RISKY_LINE.test(l))) return `${f.filename} changes secrets, the token or a trigger`;
    if (added.some((l) => WRITE.test(bare(l)))) return `${f.filename} grants write access`;
    if (removed.some((l) => PERMISSIONS_KEY.test(l))) return `${f.filename} removes a permissions key`;
    if (added.some((l) => OPAQUE.test(l))) return `${f.filename} has a YAML anchor, alias or escape the check can't follow`;
    // a workflow new to GitHub (added, or moved in from where it never ran) without a top-level permissions key runs
    // with the repository's default token
    const isWorkflow = (n?: string) => !!n && WORKFLOW.test(n);
    const isNew = f.status === "added" || f.status === "copied" || (isWorkflow(f.filename) && !isWorkflow(f.previous_filename) && !!f.previous_filename);
    if (isWorkflow(f.filename) && isNew && !added.some((l) => TOP_PERMISSIONS.test(l)))
      return `${f.filename} is a new workflow without a top-level permissions key`;
  }
  return "";
}

/** who may approve: the maintainer's login, which the reviewer thread also posts under (labels need triage rights) */
const APPROVERS = new Set(["Tuzoff"]);

/** timeline events that change the head or the files as a push does; going back to an earlier head always needs one */
const RESETS = new Set(["base_ref_changed", "head_ref_force_pushed", "head_ref_restored", "reopened"]);

/**
 * When the head was pushed: the first of this pull request's runs in the unbroken streak on the current head, newest
 * first (so pushing A, then B, then A again dates A from its last push, not its first), or a later reset event (a
 * deleted run can hide B, but not the force-push back to A). runs: this pull request's runs of this workflow, any order.
 */
export function pushedAt(runs: { created_at: string; head_sha: string }[], head: string, events: LabelEvent[]): string {
  const newest = [...runs].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  let start: string | undefined;
  for (const r of newest) {
    if (r.head_sha !== head) break;
    start = r.created_at;
  }
  // this run is one of them, so there is always a start; without one, nothing earlier than now counts
  const times = [start ?? new Date().toISOString(), ...events.filter((e) => RESETS.has(e.event)).map((e) => e.created_at)];
  return times.reduce((a, b) => (Date.parse(b) > Date.parse(a) ? b : a));
}

/** when the label was last added, if it is on the pull request now */
function addedAt(label: string, labels: string[], events: LabelEvent[]): LabelEvent | undefined {
  if (!labels.includes(label)) return undefined;
  return events.filter((e) => e.event === "labeled" && e.label?.name === label).sort((a, b) => a.created_at.localeCompare(b.created_at)).at(-1);
}

export type Verdict = { ok: boolean; description: string };

/** the verdict, given the changed files, the labels now, the label events and when this head was first seen */
export function decide(files: ChangedFile[], labels: string[], events: LabelEvent[], pushedAt: string): Verdict {
  // labelled after the push, by an approver
  const gate = gateFiles(files);
  if (gate.length === 0) return { ok: true, description: "No gate files changed." };
  const why = humanOnly(gate);
  const allowed = why ? ["gate-approved"] : ["gate-approved", "ai-gate-approved"];
  for (const label of allowed) {
    const e = addedAt(label, labels, events);
    if (e && APPROVERS.has(e.actor?.login ?? "") && Date.parse(e.created_at) > Date.parse(pushedAt)) return { ok: true, description: `${label} by ${e.actor?.login ?? "?"} after the last push.` };
  }
  return {
    ok: false,
    description: why
      ? `Needs gate-approved after the last push (${why}).`
      : "Needs gate-approved, or ai-gate-approved, after the last push.",
  };
}

export async function main(): Promise<void> {
  const env = (k: string) => process.env[k] ?? "";
  const repo = env("GITHUB_REPOSITORY");
  const pr = env("PR_NUMBER");
  const api = async (path: string): Promise<any> => {
    const r = await fetch(`https://api.github.com/${path}`, {
      headers: { authorization: `Bearer ${env("GITHUB_TOKEN")}`, accept: "application/vnd.github+json" },
    });
    if (!r.ok) throw new Error(`GET ${path}: ${r.status}`);
    return r.json();
  };
  const all = async (path: string, key?: string): Promise<any[]> => {
    const out: any[] = [];
    for (let page = 1; ; page++) {
      const body = await api(`${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
      const batch = key ? body[key] : body;
      out.push(...batch);
      if (batch.length < 100) return out;
    }
  };
  const status = async (sha: string, state: "pending" | "success" | "failure", description: string) => {
    console.log(`${state}: ${description}`);
    const r = await fetch(`https://api.github.com/repos/${repo}/statuses/${sha}`, {
      method: "POST",
      headers: { authorization: `Bearer ${env("GITHUB_TOKEN")}`, accept: "application/vnd.github+json" },
      body: JSON.stringify({ state, context: "gate-approval", description: description.slice(0, 140), target_url: env("RUN_URL") }),
    });
    if (!r.ok) throw new Error(`setting the status: ${r.status}`);
  };

  const pull = await api(`repos/${repo}/pulls/${pr}`);
  const head: string = pull.head.sha;
  // a newer head than this run's event has its own run, which decides
  if (head !== env("HEAD_SHA")) return console.log(`The pull request moved on to ${head}; its own run decides.`);
  await status(head, "pending", "Checking for gate changes and approval.");
  // a status belongs to a commit, not a pull request: one into another branch with the same head could post success
  if (pull.base.ref !== "main") return status(head, "failure", "Only pull requests into main are checked here.");
  try {
    const files = await all(`repos/${repo}/pulls/${pr}/files`);
    if (files.length >= 3000) throw new Error("GitHub lists at most 3000 files");
    const events = await all(`repos/${repo}/issues/${pr}/timeline`);
    // only this pull request's runs (named by the workflow's run-name), every head it has had: another pull request
    // may have shown the same commit, and an earlier visit of this head would date this push too early. GitHub lists the
    // newest 1000; a run it leaves out (older, or from before a branch rename) only dates the push later
    const branch = encodeURIComponent(pull.head.ref);
    const runs: { created_at: string; head_sha: string; display_title: string }[] = await all(
      `repos/${repo}/actions/workflows/gate-approval.yml/runs?event=pull_request_target&branch=${branch}`,
      "workflow_runs",
    );
    const pushed = pushedAt(runs.filter((r) => r.display_title === `gate-approval #${pr}`), head, events);
    const v = decide(files, pull.labels.map((l: { name: string }) => l.name), events, pushed);
    console.log(`Head ${head} pushed at ${pushed}.`);
    await status(head, v.ok ? "success" : "failure", v.description);
  } catch (e) {
    await status(head, "failure", "The check could not read the pull request; re-run it.");
    throw e;
  }
}

if (import.meta.main) await main();
