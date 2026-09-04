/** The social card, public/brand/og.png (1200×630), rendered from the page's own tokens and fonts.
 *
 *    node scripts/og.mjs
 *
 *  An HTML string set in Hanken Grotesk / IBM Plex Mono on the paper, screenshotted at 1200×630 with the same
 *  Chromium scripts/shoot.ts uses. Nothing here that is not on the page: paper #f6f6f4, ink #141414, muted
 *  #5c5c57, caption #6f6f69, the mark, one command in mono. */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";

const SITE = join(import.meta.dirname, "..");
const PUB = join(SITE, "public");

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

const b64 = (p, mime) => `data:${mime};base64,${readFileSync(p).toString("base64")}`;
const hanken = b64(join(PUB, "fonts", "hanken-grotesk-latin-wght-normal.woff2"), "font/woff2");
const mono = b64(join(PUB, "fonts", "ibm-plex-mono-latin-400-normal.woff2"), "font/woff2");
const mark = b64(join(PUB, "brand", "mark-sky-96.png"), "image/png");

const html = `<!doctype html><html><head><meta charset="utf-8">
<style>
  @font-face { font-family: H; src: url(${hanken}) format("woff2-variations"); font-weight: 100 900; }
  @font-face { font-family: M; src: url(${mono}) format("woff2"); }
  html, body { margin: 0; }
  body { width: 1200px; height: 630px; background: #f6f6f4; color: #141414; font-family: H, sans-serif; -webkit-font-smoothing: antialiased; position: relative; overflow: hidden; }
  .mark { position: absolute; left: 88px; top: 80px; display: flex; align-items: center; gap: 14px; font-size: 22px; font-weight: 500; letter-spacing: -0.01em; }
  .mark img { width: 30px; height: 30px; opacity: .85; filter: grayscale(1); }
  .mark small { font-size: 13px; font-weight: 500; letter-spacing: .16em; text-transform: uppercase; color: #6f6f69; margin-left: 10px; }
  h1 { position: absolute; left: 88px; top: 188px; margin: 0; width: 900px; font-size: 64px; line-height: 1.08; font-weight: 300; letter-spacing: -0.02em; }
  h1 b { font-weight: 400; }
  p { position: absolute; left: 88px; top: 388px; margin: 0; width: 760px; font-size: 24px; line-height: 1.5; color: #5c5c57; font-weight: 400; }
  code { position: absolute; left: 88px; bottom: 80px; font-family: M, monospace; font-size: 22px; color: #141414; background: #efefec; padding: 16px 22px; border-radius: 8px; }
  code span { color: #6f6f69; }
  .cap { position: absolute; right: 88px; bottom: 96px; font-size: 13px; font-weight: 500; letter-spacing: .16em; text-transform: uppercase; color: #6f6f69; }
</style></head><body>
  <div class="mark"><img src="${mark}" alt="">rovecode<small>open source · AGPL-3.0</small></div>
  <h1>A terminal coding agent with a <b>cockpit</b>, not a chat log.</h1>
  <p>16 providers or any OpenAI-compatible endpoint. Every tool call passes a deny-default policy before it touches your repository.</p>
  <code><span>$</span> rovecode "fix the failing test"</code>
  <div class="cap">TypeScript on Bun</div>
</body></html>`;

const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
await page.setContent(html, { waitUntil: "load" });
await page.evaluate(() => document.fonts.ready);
await page.waitForTimeout(150);
const out = join(PUB, "brand", "og.png");
await page.screenshot({ path: out, type: "png" });
await browser.close();
console.log("wrote", out);
