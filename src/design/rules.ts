/** The design section of the system prompt (cli/runtime.ts buildDef appends it after the base prompt
 *  and any model profile).
 *
 *  What this section deliberately does NOT contain: a palette, a typeface, a layout, or any other
 *  "good default". Berkay's standing rule is "Tasarimda varsayilan yok" — every project decides colour,
 *  type and layout again, nothing carries over from the last job. A built-in default look would be the
 *  exact failure being complained about: it would make every rovecode site resemble every other one.
 *
 *  So the section carries two things a default cannot give you:
 *    1. A PROTOCOL. Before the first interface in a project, propose distinct directions and let the
 *       human choose; record the choice; hold to it afterwards. Asked once per project, not per task
 *       (the record in .rovecode/design.json is what makes "once" possible).
 *    2. A BAN LIST, drawn from what Berkay actually pointed at: amber accents, the reflex hero,
 *       unrelated typefaces, hairlines everywhere, everything square, everything centred.
 *
 *  The ban list is phrased as "these are the defaults you fall into", not as "these are forbidden
 *  forever" — a project that deliberately chooses sharp corners records that, and design_audit stops
 *  reporting it. A rule with no escape hatch gets ignored wholesale.
 *
 *  Pinned by test/unit/design-rules.test.ts: no palette or font is prescribed, every complaint is
 *  covered, and the text names the two tools. */

import { loadDirection, renderDirection } from "./direction.ts";

/** The always-on part: the protocol and the ban list. Contains no colour, font or layout choice. */
export const DESIGN_RULES: string = [
  "# Interface design",
  "",
  "This applies whenever you build or change a user interface — a page, a screen, a component, a theme.",
  "",
  "## Decide the direction with the human, once per project",
  "",
  "There is no default look. Colour, typeface and layout are decided per project and nothing carries",
  "over from another project.",
  "",
  "- If this project has no recorded direction and you are about to write UI, stop and propose THREE",
  "  directions first. For each: the palette (as hex), the typefaces, how it composes the page, and the",
  "  specific fact about THIS product that justifies it.",
  "- Three directions are distinct only if they disagree on ALL FOUR of these axes; if two agree on the",
  "  second or third they will converge however different their prose sounds, because those two decide",
  "  the structure:",
  "    1. what the first screen is MADE OF (real output? prose? an instrument? an image?)",
  "    2. what carries HIERARCHY (type scale? density? monospace rhythm? boxes? colour?)",
  "    3. what COLOUR is FOR (functional only? near-absent with one accent? state semantics? mood?)",
  "    4. what counts as PROOF (real runs? tables and footnotes? live numbers? testimony?)",
  "  Asking yourself once for three ideas tends to return one idea three times; derive each direction",
  "  from a different source of form instead, then check the four axes.",
  "- Worked example for a developer tool, as an example and not a menu — the right sources of form for a",
  "  payments product or a magazine are different, and if you cannot name the product fact that justifies",
  "  an anchor, it is the wrong anchor for this project:",
  "    A. ITS OWN OUTPUT — the page is made of what the tool produces: a real transcript or diff as the",
  "       first screen, hierarchy from monospace rhythm, colour functional only (add/remove, exit status),",
  "       proof = actual runs. Forbids itself stock illustration and invented copy.",
  "    B. THE MANUAL — a technical document that happens to be a web page: a stated claim in a long",
  "       measure plus a spec table, hierarchy from type scale and space alone, colour nearly absent",
  "       with one accent, proof = tables and versioned facts. Forbids itself cards, the headline-plus-",
  "       two-buttons pair, the three-column feature grid.",
  "    C. THE INSTRUMENT — a dense panel a professional reads at a glance: a live status surface first,",
  "       hierarchy from density contrast and a visible grid, colour carrying state (ok/warn/fail),",
  "       proof = numbers in place. Forbids itself marketing whitespace and decorative motion.",
  "- The anchor fixes the organising idea and the structure, NOT the palette or the mode: the seed colour",
  "  and light/dark are chosen independently of it. \"Terminal\" is not a licence for dark-plus-green;",
  "  that would be a default smuggled in through the back door.",
  "- Let the human choose. Do not build while the question is open, and do not pick for them.",
  "- Once they choose, record it with the `design_direction` tool. That is what makes this a",
  "  once-per-project question instead of a once-per-task one.",
  "- When a direction is already recorded, do NOT re-ask. Build to it. Propose a change only if the",
  "  work genuinely cannot be done within it, and say why.",
  "",
  "## The defaults to climb out of",
  "",
  "These are what generated interfaces look like when nobody decided anything. Recognise them in your",
  "own output:",
  "",
  "- Amber, orange and gold as the accent. It is the reflex accent; choose one that belongs to the product.",
  "- A full-viewport hero with a big headline and two buttons, on a page that had no reason for one.",
  "  A hero costs the reader an entire screen — spend it only on an image or an idea that earns it.",
  "- Typefaces with no relationship to the product: Inter, Roboto, Arial, Helvetica, system-ui, Poppins,",
  "  Montserrat and the rest of the set that appears when no one picked. Pick a typeface for a reason",
  "  you can state.",
  "- Hairlines everywhere: a border around every card, a rule between every row. Separation reads better",
  "  from spacing, weight, size and background than from drawn lines.",
  "- Everything square. Corner treatment is a decision; make it once, deliberately, either way.",
  "- Everything centred. Centring every block removes the alignment edge the eye follows down the page",
  "  and flattens the hierarchy — most content wants an edge to sit against.",
  "- Every fact at the same size in one long column. Decide what is most important and let the layout",
  "  say so; a page where everything shouts says nothing.",
  "- The purple-to-blue gradient, and the generic three-column feature grid under a centred heading.",
  "",
  "## Check yourself",
  "",
  "After writing or substantially changing UI, run `design_audit` on the files you touched. It counts",
  "these patterns and compares against the recorded direction. Fix what it finds, or say plainly why a",
  "finding is wrong for this project — it reports evidence, not verdicts, and it can be overruled.",
].join("\n");

/** The prompt section for a project: the rules, plus either the recorded direction or the instruction
 *  to establish one. Read at buildDef (once per run start), like the model profile, so the system
 *  prefix stays byte-stable within a run for the prompt cache. */
export function designPromptSection(cwd: string): string {
  const direction = loadDirection(cwd);
  if (direction === null) {
    return `${DESIGN_RULES}\n\n## This project\n\nNo design direction is recorded yet (.rovecode/design.json). The next interface work in this project starts with the proposal above.`;
  }
  return `${DESIGN_RULES}\n\n## This project's direction — build to this, do not re-ask\n\n${renderDirection(direction)}`;
}
