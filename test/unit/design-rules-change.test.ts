/** Berkay's decision (2026-09-06): propose directions when CREATING something new; when CHANGING something
 *  that already exists, just do it. Before this, 6 of 24 measured runs ended at a question, three of them
 *  opening with design_direction, on prompts that were mostly visual ("make the background black"). The rule
 *  for new work stands unchanged ("Tasarımda varsayılan yok"); this pins the boundary and that design_audit
 *  still applies to both kinds of work. */

import { expect, test } from "bun:test";
import { DESIGN_RULES, designPromptSection } from "../../src/design/rules.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("the direction question is scoped to NEW work; a change to something on the screen is done, not proposed; the boundary is one test the model can apply", () => {
  const head = DESIGN_RULES.slice(0, DESIGN_RULES.indexOf("## The defaults to climb out of"));
  expect(head).toContain("This question is about NEW work: a page, screen or component that is not on the screen yet.");
  expect(head).toContain("A change\nto something that already exists is not this question.");
  // the examples are Berkay's own words for the case, so the model recognises them when they arrive
  expect(head).toContain("\"Make the background black\"");
  expect(head).toContain("\"add a shadow to\nthe text\"");
  expect(head).toContain("\"make this bigger\"");
  expect(head).toContain("do it, now, in the direction the existing code already shows, and do not stop at a proposal,");
  expect(head).toContain("whether or not this project has a recorded direction");
  // the boundary in one sentence, applicable without a taxonomy
  expect(head).toContain("if the person could point at\nthe thing on the screen, it exists and you change it; if they could not, it is new and the direction is\ndecided first.");
  // a change that contradicts a recorded direction is still made, and said, so the human decides about the direction
  expect(head).toContain("make the change and say so in one\nline, so the human can decide whether the direction moves.");
  // the new-work rule itself is unchanged in force: three directions, human chooses, nothing built while open
  expect(head).toContain("about to write NEW UI, stop and propose THREE\n  directions first");
  expect(head).toContain("Let the human choose. Do not build while the question is open, and do not pick for them.");
  expect(head).toContain("There is no default look.");
});

test("design_audit applies to both: writing UI and changing how an existing screen looks", () => {
  const check = DESIGN_RULES.slice(DESIGN_RULES.indexOf("## Check yourself"));
  expect(check).toContain("After writing UI, or changing how an existing screen looks (the black background, the shadow, the\nbigger heading included), run `design_audit` on the source you touched");
});

test("a project with no recorded direction still gets the proposal instruction for its NEXT new UI — the boundary does not weaken the new-work case", () => {
  const cwd = mkdtempSync(join(tmpdir(), "rovecode-design-rules-"));
  try {
    const section = designPromptSection(cwd);
    expect(section).toContain("No design direction is recorded yet");
    expect(section).toContain("The next interface work in this project starts with the proposal above.");
    expect(section).toContain("This question is about NEW work");
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
