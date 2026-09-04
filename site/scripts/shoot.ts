/** Screenshots + brand assets through playwright-core against an already-installed Chromium.
 *
 *    node scripts/shoot.ts frames   → public/shots/<name>.png   (2× device scale, from scripts/out/*.html)
 *    node scripts/shoot.ts logo     → public/brand/mark.png (transparent), favicon-32/192.png, apple-180.png
 *    node scripts/shoot.ts site     → screenshots/site-1440.png, screenshots/site-390.png (full page)
 *
 *  Chromium: the newest ms-playwright build, else Google Chrome. Nothing is downloaded. */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser } from "playwright-core";

/** Run this file with Node (`node scripts/shoot.ts`, type stripping is native in Node ≥ 23.6): under
 *  Bun on Windows, Playwright's launch pipe and its CDP WebSocket both fail to connect. */
async function launch(): Promise<{ browser: Browser; close: () => Promise<void> }> {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  return { browser, close: () => browser.close() };
}

const HERE = import.meta.dirname;
const SITE = join(HERE, "..");
const OUT_HTML = join(HERE, "out");
const SHOTS = join(SITE, "public", "shots");
const BRAND = join(SITE, "public", "brand");
const SCREENS = join(SITE, "screenshots");
const mode = process.argv[2] ?? "frames";

function findChromium(): string {
  const local = process.env.LOCALAPPDATA ?? "";
  const root = join(local, "ms-playwright");
  if (existsSync(root)) {
    const builds = readdirSync(root).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => Number(b.slice(9)) - Number(a.slice(9)));
    for (const b of builds) { const exe = join(root, b, "chrome-win64", "chrome.exe"); if (existsSync(exe)) return exe; }
  }
  for (const p of ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"]) if (existsSync(p)) return p;
  throw new Error("no Chromium found — install one with `bunx playwright install chromium`");
}

const fileUrl = (p: string) => "file:///" + p.replace(/\\/g, "/");

/** crops in CELL coordinates of a rendered frame (x, y, w, h) → public/shots/crops/<name>.png */
const CROPS: { name: string; frame: string; x: number; y: number; w: number; h: number }[] = [
  { name: "messages", frame: "editing-160x44", x: 33, y: 29, w: 89, h: 14 },
  { name: "rmrf", frame: "rmrf-160x44", x: 33, y: 29, w: 89, h: 14 },
  { name: "rewind", frame: "rewind-160x44", x: 44, y: 6, w: 72, h: 10 },
  { name: "tests", frame: "tests-160x44", x: 34, y: 11, w: 87, h: 5 },
  { name: "cockpit", frame: "editing-160x44", x: 0, y: 0, w: 123, h: 30 },
];

async function frames(): Promise<void> {
  mkdirSync(SHOTS, { recursive: true });
  const { browser, close } = await launch();
  const ctx = await browser.newContext({ viewport: { width: 2600, height: 1600 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  for (const f of readdirSync(OUT_HTML).filter((f) => f.endsWith(".html"))) {
    await page.goto(fileUrl(join(OUT_HTML, f)), { waitUntil: "networkidle" });
    await page.evaluate(() => (document as unknown as { fonts: { ready: Promise<unknown> } }).fonts.ready);
    await page.waitForTimeout(150);
    const out = join(SHOTS, f.replace(/\.html$/, ".png"));
    await page.locator("#frame").screenshot({ path: out, type: "png" });
    console.log("wrote", out);
    const stem = f.replace(/\.html$/, "");
    const m = /-(\d+)x(\d+)$/.exec(stem);
    const box = await page.locator("#frame").boundingBox();
    if (m && box) {
      const cw = box.width / Number(m[1]), ch = box.height / Number(m[2]);
      mkdirSync(join(SHOTS, "crops"), { recursive: true });
      for (const c of CROPS.filter((c) => c.frame === stem)) {
        const outc = join(SHOTS, "crops", c.name + ".png");
        await page.screenshot({ path: outc, type: "png", clip: { x: box.x + c.x * cw, y: box.y + c.y * ch, width: c.w * cw, height: c.h * ch } });
        console.log("wrote", outc);
      }
    }
  }
  await close();
}

/** chroma-key the solid ink background out of one candidate and emit the mark + favicons */
async function logo(): Promise<void> {
  const src = process.argv[3] ?? "candidate-4.png";
  const png = readFileSync(join(BRAND, src));
  const dataUrl = "data:image/png;base64," + png.toString("base64");
  const { browser, close } = await launch();
  const page = await browser.newPage();
  await page.setContent("<html><body></body></html>");
  const results = await page.evaluate(async (url: string) => {
    const img = new Image();
    img.src = url;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    const g = c.getContext("2d")!;
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height);
    const px = d.data;
    // the mark is one flat colour (#5CB8FF ≈ 92,184,255) on near-black ink; blue channel separates them cleanly
    for (let i = 0; i < px.length; i += 4) {
      const b = px[i + 2]!;
      const t = Math.min(1, Math.max(0, (b - 40) / (235 - 40)));
      px[i] = 0x5c; px[i + 1] = 0xb8; px[i + 2] = 0xff; px[i + 3] = Math.round(t * 255);
    }
    g.putImageData(d, 0, 0);
    // trim to the mark's bounding box with a 6 % margin so the favicon fills its box
    let minX = c.width, minY = c.height, maxX = 0, maxY = 0;
    for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
      if (px[(y * c.width + x) * 4 + 3]! > 24) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
    }
    const side = Math.max(maxX - minX, maxY - minY);
    const pad = Math.round(side * 0.06);
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    const box = side + pad * 2;
    const sx = Math.round(cx - box / 2), sy = Math.round(cy - box / 2);
    const render = (size: number): string => {
      const o = document.createElement("canvas");
      o.width = size; o.height = size;
      const og = o.getContext("2d")!;
      og.imageSmoothingEnabled = true; og.imageSmoothingQuality = "high";
      og.drawImage(c, sx, sy, box, box, 0, 0, size, size);
      return o.toDataURL("image/png");
    };
    return { mark: render(1024), f32: render(32), f192: render(192), a180: render(180) };
  }, dataUrl);
  await close();
  const write = (name: string, data: string) => { writeFileSync(join(BRAND, name), Buffer.from(data.split(",")[1]!, "base64")); console.log("wrote", join(BRAND, name)); };
  write("mark.png", results.mark);
  write("favicon-32.png", results.f32);
  write("favicon-192.png", results.f192);
  write("apple-180.png", results.a180);
}

async function site(): Promise<void> {
  mkdirSync(SCREENS, { recursive: true });
  const url = process.argv[3] ?? "http://localhost:5173/";
  const { browser, close } = await launch();
  for (const width of [1440, 390]) {
    const ctx = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    await page.goto(url, { waitUntil: "networkidle" });
    await page.evaluate(() => (document as unknown as { fonts: { ready: Promise<unknown> } }).fonts.ready);
    // walk the page so every section's one-time entrance has fired, then settle at the top
    await page.evaluate(async () => {
      const step = Math.round(window.innerHeight * 0.6);
      for (let y = 0; y < document.body.scrollHeight; y += step) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 90)); }
      window.scrollTo(0, 0);
      await new Promise((r) => setTimeout(r, 900));
    });
    await page.evaluate(() => Promise.all(Array.from(document.images).map((im) => (im.complete ? Promise.resolve() : new Promise((r) => { im.onload = im.onerror = () => r(null); })))));
    const out = join(SCREENS, `site-${width}.png`);
    await page.screenshot({ path: out, fullPage: true, type: "png" });
    console.log("wrote", out);
    await ctx.close();
  }
  await close();
}

/** per-section crops at viewport scale (design review without a browser) */
async function review(): Promise<void> {
  mkdirSync(SCREENS, { recursive: true });
  const url = process.argv[3] ?? "http://localhost:5173/";
  const { browser, close } = await launch();
  const shoot = async (width: number, targets: string[]) => {
    const ctx = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    await page.goto(url, { waitUntil: "networkidle" });
    await page.evaluate(() => (document as unknown as { fonts: { ready: Promise<unknown> } }).fonts.ready);
    await page.evaluate(async () => {
      const step = Math.round(window.innerHeight * 0.6);
      for (let y = 0; y < document.body.scrollHeight; y += step) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 60)); }
      window.scrollTo(0, 0);
      await new Promise((r) => setTimeout(r, 900));
    });
    await page.evaluate(() => Promise.all(Array.from(document.images).map((im) => (im.complete ? Promise.resolve() : new Promise((r) => { im.onload = im.onerror = () => r(null); })))));
    for (const t of targets) {
      await page.evaluate((hide: boolean) => { const h = document.querySelector("header"); if (h) (h as HTMLElement).style.visibility = hide ? "hidden" : "visible"; }, t !== "#top");
      if (t === "#top") await page.evaluate(() => window.scrollTo(0, 0)); else await page.locator(t).first().scrollIntoViewIfNeeded();
      await page.waitForTimeout(700);
      const out = join(SCREENS, `review-${width}-${t.replace(/[^a-z0-9]/gi, "")}.png`);
      if (t === "#top") {
        // the hero as a visitor sees it at scroll 0: header in flow above, nothing hidden under it
        const box = await page.locator(t).first().boundingBox();
        await page.screenshot({ path: out, type: "png", fullPage: true, clip: { x: 0, y: 0, width, height: Math.ceil((box?.y ?? 0) + (box?.height ?? 900)) } });
      } else {
        await page.locator(t).first().screenshot({ path: out, type: "png" });
      }
      console.log("wrote", out);
    }
    await ctx.close();
  };
  await shoot(1440, ["#top", "#proof", "#problems", "#capabilities", "#terminal article", "#quickstart", "#providers", "#faq", "#get", "footer"]);
  await shoot(390, ["#top", "#proof", "#problems", "#terminal article", "#quickstart", "footer"]);
  await close();
}

if (mode === "frames") await frames();
else if (mode === "logo") await logo();
else if (mode === "site") await site();
else if (mode === "review") await review();
else { console.error("usage: node scripts/shoot.ts frames|logo|site|review"); process.exit(2); }
