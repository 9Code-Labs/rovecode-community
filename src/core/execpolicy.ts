/** Port #9: declarative exec policy, ported from openai/codex (Apache-2.0),
 *  snapshot research/source_snapshots/openai-codex/codex-rs. `file:line` cites:
 *  execpolicy/src/{decision,rule,policy,parser}.rs (rule format + evaluation) ·
 *  shell-command/src/bash.rs (word-only script parser → execpolicy-rules.ts) ·
 *  shell-command/src/command_safety/is_dangerous_command.rs (heuristics) ·
 *  core/src/exec_policy.rs (integration: strictest across chain segments).
 *  Guiding rule: when unsure, treat input as OPAQUE and escalate to "prompt"
 *  (deny-default). Over-rejection is safe; under-rejection is a bug. */

import type { ApprovalFn, ApprovalRequest } from "./types.ts";
import type { Decision, PatternToken, PrefixRuleSpec } from "./execpolicy-rules.ts";
import { DEFAULT_RULES, parseShellScript } from "./execpolicy-rules.ts";

export type { Decision, PatternToken, PrefixRuleSpec };
export { DEFAULT_RULES, parseShellScript };

// ---------- decisions (decision.rs:9-16 — Allow < Prompt < Forbidden) ----------

const SEVERITY: Record<Decision, number> = { allow: 0, prompt: 1, forbidden: 2 };

/** Strictest-wins aggregation (policy.rs:402-411 takes max over matches; the
 *  empty case is the max() identity — internal callers guarantee non-empty). */
export function strictest(decisions: readonly Decision[]): Decision {
  let out: Decision = "allow";
  for (const d of decisions) if (SEVERITY[d] > SEVERITY[out]) out = d;
  return out;
}

export type RuleMatch =
  | { kind: "rule"; decision: Decision; matchedPrefix: string[]; justification?: string }
  | { kind: "heuristics"; decision: Decision; command: string[]; justification?: string };

export interface Evaluation { decision: Decision; matchedRules: RuleMatch[] }

// ---------- compiled rules & matching ----------

interface CompiledRule { tokens: PatternToken[]; decision: Decision; justification?: string }
type RuleMap = Map<string, CompiledRule[]>;

/** rule.rs:46-59 matches_prefix — cmd at least pattern-length; slots positional. */
function matchesPrefix(rule: CompiledRule, cmd: readonly string[]): string[] | null {
  if (cmd.length < rule.tokens.length) return null;
  for (let i = 0; i < rule.tokens.length; i++) {
    const t = rule.tokens[i], c = cmd[i];
    if (t === undefined || c === undefined) return null;
    if (typeof t === "string" ? t !== c : !t.includes(c)) return null;
  }
  return cmd.slice(0, rule.tokens.length);
}

/** All rule matches for one command against a rule map: exact first-token rules,
 *  then basename fallback for ABSOLUTE program paths (policy.rs:305-371; the
 *  AbsolutePathBuf gate at policy.rs:348 is why `./ls` gets NO fallback). Used
 *  by both policy evaluation and load-time example validation, which upstream
 *  runs with resolve_host_executables=true (exec_policy.rs:357-359,
 *  rule.rs:252-254). No heuristics here. */
function collectMatches(map: RuleMap, cmd: readonly string[]): RuleMatch[] {
  const first = cmd[0];
  if (first === undefined) return [];
  const collect = (key: string, c: readonly string[]): RuleMatch[] =>
    (map.get(key) ?? []).flatMap((r) => {
      const prefix = matchesPrefix(r, c);
      return prefix ? [{ kind: "rule" as const, decision: r.decision, matchedPrefix: prefix, justification: r.justification }] : [];
    });
  const exact = collect(first, cmd);
  if (exact.length > 0) return exact;
  // Codex additionally checks host_executable() path allowlists; absent an
  // entry, fallback is allowed (README.md:43-44) — rovecode carries no such
  // metadata, so this is always that case.
  if (!isAbsolutePath(first)) return [];
  const base = executableLookupKey(first);
  return base !== null && base !== first ? collect(base, [base, ...cmd.slice(1)]) : [];
}

/** Compile one spec into per-head rules. The first slot may be alternatives:
 *  one rule per head, keyed by it (parser.rs:384-403). Load-time validations
 *  mirror the starlark builtin: non-empty pattern (parser.rs:177-179),
 *  non-empty alternative lists (parser.rs:205-208), non-blank justification
 *  (parser.rs:363-366). */
function compileSpec(spec: PrefixRuleSpec): RuleMap {
  if (spec.justification !== undefined && spec.justification.trim() === "") {
    throw new Error("prefix_rule: justification cannot be empty");
  }
  const [first, ...rest] = spec.pattern;
  if (first === undefined) throw new Error("prefix_rule: pattern cannot be empty");
  for (const tok of spec.pattern) {
    if (typeof tok !== "string" && tok.length === 0) throw new Error("prefix_rule: pattern alternatives cannot be empty");
  }
  const heads = typeof first === "string" ? [first] : [...first];
  const map: RuleMap = new Map();
  for (const head of heads) {
    if (head.length === 0) throw new Error("prefix_rule: pattern tokens must be non-empty strings");
    const list = map.get(head) ?? [];
    list.push({ tokens: [head, ...rest], decision: spec.decision ?? "allow", justification: spec.justification });
    map.set(head, list);
  }
  return map;
}

// ---------- policy ----------

export class ExecPolicy {
  private rulesByProgram: RuleMap = new Map();

  constructor(specs: readonly PrefixRuleSpec[]) {
    const perSpec: RuleMap[] = specs.map(compileSpec);
    for (const specMap of perSpec) {
      for (const [head, rules] of specMap) {
        const list = this.rulesByProgram.get(head) ?? [];
        list.push(...rules);
        this.rulesByProgram.set(head, list);
      }
    }
    // Example validation runs per DECLARATION, against only that declaration's
    // rules — not the whole policy (parser.rs:133-148 builds a mini-policy from
    // validation.rules; not_match first, then match, parser.rs:145-148). A
    // not_match example may legitimately match a DIFFERENT rule.
    specs.forEach((spec, i) => {
      const specMap = perSpec[i]!;
      for (const ex of spec.notMatch ?? []) {
        const cmd = exampleToArgv(ex);
        if (collectMatches(specMap, cmd).length > 0) throw new Error(`prefix_rule not_match example matched its rule: ${renderCommand(cmd)}`); // rule.rs:282-306
      }
      for (const ex of spec.match ?? []) {
        const cmd = exampleToArgv(ex);
        if (collectMatches(specMap, cmd).length === 0) throw new Error(`prefix_rule match example did not match its rule: ${renderCommand(cmd)}`); // rule.rs:246-279
      }
    });
  }

  /** Evaluate ONE tokenized command; unmatched falls back to heuristics, so the
   *  match list is never empty (policy.rs:305-332). Flag-aware escalations ride
   *  along regardless — they only ADD prompt matches, never remove any. */
  check(cmd: readonly string[]): Evaluation {
    let matched = collectMatches(this.rulesByProgram, cmd);
    if (matched.length === 0) matched = [unmatchedHeuristics(cmd)];
    matched = [...matched, ...escalationMatches(cmd)];
    return { decision: strictest(matched.map((m) => m.decision)), matchedRules: matched };
  }

  /** Evaluate chain members; aggregate decision is the strictest across ALL
   *  segments (exec_policy.rs:360-364, policy.rs:265-288 check_multiple).
   *  Upstream treats empty input as an invariant violation (policy.rs:401-405);
   *  rovecode fails closed instead: empty → heuristics prompt. */
  checkMany(commands: readonly (readonly string[])[]): Evaluation {
    const matched = commands.flatMap((c) => this.check(c).matchedRules);
    if (matched.length === 0) return this.check([]);
    return { decision: strictest(matched.map((m) => m.decision)), matchedRules: matched };
  }

  /** Evaluate a raw command line as run by rovecode's bash tool (`bash -c script`).
   *  Word-only scripts split into members; anything else is OPAQUE and checked
   *  as the single command ["bash","-c",script] (exec_policy.rs:835-862). */
  checkScript(script: string): Evaluation {
    const commands = parseShellScript(script);
    return commands !== null && commands.length > 0 ? this.checkMany(commands) : this.check(["bash", "-c", script]);
  }
}

/** Basename key: strip dirs and Windows .exe/.cmd/.bat/.com suffixes
 *  (is_dangerous_command.rs:70-94). Null for non-path tokens. Deviation: codex
 *  lowercases the whole basename on Windows only; rovecode normalizes case only
 *  when a known suffix is stripped — a bare-name case mismatch just falls back
 *  to heuristics (over-rejection, safe). */
function executableLookupKey(raw: string): string | null {
  if (!raw.includes("/") && !raw.includes("\\")) return null;
  const base = raw.split(/[/\\]/).pop() ?? "";
  if (base === "") return null;
  const lower = base.toLowerCase();
  for (const suf of [".exe", ".cmd", ".bat", ".com"]) if (lower.endsWith(suf)) return lower.slice(0, -suf.length);
  return base;
}

/** POSIX `/...`, Windows drive `C:\...`/`C:/...`, or UNC `\\...` — the shapes
 *  AbsolutePathBuf::try_from accepts at policy.rs:348. Relative paths get no
 *  basename fallback and land in heuristics. */
function isAbsolutePath(raw: string): boolean {
  return raw.startsWith("/") || raw.startsWith("\\\\") || /^[A-Za-z]:[/\\]/.test(raw);
}

// ---------- unmatched-command heuristics ----------

/** rovecode's fixed mapping for unmatched commands: ALWAYS needs approval. Codex
 *  derives this from approval mode + sandbox (exec_policy.rs:735-819); rovecode has
 *  no sandbox, i.e. codex's UnlessTrusted arm → Prompt (exec_policy.rs:779-783).
 *  Dangerous commands also Prompt (exec_policy.rs:763-771), and the danger
 *  reason rides along for the approver (codex surfaces it when the prompt is
 *  rejected, exec_policy.rs:1056-1077). */
function unmatchedHeuristics(cmd: readonly string[]): RuleMatch {
  const danger = dangerousCommandMatch(cmd);
  return {
    kind: "heuristics", decision: "prompt", command: [...cmd],
    justification: danger === "forced-rm"
      ? "rm -f style commands are not permitted. Use a safer approach" // exec_policy.rs:1071-1074
      : danger === "other" ? "blocked by policy" : undefined, // exec_policy.rs:1075
  };
}

/** R2 #9 HIGH-1c (rovecode escalation, no upstream twin): `--output <path>` /
 *  `--output=<path>` turns git's readers (diff/show/log) into WRITERS, so a
 *  rule-allowed invocation gains a write side effect. Prefix rules match
 *  whole tokens positionally and cannot see `--output=x` mid-argv, so this
 *  scan adds a prompt match that strictest-wins aggregates with the rules.
 *  Tokens after `--` are pathspecs, not flags — the scan stops there
 *  (mirrors rmArgsIncludeForce, is_dangerous_command.rs:164-173). */
const OUTPUT_FLAG_SUBCOMMANDS = new Set(["diff", "show", "log"]);
// git accepts flags AFTER positionals (`git branch stale -D`), which the
// positional HIGH-1b prefix rule cannot see — the same scan covers any slot.
const BRANCH_DESTRUCTIVE_FLAGS = new Set(["-D", "-d", "-m", "-M", "-f", "--delete", "--force", "--move"]);
function escalationMatches(cmd: readonly string[]): RuleMatch[] {
  const first = cmd[0];
  const head = first === undefined ? null : (executableLookupKey(first) ?? first);
  const sub = cmd[1];
  if (head !== "git" || sub === undefined) return [];
  if (sub === "branch") {
    for (const a of cmd.slice(2)) {
      if (a === "--") break;
      if (BRANCH_DESTRUCTIVE_FLAGS.has(a)) {
        return [{ kind: "heuristics", decision: "prompt", command: [...cmd],
          justification: "deletes or rewrites branches; confirm the target" }];
      }
    }
    return [];
  }
  if (!OUTPUT_FLAG_SUBCOMMANDS.has(sub)) return [];
  for (const a of cmd.slice(2)) {
    if (a === "--") break;
    if (a === "--output" || a.startsWith("--output=")) {
      return [{ kind: "heuristics", decision: "prompt", command: [...cmd],
        justification: "--output writes the result to a file; confirm the destination" }];
    }
  }
  return [];
}

export type DangerKind = "forced-rm" | "other";
const MAX_WRAPPER_DEPTH = 8; // is_dangerous_command.rs:16

/** Flag-aware dangerous-command detector (is_dangerous_command.rs:19-173).
 *  Detection only escalates: it never proves a command safe. */
export function dangerousCommandMatch(cmd: readonly string[], depth = 0): DangerKind | null {
  if (depth > MAX_WRAPPER_DEPTH) return "other"; // fail closed (:27-29)
  const head = cmd[0] === undefined ? null : (executableLookupKey(cmd[0]) ?? cmd[0]);
  if (head === "rm" && rmArgsIncludeForce(cmd.slice(1))) return "forced-rm"; // :105-107
  if (head === "sudo") return dangerousCommandMatch(cmd.slice(1), depth + 1); // :110
  if (head === "env") { // skip assignments / -i before the wrapped command (:123-144)
    let i = 1;
    while (i < cmd.length) {
      const a = cmd[i];
      if (a === undefined) break;
      if (a === "--") { i++; break; }
      if (a === "-i" || a === "--ignore-environment" || /^[^-=][^=]*=/.test(a)) { i++; continue; }
      break;
    }
    return dangerousCommandMatch(cmd.slice(i), depth + 1);
  }
  if (head === "trap") { // trap action is shell source in the first operand (:146-162)
    const i = cmd[1] === "--" ? 2 : 1;
    const action = cmd[i];
    if (action === undefined || action.startsWith("-")) return null;
    return dangerousScript(action, depth + 1);
  }
  // bash/sh/zsh -c|-lc script: scan inner members (bash.rs:106-119 accepts
  // exactly [shell, -c|-lc, script]). Upstream scans the LITERAL parse tree
  // (is_dangerous_command.rs:37-43 parse_shell_lc_literal_commands) so it sees
  // inside control flow and substitutions; rovecode reuses the strict parser —
  // opaque inner scripts stay undetected HERE but classify as prompt anyway
  // via the opaque path, losing only the specific danger message.
  if ((head === "bash" || head === "sh" || head === "zsh") && cmd.length === 3
    && (cmd[1] === "-c" || cmd[1] === "-lc") && cmd[2] !== undefined) return dangerousScript(cmd[2], depth + 1);
  return null;
}

function dangerousScript(script: string, depth: number): DangerKind | null {
  const commands = parseShellScript(script);
  if (commands === null) return null;
  for (const c of commands) {
    const hit = dangerousCommandMatch(c, depth);
    if (hit !== null) return hit;
  }
  return null;
}

/** rm force flags: --force or a combined short group containing `f`, scanning
 *  only args BEFORE `--` (is_dangerous_command.rs:164-173). */
function rmArgsIncludeForce(args: readonly string[]): boolean {
  for (const a of args) {
    if (a === "--") return false;
    if (a === "--force" || (a.startsWith("-") && !a.startsWith("--") && a.includes("f"))) return true;
  }
  return false;
}

let defaultPolicyCache: ExecPolicy | null = null;
export function defaultExecPolicy(): ExecPolicy {
  return (defaultPolicyCache ??= new ExecPolicy(DEFAULT_RULES));
}

// ---------- shell.exec refinement (the ≤10-line wiring surface) ----------

export type ExecRefinement =
  | { effect: "allow" }
  | { effect: "prompt"; reason?: string }
  | { effect: "deny"; reason: string };

/** Classify one raw command line into the refinement the approval path needs.
 *  Reason texts follow codex's derive_forbidden_reason / derive_prompt_reason
 *  (exec_policy.rs:1016-1054, 981-1007): most specific matching rule wins. */
export function refineExec(command: string, policy: ExecPolicy = defaultExecPolicy()): ExecRefinement {
  const ev = policy.checkScript(command);
  if (ev.decision === "forbidden") {
    const rule = mostSpecific(ev, "forbidden");
    const reason = rule?.justification !== undefined
      ? `\`${command}\` rejected: ${rule.justification}`
      : rule !== null
        ? `\`${command}\` rejected: policy forbids commands starting with \`${renderCommand(rule.matchedPrefix)}\``
        : `\`${command}\` rejected: blocked by policy`;
    return { effect: "deny", reason };
  }
  if (ev.decision === "prompt") {
    const rule = mostSpecific(ev, "prompt");
    const heur = ev.matchedRules.find((m) => m.kind === "heuristics" && m.justification !== undefined);
    const reason = rule !== null
      ? (rule.justification !== undefined ? `\`${command}\` requires approval: ${rule.justification}` : `\`${command}\` requires approval by policy`)
      : heur?.justification; // rovecode extension: danger reason shown at prompt time, not only on rejection
    return { effect: "prompt", reason };
  }
  return { effect: "allow" };
}

function mostSpecific(ev: Evaluation, decision: Decision): Extract<RuleMatch, { kind: "rule" }> | null {
  let best: Extract<RuleMatch, { kind: "rule" }> | null = null;
  for (const m of ev.matchedRules) {
    if (m.kind !== "rule" || m.decision !== decision) continue;
    if (best === null || m.matchedPrefix.length > best.matchedPrefix.length) best = m;
  }
  return best;
}

/** shlex-ish rendering for messages (exec_policy.rs:1009-1011). */
function renderCommand(args: readonly string[]): string {
  return args.map((a) => (/^[A-Za-z0-9@%_+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, "'\\''")}'`)).join(" ");
}

/** Examples: token arrays pass through; strings must parse as ONE plain command.
 *  Upstream tokenizes strings with shlex (README.md:9, parser.rs:298-308); the
 *  strict parser is narrower, which only rejects at rule-authoring time. */
function exampleToArgv(ex: string | readonly string[]): string[] {
  if (typeof ex !== "string") return [...ex];
  const parsed = parseShellScript(ex);
  const first = parsed?.[0];
  if (parsed === null || parsed.length !== 1 || first === undefined) throw new Error(`prefix_rule example is not a single plain command: ${ex}`);
  return first;
}

// ---------- approver wrapper (integration seam) ----------

export interface ExecPolicyApproverOptions {
  policy?: ExecPolicy;
  /** Tool names whose string `command` arg is shell (default: rovecode's bash tool). */
  tools?: readonly string[];
}

/** Wrap an ApprovalFn so execpolicy refines the shell.exec PROMPT branch:
 *  allow → approve without asking ("once", never cached by dispatch), forbidden
 *  → deny before any human sees it, prompt → delegate to the inner approver
 *  with the policy justification attached. dispatch only calls approvers inside
 *  its prompt branch (tools.ts step 3), so allow/deny permission rules stay the
 *  outer gate — this can never widen or bypass them (ADR-005). */
export function execPolicyApprover(inner: ApprovalFn | undefined, opts: ExecPolicyApproverOptions = {}): ApprovalFn {
  const policy = opts.policy ?? defaultExecPolicy();
  const tools = new Set(opts.tools ?? ["bash"]);
  return async (req: ApprovalRequest): Promise<"once" | "always" | "deny"> => {
    const args = req.revisedArgs ?? req.args;
    const command = tools.has(req.tool) && typeof args === "object" && args !== null
      && typeof (args as Record<string, unknown>)["command"] === "string"
      ? String((args as Record<string, unknown>)["command"]) : null;
    if (command === null) return inner ? inner(req) : "deny";
    const refined = refineExec(command, policy);
    if (refined.effect === "allow") return "once";
    if (refined.effect === "deny") return "deny";
    if (!inner) return "deny"; // headless: prompts fail closed, mirroring codex's Never→Forbidden arm (exec_policy.rs:765-770)
    return inner(refined.reason !== undefined ? { ...req, reason: refined.reason } : req);
  };
}
