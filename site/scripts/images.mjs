/** Derive AVIF and WebP twins for every PNG the page shows, so <Pic> can offer them with the PNG as fallback.
 *
 *    node scripts/images.mjs
 *
 *  public/shots/<frame>.png          →  <frame>-960|1400|2400.avif / .webp   (the 160×44 frames, 2497 px native)
 *  public/shots/crops/<crop>.png     →  <crop>.avif / .webp                  (natural size; they are shown small)
 *  public/brand/mark-sky.png         →  mark-sky-96.png                      (the 20–24 px word-mark icon)
 *
 *  Idempotent: an output newer than its source is skipped. Quality: AVIF 55 / WebP 82 — screenshots of text, so
 *  the ceiling is legibility of 1-px glyph strokes, checked by eye on approval-160x44 at 1400. */
import { readdirSync, statSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import sharp from "sharp";

const HERE = import.meta.dirname;
const PUB = join(HERE, "..", "public");
const FRAME_WIDTHS = [960, 1400, 2400];

const fresh = (out, src) => existsSync(out) && statSync(out).mtimeMs >= statSync(src).mtimeMs;

async function variants(src, widths) {
  const stem = src.replace(/\.png$/, "");
  const meta = await sharp(src).metadata();
  for (const w of widths ?? [null]) {
    const tag = w ? `-${w}` : "";
    for (const [ext, encode] of [["avif", (i) => i.avif({ quality: 55, effort: 4 })], ["webp", (i) => i.webp({ quality: 82 })]]) {
      const out = `${stem}${tag}.${ext}`;
      if (fresh(out, src)) continue;
      let img = sharp(src);
      if (w && meta.width && w < meta.width) img = img.resize({ width: w, kernel: "lanczos3" });
      await encode(img).toFile(out);
      console.log("wrote", basename(out), statSync(out).size, "B");
    }
  }
}

const shots = join(PUB, "shots");
for (const f of readdirSync(shots).filter((f) => f.endsWith(".png"))) await variants(join(shots, f), FRAME_WIDTHS);
const crops = join(shots, "crops");
for (const f of readdirSync(crops).filter((f) => f.endsWith(".png"))) await variants(join(crops, f));

const mark = join(PUB, "brand", "mark-sky.png"), mark96 = join(PUB, "brand", "mark-sky-96.png");
if (!fresh(mark96, mark)) { await sharp(mark).resize({ width: 96, height: 96, fit: "inside" }).png({ compressionLevel: 9, palette: true }).toFile(mark96); console.log("wrote mark-sky-96.png", statSync(mark96).size, "B"); }
