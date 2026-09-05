/** Verify the deployed site: for every URL in sitemap.xml — 200, <html lang/dir>, title, description, canonical,
 *  hreflang count, og:url/og:locale, 0 console errors after full scroll — plus an axe-core pass (scripts/.lh).
 *    node scripts/live-check.mjs [site-url] [--only <substring>] [--shard i/n]
 *      site-url  default http://64.177.43.110; a preview URL such as http://localhost:4173 walks the same
 *                paths there while still expecting the public canonical
 *      --only    keep the URLs whose path contains this substring ("/market/", "/tr/")
 *      --shard   walk the i-th of n interleaved slices (1/4 … 4/4), so a 700-page sitemap fits in memory
 *    The browser context is recycled every RECYCLE_EVERY pages: a single Chromium context walking hundreds
 *    of pages grows until the OS kills it, which is not a finding about the site. */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";
// Parsed left to right so a flag's value is never mistaken for the site URL. Note for Git Bash on Windows:
// it rewrites a bare "/market/" into a filesystem path, so --only takes a substring without leading slash too.
const argv = process.argv.slice(2);
let base = "http://64.177.43.110";
let only;
let shard = null;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--only") { only = argv[++i]; continue; }
  if (a === "--shard") {
    const raw = argv[++i] ?? "";
    const [n1, n2] = raw.split("/").map(Number);
    if (!Number.isInteger(n1) || !Number.isInteger(n2) || n1 < 1 || n2 < 1 || n1 > n2) { console.error(`--shard wants i/n, got "${raw}"`); process.exit(2); }
    shard = { i: n1, n: n2 };
    continue;
  }
  if (a.startsWith("--")) { console.error(`unknown flag ${a}`); process.exit(2); }
  base = a;
}
base = base.replace(/\/$/, "");
if (only) only = only.replace(/^[A-Za-z]:[\\/].*?(?=\/[^/]*$|$)/, ""); // undo Git Bash's path mangling of "/market/"
/** pages per browser context — high enough to amortize the launch, low enough that memory stays flat */
const RECYCLE_EVERY = 40;
const root = join(process.env.LOCALAPPDATA ?? "", "ms-playwright");
let exe = "C:/Program Files/Google/Chrome/Application/chrome.exe";
if (existsSync(root)) for (const b of readdirSync(root).filter(d=>/^chromium-\d+$/.test(d)).sort((a,b)=>Number(b.slice(9))-Number(a.slice(9)))) { const p = join(root,b,"chrome-win64","chrome.exe"); if (existsSync(p)) { exe = p; break; } }
const axePath = join(import.meta.dirname, ".lh", "node_modules", "axe-core", "axe.min.js");

const sm = await (await fetch(`${base}/sitemap.xml`)).text();
// The sitemap carries the public origin (canonical / og:url are compared against it); the pages themselves are
// fetched from `base`, so a run against a local preview measures the preview, not the live release.
const pub = [...sm.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
const origin = pub.length ? new URL(pub[0]).origin : base;
let urls = pub.map((expected) => ({ expected, url: base + expected.slice(origin.length) }));
const total = urls.length;
if (only) urls = urls.filter(({ expected }) => new URL(expected).pathname.includes(only));
if (shard) urls = urls.filter((_, i) => i % shard.n === shard.i - 1);
const scope = [only ? `only ${only}` : null, shard ? `shard ${shard.i}/${shard.n}` : null].filter(Boolean).join(", ");
// An empty selection is a typo, not a pass: a filter that matches nothing must never print "all ok".
if (urls.length === 0) { console.error(`no URL matches ${scope || "the sitemap"} — nothing was checked`); process.exit(2); }
console.log(`sitemap: ${urls.length}${urls.length !== total ? ` of ${total}` : ""} urls${scope ? ` (${scope})` : ""}${origin !== base ? ` (public origin ${origin}, fetched from ${base})` : ""}`);
const browser = await chromium.launch({ executablePath: exe, headless: true });
const newCtx = () => browser.newContext({ viewport: { width: 1366, height: 900 }, locale: "en-US" });
let ctx = await newCtx();
let totals = { pages: 0, consoleMsgs: 0, http4xx: 0, axe: { critical: 0, serious: 0, moderate: 0, minor: 0 } };
const rows = [];
async function checkPage(expected, url) {
  const page = await ctx.newPage(); const msgs = [], bad = [];
  page.on("console", m => { if (["error","warning"].includes(m.type())) msgs.push(m.text().slice(0,100)); });
  page.on("pageerror", e => msgs.push("pageerror " + e.message.slice(0,100)));
  page.on("response", r => { if (r.status() >= 400) bad.push(r.status() + " " + r.url()); });
  const res = await page.goto(url, { waitUntil: "networkidle" });
  await page.evaluate(async () => { const step = Math.round(innerHeight*0.7); for (let y=0;y<document.body.scrollHeight;y+=step){ scrollTo(0,y); await new Promise(r=>setTimeout(r,50)); } scrollTo(0,0); });
  await page.waitForLoadState("networkidle");
  const meta = await page.evaluate(() => ({
    lang: document.documentElement.lang, dir: document.documentElement.dir || "ltr", title: document.title.length, desc: document.querySelector('meta[name=description]')?.content.length,
    canonical: document.querySelector('link[rel=canonical]')?.href, hreflang: document.querySelectorAll('link[rel=alternate][hreflang]').length,
    ogUrl: document.querySelector('meta[property="og:url"]')?.content, ogLocale: document.querySelector('meta[property="og:locale"]')?.content, h1: document.querySelectorAll("h1").length }));
  await page.addScriptTag({ path: axePath });
  const axe = await page.evaluate(async () => { const r = await window.axe.run(document, { resultTypes: ["violations"] }); return r.violations.map(v => ({ id: v.id, impact: v.impact, nodes: v.nodes.length, help: v.help })); });
  const counts = { critical: 0, serious: 0, moderate: 0, minor: 0 }; for (const v of axe) counts[v.impact] += v.nodes;
  for (const k in counts) totals.axe[k] += counts[k];
  totals.pages++; totals.consoleMsgs += msgs.length; totals.http4xx += bad.length;
  const ok = res.status() === 200 && meta.canonical === expected && meta.ogUrl === expected && meta.hreflang === 16 && meta.h1 === 1 && msgs.length === 0 && bad.length === 0;
  if (axe.length) console.log("  axe", url.replace(base, "") || "/", JSON.stringify(axe));
  if (msgs.length || bad.length) console.log("  msgs", url.replace(base, ""), JSON.stringify({ msgs, bad }));
  await page.close();
  return { url: url.replace(base, ""), status: res.status(), ...meta, console: msgs.length, http4xx: bad.length, axe: counts, ok };
}
// Headless Chromium occasionally drops a tab ("Target crashed"); one retry per page, and a crash that repeats is a
// failing row rather than an aborted run — the gate must name the page, not die.
for (const [index, { expected, url }] of urls.entries()) {
  if (index > 0 && index % RECYCLE_EVERY === 0) { await ctx.close(); ctx = await newCtx(); }
  let row;
  for (let attempt = 1; ; attempt++) {
    try { row = await checkPage(expected, url); break; }
    catch (e) {
      console.log("  crash", url.replace(base, "") || "/", `attempt ${attempt}:`, String(e?.message ?? e).split("\n")[0].slice(0, 120));
      if (attempt >= 2) { totals.pages++; row = { url: url.replace(base, ""), status: 0, console: 0, http4xx: 0, axe: { critical: 0, serious: 0, moderate: 0, minor: 0 }, ok: false }; break; }
    }
  }
  rows.push(row);
}
console.table(rows.map(r => ({ url: r.url || "/", st: r.status, lang: r.lang, dir: r.dir, title: r.title, desc: r.desc, hreflang: r.hreflang, ogLocale: r.ogLocale, h1: r.h1, con: r.console, x4: r.http4xx, crit: r.axe.critical, ser: r.axe.serious, mod: r.axe.moderate, min: r.axe.minor, ok: r.ok })));
const allOk = rows.every(r => r.ok) && totals.axe.critical === 0 && totals.axe.serious === 0;
console.log("TOTALS", JSON.stringify(totals), "all ok:", allOk);
// a gate, not just a report: deploy-site.sh --check and CI read the exit code
process.exitCode = allOk ? 0 : 1;
await browser.close();
