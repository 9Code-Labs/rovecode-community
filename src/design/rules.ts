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
  "This question is about NEW work: a page, screen or component that is not on the screen yet. A change",
  "to something that already exists is not this question. \"Make the background black\", \"add a shadow to",
  "the text\", \"make this bigger\", a new state on an existing screen, a colour swapped on an existing",
  "button: do it, now, in the direction the existing code already shows, and do not stop at a proposal,",
  "whether or not this project has a recorded direction. The test is simple: if the person could point at",
  "the thing on the screen, it exists and you change it; if they could not, it is new and the direction is",
  "decided first. When the change would contradict a recorded direction, make the change and say so in one",
  "line, so the human can decide whether the direction moves.",
  "",
  "- If this project has no recorded direction and you are about to write NEW UI, stop and propose THREE",
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
  "       proof = actual runs. Forbids itself stock illustration and invented copy. Even here the first",
  "       screen still SAYS what the product is, in one visible line above or beside the output — a",
  "       caption, not a hero. A transcript a stranger cannot name is a demo, not a page, and an",
  "       sr-only h1 is not that line: it has to be visible.",
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
  "- Keep each option LABEL to 60 characters or less — a letter and the direction's name (\"A. Its own",
  "  output\"). The four axes, the palette and the rationale go in the question body, not the label:",
  "  ask_user truncates a long option and the human then chooses between three cut-off phrases.",
  "- WHEN NOTHING CAN ASK A HUMAN (a headless `rovecode run`, no terminal): do not stall, and do not",
  "  quietly promote your own pick to a decision. Build ONE direction and record it as provisional —",
  "  `design_direction set` with `provisional: true` and the other two names in `alternatives`. Then say",
  "  so in your final summary: which one you built, which two you did not, and that the choice is still",
  "  theirs. The next interactive session asks the question once before writing more UI.",
  "- Once they choose, record it with the `design_direction` tool. That is what makes this a",
  "  once-per-project question instead of a once-per-task one.",
  "- When a direction is already recorded, do NOT re-ask. Build to it. Propose a change only if the",
  "  work genuinely cannot be done within it, and say why. The one exception: a direction recorded as",
  "  PROVISIONAL was chosen by an agent, not a human — ask once, in the first interactive session that",
  "  touches UI, before building more; then record the answer with `provisional` dropped.",
  "",
  "## The defaults to climb out of",
  "",
  "These are what generated interfaces look like when nobody decided anything. Recognise them in your",
  "own output:",
  "",
  "- Amber, orange and gold as the accent. It is the reflex accent; choose one that belongs to the product.",
  "- A full-viewport hero with a big headline and two buttons, on a page that had no reason for one.",
  "  A hero costs the reader an entire screen — spend it only on an image or an idea that earns it.",
  "- Typefaces with no relationship to the product: Inter, Roboto, Poppins, Montserrat and the rest of",
  "  the set that arrives when no one picked. What matters is the face you LOAD — an import, an",
  "  @font-face, a fonts URL — because that is where the decision is; a system stack sitting behind your",
  "  chosen face is a fallback, not a choice, and neither is a face merely named in prose. Pick the face",
  "  you load for a reason you can state. And if you name a face in CSS, LOAD it — a link, an @import,",
  "  an @font-face or a framework font import — or drop the name: a named-but-unloaded face renders as",
  "  its fallback, so the page does not look the way the code says it does. That is no decision at all,",
  "  and `design_audit` reports it as `font-named-not-loaded`.",
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
  "After writing UI, or changing how an existing screen looks (the black background, the shadow, the",
  "bigger heading included), run `design_audit` on the source you touched — the PAGE",
  "file together with the components it imports, not one component alone. Hairline density and centring",
  "are properties of a page, and \"no rounded corner anywhere\" is a property of a project, so a",
  "single-component run cannot see them. Run it on source, never on a fetched page: a built page measures",
  "the framework's output.",
  "",
  "It separates two things. A SLOP finding means nothing here records a decision — it disappears the",
  "moment the human chooses and you record it, and it is not a claim that the pattern is ugly. A",
  "DEVIATION means the code contradicts what this project already chose, which is the half worth acting",
  "on. Fix what it finds, or say plainly why a finding is wrong for this project: it reports evidence,",
  "not verdicts, and it can be overruled.",
  "",
  "The audit measures patterns, not promises, so it cannot check the half of the direction that is",
  "prose. Do that part yourself: re-read the `notes` and `rationale` recorded in design.json and take",
  "each claim to the page one at a time. \"No stock imagery\", \"numbers in place, no adjectives\",",
  "\"one entrance per section\" — either the page does it or it does not, and a clean audit says",
  "nothing about any of them.",
].join("\n");

/** The prompt section for a project: the rules, plus either the recorded direction or the instruction
 *  to establish one. Read at buildDef (once per run start), like the model profile, so the system
 *  prefix stays byte-stable within a run for the prompt cache.
 *
 *  STAGED (measured 2026-09-20): a project with NO recorded direction used to carry the whole ~2.2k
 *  token proposal on every request — the largest single item in the default prompt after the tool
 *  schemas, paid by every session that never touches an interface. Such a project now gets a stub
 *  that names the protocol and the tool carrying it; `design_direction {action:"get"}` returns the
 *  full ban list on demand (the MCP lazy-disclosure pattern: zero idle tokens, the words arrive the
 *  moment the work does). Once a direction IS recorded — the project has declared itself
 *  design-relevant — the full section rides again, exactly as before. ROVECODE_DESIGN=full restores
 *  the old always-on form; =off still drops the section entirely (cli/runtime.ts buildDef). */
export function designPromptSection(cwd: string, env: Record<string, string | undefined> = process.env): string {
  const direction = loadDirection(cwd);
  if (direction === null) {
    if ((env["ROVECODE_DESIGN"] ?? "").trim().toLowerCase() === "full") {
      return `${DESIGN_RULES}\n\n## This project\n\nNo design direction is recorded yet (.rovecode/design.json). The next interface work in this project starts with the proposal above.`;
    }
    return [
      "# Design",
      "",
      `No design direction is recorded yet (.rovecode/design.json). Before ANY interface work, call design_direction {action:"get"}: it returns this project's design protocol (the defaults to climb out of, the ban list, how to propose). Then propose THREE distinct directions and let the human choose; design_audit checks later screens against the recorded direction.`,
    ].join("\n");
  }
  // A provisional direction is built to exactly like a chosen one, but the heading must not tell the
  // model "do not re-ask" about the one question that is still open. renderDirection carries the rest.
  const heading = direction.provisional === true
    ? "## This project's direction — PROVISIONAL: build to this, and ask once before more UI"
    : "## This project's direction — build to this, do not re-ask";
  return `${DESIGN_RULES}

${heading}

${renderDirection(direction)}`;
}
