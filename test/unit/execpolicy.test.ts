/** Tests for the execpolicy port (#9). `file:line` cites refer to upstream
 *  openai/codex snapshot research/source_snapshots/openai-codex/codex-rs —
 *  tables mirror upstream tests in shell-command/src/bash.rs:315-565 and
 *  shell-command/src/command_safety/is_dangerous_command.rs:175-288. */
import { test, expect } from "bun:test";
import {
  ExecPolicy, defaultExecPolicy, refineExec, strictest, parseShellScript,
  dangerousCommandMatch, execPolicyApprover,
} from "../../src/core/execpolicy.ts";
import { ToolRegistry } from "../../src/core/tools.ts";
import type {
  ApprovalFn, ApprovalRequest, PermissionRule, RunEvent, Tool, ToolCallPart, ToolContext,
} from "../../src/core/types.ts";

// ── classification table (default rules; bar: safe / needs-approval / forbidden) ──

const CASES: [string, "allow" | "prompt" | "deny"][] = [
  ["ls", "allow"],
  ["ls -la .", "allow"],
  ["pwd", "allow"],
  ["cat file.txt", "allow"],
  ["head -n 5 CHANGELOG.md", "allow"],           // option-value form
  ["git status", "allow"],
  ["git log --oneline", "allow"],
  ["git diff HEAD", "allow"],
  ["echo 'hi there'", "allow"],
  ["git push", "prompt"],                        // state-changing → approval
  ["git push origin main", "prompt"],
  ["git push --force-with-lease", "prompt"],     // NOT the forbidden flag
  ["git push --force", "deny"],                  // flag-aware: ≠ `git push`
  ["git push -f origin main", "deny"],           // short flag + option-value args
  ["git reset --hard", "deny"],                  // example.codexpolicy:4-15
  ["git reset --keep", "prompt"],                // unknown git subcommand → default
  ["git stash", "prompt"],
  ["frobnicate --yes", "prompt"],                // unknown command → deny-default spirit
  ["python -c 'print(1)'", "prompt"],
  // R2 #9 HIGH-1: rg dropped from the allow list (--pre/--hostname-bin run programs);
  // git branch destructive flags and git diff/show/log --output escalate to prompt
  ["rg -n TODO src", "prompt"],
  ["rg --pre /tmp/payload.sh secrets.txt", "prompt"],
  ["git branch", "allow"],
  ["git branch --list", "allow"],
  ["git branch -D feature", "prompt"],
  ["git diff --output=/tmp/x.patch HEAD", "prompt"],
  ["ls && git diff --output out.txt", "prompt"], // escalation aggregates across chains too
  // chaining: composite escalates to the STRICTEST member (policy.rs:265-288,402-411)
  ["ls && pwd; echo hi | wc -l", "allow"],
  ["ls && git push", "prompt"],
  ["ls; git push --force", "deny"],
  ["git status | git push -f origin main", "deny"],
  ["ls || git reset --hard", "deny"],
  ["ls\npwd", "allow"],                          // newline separation
  // substitution / structure → opaque → prompt (bash.rs:404-421 reject set)
  ["echo $(pwd)", "prompt"],
  ["echo `pwd`", "prompt"],
  ["echo $HOME", "prompt"],
  ["ls > out.txt", "prompt"],
  ["(ls)", "prompt"],
  ["ls & pwd", "prompt"],
  ["FOO=bar ls", "prompt"],
  ["ls &&", "prompt"],                           // dangling operator is opaque, not allow
  ["", "prompt"],                                // empty script fails closed
  // path programs: basename fallback is ABSOLUTE-only (policy.rs:344-352)
  ["/usr/bin/ls -la", "allow"],
  ["./ls -la", "prompt"],
  ["C:/tools/git.exe status", "allow"],          // drive path + Windows suffix strip
];

test("classification table over the default policy", () => {
  for (const [command, effect] of CASES) {
    expect({ command, effect: refineExec(command).effect }).toEqual({ command, effect });
  }
});

// ── word-only parser (mirrors bash.rs tests) ─────────────────────────────────

test("parser accepts plain word sequences and quoted literals", () => {
  expect(parseShellScript("ls && pwd; echo 'hi there' | wc -l")).toEqual([
    ["ls"], ["pwd"], ["echo", "hi there"], ["wc", "-l"],
  ]); // bash.rs:331-341
  expect(parseShellScript('git commit -m "line1\nline2"')).toEqual([
    ["git", "commit", "-m", "line1\nline2"],
  ]); // bash.rs:358-370 newline inside quotes
  expect(parseShellScript(`echo "/usr"'/'"local"/bin`)).toEqual([["echo", "/usr/local/bin"]]); // bash.rs:373-382
  expect(parseShellScript('rg -n "foo" -g"*.py"')).toEqual([["rg", "-n", "foo", "-g*.py"]]); // bash.rs:524-536
  expect(parseShellScript("echo 123 456")).toEqual([["echo", "123", "456"]]); // bash.rs:391-401
  expect(parseShellScript(`echo "~HOME" 'HEAD~1' "HEAD^" 'foo#bar' "=sh" 'file~'`)).toEqual([
    ["echo", "~HOME", "HEAD~1", "HEAD^", "foo#bar", "=sh", "file~"],
  ]); // bash.rs:452-462 quoting protects unsafe chars
  expect(parseShellScript('echo "\\n"')).toEqual([["echo", "\\n"]]); // bash.rs:453-455 stays two chars
});

test("parser rejects everything that could expand or restructure", () => {
  const rejected = [
    "(ls)", "ls || (pwd && echo hi)",            // bash.rs:404-407 subshells
    "ls > out.txt", "echo hi & echo bye",        // bash.rs:410-413 redirect/background
    "echo $(pwd)", "echo `pwd`", "echo $HOME", 'echo "hi $USER"', // bash.rs:416-421
    "find . -{delete,print}", "find . -del*", "find . -delet?", "find . -delet[e]",
    "find . -de\\lete", "echo ~", "echo HEAD~1", "echo HEAD^", "echo =sh", "l* -l", // bash.rs:424-449
    'echo "\\$HOME"', 'echo "\\\\"',             // bash.rs:477-489 double-quoted escapes
    "FOO=bar ls",                                // bash.rs:492-494 assignment prefix
    "ls &&", "&& ls", "ls ;; pwd", "ls | | wc",  // bash.rs:497-514 operator placement
    "cmd=rm; $cmd -rf /tmp/x",                   // is_dangerous_command.rs:266 stays opaque
    "! ls", "'ls' -la",                          // negation; quoted command name (bash.rs:170-175)
    "echo 'unterminated",
  ];
  for (const src of rejected) {
    expect({ src, parsed: parseShellScript(src) }).toEqual({ src, parsed: null });
  }
});

// ── rule machinery ───────────────────────────────────────────────────────────

test("first pattern token may be alternatives: fans out per head (parser.rs:384-403)", () => {
  const p = new ExecPolicy([{ pattern: [["git", "jj"], "status"] }]);
  expect(p.check(["git", "status"]).decision).toBe("allow");
  expect(p.check(["jj", "status"]).decision).toBe("allow");
  expect(p.check(["jj", "log"]).decision).toBe("prompt"); // heuristics
});

test("longer prefixes and alternative slots match positionally (rule.rs:46-59)", () => {
  const p = new ExecPolicy([{ pattern: ["git", "push", ["--force", "-f"]], decision: "forbidden", justification: "no" }]);
  expect(p.check(["git", "push", "--force"]).decision).toBe("forbidden");
  expect(p.check(["git", "push", "-f", "origin"]).decision).toBe("forbidden");
  expect(p.check(["git", "push"]).decision).toBe("prompt");        // shorter than pattern
  expect(p.check(["git", "push", "--tags"]).decision).toBe("prompt"); // slot mismatch
});

test("basename fallback: absolute paths only; exact rules win (policy.rs:305-371)", () => {
  const p = new ExecPolicy([
    { pattern: ["git", "status"] },
    { pattern: ["/opt/git"], decision: "forbidden", justification: "pinned build" },
  ]);
  expect(p.check(["/usr/bin/git", "status"]).matchedRules[0]?.kind).toBe("rule");
  expect(p.check(["/usr/bin/git", "status"]).decision).toBe("allow");
  expect(p.check(["C:\\bin\\GIT.EXE", "status"]).decision).toBe("allow");  // suffix strip + case (executable_name.rs:6-23)
  expect(p.check(["\\\\srv\\tools\\git.exe", "status"]).decision).toBe("allow"); // UNC
  expect(p.check(["./git", "status"]).matchedRules[0]?.kind).toBe("heuristics"); // relative → no fallback
  expect(p.check(["git.exe", "status"]).matchedRules[0]?.kind).toBe("heuristics"); // bare token → no fallback
  expect(p.check(["/opt/git", "anything"]).decision).toBe("forbidden"); // exact match precedes fallback
});

test("unknown commands default to prompt; empty input fails closed", () => {
  const p = new ExecPolicy([]);
  expect(p.check(["anything"]).decision).toBe("prompt");
  expect(p.check(["anything"]).matchedRules).toHaveLength(1); // policy.rs:290-296 non-empty guarantee
  expect(p.checkMany([]).decision).toBe("prompt");
  expect(p.checkScript("").decision).toBe("prompt");
});

test("strictest is max over the Allow<Prompt<Forbidden order (decision.rs:9-16)", () => {
  expect(strictest(["allow", "prompt"])).toBe("prompt");
  expect(strictest(["prompt", "forbidden", "allow"])).toBe("forbidden");
  expect(strictest(["allow"])).toBe("allow");
});

// ── load-time example validation (parser.rs:133-148: per-declaration scope) ──

test("notMatch examples are validated against the declaring rule only", () => {
  // Regression: `git push` matches the OTHER (prompt) rule; upstream still loads.
  expect(() => new ExecPolicy([
    { pattern: ["git", "push"], decision: "prompt" },
    { pattern: ["git", "push", "--force"], decision: "forbidden", justification: "no", notMatch: ["git push"] },
  ])).not.toThrow();
  expect(() => defaultExecPolicy()).not.toThrow();
  expect(defaultExecPolicy().check(["ls"]).decision).toBe("allow");
});

test("match examples must match the declaring rule, not just any rule", () => {
  expect(() => new ExecPolicy([
    { pattern: ["ls"] },
    { pattern: ["pwd"], match: ["ls"] }, // matches the ls rule, not this one
  ])).toThrow(/match example did not match/);
});

test("invalid specs throw at load time (parser.rs:177-179,205-208,363-366)", () => {
  expect(() => new ExecPolicy([{ pattern: [] }])).toThrow(/pattern cannot be empty/);
  expect(() => new ExecPolicy([{ pattern: ["git", []] }])).toThrow(/alternatives cannot be empty/);
  expect(() => new ExecPolicy([{ pattern: ["ls"], justification: "  " }])).toThrow(/justification cannot be empty/);
  expect(() => new ExecPolicy([{ pattern: ["ls"], match: ["echo $(x)"] }])).toThrow(/not a single plain command/);
  expect(() => new ExecPolicy([{ pattern: ["ls"], notMatch: [["ls", "-la"]] }])).toThrow(/not_match example matched/);
});

// ── dangerous-command heuristics (is_dangerous_command.rs:175-288 tables) ────

test("forced rm variants are flagged through wrappers", () => {
  for (const cmd of [
    ["rm", "-rf", "/"], ["rm", "-f", "/"], ["/bin/rm", "-fr", "/tmp/example"],
    ["rm", "-r", "-f", "/tmp/example"], ["rm", "--force", "/tmp/example"],
    ["rm", "/tmp/example", "-f"], ["sudo", "rm", "-rf", "/tmp/example"],
    ["env", "TARGET=/tmp/example", "rm", "-rf", "/tmp/example"],
    ["env", "-i", "--", "rm", "-rf", "x"],
    ["bash", "-c", "rm -rf /tmp/x"], ["zsh", "-lc", "ls && rm -f x"],
    ["trap", "rm -rf /tmp/x", "EXIT"], ["trap", "--", "rm -f x", "EXIT"],
  ]) {
    expect({ cmd, hit: dangerousCommandMatch(cmd) }).toEqual({ cmd, hit: "forced-rm" });
  }
});

test("non-forced or non-literal rm is not flagged", () => {
  for (const cmd of [
    ["rm", "-r", "/tmp/example"], ["rm", "--", "-f"],
    ["bash", "-lc", "echo 'rm -rf /tmp/example'"],
    ["bash", "-lc", "trap 'echo rm -rf /tmp/example' EXIT"],
    ["env", "TARGET=/tmp/example", "rm", "-r", "/tmp/example"],
    ["trap", "-l"], ["ls", "-rf"],
  ]) {
    expect({ cmd, hit: dangerousCommandMatch(cmd) }).toEqual({ cmd, hit: null });
  }
});

test("deeply nested wrappers fail closed at depth 8 (is_dangerous_command.rs:16,27-29)", () => {
  const wrap = (n: number) => [...Array<string>(n).fill("env"), "rm", "-rf", "/tmp/example"];
  expect(dangerousCommandMatch(wrap(8))).toBe("forced-rm");
  expect(dangerousCommandMatch(wrap(9))).toBe("other");
});

// ── refinement reasons (exec_policy.rs:981-1007,1016-1054,1068-1077) ─────────

test("refineExec reasons follow the most specific matching rule", () => {
  expect(refineExec("git push --force")).toEqual({
    effect: "deny",
    reason: "`git push --force` rejected: history-rewriting push; use --force-with-lease after user sign-off",
  });
  const bare = new ExecPolicy([{ pattern: ["shred"], decision: "forbidden" }]);
  expect(refineExec("shred -u f", bare).effect).toBe("deny");
  expect((refineExec("shred -u f", bare) as { reason: string }).reason)
    .toBe("`shred -u f` rejected: policy forbids commands starting with `shred`");
  const mv = new ExecPolicy([{ pattern: ["mv"], decision: "prompt" }]);
  expect(refineExec("mv a b", mv)).toEqual({ effect: "prompt", reason: "`mv a b` requires approval by policy" });
  expect(refineExec("git push")).toEqual({
    effect: "prompt", reason: "`git push` requires approval: pushes publish state; confirm the remote and branch",
  });
  expect(refineExec("rm -rf /tmp/x")).toEqual({
    effect: "prompt", reason: "rm -f style commands are not permitted. Use a safer approach", // exec_policy.rs:1071-1074
  });
  expect(refineExec("echo $(pwd)")).toEqual({ effect: "prompt", reason: undefined }); // heuristics-only prompt carries no rule reason
  expect(refineExec("ls -la")).toEqual({ effect: "allow" });
});

// ── R2 #9 HIGH-1 regressions (each block fails if its fix is reverted) ───────

test("rg is NOT allow-listed: --pre/--hostname-bin are exec trampolines, so ALL rg prompts (HIGH-1a)", () => {
  // re-adding `{ pattern: ["rg"] }` to DEFAULT_RULES turns every line below "allow" → fails
  for (const cmd of [
    "rg --pre /tmp/payload.sh secrets.txt",
    "rg --hostname-bin=/tmp/payload.sh x",
    "rg -n TODO src",
  ]) {
    expect({ cmd, effect: refineExec(cmd).effect }).toEqual({ cmd, effect: "prompt" });
  }
});

test("git branch destructive flags prompt; read forms stay allowed (HIGH-1b)", () => {
  expect(refineExec("git branch").effect).toBe("allow");
  expect(refineExec("git branch --list").effect).toBe("allow");
  for (const cmd of [
    "git branch -D topic", "git branch -d topic", "git branch -m old new",
    "git branch -M main", "git branch -f topic abc123", "git branch --delete topic",
    "git branch --force topic abc123", "git branch --move a b",
    // git accepts the flag AFTER the positional — the escalation scan covers any slot
    "git branch topic -D", "git branch stale --delete", "git branch old new -M",
  ]) {
    expect({ cmd, effect: refineExec(cmd).effect }).toEqual({ cmd, effect: "prompt" });
  }
  // after `--` tokens are branch names, not flags — a branch literally named -D stays a read
  expect(refineExec("git branch --list -- -D").effect).toBe("allow");
  // strictest-wins over the reader allow rule; the length-3 prompt rule is most specific
  expect(refineExec("git branch -D topic")).toEqual({
    effect: "prompt",
    reason: "`git branch -D topic` requires approval: deletes or rewrites branches; confirm the target",
  });
});

test("git diff/show/log --output turns a reader into a writer → prompt escalation (HIGH-1c)", () => {
  expect(refineExec("git diff").effect).toBe("allow");
  expect(refineExec("git log --oneline").effect).toBe("allow");
  for (const cmd of [
    "git diff --output=/tmp/x.patch HEAD",   // =-joined, flag mid-argv
    "git diff --output /tmp/x.patch",        // two-token form
    "git log --output=log.txt",
    "git show --output x HEAD",
  ]) {
    expect({ cmd, effect: refineExec(cmd).effect }).toEqual({ cmd, effect: "prompt" });
  }
  // the escalation is a heuristics match, so its justification IS the prompt reason
  expect(refineExec("git log --output=log.txt")).toEqual({
    effect: "prompt", reason: "--output writes the result to a file; confirm the destination",
  });
  expect(refineExec("git diff -- --output").effect).toBe("allow"); // post-`--` it is a pathspec, not a flag
});

// ── module-level integration: forbidden argv never reaches execution ─────────
// Wiring mirror: dispatch (ADR-005 pipeline, tools.ts) with the shell.exec
// prompt rule as the OUTER gate and execPolicyApprover as the approver.

const PROMPT_EXEC: PermissionRule[] = [{ action: "shell.exec", resource: "*", effect: "prompt" }];

function bashTool(executed: string[]): Tool {
  return {
    schema: { name: "bash", description: "run a shell command", args: {} },
    kind: "execute",
    async execute(args) {
      executed.push(String((args as { command: string }).command));
      return { ok: true, output: "ran" };
    },
  };
}
const ctx = (): ToolContext => ({
  sessionId: "s", cwd: "/", signal: new AbortController().signal, permissions: { effect: "allow" },
});
const call = (command: string, id = "c1"): ToolCallPart => ({ kind: "tool_call", id, tool: "bash", args: { command } });

async function run(command: string, inner?: ApprovalRequest[] | null, verdict: "once" | "deny" = "once") {
  const executed: string[] = [];
  const events: RunEvent[] = [];
  const reg = new ToolRegistry();
  reg.register(bashTool(executed));
  const innerFn = inner === null || inner === undefined ? undefined
    : async (req: ApprovalRequest) => { inner.push(req); return verdict; };
  const approve = execPolicyApprover(innerFn);
  const out = await reg.dispatch(call(command), ctx(), undefined, PROMPT_EXEC, approve, (e) => events.push(e));
  return { out, executed, events };
}

test("a forbidden argv never reaches execution and never reaches the human", async () => {
  const seen: ApprovalRequest[] = [];
  const { out, executed, events } = await run("git push --force", seen);
  expect(executed).toEqual([]);                       // executor spy untouched
  expect(seen).toEqual([]);                           // inner approver never consulted
  expect(out.ok).toBe(false);
  expect(out.output).toContain("Permission denied");
  expect(events.some((e) => e.type === "tool_call_failed" && e.reason === "permission_denied")).toBe(true);
  expect(events.some((e) => e.type === "tool_execution_start")).toBe(false);
});

test("forbidden members of a chain block the whole composite", async () => {
  const seen: ApprovalRequest[] = [];
  const { executed } = await run("ls && git reset --hard", seen);
  expect(executed).toEqual([]);
  expect(seen).toEqual([]);
});

test("an allow-listed argv runs without consulting the inner approver", async () => {
  const seen: ApprovalRequest[] = [];
  const { out, executed } = await run("ls -la", seen);
  expect(executed).toEqual(["ls -la"]);
  expect(seen).toEqual([]);
  expect(out.ok).toBe(true);
  // MED-2 pin: the auto-allow verdict is exactly "once" — "always" would enter
  // dispatch's approval cache (tools.ts:99-100) and skip policy on repeats
  const approve = execPolicyApprover(async () => { throw new Error("inner must not be consulted on allow"); });
  await expect(approve({ tool: "bash", args: { command: "ls -la" }, revisedArgs: { command: "ls -la" }, reason: "r" }))
    .resolves.toBe("once");
});

test('allow verdicts are never cached: dispatch re-consults the policy on every repeat ("once" ≠ "always")', async () => {
  const executed: string[] = [];
  const reg = new ToolRegistry();
  reg.register(bashTool(executed));
  let policyConsults = 0;
  const wrapped = execPolicyApprover(undefined);
  const approve: ApprovalFn = async (req) => { policyConsults++; return wrapped(req); };
  await reg.dispatch(call("ls -la", "c1"), ctx(), undefined, PROMPT_EXEC, approve, () => {});
  await reg.dispatch(call("ls -la", "c2"), ctx(), undefined, PROMPT_EXEC, approve, () => {});
  expect(executed).toEqual(["ls -la", "ls -la"]);
  expect(policyConsults).toBe(2); // an "always" verdict would cache after c1 → 1 consult
});

test("a rule-level deny hard-stops BEFORE the wrapper: policy cannot resurrect a denied call", async () => {
  const executed: string[] = [];
  const reg = new ToolRegistry();
  reg.register(bashTool(executed));
  const events: RunEvent[] = [];
  let approverCalls = 0;
  const wrapped = execPolicyApprover(async () => "once");
  const approve: ApprovalFn = async (req) => { approverCalls++; return wrapped(req); };
  const DENY_EXEC: PermissionRule[] = [{ action: "shell.exec", resource: "*", effect: "deny" }];
  // even a policy-ALLOW-listed argv stays denied (the wrapper can never widen rules, ADR-005)…
  const out = await reg.dispatch(call("ls -la"), ctx(), undefined, DENY_EXEC, approve, (e) => events.push(e));
  expect(out.ok).toBe(false);
  expect(out.output).toContain("Permission denied");
  // …and a policy-forbidden argv dies at the same rule gate
  const out2 = await reg.dispatch(call("git push --force", "c2"), ctx(), undefined, DENY_EXEC, approve, (e) => events.push(e));
  expect(out2.ok).toBe(false);
  expect(approverCalls).toBe(0);                      // approver (and thus policy) never consulted
  expect(executed).toEqual([]);
  expect(events.filter((e) => e.type === "tool_call_failed" && e.reason === "permission_denied")).toHaveLength(2);
  expect(events.some((e) => e.type === "tool_execution_start")).toBe(false);
});

test("a prompt argv reaches the inner approver with the policy justification", async () => {
  const seen: ApprovalRequest[] = [];
  const { executed } = await run("git push", seen);
  expect(seen).toHaveLength(1);
  expect(seen[0]!.reason).toBe("`git push` requires approval: pushes publish state; confirm the remote and branch");
  expect(executed).toEqual(["git push"]);             // human said "once"
});

test("inner deny keeps opaque commands from executing", async () => {
  const seen: ApprovalRequest[] = [];
  const { out, executed } = await run("echo $(pwd)", seen, "deny");
  expect(seen).toHaveLength(1);                       // opaque → prompt → human sees it
  expect(executed).toEqual([]);
  expect(out.output).toContain("Permission denied");
});

test("headless (no inner approver): prompts fail closed, allows still run", async () => {
  const denied = await run("git push", null);
  expect(denied.executed).toEqual([]);
  expect(denied.out.ok).toBe(false);
  const allowed = await run("ls", null);
  expect(allowed.executed).toEqual(["ls"]);
});

test("non-shell tools pass through the wrapper to the inner approver", async () => {
  const seen: ApprovalRequest[] = [];
  const approve = execPolicyApprover(async (req) => { seen.push(req); return "once"; });
  const verdict = await approve({ tool: "web_fetch", args: { url: "https://x" }, revisedArgs: { url: "https://x" }, reason: "r" });
  expect(verdict).toBe("once");
  expect(seen).toHaveLength(1);
});
