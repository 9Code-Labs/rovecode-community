/** design_audit / design_direction — the agent's half of the design protocol (design/rules.ts).
 *
 *  Split like provider_list/provider_edit (and task/task_status) for the same reason: reading must
 *  never cost a prompt, writing must be visible.
 *    - design_audit is kind "read" -> policy action file.read, auto-allowed under the gated rules and
 *      in plan mode. Checking your own work has to be free, or it will not happen.
 *    - design_direction is kind "custom" -> action tool.design_direction, PROMPT under the gated rules
 *      (cli/runtime.ts buildCfg), denied in plan mode by the blanket tool.* rule, allowed under yolo.
 *      It writes the project's design identity, and the approval card is where the human sees exactly
 *      what is being recorded on their behalf. It is asked ONCE per project, which is the whole design
 *      of the feature -- so the one prompt is the point, not friction.
 *
 *  design_direction deliberately cannot invent a direction: `set` records what the human chose. The
 *  model is expected to have asked first (the prompt section says so). Nothing here can enforce that
 *  -- what it can do is keep the record honest and put the write in front of a human once. */

import { isAbsolute, relative, resolve } from "node:path";
import type { Tool, ToolOutput } from "../core/types.ts";
import { auditFiles, auditProject, formatFindings, type Finding } from "../design/audit.ts";
import {
  designPath, loadDirection, parseDirection, renderDirection, saveDirection,
  type DesignDirection,
} from "../design/direction.ts";

/** Resolve a caller-supplied path against the run's cwd and refuse to leave it: an audit is about
 *  THIS project's files, and a read tool that wanders is a read tool nobody can reason about. */
function insideCwd(cwd: string, p: string): string | null {
  const abs = isAbsolute(p) ? resolve(p) : resolve(cwd, p);
  const rel = relative(resolve(cwd), abs);
  return rel === "" || rel.startsWith("..") || isAbsolute(rel) ? null : abs;
}

export function designAuditTool(): Tool {
  return {
    schema: {
      name: "design_audit",
      description:
        "Check interface code for the patterns that arrive when nobody decided (a webfont loaded without a choice, amber doing accent duty, the three-up feature grid, a centred full-viewport hero, the violet-to-blue gradient, nothing but square corners) and for drift from the direction this project recorded in .rovecode/design.json. Run it on the SOURCE TREE, not on a fetched page: a built page measures the framework's output, not the design. Pass the page files you touched along with the components they import, because density and centring are scored per page and 'no rounded corner anywhere' is scored per project. It reports evidence, not verdicts: each finding says what it counted, so you can fix it or explain why it is wrong here. Never prompts, never writes.",
      args: {
        type: "object",
        properties: {
          files: { type: "array", items: { type: "string" }, description: "paths inside the project to audit (html/css/jsx/tsx/vue/svelte)" },
          source: { type: "string", description: "audit this markup/CSS directly instead of reading files" },
          ignore: { type: "array", items: { type: "string" }, description: "rule ids to skip (the full table is in docs/design.md): cliche-font, font-deviation, font-named-not-loaded, cliche-accent-amber, accent-deviation, template-grid, template-icons, reflex-hero, cliche-gradient, off-palette, decoration-density, rule-line-density, everything-centered, all-square" },
        },
      },
    },
    kind: "read",
    sequential: false,
    async execute(args, ctx): Promise<ToolOutput> {
      const a = (args && typeof args === "object" ? args : {}) as { files?: string[]; source?: string; ignore?: string[] };
      const direction = loadDirection(ctx.cwd);
      const ignore = a.ignore ?? [];
      const findings: Finding[] = [];

      // `source` is one pathless page: auditProject treats a lone file as a page so pasted markup still
      // gets the page-scoped density and centring checks (auditSource alone is file-scope by design).
      if (typeof a.source === "string" && a.source.length > 0) {
        findings.push(...auditProject([{ path: "source", text: a.source }], { direction, ignore }));
      }
      const paths = a.files ?? [];
      if (paths.length > 0) {
        const resolved: string[] = [];
        const outside: string[] = [];
        for (const p of paths) {
          const abs = insideCwd(ctx.cwd, p);
          if (abs === null) outside.push(p); else resolved.push(abs);
        }
        if (outside.length > 0) {
          return { ok: false, output: `design_audit only reads files inside the project. Outside: ${outside.join(", ")}` };
        }
        findings.push(...auditFiles(resolved, { direction, ignore }).map((f) => ({
          ...f, ...(f.file !== undefined ? { file: relative(resolve(ctx.cwd), f.file) || f.file } : {}),
        })));
      }
      if (paths.length === 0 && (a.source === undefined || a.source.length === 0)) {
        return { ok: false, output: "design_audit needs `files` (paths inside the project) or `source` (markup/CSS text)." };
      }
      return { ok: true, output: formatFindings(findings, direction), data: { findings, direction } };
    },
  };
}

export function designDirectionTool(): Tool {
  return {
    schema: {
      name: "design_direction",
      description:
        "Read or record this project's design direction (.rovecode/design.json). `get` returns the recorded direction, or says none is recorded. `set` records the direction THE HUMAN CHOSE after you proposed three — do not call it with a direction you picked yourself. The one exception is a headless run where nothing can ask a human: then build ONE direction and record it with provisional:true and the other two in `alternatives`, so the next interactive session asks before more UI is built. Recording it is what makes the choice a once-per-project question and lets design_audit check later screens for consistency.",
      args: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["get", "set"] },
          name: { type: "string", description: "short name of the chosen direction, as presented to the human" },
          rationale: { type: "string", description: "one line: why it suits this product" },
          palette: { type: "object", description: "chosen colours, e.g. {\"ink\":\"#0b1a2e\",\"accent\":\"#c2410c\"}" },
          typeface: { type: "object", description: "{\"display\":\"...\",\"text\":\"...\"}" },
          corners: { type: "string", enum: ["sharp", "soft", "round"] },
          layout: { type: "string", enum: ["centered", "left", "asymmetric", "grid"] },
          density: { type: "string", enum: ["tight", "regular", "airy"] },
          sectionOrder: { type: "array", items: { type: "string" }, description: "the page's blocks in order, e.g. [\"hero\",\"proof\",\"pricing\",\"faq\"]" },
          heroPattern: { type: "string", description: "the hero pattern by name, e.g. \"command-first\" or \"product-forward\"" },
          typeScale: { type: "array", items: { type: "number" }, description: "the chosen type steps, e.g. [14,16,20,28,44]" },
          motion: { type: "string", description: "the motion rule in the human's words, e.g. \"one entrance per section, no loops\"" },
          copyRegister: { type: "string", description: "how the copy reads, e.g. \"technical, names and numbers, no marketing verbs\"" },
          notes: { type: "string", description: "what the audit cannot infer: imagery, what to avoid here" },
          provisional: { type: "boolean", description: "true ONLY when no human could be asked (a headless run): you built to one direction to get unblocked. Never true when a human answered." },
          alternatives: { type: "array", items: { type: "string" }, description: "with provisional: the names of the directions you did NOT build, so the next interactive session can offer them" },
        },
        required: ["action"],
      },
    },
    kind: "custom",
    sequential: true,
    // `get` reads .rovecode/design.json and writes nothing; `set` records the project's design
    // identity. Only the second is worth a human's attention, so the two get their own policy
    // resource (types.ts Tool.resource) instead of sharing one rule under the tool name. Anything
    // that is not the literal "get" is treated as the write: an unknown action must not read as
    // the safer of the two.
    resource(args: unknown): string {
      const a = args && typeof args === "object" ? (args as Record<string, unknown>) : undefined;
      return a?.["action"] === "get" ? "get" : "set";
    },
    async execute(args, ctx): Promise<ToolOutput> {
      const a = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
      if (a["action"] === "get") {
        const d = loadDirection(ctx.cwd);
        return d === null
          ? { ok: true, output: `No design direction recorded for this project (${designPath(ctx.cwd)} does not exist). Propose three distinct directions and let the human choose before writing UI. If nothing here can ask a human, build ONE and record it with provisional: true.` }
          : { ok: true, output: renderDirection(d), data: d };
      }
      if (a["action"] !== "set") return { ok: false, output: "design_direction: action must be \"get\" or \"set\"." };

      const parsed: DesignDirection | null = parseDirection(a);
      if (parsed === null) {
        return { ok: false, output: "design_direction set needs at least `name` — the short name of the direction the human chose." };
      }
      // Who chose is DERIVED, never taken from the call: `provisional` means the agent picked, its
      // absence means a human did. Trusting the model with both fields lets one contradict the other,
      // and the whole point of the field is that it can be believed. Stamped on every write, so a
      // record always says who — absent is only ever a file written before the field existed.
      parsed.chosenBy = parsed.provisional === true ? "agent" : "human";
      const path = saveDirection(ctx.cwd, parsed);
      if (parsed.provisional === true) {
        const alts = parsed.alternatives === undefined ? "" : ` The alternatives (${parsed.alternatives.join(", ")}) are recorded with it.`;
        return { ok: true, output: `Recorded "${parsed.name}" in ${path} as PROVISIONAL — you chose it, not the human.${alts} Build to it and say so in your final summary, naming what you did not build. The next interactive session asks before more UI is written.`, data: parsed };
      }
      return { ok: true, output: `Recorded "${parsed.name}" in ${path}. Later UI in this project is built to it, and design_audit checks against it.`, data: parsed };
    },
  };
}
