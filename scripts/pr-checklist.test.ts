import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { problems, requirementIds } from "./pr-checklist.ts";

const IDS = requirementIds();
const TEMPLATE = readFileSync(new URL("../.github/pull_request_template.md", import.meta.url), "utf8");
const ticked = (requirements: string) =>
  TEMPLATE.replace(/^Requirements:.*$/m, `Requirements: ${requirements}`).replaceAll("- [ ] **", "- [x] **");

test("docs/requirements.md's ids are read", () => {
  assert.ok(IDS.has("S1") && IDS.has("S17"));
  assert.ok(!IDS.has("S999"), "an id the table doesn't list");
});

test("the template, filled in, passes", () => {
  assert.deepEqual(problems(ticked("S1, S4"), IDS), []);
  assert.deepEqual(problems(ticked("S4 F39"), IDS), [], "an app id may be named, undescribed");
  assert.deepEqual(problems(ticked("none (CI only)"), IDS), []);
});

test("the template as it comes fails on every box and the empty line", () => {
  const p = problems(TEMPLATE, IDS);
  for (const box of ["Simplify", "Code review", "Security review", "Tests"]) assert.ok(p.some((l) => l.includes(`"${box}"`)), box);
  assert.ok(p.some((l) => l.includes('no "Requirements:')));
});

test("an unknown id, or none without a reason, fails", () => {
  assert.deepEqual(problems(ticked("S999"), IDS), ['"S999" is not an id in docs/requirements.md']);
  assert.deepEqual(problems(ticked("none"), IDS), ['say why no id fits, as "Requirements: none (why)"']);
});

test("a box ticked only inside a comment or a code block doesn't count", () => {
  const body = TEMPLATE.replace("- [ ] **Simplify**", "<!-- - [x] **Simplify** -->\n```\n- [x] **Simplify**\n```");
  assert.ok(problems(body.replace(/^Requirements:.*$/m, "Requirements: S1"), IDS).some((l) => l.includes('"Simplify"')));
});

test("a box hidden in an indented or tilde fence, an unclosed comment or an indented code block doesn't count", () => {
  for (const hide of ["  ```\n- [x] **Simplify**\n  ```", "~~~\n- [x] **Simplify**\n~~~", "<!--\n- [x] **Simplify**", "<!<!-- -->--\n- [x] **Simplify**\n-->", "    - [x] **Simplify**"]) {
    const body = ticked("S1").replace("- [x] **Simplify**", hide);
    assert.ok(problems(body, IDS).some((l) => l.includes('"Simplify"')), hide);
  }
});

test("a filled Requirements line below a leftover empty one counts, and ids may be split by semicolons", () => {
  assert.deepEqual(problems(ticked("S1; S4").replace("Requirements: S1; S4", "Requirements:\nRequirements: S1; S4"), IDS), []);
  assert.deepEqual(problems(ticked("F0"), IDS), ['"F0" is not an id in docs/requirements.md']);
});
