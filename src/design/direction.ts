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
  /** anything the audit cannot infer: motion, density, imagery, what to avoid in THIS project */
  notes?: string;
  /** ISO date the human chose it */
  chosenAt?: string;
}

export function designPath(cwd: string): string {
  return join(cwd, ".rovecode", DESIGN_FILE);
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined);

const CORNERS: readonly string[] = ["sharp", "soft", "round"];
const LAYOUTS: readonly string[] = ["centered", "left", "asymmetric", "grid"];

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
  const lines: string[] = [`Chosen direction: ${d.name}${d.chosenAt ? ` (chosen ${d.chosenAt})` : ""}`];
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
  if (d.notes !== undefined) lines.push(`Notes: ${d.notes}`);
  return lines.join("\n");
}
