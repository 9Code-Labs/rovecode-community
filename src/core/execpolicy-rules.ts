/** Port #9 (execpolicy, openai/codex, Apache-2.0) — data half: rule-spec types,
 *  the word-only shell-script parser, and the curated default rule set. The
 *  evaluation engine lives in execpolicy.ts (import surface for both files).
 *  `file:line` cites refer to research/source_snapshots/openai-codex/codex-rs. */

// ---------- decisions & rule specs (decision.rs:9-16; README.md:5-9,17-23) ----------

/** decision.rs:9-16 — Allow < Prompt < Forbidden (derived Ord = severity). */
export type Decision = "allow" | "prompt" | "forbidden";

/** One pattern slot: fixed token or alternatives (rule.rs:16-19 PatternToken).
 *  The FIRST slot may also be alternatives: the loader fans it out into one
 *  rule per head, since the policy keys rules by first token (parser.rs:384-403,
 *  rule.rs:40-43 PrefixPattern.first). */
export type PatternToken = string | readonly string[];

export interface PrefixRuleSpec {
  /** Ordered tokens (README.md:7); must be non-empty (parser.rs:177-179). */
  pattern: readonly PatternToken[];
  decision?: Decision; // defaults to "allow" (README.md:7, parser.rs:355-358)
  /** Optional rationale; must not be blank when present (parser.rs:363-366). */
  justification?: string;
  /** Load-time-validated positive examples (rule.rs:246-279). */
  match?: readonly (string | readonly string[])[];
  /** Load-time-validated negative examples (rule.rs:282-306). Validated against
   *  THIS spec's rules only, not the whole policy (parser.rs:133-148). */
  notMatch?: readonly (string | readonly string[])[];
}

// ---------- word-only shell-script parser (bash.rs:29-127, hand-rolled) ----------
// Accepts ONLY plain word commands joined by `&&` `||` `;` `|` and newlines
// (bash.rs:22-28,36-52). Everything else — subshells, redirections, `&`, $VAR,
// ${..}, $(..), backticks, escapes, glob/brace/tilde words, assignments —
// returns null so the caller treats the whole script as opaque. Upstream walks
// a tree-sitter-bash parse tree; this port tokenizes by hand but enforces the
// same accept set, erring toward rejection (opaque → needs approval).

/** Chars that make a BARE word expansion-risky (bash.rs:260-274) plus the
 *  structural chars tree-sitter would parse into rejected nodes. */
const UNSAFE_WORD_CHARS = new Set([..."{}*?[]\\~^#$`()<>"]);

export function parseShellScript(src: string): string[][] | null {
  const toks = tokenize(src);
  if (toks === null) return null;
  const commands: string[][] = [];
  let current: string[] = [];
  let pendingConnector = false; // after && || | a command MUST follow (bash.rs:497-514)
  const flush = (): boolean => {
    const head = current[0];
    // Variable-assignment prefix rejected (bash.rs:492-494 `FOO=bar ls`).
    if (head === undefined || /^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(head)) return false;
    commands.push(current);
    current = [];
    return true;
  };
  for (const t of toks) {
    if (t.kind === "word") {
      if (t.quotedHead && current.length === 0) return null; // command name must be a bare word (bash.rs:170-175)
      current.push(t.text);
    } else if (t.op === "\n") { // newline separates; blank lines + `ls &&\npwd` are fine
      if (current.length > 0) { if (!flush()) return null; pendingConnector = false; }
    } else if (t.op === ";") { // needs a command before it (bash.rs:506-509)
      if (current.length === 0 || !flush()) return null;
      pendingConnector = false;
    } else { // && || | — leading/doubled operator rejected (bash.rs:497-514)
      if (current.length === 0 || !flush()) return null;
      pendingConnector = true;
    }
  }
  if (pendingConnector && current.length === 0) return null; // trailing `ls &&` (bash.rs:497-499)
  if (current.length > 0 && !flush()) return null;
  return commands;
}

type Tok = { kind: "word"; text: string; quotedHead: boolean } | { kind: "op"; op: string };

function tokenize(src: string): Tok[] | null {
  const toks: Tok[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i];
    if (ch === undefined) break;
    if (ch === " " || ch === "\t" || ch === "\r") { i++; continue; } // \r: CRLF layout
    if (ch === "\n") { toks.push({ kind: "op", op: "\n" }); i++; continue; }
    if (ch === "&") {
      if (src[i + 1] !== "&") return null; // background `&` (bash.rs:410-413)
      toks.push({ kind: "op", op: "&&" }); i += 2; continue;
    }
    if (ch === "|") {
      if (src[i + 1] === "|") { toks.push({ kind: "op", op: "||" }); i += 2; continue; }
      if (src[i + 1] === "&") return null; // `|&` stderr pipe — not an allowed operator
      toks.push({ kind: "op", op: "|" }); i++; continue;
    }
    if (ch === ";") {
      if (src[i + 1] === ";") return null; // `;;` (bash.rs:506-509)
      toks.push({ kind: "op", op: ";" }); i++; continue;
    }
    // word: concatenation of bare and quoted runs (bash.rs:188-213)
    let text = "";
    let runs = 0;
    let quotedFirstRun = false;
    while (i < n) {
      const c = src[i];
      if (c === undefined) break;
      if (" \t\r\n&|;".includes(c)) break;
      if (c === "'") { // raw string: verbatim to closing quote (bash.rs:303-313)
        const end = src.indexOf("'", i + 1);
        if (end === -1) return null;
        text += src.slice(i + 1, end);
        if (runs === 0) quotedFirstRun = true;
        runs++; i = end + 1; continue;
      }
      if (c === '"') { // double-quoted: literal content only (bash.rs:276-301)
        const parsed = scanDoubleQuoted(src, i);
        if (parsed === null) return null;
        text += parsed.text;
        if (runs === 0) quotedFirstRun = true;
        runs++; i = parsed.next; continue;
      }
      let bare = ""; // bare run
      while (i < n) {
        const b = src[i];
        if (b === undefined || " \t\r\n&|;'\"".includes(b)) break;
        if (UNSAFE_WORD_CHARS.has(b)) return null; // bash.rs:260-274
        bare += b; i++;
      }
      if (bare.startsWith("=")) return null; // zsh equals expansion (bash.rs:271)
      if (runs === 0 && bare === "!") return null; // pipeline negation
      text += bare; runs++;
    }
    if (runs > 1 && text.length === 0) return null; // empty concatenation (bash.rs:209-211)
    toks.push({ kind: "word", text, quotedHead: quotedFirstRun });
  }
  return toks;
}

/** Double-quoted scan (bash.rs:276-301): reject `$` and backtick (expansions)
 *  and backslash before the special set (bash.rs:293-299); everything else is
 *  literal — e.g. "\n" stays two literal chars (bash.rs:453-455). */
function scanDoubleQuoted(src: string, start: number): { text: string; next: number } | null {
  let i = start + 1;
  let text = "";
  while (i < src.length) {
    const c = src[i];
    if (c === undefined) return null;
    if (c === '"') return { text, next: i + 1 };
    if (c === "$" || c === "`") return null;
    if (c === "\\") {
      const nx = src[i + 1];
      if (nx === undefined || nx === "$" || nx === "`" || nx === '"' || nx === "\\" || nx === "\n") return null;
      text += c + nx; i += 2; continue;
    }
    text += c; i++;
  }
  return null; // unterminated
}

// ---------- default rules (data, not code) ----------
// Curated from execpolicy/examples/example.codexpolicy plus the flag-aware git
// cases the port bar names. Read-only → allow; state-changing → prompt;
// history-destroying → forbidden with justification (README.md:8).

export const DEFAULT_RULES: readonly PrefixRuleSpec[] = [
  { pattern: ["ls"], match: [["ls"], "ls -la ."] },       // example.codexpolicy:17-24
  { pattern: ["pwd"], match: [["pwd"]] },                  // :65-70
  { pattern: ["cat"], match: ["cat file.txt"] },           // :26-32
  { pattern: ["head"], match: ["head -n 5 CHANGELOG.md"], notMatch: [["hea", "-n", "1"]] }, // :43-52
  { pattern: ["tail"] },
  { pattern: ["wc"] },
  { pattern: ["echo"] },
  { pattern: ["which"], match: ["which python3"] },        // :72-78
  { pattern: ["printenv"], notMatch: [["print", "-0"]] },  // :54-63
  { pattern: ["grep"] },
  // NO rg rule (R2 #9 HIGH-1a): `rg --pre <cmd>` / `--hostname-bin <cmd>` execute
  // arbitrary programs, and the rule was an rovecode ADDITION absent from upstream
  // example.codexpolicy — unknown rg falls to heuristics → prompt.
  { pattern: ["cd"] },
  { pattern: ["git", ["status", "log", "diff", "show", "branch"]],
    match: ["git status", ["git", "log", "--oneline"]], notMatch: ["git stash"] },
  // R2 #9 HIGH-1b: destructive git-branch flags escalate the reader rule above
  // via strictest-wins; bare `git branch` / `git branch --list` stay allowed.
  { pattern: ["git", "branch", ["-D", "-d", "-m", "-M", "-f", "--delete", "--force", "--move"]],
    decision: "prompt", justification: "deletes or rewrites branches; confirm the target",
    match: ["git branch -D feature", ["git", "branch", "--delete", "old"]],
    notMatch: ["git branch", "git branch --list", "git branch -a"] },
  { pattern: ["git", "push"], decision: "prompt", justification: "pushes publish state; confirm the remote and branch",
    match: ["git push", "git push --force-with-lease"] },
  { pattern: ["git", "push", ["--force", "-f"]], decision: "forbidden",
    justification: "history-rewriting push; use --force-with-lease after user sign-off",
    match: ["git push --force", ["git", "push", "-f", "origin", "main"]],
    notMatch: ["git push", "git push --force-with-lease"] },
  // example.codexpolicy:4-15 verbatim case
  { pattern: ["git", "reset", "--hard"], decision: "forbidden", justification: "destructive operation",
    match: [["git", "reset", "--hard"]], notMatch: [["git", "reset", "--keep"], "git reset --merge"] },
];
