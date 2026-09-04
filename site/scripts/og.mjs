/** The social card, public/brand/og.png (1200×630), rendered from the page's own tokens and fonts.
 *
 *    node scripts/og.mjs
 *
 *  An HTML string set in Manrope / JetBrains Mono on the mist, screenshotted at 1200×630 with the same Chromium
 *  scripts/shoot.ts uses. Nothing here that is not on the page (Y3 · Sabah sisi): ground #f4f6fb under the mist
 *  gradient, text #1b2230, muted #4a5568, faint #5e6880, accent-text #2f6ac0, a white card, the mark, one command. */
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
const sans = b64(join(PUB, "fonts", "manrope-latin-wght-normal.woff2"), "font/woff2");
const mono = b64(join(PUB, "fonts", "jetbrains-mono-latin-wght-normal.woff2"), "font/woff2");
const mark = b64(join(PUB, "brand", "mark-sky-96.png"), "image/png");

const html = `<!doctype html><html><head><meta charset="utf-8">
<style>
  @font-face { font-family: H; src: url(${sans}) format("woff2-variations"); font-weight: 200 800; }
  @font-face { font-family: M; src: url(${mono}) format("woff2-variations"); font-weight: 100 800; }
  html, body { margin: 0; }
  body { width: 1200px; height: 630px; color: #1b2230; font-family: H, sans-serif; -webkit-font-smoothing: antialiased; position: relative; overflow: hidden;
         background: radial-gradient(90% 60% at 50% 0%, rgba(159,184,232,.22) 0%, rgba(159,184,232,0) 70%), linear-gradient(180deg, #fdfdfe 0%, #f9fafd 40%, #f4f6fb 100%); }
  .mark { position: absolute; left: 88px; top: 80px; display: flex; align-items: center; gap: 14px; font-size: 23px; font-weight: 600; letter-spacing: -0.01em; }
  .mark img { width: 30px; height: 30px; }
  .mark small { font-size: 12px; font-weight: 600; letter-spacing: .12em; text-transform: uppercase; color: #5e6880; margin-left: 10px; background: #e3eaf8; border-radius: 999px; padding: 6px 12px; }
  h1 { position: absolute; left: 88px; top: 180px; margin: 0; width: 940px; font-size: 64px; line-height: 1.08; font-weight: 600; letter-spacing: -0.025em; }
  h1 b { font-weight: 600; color: #2f6ac0; }
  p { position: absolute; left: 88px; top: 388px; margin: 0; width: 760px; font-size: 24px; line-height: 1.5; color: #4a5568; font-weight: 400; }
  code { position: absolute; left: 88px; bottom: 80px; font-family: M, monospace; font-size: 22px; color: #1b2230; background: #ffffff; border: 1px solid #e6eaf3; padding: 16px 22px; border-radius: 16px; box-shadow: 0 12px 40px -20px rgba(27,34,48,.18); }
  code span { color: #2f6ac0; }
  .cap { position: absolute; right: 88px; bottom: 96px; font-size: 12px; font-weight: 600; letter-spacing: .12em; text-transform: uppercase; color: #5e6880; }
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
