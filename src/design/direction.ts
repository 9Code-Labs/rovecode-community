/** The project's chosen design direction, recorded once and then honoured.
 *
 *  Berkay's standing rule is "Tasarimda varsayilan yok" — no carried-over palette, no safe font,
 *  no direction picked by the tool. So rovecode ships NO default look. What it ships is a protocol:
 *  before the first UI is written, the agent proposes distinct directions, the HUMAN picks one, and
 *  the choice is written here. Every later piece of UI in the project is measured against it.
 *
 *  Why persist it at all: without a record the second screen drifts from the first, and "consistent"
 *  degrades into "whatever the model remembered". With it, design_audit can report DEVIATION (a font
 *  that is not the chosen font) rather than only taste, which is the part a machine can actually judge.
 *
 *  The file is <cwd>/.rovecode/design.json. It is deliberately per-project and never global: a global
 *  design file would be exactly the "carried over from the last job" default the rule forbids. */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const DESIGN_FILE = "design.json";

/** How corners read. Recorded because "no radius anywhere" is a finding UNLESS it was the choice. */
export type Corners = "sharp" | "soft" | "round";
/** How the page is composed. Recorded because centred-everything is a finding UNLESS it was the choice. */
export type Layout = "centered" | "left" | "asymmetric" | "grid";
/** How tightly the page is packed. Recorded because "airy" and "tight" want opposite spacing scales,
 *  and a model with no record of which regresses to the mode on every screen. */
export type Density = "tight" | "regular" | "airy";

export interface DesignDirection {
  /** short name of the direction, as it was presented to the human ("lacivert band + beyaz govde") */
  name: string;
  /** one line: why this direction suits this product */
  rationale?: string;
  /** the palette as chosen — free-form keys so a direction is not forced into a fixed slot set */
  palette?: Record<string, string>;
  /** typefaces as chosen, by ROLE: `display`, `text`, and any role the direction needs (`label`,
   *  `mono`, …). Free-form keys on purpose: a chart-style direction has condensed map labels as a
   *  first-class role, and every face named here is exempt from the cliché-font check. */
  typeface?: Record<string, string>;
  corners?: Corners;
  layout?: Layout;

  /* The axes below were added on docs/design-slop-research.md §6.3. The argument for them is not that
   * the auditor needs more fields: it is that an unspecified requirement is inferred correctly only
   * 41.1% of the time and underspecified prompts are twice as likely to fail when conditions change
   * (Yang et al., arXiv:2505.13360). Every axis this file leaves blank regresses to the training mode
   * on EVERY call, which is where a second screen drifts from the first. All optional: a direction that
   * says nothing about motion is a direction that has not decided about motion, not an invalid one. */

  /** the page's blocks in order, as the human chose them ("hero, proof, problems, pricing, faq") */
  sectionOrder?: string[];
  /** the hero pattern by name, so "is this the hero we chose" becomes answerable */
  heroPattern?: string;
  /** the type scale as chosen, in px or rem steps — the count and the gaps, not a ratio */
  typeScale?: number[];
  /** how tightly the page is packed */
  density?: Density;
  /** the motion rule in the human's words ("one entrance per section, no loops") */
  motion?: string;
  /** the copy register ("technical, names and numbers, no marketing verbs") */
  copyRegister?: string;

  /** anything the audit cannot infer: imagery, what to avoid in THIS project */
  notes?: string;
  /** ISO date the human chose it */
  chosenAt?: string;

  /* Headless runs. `ask_user` needs a human on the other end; in a one-shot `rovecode run` there is
   * none, so an agent that must ship a page either stalls or — measured, 2026-09-04 — picks a
   * direction itself and records it as though a human had chosen. The second is worse than the first:
   * it launders the agent's taste into the one file whose whole job is to hold the HUMAN's choice, and
   * every later screen is then measured against a default nobody picked. So the record carries who
   * chose. A provisional direction is honoured exactly like a chosen one while it stands — the point
   * is not to weaken it, only to stop it from silently becoming permanent. */

  /** true when no human could answer and the agent built to one direction to get unblocked */
  provisional?: boolean;
  /** who chose it. Absent means a human did (every record written before this field existed). */
  chosenBy?: "human" | "agent";
  /** the directions NOT built, by name — what the next interactive session offers instead */
  alternatives?: string[];
}

export function designPath(cwd: string): string {
  return join(cwd, ".rovecode", DESIGN_FILE);
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined);

const CORNERS: readonly string[] = ["sharp", "soft", "round"];
const LAYOUTS: readonly string[] = ["centered", "left", "asymmetric", "grid"];
const DENSITIES: readonly string[] = ["tight", "regular", "airy"];

/** Parse a raw record into a direction, dropping anything malformed rather than throwing: a
 *  hand-edited design.json with one bad field must not take the whole run down. Returns null when
 *  there is no usable direction at all (no name). */
export function parseDirection(raw: unknown): DesignDirection | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const name = str(r["name"]);
  if (name === undefined) return null;
  const out: DesignDirection = { name };
  const rationale = str(r["rationale"]); if (rationale !== undefined) out.rationale = rationale;
  const notes = str(r["notes"]); if (notes !== undefined) out.notes = notes;
  const chosenAt = str(r["chosenAt"]); if (chosenAt !== undefined) out.chosenAt = chosenAt;
  const corners = str(r["corners"])?.toLowerCase();
  if (corners !== undefined && CORNERS.includes(corners)) out.corners = corners as Corners;
  const layout = str(r["layout"])?.toLowerCase();
  if (layout !== undefined && LAYOUTS.includes(layout)) out.layout = layout as Layout;
  if (typeof r["palette"] === "object" && r["palette"] !== null) {
    const pal: Record<string, string> = {};
    for (const [k, v] of Object.entries(r["palette"] as Record<string, unknown>)) {
      const s = str(v); if (s !== undefined) pal[k] = s;
    }
    if (Object.keys(pal).length > 0) out.palette = pal;
  }
  if (typeof r["typeface"] === "object" && r["typeface"] !== null) {
    const tf: Record<string, string> = {};
    for (const [k, v] of Object.entries(r["typeface"] as Record<string, unknown>)) {
      const s = str(v); if (s !== undefined) tf[k] = s;
    }
    if (Object.keys(tf).length > 0) out.typeface = tf;
  }
  // the §6.3 axes. Same discipline as everything above: a malformed field is dropped, never thrown on,
  // so one bad hand-edit costs that axis and not the run.
  if (r["provisional"] === true) out.provisional = true;
  const chosenBy = str(r["chosenBy"])?.toLowerCase();
  if (chosenBy === "human" || chosenBy === "agent") out.chosenBy = chosenBy;
  if (Array.isArray(r["alternatives"])) {
    const alts = r["alternatives"].map(str).filter((x): x is string => x !== undefined);
    if (alts.length > 0) out.alternatives = alts;
  }
  const heroPattern = str(r["heroPattern"]); if (heroPattern !== undefined) out.heroPattern = heroPattern;
  const motion = str(r["motion"]); if (motion !== undefined) out.motion = motion;
  const copyRegister = str(r["copyRegister"]); if (copyRegister !== undefined) out.copyRegister = copyRegister;
  const density = str(r["density"])?.toLowerCase();
  if (density !== undefined && DENSITIES.includes(density)) out.density = density as Density;
  if (Array.isArray(r["sectionOrder"])) {
    const secs = r["sectionOrder"].map(str).filter((s): s is string => s !== undefined);
    if (secs.length > 0) out.sectionOrder = secs;
  }
  if (Array.isArray(r["typeScale"])) {
    const steps = r["typeScale"].filter((n): n is number => typeof n === "number" && Number.isFinite(n) && n > 0);
    if (steps.length > 0) out.typeScale = steps;
  }
  return out;
}

/** The recorded direction, or null when this project has not chosen one yet. Never throws. */
export function loadDirection(cwd: string): DesignDirection | null {
  const p = designPath(cwd);
  if (!existsSync(p)) return null;
  try { return parseDirection(JSON.parse(readFileSync(p, "utf8"))); } catch { return null; }
}

/** Write the direction the human chose. Returns the path written. */
export function saveDirection(cwd: string, d: DesignDirection): string {
  const p = designPath(cwd);
  mkdirSync(dirname(p), { recursive: true });
  const body: DesignDirection = { ...d, chosenAt: d.chosenAt ?? new Date().toISOString().slice(0, 10) };
  writeFileSync(p, JSON.stringify(body, null, 2) + "\n");
  return p;
}

/** The direction as prompt text — what the agent must stay faithful to. Empty string when none. */
export function renderDirection(d: DesignDirection | null): string {
  if (d === null) return "";
  const lines: string[] = d.provisional === true
    ? [`PROVISIONAL direction: ${d.name}${d.chosenAt ? ` (recorded ${d.chosenAt})` : ""} — chosen by the agent, no human was available.`,
       "Build to it, but ask the human once before the next screen: this is the one decision that is theirs."]
    : [`Chosen direction: ${d.name}${d.chosenAt ? ` (chosen ${d.chosenAt})` : ""}`];
  if (d.rationale !== undefined) lines.push(`Why: ${d.rationale}`);
  if (d.palette !== undefined) lines.push(`Palette: ${Object.entries(d.palette).map(([k, v]) => `${k} ${v}`).join(", ")}`);
  if (d.typeface !== undefined) {
    const roles = Object.entries(d.typeface);
    const faces = new Set(roles.map(([, f]) => f));
    // one face everywhere reads as one name; otherwise each role names its face
    lines.push(`Typefaces: ${faces.size === 1 ? roles[0]![1] : roles.map(([role, f]) => `${f} for ${role}`).join(", ")}`);
  }
  if (d.corners !== undefined) lines.push(`Corners: ${d.corners}`);
  if (d.layout !== undefined) lines.push(`Composition: ${d.layout}`);
  if (d.density !== undefined) lines.push(`Density: ${d.density}`);
  if (d.sectionOrder !== undefined) lines.push(`Section order: ${d.sectionOrder.join(" -> ")}`);
  if (d.heroPattern !== undefined) lines.push(`Hero: ${d.heroPattern}`);
  if (d.typeScale !== undefined) lines.push(`Type scale: ${d.typeScale.join(", ")}`);
  if (d.motion !== undefined) lines.push(`Motion: ${d.motion}`);
  if (d.copyRegister !== undefined) lines.push(`Copy register: ${d.copyRegister}`);
  if (d.notes !== undefined) lines.push(`Notes: ${d.notes}`);
  if (d.alternatives !== undefined) lines.push(`Not built: ${d.alternatives.join(", ")}`);
  return lines.join("\n");
}
