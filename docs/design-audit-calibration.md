# design_audit calibration — does it tell slop from design?

> **Status: historical.** These are the measurements that motivated the rework, taken against commit
> f661b70. The thresholds they argued for now ship; for what the checker actually does see
> [design.md](design.md).

Measured 2026-09-04 against `src/design/audit.ts` as it sat on disk at ~15:00 (commit f661b70 plus the
uncommitted "system stacks count only when they lead the list" change to `cliche-font`). Every number
below comes from running the real `auditSource` — nothing was re-implemented except the three density
regexes, copied verbatim so a per-file ratio could be read even when no finding fired.

**Short answer.** Of the seven slop rules, **none** separates the two corpora on live sites, and only
`everything-centered` and `reflex-hero` lean the right way on source repos — weakly, and mostly by
catching login pages and 404s. Two rules fire **more** on well-designed sites than on templates
(`cliche-accent-amber`, `cliche-gradient`), one fires on almost everything (`cliche-font`), two fire at
the same rate everywhere (`rule-line-density`, `all-square`). Meanwhile the corpus surfaced three cheap
signals the checker does not have that split the repos 12/13 vs 0/7. Details and the fix list follow.

## 1. What was measured

Two corpora, because the checker has two possible inputs and they behave completely differently.

**Domain A — live sites (HTML + up to 4 linked stylesheets, fetched with a browser UA).** This is
*out of domain* for a checker written to grep source, and the results say so; it is reported because it
is the only way to measure sites whose source is private (Stripe, Linear, Vercel, Anthropic, Basecamp).
Caveats that matter: the checker sees build output (hashed classes, minified CSS, whole Tailwind
palettes shipped in one file); SPA shells arrive with 20-40 elements and nothing to judge (7 of 43 sites,
listed in §5); 5 sites shipped no `<link rel=stylesheet>` at all (inline or JS-injected), so their CSS
was never seen. Evidence from this domain is **weak where noted**.

**Domain B — source repositories (tarballs, every `.tsx .jsx .astro .css .html .vue .svelte .scss .mdx`
outside `node_modules/dist/public/tests/stories`).** This is the checker's real domain: `design_audit`
runs `auditSource` per file over a project exactly like this. 1,502 files across 20 repos. Findings are
reported **per file** (what the tool emits) and **per repo** (does any file fire — what a user sees as
"the audit complains").

Per the brief, "good design" is split into **expressive** (studio / award-gallery shape) and **sober**
(restrained product and documentation sites), and the split is reported wherever the two behave
differently.

### Corpora

| group | domain A — live sites (n) | domain B — repos (files) |
|---|---|---|
| good / expressive | pentagram, locomotive, activetheory, bruno-simon, rauno.me, paco.me, aristidebenoist, hoverstat.es, awwwards, readymag, studiofreight (11) | pacocoursey/paco (19), shuding/shud.in (39), brunosimon/folio-2019 (2), kentcdodds/kentcdodds.com (401) |
| good / sober | stripe, linear, vercel, basecamp, anthropic, ghost, 11ty, MDN, tailwindcss, sentry, postgresql, caniuse, HN, sourcegraph, fly.io (15) | 11ty/11ty-website (46), leerob/site (7), sindresorhus/sindresorhus.github.com (49) |
| slop / template | cruip ×3 demos + cruip.com, startbootstrap ×3, html5up ×2, shadcn-landing ×2, next-saas-starter, astro-moon, astro-landing, nextjs-boilerplate, nextjs-ai-chatbot, ai-saas-landing, tailwind-landing-template, startup-landing (17) | leoMirandaa & nobruf shadcn-landing-page, NextJSTemplates/startup-nextjs, cruip ×2, ixartz/SaaS-Boilerplate, nextjs/saas-starter, timlrx starter-blog, shadcn-ui/taxonomy, mickasmt/next-saas-stripe-starter, steven-tey/precedent, materio admin, onwidget/astrowind (13 repos, 939 files) |

The slop corpus is *template* slop — the landing-page shapes that v0 / Lovable / Bolt output copies
(shadcn + Tailwind + lucide, three-column features, centred hero) — not literal AI-generated sites, whose
URLs are not discoverable. Good-design repos are personal and studio sites with public source; the
sober good repos are few (3) because sober product sites rarely publish theirs. Read the good/sober
column in domain B with that n in mind. Failed fetches (oma.eu, designbyimpulse, raunofreiberg/ui,
emilkowalski, joshwcomeau, vite, biome, bun.sh, astro.build >80 MB, mdn/yari) are simply absent.

## 2. Discrimination tables

### Domain A — live sites, finding rate per site

| rule | good/expressive | good/sober | **good, all** | **slop** | discriminates? |
|---|---|---|---|---|---|
| cliche-font | 10/11 91% | 12/15 80% | 22/26 **85%** | 14/17 **82%** | no — fires on everything |
| cliche-accent-amber | 1/11 9% | 12/15 80% | 13/26 **50%** | 6/17 **35%** | **inverted** |
| cliche-gradient | 0/11 0% | 8/15 53% | 8/26 **31%** | 2/17 **12%** | **inverted** |
| rule-line-density | 3/11 27% | 5/15 33% | 8/26 31% | 8/17 47% | barely (0.5 : 0.3 ratio) |
| everything-centered | 0/11 | 1/15 7% | 1/26 4% | 1/17 6% | no signal either way |
| all-square | 1/11 9% | 1/15 7% | 2/26 8% | 0/17 0% | fires only on good sites |
| reflex-hero | 0/11 | 0/15 | 0/26 0% | 1/17 6% | one hit, right direction |

Sober good sites are punished far more than expressive ones by amber and gradient — the opposite of
"measures loudness". They are punished because they ship **large, complete stylesheets** (Vercel: 218
amber tokens = the whole Tailwind palette in one CSS file; Stripe: 58, of which `#fbbc04` is the yellow of
the Google logo SVG on the sign-in button). Element count is the confound: the checker's budgets are
absolute counts, so the bigger the site the more it "offends".

### Domain B — source repos, per FILE (what `design_audit` emits)

| rule | good/expressive (461 files) | good/sober (102) | slop (939) |
|---|---|---|---|
| cliche-font | 2.0% | 13.7% | 1.9% |
| cliche-accent-amber | 0.9% | 1.0% | 0.3% |
| cliche-gradient | 0.0% | 2.0% | 1.4% |
| rule-line-density | 0.4% | 2.0% | 1.3% |
| everything-centered | 0.2% | 2.0% | 2.2% |
| all-square | **24.9%** | 10.8% | **21.7%** |
| reflex-hero | 0.0% | 2.9% | 0.7% |

### Domain B — per REPO (any file fires; this is what a user experiences)

| rule | good/expressive (4) | good/sober (3) | **good, all (7)** | **slop (13)** | verdict |
|---|---|---|---|---|---|
| cliche-font | 3/4 | 3/3 | **6/7 86%** | 9/13 69% | no |
| cliche-accent-amber | 1/4 | 1/3 | 2/7 29% | 2/13 15% | no (inverted) |
| cliche-gradient | 0/4 | 1/3 | 1/7 14% | 3/13 23% | too few hits to call |
| rule-line-density | 2/4 | 1/3 | 3/7 43% | 7/13 54% | no |
| everything-centered | 1/4 | 1/3 | 2/7 29% | 8/13 62% | weak yes (see §3.6 for what it caught) |
| all-square | 3/4 | 2/3 | 5/7 71% | 13/13 100% | no — and every one of these 20 repos uses rounded corners |
| reflex-hero | 0/4 | 1/3 | 1/7 14% | 3/13 23% | weak yes (see §3.7 for what it caught) |

### What DID separate the repos (not in the checker)

Counted with `grep` over the same tarballs; "repos with ≥1 hit".

| signal | good (7) | slop (13) |
|---|---|---|
| `md:grid-cols-3` / `lg:grid-cols-3` — the three-up feature grid | **0/7** | **12/13** |
| `import … from "next/font/google"` (Inter loaded as *the* font) | **0/7** | 6/13 |
| files importing `lucide-react` (icon-per-feature-card) | **0/7** | 6/13 |
| `rounded-lg border` / `bg-card text-card-foreground` shadcn card idiom | 2/7 (kentcdodds 10, sindresorhus 7) | 9/13 |

The first row is the strongest single number in this study. It is also exactly Berkay's complaint
("every piece of information stacked down the middle") stated as a grep — the three-column feature
grid is the unit of the stacked layout.

## 3. Rule by rule: where the checker was wrong

### 3.1 `cliche-font` — fires on 85% of good sites and 86% of good repos

**False positives, named.** Pentagram (`Roboto, Helvetica Neue, -apple-system`), Locomotive, Anthropic
(`Arial, Helvetica Neue`), Stripe (`Roboto, -apple-system, Montserrat`), rauno.me (Roboto), Sentry,
Sourcegraph, fly.io: in every one of these the match is a **fallback stack** or a **third-party embed**
(Google Fonts CSS for a cookie banner, a YouTube/Intercom iframe's styles, `<link href=fonts.googleapis
…family=Roboto>` pulled in by an analytics widget). Not one of them *uses* Roboto as its face. In the
source repos: kentcdodds.com fires on `blog/migrating-to-workspaces-and-nx.mdx` because the post *mentions*
Inter; shud.in fires on `opengraph-image.tsx` (the OG-image renderer loads Inter for the social card, not
the site); 11ty fires on `code.css` fallbacks and `direct-links.css: system-ui`.

**The leading-stack fix helped, and is not enough.** After it, `system-ui` still fires on Vercel,
tailwindcss.com, 11ty and paco.me — all with deliberately chosen webfonts — because a reset somewhere
puts `system-ui` first for a *form control* or a *code block* (`button, input { font-family: system-ui }`).
"Leads a list" is still not "is the chosen face".

**Real signal, and where it is.** Inter is in 11/13 slop repos, but the *decisive* form is
`import { Inter } from "next/font/google"` in `app/layout.tsx` (6/13 slop, 0/7 good). paco.me and
leerob.io also use Inter — **as a decision**, which the checker cannot tell from a reflex, and should not
try to: Berkay's rule is that the human picks, and a chosen Inter is legitimate.

**Recommend.**
1. Drop `system-ui, -apple-system, Segoe UI, Arial, Helvetica, Helvetica Neue` from *slop* detection
   entirely. They are fallbacks in effectively every reset (Tailwind preflight, normalize, every
   framework); measured: 100% of the false positives above involve one of them. Keep them only for the
   *deviation* check once a direction is recorded (a file that sets `font-family: Arial` on a heading
   when the direction says Fraunces is a real finding).
2. For named webfonts, match **load sites**, not mentions: `next/font/google` imports, `@fontsource`
   imports, `@font-face { font-family: X }`, Google Fonts `family=X` URLs in *first-party* markup. A
   mention in prose, a fallback position, or a stack behind a webfont is not a decision.
3. Exclude `.md` / `.mdx` and `opengraph-image.*` / `og/route.*` from the font rule (3 of 9 good-repo
   hits were exactly those).
4. Severity: with a direction recorded, a cliché font that is **the** chosen font is not a finding at
   all (already so); with none recorded, this rule is the "no decision was made" alarm and belongs at
   `med`, not `high` — 6 of 7 good repos would otherwise open with a high.

### 3.2 `cliche-accent-amber` — inverted on live sites (80% of sober good vs 35% slop)

**False positives, named.** Stripe (58: `#fbbc04` Google-logo yellow, `#ff6201` in an illustration
sprite), Linear (36: `#F2C94C` is its *warning/priority* semantic colour, not an accent), Vercel (218:
the whole Tailwind palette shipped), tailwindcss.com (125: the colour-palette documentation page itself),
Sentry (74), fly.io (124), PostgreSQL (29: Bootstrap's `#ffc107` warning), caniuse (32: support-table
"partial" yellow), MDN (5: notecard warning). In source: kentcdodds.com — `#ffd644` is his **brand
yellow**, a choice he has kept for years; sindresorhus `feedback.astro` — amber on a *warning box*.

**True positives, named.** cruip ×3 (`orange-300…700` as the button/link accent), startbootstrap
(`#f4a100`, `#f76400` as the theme). The rule does find the reflex amber when it is there.

**Why it inverts.** The budget is an absolute count (`> 2`, `> 5 → high`) across a whole document. Any
site large enough to have a warning state, a status colour, a syntax theme or a logo SVG exceeds it, and
large sites are disproportionately the good ones. The rule measures **stylesheet size**, then amber.

**Recommend.**
1. Count **accent positions**, not occurrences: amber in `--primary` / `--accent` / `--brand` /
   `--color-*` tokens, in `bg-*` on a `button|a|Button` element, in `text-*` on `h1|h2`, in `from-*`
   of a hero gradient. A warning/status use (`text-amber-` beside `warning|warn|caution|alert`) never
   counts. Measured: this would clear Linear, MDN, caniuse, PostgreSQL, sindresorhus and keep cruip and
   startbootstrap.
2. Normalise by palette: if the document also declares ≥ 5 *other* saturated hues (a full palette), amber
   is one swatch among many, not the accent — clears Vercel, tailwindcss.com, Sentry, fly.io.
3. Skip `<svg>` content and `.svg`-in-CSS data URIs (Stripe's Google logo).
4. With a direction recorded that **includes** an amber (a chosen one — Berkay's rule allows it), the
   slop rule must not fire; `off-palette` already covers a stray one. Today it fires regardless of
   direction.

### 3.3 `cliche-gradient` — 53% of sober good sites, 12% of slop

**False positives, named.** Stripe, Linear, Vercel, Ghost, 11ty, Sentry, fly.io — each has *a*
`linear-gradient(...)` with *a* violet-band hex stop somewhere in a large stylesheet: syntax-highlight
themes, a dark-mode hero glow, a progress bar, an illustration. The hex form of the rule (`any
linear-gradient whose any stop is h 250–290, s ≥ 40`) is far too broad; the Tailwind pair form
(`from-violet-… to-blue-…`) fired 1/26 good (tailwindcss.com's docs, showing gradients) vs 2/17 slop.

**True positives.** open.cruip.com and cruip.com — the purple→blue hero. cruip/open-react-template
in source: 7 files.

**Recommend.** Keep the Tailwind pair pattern; for CSS, require **two** saturated stops with the
violet→blue/pink hue ordering (h₁ ∈ 250–290, h₂ ∈ 180–330, both s ≥ 40) — the *signature* is the pair,
not a violet somewhere. Ignore gradients inside `pre|code|.hljs|.shiki|token` scopes.

### 3.4 `rule-line-density` — same rate everywhere, and the Device.tsx question

Live sites: 31% good vs 47% slop; hits on Locomotive (0.86), paco.me (1.28), Vercel (1.91), Anthropic
(0.63), PostgreSQL (1.56), fly.io (1.66). In build output the regex counts every `.border-*` **class
definition in the shipped Tailwind CSS**, not borders drawn — Vercel's 2077 "declarations" are the
utility file. Out-of-domain noise; weak evidence.

Source repos, per file (files ≥ 10 elements, the rule's floor):

| bucket by element count | good/expressive | good/sober | slop |
|---|---|---|---|
| 10–14 | 1/40 | 0/9 | 3/122 |
| 15–29 | 0/76 | 2/8 | 8/166 |
| 30–59 | 1/30 | 0/1 | 1/56 |
| 60+ | 0/23 | 0/2 | 0/22 |

**Small files do not dominate the false positives** — the good-repo hits are `kentcdodds …/resources/`
(10 els, 0.50), shud.in `double-slit-playground` (47 els, 0.51 — an interactive article figure),
sindresorhus `feeds.astro` (20 els, 1.00 — a list of feed links each in a bordered row) and `index.astro`
(23, 0.52). They sit at 10, 20, 23 and 47 elements: no floor removes them without removing the slop
hits too. So an element floor is **not** the fix f9's Device.tsx case suggests.

Threshold and floor sweeps (files ≥ 10 els; good = expressive + sober):

| what fires | T=0.3 | T=0.4 (now) | T=0.5 | T=0.6 | T=0.8 |
|---|---|---|---|---|---|
| good fires | 5/189 | 4/189 | 3/189 | 1/189 | 1/189 |
| slop fires | 22/366 | 12/366 | 5/366 | 1/366 | 0/366 |

| floor N (T=0.4) | N=10 | N=15 | N=20 | N=30 | N=40 |
|---|---|---|---|---|---|
| good fires | 4/189 | 3/140 | 3/106 | 1/56 | 1/41 |
| slop fires | 12/366 | 9/244 | 4/164 | 1/78 | 0/43 |

At every T and every N the good and slop rates are within noise of each other (2% vs 3%). The rule
does not measure the thing Berkay named. What it measures in slop: `components/ui/scroll-area.tsx`
(10 els, 5 borders — the **same vendored shadcn file** fires identically in 3 repos), `chart.tsx`,
`Form.astro`, a pricing comparison table. What it measures in good: a feed list, an article figure.
Both are "a component whose job is drawing a framed thing" — f9's Device.tsx diagnosis is right about the
*meaning*, wrong about the *remedy*: the failure is per-file scoring of components, not small files.

(Device.tsx itself could not be re-measured: it has since been rewritten in the R3 round and now has
10 elements and 0 borders. The pre-R3 file at 0.60 was 6 borders / 10 elements — at the floor, where the
sweep above shows the rule is indistinguishable from noise anyway.)

**Recommend.**
1. Stop scoring density **per component file**. Score it per *page*: the route files (`app/**/page.*`,
   `pages/**`, `src/pages/**`, `*.html`) plus the components they import, summed. A bezel drawn with six
   borders is one figure on a page of 300 elements — 0.02, not 0.60. This is the one change that makes
   f9's case and the shadcn `scroll-area.tsx` case disappear for the right reason.
2. Skip `components/ui/**` (vendored primitives) from all slop density rules — 4 of 12 slop hits and 0
   design decisions.
3. If per-file must stay: raise T to 0.6 (1 good, 1 slop fire in 555 files — the rule goes quiet
   rather than wrong) and say in the message that it is a *page-level* smell.

### 3.5 `all-square` — 22–25% of files in both groups; 100% of slop repos and 71% of good repos

Every one of the 20 repos uses rounded corners somewhere (`rounded-*` or `border-radius` occur in all
of them), yet 330 files "have not one rounded corner" — because a file with ≥ 10 JSX elements and no
`rounded` class is common and meaningless: `MetaTags.astro`, `mdx-components.tsx`, `Pagination.astro`,
`arrow-button.tsx`, a table, a form. In site/src today, with a direction recorded (`corners: "soft"`,
radius tokens 6/12/20/28 in `index.css`), 8 component files still fire when audited file-by-file without
the direction passed. Live sites: only aristidebenoist (a deliberately hard-edged portfolio) and Hacker
News fired — both correct, both good.

**Recommend.** Make `all-square` a **project-level** finding only: no radius declaration anywhere in the
audited set. Never per file. With that change it would have fired on 0/20 repos here, and on the two
live sites where it was true.

### 3.6 `everything-centered` — 62% of slop repos vs 29% good, but look at what it caught

Firing files, slop: `login/page.tsx`, `register/page.tsx` (×2 repos), `404.astro`, `not-found`,
`loading.tsx`, `empty-placeholder.tsx` (×2), `Newsletter.tsx`, `Stats.astro`, `SharePost.tsx`,
`tooltip.tsx`. Good: `error-boundary.tsx`, `Announcement.astro`, `404.astro`. **Every one is a page
type that is correctly centred** — a login form, a 404, an empty state, a tooltip. The rule's true
positives on marketing pages: `precedent/app/page.tsx` (0.45), `startup-nextjs/blog/page.tsx` (0.74),
`nobruf …/sections/features` (0.58), `astrowind Content.astro` (0.45). Four real ones out of 24 fires.

**Recommend.**
1. Exempt routes and components whose *name* says centred is right: `login|register|signin|signup|auth|
   404|not-found|error|loading|empty|placeholder|tooltip|dialog|modal|toast|announcement`. Measured: this
   removes 17 of 24 fires, 14 of them slop (i.e. it costs recall the rule never really had).
2. As with density, measure per page, not per component — the complaint is a *page* whose sections are
   all centred.
3. Add the `md:grid-cols-3` signal (§2, 12/13 vs 0/7) as the direct measurement of "stacked down the
   middle": a feature grid of three equal cards is the unit of that layout, and no good repo in the
   corpus has one.

### 3.7 `reflex-hero` — 23% of slop repos vs 14% good, caught heroes 1 time in 10

Firing files: sindresorhus `SimplePageLayout`, `index.astro`, `feedback.astro` — `min-h-screen` is the
**sticky-footer wrapper** with the page's `h1` inside it; slop: `login/page.tsx` ×2, `register/page.tsx`
×2, `not-found.tsx`, `pricing/page.tsx` — the same wrapper idiom around a centred form. Exactly **one**
of ten fires was a hero (astrowind `Hero2.astro`). The live-site hit (astro-landing-page) was real.

**Recommend.** A hero is a full-viewport block that is *also* centred and *also* first: require
`min-h-screen|h-screen|100[sd]?vh` **and** a centring class in the same element's class list **and**
the `h1` within the window **and** the file to be a page/section (not `layout|login|register|404|
not-found`). Or drop the rule: Berkay's "hero for no reason" is a judgement about *earned height* that a
grep cannot make, and the false positives here are structurally identical to the true one.

### 3.8 `off-palette` — not measured

No corpus site has a `design.json`, so the deviation half never ran. It is the half that *can* work:
against a recorded palette the question is mechanical. The one caution from this data: `isNeutral`'s
tinted-ink allowance (`l < 20 && s < 45`) would still have counted Linear's dark-mode surface stack
(`#08090a`, `#0f1011` …) as neutral, good; but Tailwind's `slate-800 #1e293b` is l 17 s 33 → neutral,
while `gray-700 #374151` is l 27 s 19 → **not** neutral by the s < 12 test → off-palette. Every
Tailwind-based body text colour between l 20 and l 92 with s 12–45 will read as an off-palette colour.
Recommend widening the mid-tone neutral band to s < 20, or treating any hex that appears ≥ 10 times as
"a neutral this project uses".

## 4. Misses — slop the checker waved through

- **startup-landing-page.vercel.app** (460 elements, full HTML): **clean**. A textbook centred hero +
  three-feature grid + pricing template.
- **leoMirandaa/shadcn-landing-page** whole-project audit: **clean** (per file: 7 `all-square` on
  components, nothing else). 11 files import lucide-react, `md:grid-cols-3` twice.
- **ixartz/SaaS-Boilerplate**: clean apart from 2 `all-square`.
- **shadcn-ui/taxonomy**, **mickasmt/next-saas-stripe-starter**: only `reflex-hero` on login pages and
  `everything-centered` on 404/empty states — i.e. caught for the wrong reasons.

What these have in common is not amber, not Inter-in-CSS, not hairlines. It is the **shadcn + lucide +
three-column** vocabulary and identical section shells. The grep signals in §2 catch all four; the current
rules catch none of them.

## 5. Things the checker structurally cannot see

- **SPA shells.** 7 of 43 live sites arrived with < 60 elements: activetheory (36), aristidebenoist (43),
  shadcn-landing ×2 (22, 20), nextjs-boilerplate (28), nextjs-ai-chatbot (30), astro-landing (42). A
  textual checker on production HTML judges the framework's shell, not the design. `design_audit` is
  right to target source; the tool description should say "run it on the source tree, never on a fetched
  page".
- **Decision vs reflex.** Kent C. Dodds' yellow, Paco Coursey's Inter and Aristide Benoist's square
  corners are the *same tokens* as a template's yellow, Inter and squares. No count distinguishes them;
  the recorded direction does. This is an argument for making **every** slop rule conditional on
  "no direction recorded", and for `design_direction` — not the auditor — being the thing that carries
  Berkay's rule. Today `cliche-accent-amber` and `cliche-gradient` fire even against a direction that
  chose those colours.
- **Size.** Absolute budgets (amber > 2, the 1500-char hero window) scale with document size. Every rate
  in this study that inverted did so because good sites are bigger.

## 6. Recommended changes, in order of measured payoff

1. **`cliche-font`:** remove system stacks from slop detection; match font *load sites* only; skip
   `.md/.mdx` and OG-image files; severity `med` when no direction is recorded. (Clears 22/26 good live
   sites and 6/7 good repos; keeps 9/13 slop repos via `next/font` Inter.)
2. **New rule `template-grid`:** `(md|lg):grid-cols-3` in a page/section file, `low`, message "three
   equal cards is the feature grid every template ships; is this the layout the content wants?"
   (12/13 slop, 0/7 good.) Make it *direction-aware*: silent when `layout` is recorded as anything.
3. **Per-page scoring** for `rule-line-density` and `everything-centered`; skip `components/ui/**`;
   exempt auth/404/empty/loading/tooltip names. (Removes all 8 good-repo density/centring fires and the
   17 legitimately-centred slop fires; what remains — 4 marketing pages — is the complaint.)
4. **`all-square` project-level only.** (330 per-file fires → 0 on these repos; the two live true
   positives stay.)
5. **`cliche-accent-amber`:** accent *positions* not counts; ignore warning/status contexts, `<svg>`,
   and documents declaring a full palette; never fire when the recorded direction includes the colour.
6. **`cliche-gradient`:** require the violet→blue/pink *pair* in CSS as it already does in Tailwind;
   ignore code-highlight scopes.
7. **`reflex-hero`:** require centring on the same element and a page/section file, or delete.
8. **`isNeutral`:** widen the mid-tone band (s < 20) or treat hexes used ≥ 10× as project neutrals,
   before `off-palette` gets its first real run.
9. **Tool description:** "source tree only; a fetched page measures the framework."

None of these encodes a palette or a typeface. Rules 1, 2 and 5 detect the *absence of a decision*
(a font that arrived with the framework, a layout that arrived with the template) and go quiet the
moment `design.json` records one.

## Appendix — how this was run

Harness (outside the repo, read-only import of `src/design/audit.ts`):
`%LOCALAPPDATA%\Temp\dacal\` — `run.ts` (live sites → `rows-all.json`), `walk.ts` (extracted tarballs
→ `file-rows.json`), `local.ts` (site/src + evidence). Tarballs from `codeload.github.com`, default
branch `main` then `master`. All fetches 2026-09-04 14:30–15:10 local; the GitHub REST API was
exhausted (60/h) after the first repo pass, so the per-file pass used tarballs — the numbers in §2 are
from the tarball pass. `site/.rovecode/design.json` exists (R3 direction, `corners: "soft"`); the
site/src per-file run in §3.5 deliberately did *not* pass it, to show what per-file `all-square` does
without a direction.
