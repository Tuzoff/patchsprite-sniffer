// spec-review-comments.yml: a "Spec review: OK (sniffer|scope)" comment adds that thread's label one at a time (never replacing
// the list), "withdrawn" takes it off, and the spec-review check is re-run. Run with a fake gh.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const YML = readFileSync(fileURLToPath(new URL("../.github/workflows/spec-review-comments.yml", import.meta.url)), "utf8");
const from = YML.indexOf("- name: Add or take off the spec-ok label");
const lines = YML.slice(YML.indexOf("run: |\n", from) + "run: |\n".length).split("\n");
const indent = /^ */.exec(lines[0])![0].length;
const out: string[] = [];
for (const l of lines) {
  if (l.trim() && /^ */.exec(l)![0].length < indent) break;
  out.push(l.slice(indent));
}
const SCRIPT = out.join("\n");

// `runs` is what each listing of the head's spec-review runs answers in turn (the last one repeats): "<id> <status>".
function run(body: string, runs = ["900 completed"]) {
  const dir = mkdtempSync(join(tmpdir(), "spec-review-"));
  try {
    const gh = join(dir, "gh");
    writeFileSync(join(dir, "runs"), runs.join("\n") + "\n");
    writeFileSync(
      gh,
      `#!/usr/bin/env bash
echo "$*" >> "${join(dir, "calls")}"
case "$*" in
  *"pulls/7 --jq .head.sha"*) echo ${"e".repeat(40)} ;;
  *"spec-review.yml/runs"*)
    n=$(grep -c "spec-review.yml/runs" "${join(dir, "calls")}")
    sed -n "\${n}p" "${join(dir, "runs")}" | grep . || tail -n 1 "${join(dir, "runs")}" ;;
esac
`,
    );
    chmodSync(gh, 0o755);
    const r = spawnSync("bash", ["-c", SCRIPT], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        GITHUB_REPOSITORY: "acme/sniffer",
        PR: "7",
        BODY: body,
        SPEC_REVIEW_PAUSE: "0",
      },
    });
    let calls: string[] = [];
    try {
      calls = readFileSync(join(dir, "calls"), "utf8").trim().split("\n");
    } catch {}
    return { status: r.status, out: r.stdout + r.stderr, calls };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("an OK comment adds its thread's label one at a time and re-runs the spec-review check", () => {
  const r = run("Looks good.\r\nSpec review: OK (scope)\r\n");
  assert.equal(r.status, 0, r.out);
  assert.ok(r.calls.includes("api -X POST repos/acme/sniffer/issues/7/labels -f labels[]=spec-ok: scope --silent"), r.calls.join("\n"));
  assert.ok(r.calls.includes("api -X POST repos/acme/sniffer/actions/runs/900/rerun --silent"));
  assert.equal(r.calls.filter((c) => / -X PUT | labels -f labels\[\]=spec-ok: sniffer/.test(c)).length, 0, "never replaces the list");
});

test("withdrawn takes the label off; other text, or another thread's name, does nothing", () => {
  const w = run("Spec review: withdrawn (sniffer)");
  assert.ok(w.calls.some((c) => c.startsWith("api -X DELETE repos/acme/sniffer/issues/7/labels/spec-ok%3A%20sniffer")), w.calls.join("\n"));
  for (const body of ["Spec review: OK", "Spec review: OK (builder)", "I'd say Spec review: OK (scope) later"]) {
    const r = run(body);
    assert.equal(r.status, 0, r.out);
    assert.deepEqual(r.calls, [], body);
  }
});

test("a spec-review run still going is waited for, never passed over for an older one", () => {
  const r = run("Spec review: OK (sniffer)", ["901 in_progress", "901 queued", "901 completed"]);
  assert.equal(r.status, 0, r.out);
  const reruns = r.calls.filter((c) => c.endsWith("/rerun --silent"));
  assert.deepEqual(reruns, ["api -X POST repos/acme/sniffer/actions/runs/901/rerun --silent"], r.calls.join("\n"));
  assert.equal(r.calls.filter((c) => c.includes("spec-review.yml/runs")).length, 3);
  const none = run("Spec review: OK (sniffer)", [""]);
  assert.equal(none.status, 0, none.out);
  assert.match(none.out, /No finished spec-review run/);
});

test("only comments by people with write access count, and the check reads the labels as they are now", () => {
  assert.match(YML, /contains\(fromJSON\('\["OWNER","MEMBER","COLLABORATOR"\]'\), github\.event\.comment\.author_association\)/);
  const check = readFileSync(fileURLToPath(new URL("../.github/workflows/spec-review.yml", import.meta.url)), "utf8");
  assert.match(check, /permissions:\n  pull-requests: read\n/);
  assert.match(check, /labels="\$\(gh api "repos\/\$GITHUB_REPOSITORY\/pulls\/\$PR" --jq '\.labels\[\]\.name'/);
});
