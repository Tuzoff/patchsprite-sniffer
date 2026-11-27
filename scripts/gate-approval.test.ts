import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, gateFiles, humanOnly, type ChangedFile, type LabelEvent } from "./gate-approval.ts";

const PUSH = "2026-11-27T18:00:00Z";
const labeled = (name: string, at: string): LabelEvent => ({ event: "labeled", created_at: at, label: { name }, actor: { login: "maintainer" } });
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

test("only a maintainer may approve permissions, secrets, triggers, this check and unseen diffs", () => {
  for (const line of ["+permissions:", "+  contents: write", "-  pull-requests: read", "+  pull_request_target:", "+  workflow_run:", "+  X: ${{ secrets.T }}", "+permissions: write-all", "+  id-token: 'write'", "+  contents: \"write\"", "+on: [workflow_run]", "+  issue_comment:", "+        secrets: inherit", "+      GH_TOKEN: ${{ github.token }}", "+      persist-credentials: true"]) {
    assert.notEqual(humanOnly([wf(`@@ -1 +1 @@\n${line}`)]), "", line);
  }
  assert.notEqual(humanOnly([{ filename: ".github/workflows/gate-approval.yml", patch: "@@\n+# a comment" }]), "");
  assert.notEqual(humanOnly([{ filename: "scripts/gate-approval.ts", patch: "@@\n+// a comment" }]), "");
  assert.notEqual(humanOnly([{ filename: ".claude/settings.json", patch: "@@\n+{}" }]), "");
  assert.notEqual(humanOnly([{ filename: ".github/workflows/big.yml" }]), "", "no diff shown");
  assert.equal(humanOnly([wf("@@ -1 +1 @@\n   permissions: read\n-  node-version: 20\n+  node-version: 22")]), "", "an unchanged context line");
  const f = [wf("@@ -1 +1 @@\n+permissions: {}")];
  assert.equal(decide(f, ["ai-gate-approved"], [labeled("ai-gate-approved", "2026-11-27T18:00:01Z")], PUSH).ok, false);
  assert.equal(decide(f, ["gate-approved"], [labeled("gate-approved", "2026-11-27T18:00:01Z")], PUSH).ok, true);
});
