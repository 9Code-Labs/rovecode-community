/** Lighthouse, mobile + desktop, against the live site or any URL — on the Playwright Chromium this repo already has.
 *
 *    node scripts/lighthouse.mjs [url]        (default http://64.177.43.110/)
 *
 *  Lighthouse is not a dependency of the site: the first run installs it into scripts/.lh/ (git-ignored) and later
 *  runs reuse it, so `bun install --frozen-lockfile` in CI stays as small as the site itself. Lighthouse's own
 *  Chrome launcher fails on this machine (EPERM on its temp profile), so Chromium is launched here with a debugging
 *  port and Lighthouse attaches to it. Reports land in scripts/.lh/<mobile|desktop>.json. */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright-core";

const HERE = import.meta.dirname;
const LH = join(HERE, ".lh");
const url = process.argv[2] ?? "http://64.177.43.110/";

if (!existsSync(join(LH, "node_modules", "lighthouse"))) {
  mkdirSync(LH, { recursive: true });
  writeFileSync(join(LH, "package.json"), JSON.stringify({ name: "site-lighthouse", private: true, type: "module" }, null, 2));
  console.log("installing lighthouse into scripts/.lh …");
  execSync("bun add lighthouse@^13", { cwd: LH, stdio: "inherit" });
}
const lighthouse = (await import(pathToFileURL(join(LH, "node_modules", "lighthouse", "core", "index.js")).href)).default;
const desktopConfig = (await import(pathToFileURL(join(LH, "node_modules", "lighthouse", "core", "config", "desktop-config.js")).href)).default;

function findChromium() {
  const root = join(process.env.LOCALAPPDATA ?? "", "ms-playwright");
  if (existsSync(root)) {
    for (const b of readdirSync(root).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => Number(b.slice(9)) - Number(a.slice(9)))) {
      const exe = join(root, b, "chrome-win64", "chrome.exe");
      if (existsSync(exe)) return exe;
    }
  }
  for (const p of ["C:/Program Files/Google/Chrome/Application/chrome.exe", "/usr/bin/chromium", "/usr/bin/google-chrome"]) if (existsSync(p)) return p;
  throw new Error("no Chromium found");
}

const port = 9555;
const browser = await chromium.launch({ executablePath: findChromium(), headless: true, args: [`--remote-debugging-port=${port}`, "--window-size=1366,900"] });
await (await browser.newPage()).goto("about:blank");

for (const [name, config] of [["mobile", undefined], ["desktop", desktopConfig]]) {
  const r = await lighthouse(url, { port, output: "json", logLevel: "silent", onlyCategories: ["performance", "accessibility", "best-practices", "seo"] }, config);
  const lhr = r.lhr;
  writeFileSync(join(LH, `${name}.json`), r.report);
  if (lhr.runtimeError) { console.log(name, "runtimeError", lhr.runtimeError.code, (lhr.runtimeError.message ?? "").slice(0, 120)); continue; }
  console.log(name, Object.values(lhr.categories).map((c) => `${c.id} ${Math.round(c.score * 100)}`).join(" · "));
  const low = Object.values(lhr.audits).filter((a) => a.score !== null && a.score < 0.9 && !["informative", "notApplicable", "manual"].includes(a.scoreDisplayMode)).map((a) => `${a.id}=${a.displayValue || a.score}`);
  console.log("  low:", low.join(", ") || "none");
  const m = lhr.audits.metrics?.details?.items?.[0];
  if (m) console.log(`  FCP ${m.firstContentfulPaint} LCP ${m.largestContentfulPaint} TBT ${m.totalBlockingTime} CLS ${m.cumulativeLayoutShift} SI ${m.speedIndex}`);
}
await browser.close();
