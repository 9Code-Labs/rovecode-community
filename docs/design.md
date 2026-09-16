# Interface design

Rovecode ships **no default look**. There is no built-in palette, no safe typeface, no house layout, and
nothing carries over from the last project. A built-in default would be the exact failure being avoided:
it would make every rovecode interface resemble every other one.

What ships instead is a protocol and a checker.

- A **protocol** in the system prompt: before the first interface in a project, propose **three**
  genuinely different directions, let the human choose, record the choice, then build to it.
- A **record**, `.rovecode/design.json`, written by the `design_direction` tool.
- A **checker**, the `design_audit` tool, which counts patterns in source and compares them against the
  record.

This page is the whole shipped behaviour; nothing below depends on reading anything else. Two research
write-ups sit beside it in the repository — `docs/design-slop-research.md`, which argued for recording more
of the direction rather than widening a ban list, and `docs/design-audit-calibration.md`, which measured the
checker against twenty repositories and set the thresholds quoted here. Both are pinned to the code as it
was before the rework and are kept as history, not as documentation.

## The prompt section

Every run carries an "Interface design" section in the system prompt (`src/design/rules.ts`, appended by
`buildDef` in `src/cli/runtime.ts`). Set `ROVECODE_DESIGN=off` to drop it for runs that have nothing to do
with interfaces.

The section asks for three directions that disagree on all four of these axes, because two proposals that
agree on the second or third converge however different their prose sounds:

1. what the first screen is **made of** (real output? prose? an instrument? an image?)
2. what carries **hierarchy** (type scale? density? monospace rhythm? boxes? colour?)
3. what **colour is for** (functional only? near-absent with one accent? state semantics? mood?)
4. what counts as **proof** (real runs? tables and footnotes? live numbers? testimony?)

Asking one model once for three ideas tends to return one idea three times, so each direction is derived
from a different source of form and then checked against the four axes.

## `design_direction`

Reads or records the project's chosen direction. `action` is required.

| action | what it does |
| --- | --- |
| `get` | returns the recorded direction, or says none is recorded |
| `set` | records the direction **the human chose**; it cannot invent one |

`set` accepts these fields. Only `name` is required; everything else is optional, and a malformed field is
dropped rather than throwing, so one bad hand-edit costs that field and not the run.

| field | type | meaning |
| --- | --- | --- |
| `name` | string | short name of the direction as it was presented to the human |
| `rationale` | string | one line: why it suits this product |
| `palette` | object | chosen colours, free-form keys: `{"ink":"#0b1a2e","accent":"#c2410c"}` |
| `typeface` | object | faces by role, free-form keys: `{"display":"…","text":"…","mono":"…"}` |
| `corners` | `sharp` \| `soft` \| `round` | how corners read |
| `layout` | `centered` \| `left` \| `asymmetric` \| `grid` | how the page is composed |
| `density` | `tight` \| `regular` \| `airy` | how tightly the page is packed |
| `sectionOrder` | string[] | the page's blocks in order, e.g. `["hero","proof","pricing","faq"]` |
| `heroPattern` | string | the hero pattern by name, e.g. `"command-first"` |
| `typeScale` | number[] | the chosen type steps, e.g. `[14,16,20,28,44]` |
| `motion` | string | the motion rule in the human's words |
| `copyRegister` | string | how the copy reads |
| `notes` | string | anything the audit cannot infer |
| `chosenAt` | string | ISO date; filled in automatically when omitted |
| `provisional` | boolean | `true` only when no human could be asked — see below |
| `chosenBy` | `human` \| `agent` | derived: setting `provisional` forces `agent`. Absent means a human chose |
| `alternatives` | string[] | with `provisional`: the directions that were **not** built |

The record lives at `<cwd>/.rovecode/design.json` and is deliberately **per project, never global** — a
global design file would be the carried-over default the rule forbids.

### Headless runs: the provisional direction

`ask_user` needs a human on the other end. A one-shot `rovecode run` has none, and a run measured on
2026-09-04 showed what an agent does then: it picks a direction itself and records it as though a human
had chosen — which launders the agent's taste into the one file whose whole job is to hold the human's.

So the record carries who chose. With no human reachable, the agent builds **one** direction and records
it with `provisional: true` and the other two names in `alternatives`. From then on:

- `design_direction get` and the system prompt both open with `PROVISIONAL direction: …`, not
  `Chosen direction: …`, and say the choice is still the human's.
- `design_audit`'s consistency line reads *"consistent with the recorded direction X (provisional
  direction — recorded by the agent, not yet confirmed by a human)"*. The rules run exactly as they
  would against a chosen direction — the flag weakens nothing, it only stops the record from silently
  becoming permanent.
- The final summary of the headless run names the two directions it did not build.
- The next interactive session that touches UI asks the question once, then re-records without the flag.

`provisional: true` always implies `chosenBy: "agent"`; the two cannot disagree.

**`set` prompts for approval; `get` does not.** That one prompt is the point: it is where the human sees
what is being recorded on their behalf, and it is asked once per project rather than once per task. `get`
only reads `.rovecode/design.json` and writes nothing, so it is allowed outright — a card there would cost
an interruption before every UI task, and would train the human to allow a `design_direction` card
reflexively, which is exactly the card that matters.

The two are told apart by the tool's own `resource()` (`src/core/types.ts` `Tool.resource`), which reports
`get` or `set` instead of letting the policy fall back to the tool name; the rules are
`tool.design_direction * -> prompt` then `tool.design_direction get -> allow` (last match wins). Anything
that is not literally `get` is treated as the write, so an unknown action can never read as the safer of
the two, and plan mode still denies `set` outright.

## `design_audit`

Counts patterns in source and reports evidence, never verdicts. It never prompts and never writes.

| argument | meaning |
| --- | --- |
| `files` | paths inside the project to audit |
| `source` | audit this markup/CSS text directly instead of reading files |
| `ignore` | rule ids to skip, e.g. `["all-square"]` |

Run it on the **source tree**, not on a fetched page: a built page measures the framework's output, not the
design. Pass the page file **together with the components it imports** — density and centring are scored per
page, and "no rounded corner anywhere" is scored per project, so a single-component run cannot see them.

A **page** means a route file: `app/**/page.tsx`, `app/page.tsx`, anything under `pages/` that is not
`pages/api/`, `routes/**/+page.svelte`, or any `.html`.

A page is scored as what it **renders**, not as what its file contains. That means the route file, the
components it imports one level deep, and — because Next.js and its imitators nest them implicitly — every
`layout.*` from its own directory up to the root, plus what those layouts import. `components/ui/**` is left
out of the count wherever it comes from. This matters more than it sounds: measured on a fourteen-route
Next.js app, the layout chain carried 8–24 elements per route and on four routes was *larger* than the page
file, and that is exactly where a site keeps the nav, the footer and the section rules a density check is
looking for. Every finding names the files it counted, so you can disagree with the scope itself.

Pass only components and the two page-scoped rules produce nothing at all — a clean report there means "not
measured", not "fine". Text passed as `source` is treated as one page, so pasted markup does get the page
checks.

### Slop and deviation

Every finding is one of two kinds, and the difference is the whole design of the checker.

- **slop** — nothing here records a decision. Only assertable when `.rovecode/design.json` is absent. It is
  not a claim that the pattern is ugly; it disappears the moment the human chooses and the choice is
  recorded.
- **deviation** — the code contradicts what this project already chose. This is the half worth acting on,
  and the half a machine can actually judge.

The reason for the split: one person's brand yellow and a template's default yellow are the same token. No
count tells them apart. Only the record does.

### The rules

| id | kind | scope | fires when |
| --- | --- | --- | --- |
| `cliche-font` | slop | file | a default webfont is **loaded** (a `next/font/google` import, `@fontsource`, `@font-face`, a Google Fonts `family=` URL) and no direction is recorded. A mention in prose, a fallback position and a system stack are not decisions and never count; `.md`/`.mdx` and OG-image files are excluded |
| `font-named-not-loaded` | slop, or deviation when it is the recorded face | **project** | a face is named in a `font-family` (or a Tailwind `font-[…]`) that **nothing in the audited set loads**. It renders as its fallback, so the page does not look the way the code says. Generic keywords, system stacks and `var()` indirection are not faces. Project-scoped because the load site is usually a layout or a global stylesheet — pass those in or the rule cannot see them. Blind spot: `next/font/local` and a bare `src: url(…)` outside `@font-face` do not name their face reliably, so a face loaded only that way still reports |
| `font-deviation` | deviation | file | a face is loaded that is not the recorded one, or a `font-family` declaration leads with a system stack while a face is recorded |
| `cliche-accent-amber` | slop | file | amber sits in an **accent position** (a `--primary`/`--accent`/`--brand` token, or `bg`/`text`/`from`/`border-amber-[3-7]00` next to a button, link or heading) with no direction recorded. Warning and status uses, `<svg>` payloads and data URIs never count, and a document declaring five or more saturated hue families is a palette, not an amber theme |
| `accent-deviation` | deviation | file | the same, when the recorded palette holds no amber |
| `template-grid` | slop | file | `(md\|lg):grid-cols-3` in a page or section file and no `layout` recorded — the three-up feature grid every template ships |
| `template-icons` | slop | file | `lucide-react` is imported and nothing at all is recorded. A marker, not a fault |
| `reflex-hero` | slop, or deviation once `heroPattern` is recorded | file | viewport height **and** a centring class on the same element **and** an `<h1>` within the window **and** a page or section file that is not an exempt name |
| `cliche-gradient` | slop / deviation | file | the violet-to-blue **pair**: a Tailwind `from-violet…to-blue`, or a CSS gradient with two saturated stops, one violet. Syntax-highlight scopes are excluded |
| `off-palette` | deviation | file | more than one OKLCH hue family outside the recorded palette. Tints and shades of a recorded colour are in-palette; one extra family is allowed, because semantic states are not a second brand |
| `decoration-density` | deviation | file | the record itself asks for restraint **and** decoration (gradients, background images, ornament, motion) runs above 0.6 per element |
| `rule-line-density` | slop / deviation | **page** | borders and dividers above 0.4 per element across a route file plus the components it imports. `components/ui/**` never contributes |
| `everything-centered` | slop | **page** | centring above 0.45 per element across a page, with no `layout` recorded. Page types that are correctly centred — login, register, 404, error, loading, empty, tooltip, dialog, modal, toast, announcement, layout — are exempt |
| `all-square` | slop | **project** | not one radius declaration anywhere in the audited set, and `corners` is not `sharp` |

Some page types are exempt from centring and hero checks by name because centring is correct for them: a
login form, a 404, an empty state, a tooltip.

Every finding names the evidence it counted, so a human can overrule it. Saying plainly why a finding is
wrong for this project is a valid response; so is recording the decision and watching the finding disappear.

### The amber floor

`cliche-accent-amber` fires on hues 20–55°. Rust and terracotta measure below that — `#b4431d` is 15°,
`#c2410c` 17°, `#9a3412` 15° — and the reflex amber ramp above it: `#ea580c` 21°, `#b45309` 26°,
`#d97706` 32°, `#f59e0b` 38°. The floor stays at 20 on purpose: a rust is a colour somebody reaches for,
never a default. The cost is accepted and stated — an amber at exactly 19° escapes too. This rule only
ever fires when no direction is recorded, and one wrong slop finding on a deliberate palette costs more
trust than one missed cliché costs quality.

### Known limits

The checker greps source. It reports what is **written**, misses what is computed at runtime, and can be
fooled by indirection. Colour is read as a hex literal, as a bare `H S% L%` triplet on a custom property
(the Tailwind `hsl(var(--x))` convention), or as a written `hsl()`; a colour behind `color-mix`, an
`oklch()` literal, or a second level of variable indirection is still unread. Path prefixes matter too: the
`components/ui/**` exemption and the route patterns are matched against the paths you pass, so auditing from
inside `components/` rather than from the project root quietly turns them off. It cannot see rhythm, whether the copy is filler, or whether the layout has one
organising idea. The calibration measured the ceiling honestly: without a recorded direction, a deliberate
choice and a reflex look identical, which is why the deviation half is where the value is.
