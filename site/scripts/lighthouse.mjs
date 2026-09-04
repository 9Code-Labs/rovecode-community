import lighthouse from "lighthouse";
import { chromium } from "playwright-core";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const root = join(process.env.LOCALAPPDATA ?? "", "ms-playwright");
let exe = "C:/Program Files/Google/Chrome/Application/chrome.exe";
if (existsSync(root)) for (const b of readdirSync(root).filter(d=>/^chromium-\d+$/.test(d)).sort((a,b)=>Number(b.slice(9))-Number(a.slice(9)))) { const p = join(root,b,"chrome-win64","chrome.exe"); if (existsSync(p)) { exe = p; break; } }
const url = process.argv[2] ?? "http://64.177.43.110/";
const browser = await chromium.launch({ executablePath: exe, headless: true, args: ["--remote-debugging-port=9555", "--window-size=1366,900"] });
const page = await browser.newPage(); await page.goto("about:blank");
for (const [name, preset] of [["mobile", undefined], ["desktop", "desktop"]]) {
  const flags = { port: 9555, output: "json", logLevel: "silent", onlyCategories: ["performance","accessibility","best-practices","seo"], ...(preset ? { preset } : {}) };
  const config = preset === "desktop" ? (await import("lighthouse/core/config/desktop-config.js")).default : undefined;
  const r = await lighthouse(url, flags, config);
  const lhr = r.lhr;
  writeFileSync(`${process.env.LOCALAPPDATA}/Temp/lh/${name}.json`, r.report);
  if (lhr.runtimeError) { console.log(name, "runtimeError", lhr.runtimeError.code, lhr.runtimeError.message?.slice(0,120)); continue; }
  console.log(name, Object.values(lhr.categories).map(c => `${c.id} ${Math.round(c.score*100)}`).join(" · "));
  const bad = Object.values(lhr.audits).filter(a => a.score !== null && a.score < 0.9 && !["informative","notApplicable","manual"].includes(a.scoreDisplayMode)).map(a => `${a.id}=${a.displayValue || a.score}`);
  console.log("  low:", bad.join(", ") || "none");
  const m = lhr.audits.metrics?.details?.items?.[0]; if (m) console.log(`  FCP ${m.firstContentfulPaint} LCP ${m.largestContentfulPaint} TBT ${m.totalBlockingTime} CLS ${m.cumulativeLayoutShift} SI ${m.speedIndex}`);
}
await browser.close();
