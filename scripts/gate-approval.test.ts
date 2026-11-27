import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, gateFiles, humanOnly, pushedAt, type ChangedFile, type LabelEvent } from "./gate-approval.ts";

const PUSH = "2026-11-27T18:00:00Z";
const labeled = (name: string, at: string): LabelEvent => ({ event: "labeled", created_at: at, label: { name }, actor: { login: "Tuzoff" } });
const doc: ChangedFile = { filename: "packages/sniffer/src/walk.ts", patch: "@@ -1 +1 @@\n-a\n+b" };
const wf = (patch: string): ChangedFile => ({ filename: ".github/workflows/test.yml", patch });

test("a pull request that leaves the gate alone passes at once", () => {
  assert.deepEqual(gateFiles([doc]), []);
  assert.equal(decide([doc], [], [], PUSH).ok, true);
});

test("a gate change needs a label added after the last push", () => {
  const f = [wf("@@ -1 +1 @@\n-  node-version: 20\n+  node-version: 22")];
  assert.equal(decide(f, [], [], PUSH).ok, false);
  assert.equal(decide(f, ["gate-approved"], [labeled("gate-approved", "2026-11-27T17:59:59Z")], PUSH).ok, false, "before the push");
  assert.equal(decide(f, ["gate-approved"], [labeled("gate-approved", "2026-11-27T18:00:01Z")], PUSH).ok, true);
  assert.equal(decide(f, ["ai-gate-approved"], [labeled("ai-gate-approved", "2026-11-27T18:00:01Z")], PUSH).ok, true, "the reviewer may stand in");
  assert.equal(decide(f, [], [labeled("gate-approved", "2026-11-27T18:00:01Z")], PUSH).ok, false, "a label taken off again");
  assert.equal(decide(f, ["gate-approved"], [labeled("gate-approved", "2026-11-27T18:00:00Z")], "2026-11-27T18:00:00.500Z").ok, false, "times, not strings");
});

test("the gate files: .github, .claude, the check scripts, the CLA and the licence, renames included", () => {
  for (const filename of [".github/pull_request_template.md", ".claude/settings.json", "scripts/pr-checklist.ts", "scripts/gate-approval.ts", "CLA.md", "LICENSE"]) {
    assert.equal(gateFiles([{ filename, patch: "" }]).length, 1, filename);
  }
  assert.equal(gateFiles([{ filename: "docs/x.md", previous_filename: ".github/x.md", patch: "" }]).length, 1);
  assert.equal(gateFiles([{ filename: "scripts/schemas.ts", patch: "" }]).length, 0);
});

test("only a maintainer may approve write grants, removed permissions keys, secrets, triggers, this check and unseen diffs", () => {
  for (const line of ["+  contents: write", "+      contents:\n+        write", "-permissions: read-all", "-    permissions:", "-      persist-credentials: false", "+  x: *anchor", "+  \"pull_\\x72equest_target\": {}", "+  pull_request_target:", "+  workflow_run:", "+  X: ${{ secrets.T }}", "+permissions: write-all", "+  id-token: 'write'", "+  contents: \"write\"", "+on: [workflow_run]", "+  issue_comment:", "+        secrets: inherit", "+      GH_TOKEN: ${{ github.token }}", "+      persist-credentials: true", "+      contents: !!str write", "+      contents: \"wr\\\n+        ite\"", "+      X: \"${{ sec\\\n+        rets.T }}\"", "+++ ${{ secrets.T }}", "--- persist-credentials: false"]) {
    assert.notEqual(humanOnly([wf(`@@ -1 +1 @@\n${line}`)]), "", line);
  }
  assert.notEqual(humanOnly([{ filename: ".github/workflows/gate-approval.yml", patch: "@@\n+# a comment" }]), "");
  assert.notEqual(humanOnly([{ filename: "scripts/gate-approval.ts", patch: "@@\n+// a comment" }]), "");
  assert.notEqual(humanOnly([{ filename: ".claude/settings.json", patch: "@@\n+{}" }]), "");
  assert.notEqual(humanOnly([{ filename: ".github/workflows/big.yml" }]), "", "no diff shown");
  assert.equal(humanOnly([wf("@@ -1 +1 @@\n   permissions: read\n-  node-version: 20\n+  node-version: 22")]), "", "an unchanged context line");
  const f = [wf("@@ -1 +1 @@\n+  contents: write")];
  assert.equal(decide(f, ["ai-gate-approved"], [labeled("ai-gate-approved", "2026-11-27T18:00:01Z")], PUSH).ok, false);
  assert.equal(decide(f, ["gate-approved"], [labeled("gate-approved", "2026-11-27T18:00:01Z")], PUSH).ok, true);
});

test("read-only and narrowing permission lines are the reviewer's (27 Nov 2026)", () => {
  for (const line of ["+permissions: {}", "+permissions:\n+  contents: read", "+  issues: none", "-  pull-requests: read", "-  contents: write", "+permissions: read-all", "+  # write access is not needed here"]) {
    assert.equal(humanOnly([wf(`@@ -1 +1 @@\n${line}`)]), "", line);
  }
  const f = [wf("@@ -1 +1 @@\n+permissions: {}")];
  assert.equal(decide(f, ["ai-gate-approved"], [labeled("ai-gate-approved", "2026-11-27T18:00:01Z")], PUSH).ok, true);
});

test("a push is dated by the current head's unbroken streak of runs, so A, B, A again dates A from its return", () => {
  const run = (head_sha: string, created_at: string) => ({ head_sha, created_at });
  const runs = [run("A", "2026-11-27T10:00:00Z"), run("A", "2026-11-27T10:05:00Z"), run("B", "2026-11-27T11:00:00Z"), run("A", "2026-11-27T12:00:00Z"), run("A", "2026-11-27T12:01:00Z")];
  assert.equal(pushedAt(runs, "A", []), "2026-11-27T12:00:00Z");
  assert.equal(pushedAt(runs.slice(0, 3), "B", []), "2026-11-27T11:00:00Z");
  const f = [{ filename: ".github/workflows/test.yml", patch: "@@\n+  node-version: 22" }];
  // labelled on A's first visit, then B, then A again: the old label is stale
  assert.equal(decide(f, ["gate-approved"], [{ event: "labeled", created_at: "2026-11-27T10:10:00Z", label: { name: "gate-approved" }, actor: { login: "Tuzoff" } }], pushedAt(runs, "A", [])).ok, false);
});

test("a new base branch counts as a push", () => {
  const runs = [{ head_sha: "A", created_at: "2026-11-27T10:00:00Z" }];
  assert.equal(pushedAt(runs, "A", [{ event: "base_ref_changed", created_at: "2026-11-27T11:00:00Z" }]), "2026-11-27T11:00:00Z");
});

test("only an approver's label counts", () => {
  const f = [{ filename: ".github/workflows/test.yml", patch: "@@\n+  node-version: 22" }];
  const by = (login: string): LabelEvent => ({ event: "labeled", created_at: "2026-11-27T18:00:01Z", label: { name: "gate-approved" }, actor: { login } });
  assert.equal(decide(f, ["gate-approved"], [by("someone-else")], PUSH).ok, false);
  assert.equal(decide(f, ["gate-approved"], [by("Tuzoff")], PUSH).ok, true);
});

test("a force-push, reopen or branch restore counts as a push, so a deleted run can't hide one", () => {
  const runs = [{ head_sha: "A", created_at: "2026-11-27T10:00:00Z" }];
  for (const event of ["head_ref_force_pushed", "reopened", "head_ref_restored"]) {
    assert.equal(pushedAt(runs, "A", [{ event, created_at: "2026-11-27T11:00:00Z" }]), "2026-11-27T11:00:00Z", event);
  }
  assert.equal(pushedAt(runs, "A", [labeled("gate-approved", "2026-11-27T11:00:00Z")]), "2026-11-27T10:00:00Z");
});
