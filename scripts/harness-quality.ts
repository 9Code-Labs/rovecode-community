/** Deterministic offline quality-gate runner with measured output and failure taxonomy. */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const groups = [
  { id: "tool-call-wire", files: ["test/unit/middleware.test.ts", "test/unit/responses-stream.test.ts", "test/unit/wire-messages.test.ts"] },
  { id: "tool-policy", files: ["test/integration/guard-wiring.test.ts", "test/unit/execpolicy.test.ts", "test/unit/workspace.test.ts", "test/unit/validate.test.ts"] },
  { id: "loop-recovery", files: ["test/integration/loop.test.ts", "test/integration/loop-gap.test.ts", "test/unit/guardrails.test.ts", "test/unit/compaction.test.ts"] },
  { id: "subagents", files: ["test/integration/tasks-wiring.test.ts", "test/unit/tasks.test.ts", "test/unit/lanes-runner.test.ts"] },
  { id: "mcp-provider", files: ["test/unit/mcp-depth.test.ts", "test/unit/mcp-misbehave.test.ts", "test/unit/retry.test.ts", "test/unit/router.test.ts", "test/unit/wire-failures.test.ts"] },
  { id: "redaction-offline", files: ["test/unit/auth.test.ts", "test/unit/output.test.ts", "test/unit/isolate-home.test.ts", "test/unit/webfetch.test.ts"] },
];
const repeat = Number(process.env.ROVECODE_GAUNTLET_REPEAT ?? 2);
const started = performance.now();
const runs = [];
for (let seed = 1; seed <= repeat; seed++) for (const group of groups) {
  const t = performance.now();
  const env: Record<string, string | undefined> = { ...process.env, ROVECODE_FUZZ_SEED: String(seed), ROVECODE_HOME: resolve(root, ".rovecode-gauntlet-home") };
  for (const key of Object.keys(env)) if (/(_API_KEY|TOKEN|SECRET)$/i.test(key) || key === "ROVECODE_BASE_URL") delete env[key];
  const p = spawnSync(process.execPath, ["test", ...group.files], { cwd: root, env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const text = `${p.stdout}${p.stderr}`, pass = Number(/\n\s*(\d+) pass/.exec(text)?.[1] ?? 0), fail = Number(/\n\s*(\d+) fail/.exec(text)?.[1] ?? 0);
  runs.push({ group: group.id, seed, pass, fail, exitCode: p.status ?? 1, durationMs: Math.round(performance.now() - t), outputBytes: Buffer.byteLength(text), outputSha256: createHash("sha256").update(text).digest("hex") });
}
const report = { schemaVersion: 1, offline: true, repeat, groups: groups.map((g) => g.id), totals: {
  runs: runs.length, pass: runs.reduce((n, r) => n + r.pass, 0), fail: runs.reduce((n, r) => n + r.fail, 0), durationMs: Math.round(performance.now() - started), outputBytes: runs.reduce((n, r) => n + r.outputBytes, 0),
}, taxonomy: { assertion: runs.filter((r) => r.fail > 0).length, process: runs.filter((r) => r.exitCode !== 0 && r.fail === 0).length, flaky: 0 }, runs };
const byGroup = new Map();
for (const r of runs) { const sig = `${r.pass}/${r.fail}/${r.exitCode}`; const set = byGroup.get(r.group) ?? new Set(); set.add(sig); byGroup.set(r.group, set); }
report.taxonomy.flaky = [...byGroup.values()].filter((s) => s.size > 1).length;
const out = resolve(process.argv[2] ?? "harness-quality-report.json"); writeFileSync(out, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ out, ...report.totals, taxonomy: report.taxonomy }, null, 2));
if (report.totals.fail || report.taxonomy.process || report.taxonomy.flaky) process.exit(1);
