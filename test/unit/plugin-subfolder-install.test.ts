/** A catalog row installs, end to end: registry.itemFromCatalog → market.planInstall → runInstall →
 *  plugins/install.addPlugin, with the clone faked so nothing touches the network.
 *
 *  This is the seam that was broken until 2026-09-05: every real plugin lives in a subfolder of a
 *  repository that publishes several, `InstallSpec` had no `subfolder`, and `addPlugin` looked only at
 *  the clone root — so the plugin catalog could describe rows that could not be installed. Two sessions
 *  own the two halves (a5 the spec and the planner, this one the installer), which is exactly why the
 *  test drives the whole path rather than either half. */

import { test, expect } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { itemFromCatalog } from "../../src/market/registry.ts";
import { planInstall, runInstall } from "../../src/market/install.ts";

const CATALOGS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "market", "catalogs");
const catalogItem = (id: string) => {
  const doc = JSON.parse(readFileSync(join(CATALOGS, "plugins.json"), "utf8")) as { items: Record<string, unknown>[] };
  const raw = doc.items.find((i) => i["id"] === id);
  expect(raw).toBeDefined();
  return itemFromCatalog("plugin", raw!, [])!;
};

/** stands in for `git clone`: writes a monorepo with the plugin in plugins/<name>, never the root */
const fakeClone = (name: string, extra: Record<string, string> = {}) =>
  async (cmd: readonly string[], cwd: string) => {
    const dir = join(cwd, cmd[cmd.length - 1] as string);
    const inner = join(dir, "plugins", name);
    mkdirSync(inner, { recursive: true });
    writeFileSync(join(inner, "plugin.json"), JSON.stringify({ api: 1, name, version: "0.1.0", entry: "index.ts" }));
    writeFileSync(join(inner, "index.ts"), "export default { api: 1 };");
    writeFileSync(join(dir, "README.md"), "the repository root, which is NOT the plugin");
    for (const [p, t] of Object.entries(extra)) writeFileSync(join(dir, p), t);
    return { code: 0, stderr: "" };
  };

function rig() {
  const cwd = mkdtempSync(join(tmpdir(), "rovecode-sub-cwd-"));
  const home = mkdtempSync(join(tmpdir(), "rovecode-sub-home-"));
  return { cwd, home, done: () => { rmSync(cwd, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); } };
}

test("a first-party plugin row installs from its subfolder, and the plan says so before anything lands", async () => {
  const r = rig();
  try {
    const item = catalogItem("safety-net");
    const plan = planInstall(item, { scope: "user", cwd: r.cwd, home: r.home });
    expect("error" in plan).toBe(false);
    if ("error" in plan) return;

    // the preview names the subfolder and the fact that this one runs code — before any consent
    const text = plan.preview.join("\n");
    expect(text).toContain("plugins/safety-net");
    expect(text).toMatch(/runs code/);
    expect(existsSync(join(r.home, "plugins", "safety-net"))).toBe(false);

    const out = await runInstall(plan, {}, { scope: "user", cwd: r.cwd, home: r.home }, { spawn: fakeClone("safety-net") });
    expect(out.ok).toBe(true);

    // the plugin landed under its own name, with its manifest — not the repository root
    const dir = join(r.home, "plugins", "safety-net");
    expect(existsSync(join(dir, "plugin.json"))).toBe(true);
    expect(existsSync(join(dir, "index.ts"))).toBe(true);
    expect(existsSync(join(dir, "README.md"))).toBe(false);        // the root's files stayed behind
    expect(existsSync(join(r.home, "plugins", "plugins"))).toBe(false);
    expect(JSON.parse(readFileSync(join(dir, "plugin.json"), "utf8")).name).toBe("safety-net");
  } finally { r.done(); }
});

test("the licence rides all the way to the approval preview, source-available said as such", () => {
  const r = rig();
  try {
    const plugin = planInstall(catalogItem("notes"), { scope: "user", cwd: r.cwd, home: r.home });
    if ("error" in plugin) throw new Error(plugin.error);
    expect(plugin.preview.join("\n")).toContain("AGPL-3.0-only");

    // and a skill whose upstream is source-available says that, not "open source"
    const skills = JSON.parse(readFileSync(join(CATALOGS, "skills.json"), "utf8")) as { items: Record<string, unknown>[] };
    const xlsx = itemFromCatalog("skill", skills.items.find((i) => i["id"] === "xlsx")!, [])!;
    expect(xlsx.license).toBe("source-available");
    const sp = planInstall(xlsx, { scope: "user", cwd: r.cwd, home: r.home });
    if ("error" in sp) throw new Error(sp.error);
    expect(sp.preview.join("\n")).toContain("source-available");
  } finally { r.done(); }
});
