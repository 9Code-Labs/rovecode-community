/** Cross-engine pass over the deployed pages: Chromium, Firefox and WebKit (Playwright builds) at 1440 and 390 on
 *  /, /tr/, /ar/ and /ja/ — web fonts actually loaded, RTL layout on /ar/ (page rtl, code blocks ltr), the language
 *  picker's keyboard flow, the fixed header after scroll, the copy button's behaviour where the clipboard API is
 *  refused (plain http). Screenshots land in scripts/.lh/shots-<engine>-<w>-<path>.png.
 *    node scripts/browsers-check.mjs [site-url]     (default http://64.177.43.110) */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium, firefox, webkit } from "playwright-core";

const base = (process.argv[2] ?? "http://64.177.43.110").replace(/\/$/, "");
const OUT = join(import.meta.dirname, ".lh"); mkdirSync(OUT, { recursive: true });
const PATHS = ["/", "/tr/", "/ar/", "/ja/"];
const rows = []; const issues = [];

for (const [name, type] of [["chromium", chromium], ["firefox", firefox], ["webkit", webkit]]) {
  let browser;
  try { browser = await type.launch({ headless: true }); } catch (e) { issues.push(`${name}: launch failed — ${e.message.split("\n")[0]}`); continue; }
  for (const width of [1440, 390]) {
    const ctx = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 }, locale: "en-US" });
    for (const path of PATHS) {
      const page = await ctx.newPage(); const msgs = [];
      page.on("console", (m) => { if (["error", "warning"].includes(m.type())) msgs.push(m.text().slice(0, 100)); });
      page.on("pageerror", (e) => msgs.push("pageerror " + e.message.slice(0, 100)));
      await page.goto(base + path, { waitUntil: "load" });
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(600);
      const fonts = await page.evaluate(() => ({
        body: document.fonts.check('16px "Hanken Grotesk"'), mono: document.fonts.check('14px "IBM Plex Mono"'),
        loaded: [...document.fonts].filter((f) => f.status === "loaded").map((f) => f.family).filter((v, i, a) => a.indexOf(v) === i),
        bodyComputed: getComputedStyle(document.body).fontFamily.split(",")[0],
      }));
      const rtl = await page.evaluate(() => {
        const dir = document.documentElement.dir || "ltr";
        const codes = [...document.querySelectorAll("code[dir]")].map((c) => c.getAttribute("dir"));
        const h = document.querySelector("header > div"); const first = h?.firstElementChild?.getBoundingClientRect(); const last = h?.lastElementChild?.getBoundingClientRect();
        return { dir, codeLtr: codes.length && codes.every((d) => d === "ltr"), markOnRight: first && last ? first.left > last.left : null };
      });
      // fixed header after a scroll
      await page.evaluate(() => scrollTo(0, 1200)); await page.waitForTimeout(400);
      const header = await page.evaluate(() => { const h = document.querySelector("header"); const r = h.getBoundingClientRect(); const s = getComputedStyle(h); return { top: Math.round(r.top), position: s.position, frosted: s.backdropFilter !== "none" || s.webkitBackdropFilter !== "none" }; });
      await page.evaluate(() => scrollTo(0, 0)); await page.waitForTimeout(200);
      // language picker keyboard flow (desktop only: the picker is in the bar at every width, but keep it to one)
      let picker = null;
      if (width === 1440) {
        const btn = page.locator("header button[aria-haspopup='listbox']");
        await btn.focus(); await page.keyboard.press("Enter"); await page.waitForTimeout(200);
        const opened = await page.evaluate(() => ({ expanded: document.querySelector("header button[aria-haspopup]")?.getAttribute("aria-expanded"), focusedRole: document.activeElement?.getAttribute("role") }));
        await page.keyboard.press("ArrowDown"); await page.keyboard.press("Escape"); await page.waitForTimeout(150);
        const closed = await page.evaluate(() => ({ expanded: document.querySelector("header button[aria-haspopup]")?.getAttribute("aria-expanded"), backOnButton: document.activeElement === document.querySelector("header button[aria-haspopup]") }));
        picker = { ok: opened.expanded === "true" && opened.focusedRole === "option" && closed.expanded === "false" && closed.backOnButton };
      }
      // copy button: what does it do here?
      const copyBtn = page.locator("button[aria-label]").filter({ has: page.locator("svg") }).nth(0);
      await copyBtn.scrollIntoViewIfNeeded();
      const before = await copyBtn.innerText();
      await copyBtn.click(); await page.waitForTimeout(200);
      const after = await page.evaluate(() => ({ label: document.activeElement?.innerText?.trim(), selection: (window.getSelection()?.toString() ?? "").slice(0, 40), clipboardApi: !!navigator.clipboard?.writeText }));
      const shot = join(OUT, `shots-${name}-${width}-${path.replace(/\//g, "") || "root"}.png`);
      await page.screenshot({ path: shot, fullPage: false });
      rows.push({ engine: name, w: width, path, fontBody: fonts.body, fontMono: fonts.mono, bodyFace: fonts.bodyComputed, dir: rtl.dir, codeLtr: !!rtl.codeLtr, markRight: rtl.markOnRight, hdrTop: header.top, hdrPos: header.position, frosted: header.frosted, picker: picker ? picker.ok : "-", copy: after.label !== before.trim() ? "copied" : after.selection ? "selected" : "nothing", clipApi: after.clipboardApi, console: msgs.length });
      if (msgs.length) issues.push(`${name} ${width} ${path}: ${msgs.join(" | ")}`);
      await page.close();
    }
    await ctx.close();
  }
  await browser.close();
}
console.table(rows);
console.log("ISSUES:", issues.length ? "\n  " + issues.join("\n  ") : "none");
