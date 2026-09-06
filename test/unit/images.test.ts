/** Port #34 image attachments (core/images.ts): magic-byte sniffing (the extension is never
 *  trusted), the per-image size cap (default 5 MiB, ROVECODE_IMAGE_MAX_BYTES) and per-message count
 *  cap, header-only dimension parsing for all four containers, the placeholder/chip text pins,
 *  the wire block helpers both adapters use, and the transport (base64) form. */

import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  sniffImageMime, imageDimensions, imageFromBytes, imageFromBase64, loadImageAttachment, checkImageCount,
  imageMaxBytes, imageData, imageByteSize, describeImage, imagePlaceholder, imageChip, anthropicImageBlock,
  openaiImageBlock, imageExt, IMAGE_MAX_BYTES, MAX_IMAGES_PER_MESSAGE, type ImageLoadResult,
} from "../../src/core/images.ts";
import type { ImagePart } from "../../src/core/types.ts";
import { PNG_1x1, PNG_1x1_B64, GIF_2x3, JPEG_2x3, WEBP_VP8L_2x3, WEBP_VP8X_4x5, WEBP_VP8_6x7 } from "../fixtures/images.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "rovecode-img-"));
function ok(r: ImageLoadResult): ImagePart { if ("error" in r) throw new Error(r.error); return r; }
function err(r: ImageLoadResult): string { if (!("error" in r)) throw new Error("expected { error }, got an ImagePart"); return r.error; }

// ---------- sniffing ----------

test("sniffImageMime: magic bytes decide — png/jpeg/gif/webp recognised; text, a broken PNG signature, bmp, pdf, a non-WEBP RIFF and an empty buffer rejected", () => {
  expect(sniffImageMime(PNG_1x1)).toBe("image/png");
  expect(sniffImageMime(JPEG_2x3)).toBe("image/jpeg");
  expect(sniffImageMime(GIF_2x3)).toBe("image/gif");
  expect(sniffImageMime(WEBP_VP8L_2x3)).toBe("image/webp");
  expect(sniffImageMime(Buffer.from("hello world"))).toBeUndefined();
  expect(sniffImageMime(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x00, 0x00]))).toBeUndefined(); // first 4 of 8 signature bytes only
  expect(sniffImageMime(Buffer.from("BM......"))).toBeUndefined();   // bmp: opencode sniffs it, neither wire protocol takes it
  expect(sniffImageMime(Buffer.from("%PDF-1.7"))).toBeUndefined();
  expect(sniffImageMime(Buffer.from("RIFF....WAVE"))).toBeUndefined(); // RIFF container that is not WEBP
  expect(sniffImageMime(new Uint8Array(0))).toBeUndefined();
});

test("loadImageAttachment: a .png that is really text is rejected by its bytes; PNG bytes under a .txt name load as image/png (extension never trusted)", () => {
  const dir = tmp();
  writeFileSync(join(dir, "fake.png"), "hello, i am text pretending to be an image");
  writeFileSync(join(dir, "real.txt"), PNG_1x1);
  expect(err(loadImageAttachment(join(dir, "fake.png")))).toBe("fake.png: not a png/jpeg/gif/webp image (magic bytes: 68 65 6c 6c)");
  expect(ok(loadImageAttachment(join(dir, "real.txt")))).toEqual({ kind: "image", mime: "image/png", bytes: PNG_1x1_B64, width: 1, height: 1, name: "real.txt" });
  rmSync(dir, { recursive: true, force: true });
});

// ---------- caps ----------

test("size cap: 5 MiB + 1 is rejected (default cap), exactly 5 MiB loads; env/option overrides; garbage env falls back to the default", () => {
  const dir = tmp();
  const big = Buffer.alloc(IMAGE_MAX_BYTES + 1); PNG_1x1.copy(big);   // valid PNG header, oversize body
  const exact = Buffer.alloc(IMAGE_MAX_BYTES); PNG_1x1.copy(exact);
  writeFileSync(join(dir, "big.png"), big);
  writeFileSync(join(dir, "exact.png"), exact);
  expect(err(loadImageAttachment(join(dir, "big.png")))).toBe("big.png: 5121 KB is over the 5120 KB per-image cap (ROVECODE_IMAGE_MAX_BYTES)");
  expect(ok(loadImageAttachment(join(dir, "exact.png"))).width).toBe(1);
  expect(err(imageFromBytes(big, { name: "big.png" }))).toContain("over the 5120 KB per-image cap");
  // ROVECODE_IMAGE_MAX_BYTES read from the env handed in (process.env untouched); non-positive/garbage → default
  expect(imageMaxBytes({ ROVECODE_IMAGE_MAX_BYTES: "100" })).toBe(100);
  expect(imageMaxBytes({ ROVECODE_IMAGE_MAX_BYTES: "lots" })).toBe(IMAGE_MAX_BYTES);
  expect(imageMaxBytes({ ROVECODE_IMAGE_MAX_BYTES: "-5" })).toBe(IMAGE_MAX_BYTES);
  expect(imageMaxBytes({ ROVECODE_IMAGE_MAX_BYTES: "0" })).toBe(IMAGE_MAX_BYTES);
  expect(imageMaxBytes({})).toBe(IMAGE_MAX_BYTES);
  expect(err(loadImageAttachment(join(dir, "exact.png"), { env: { ROVECODE_IMAGE_MAX_BYTES: "1024" } }))).toBe("exact.png: 5120 KB is over the 1 KB per-image cap (ROVECODE_IMAGE_MAX_BYTES)");
  expect(err(imageFromBytes(PNG_1x1, { maxBytes: 10, name: "dot.png" }))).toBe("dot.png: 70 B is over the 10 B per-image cap (ROVECODE_IMAGE_MAX_BYTES)");
  expect(ok(imageFromBytes(PNG_1x1, { maxBytes: 70 })).mime).toBe("image/png"); // cap is inclusive
  rmSync(dir, { recursive: true, force: true });
});

test("count cap: up to 8 images per message pass, the 9th is refused naming the cap", () => {
  expect(MAX_IMAGES_PER_MESSAGE).toBe(8);
  expect(checkImageCount(0)).toBeUndefined();
  expect(checkImageCount(8)).toBeUndefined();
  expect(checkImageCount(9)).toBe("at most 8 images per message (9 attached)");
  expect(checkImageCount(3, 2)).toBe("at most 2 images per message (3 attached)");
});

// ---------- dimensions ----------

test("imageDimensions pins: PNG IHDR 1x1, GIF 2x3, JPEG SOF0 2x3, WebP VP8L 2x3 / VP8X 4x5 / VP8 6x7; truncated headers → undefined while the part still loads", () => {
  expect(imageDimensions(PNG_1x1, "image/png")).toEqual({ width: 1, height: 1 });
  expect(imageDimensions(GIF_2x3, "image/gif")).toEqual({ width: 2, height: 3 });
  expect(imageDimensions(JPEG_2x3, "image/jpeg")).toEqual({ width: 2, height: 3 });
  expect(imageDimensions(WEBP_VP8L_2x3, "image/webp")).toEqual({ width: 2, height: 3 });
  expect(imageDimensions(WEBP_VP8X_4x5, "image/webp")).toEqual({ width: 4, height: 5 });
  expect(imageDimensions(WEBP_VP8_6x7, "image/webp")).toEqual({ width: 6, height: 7 });
  expect(imageDimensions(PNG_1x1.subarray(0, 20), "image/png")).toBeUndefined();
  expect(imageDimensions(JPEG_2x3.subarray(0, 20), "image/jpeg")).toBeUndefined();  // APP0 only, SOF never reached
  expect(imageDimensions(GIF_2x3.subarray(0, 8), "image/gif")).toBeUndefined();
  const cut = ok(imageFromBytes(PNG_1x1.subarray(0, 20), { name: "cut.png" }));
  expect(cut.mime).toBe("image/png");
  expect(cut.width).toBeUndefined();
  expect(cut.height).toBeUndefined();
});

// ---------- text pins ----------

test("text pins: describeImage / imagePlaceholder (default + custom reason) / imageChip; nameless parts fall back to the mime", () => {
  const p = ok(imageFromBytes(PNG_1x1, { name: "dot.png" }));
  expect(imageByteSize(p)).toBe(70);
  expect(describeImage(p)).toBe("dot.png, 1x1, 70 B");
  expect(imagePlaceholder(p)).toBe("[image: dot.png, 1x1, 70 B — model has no vision]");
  expect(imagePlaceholder(p, "file unavailable")).toBe("[image: dot.png, 1x1, 70 B — file unavailable]");
  expect(imageChip(p)).toBe("[image: dot.png]");
  const nameless: ImagePart = { kind: "image", mime: "image/webp" };
  expect(imagePlaceholder(nameless)).toBe("[image: image/webp — model has no vision]");
  expect(imageChip(nameless)).toBe("[image: image/webp]");
});

// ---------- wire helpers + reading back ----------

test("wire block helpers: Anthropic base64 source and OpenAI data URL (detail auto by default) — exact shapes; undefined when the bytes are unreadable", () => {
  const p = ok(imageFromBytes(PNG_1x1));
  expect(anthropicImageBlock(p)).toEqual({ type: "image", source: { type: "base64", media_type: "image/png", data: PNG_1x1_B64 } });
  expect(openaiImageBlock(p)).toEqual({ type: "image_url", image_url: { url: `data:image/png;base64,${PNG_1x1_B64}`, detail: "auto" } });
  expect((openaiImageBlock(p, "high") as { image_url: { detail: string } }).image_url.detail).toBe("high");
  const gone: ImagePart = { kind: "image", mime: "image/png", path: join(tmpdir(), "definitely-missing-rovecode-p34.png") };
  expect(anthropicImageBlock(gone)).toBeUndefined();
  expect(openaiImageBlock(gone)).toBeUndefined();
});

test("imageData: inline bytes as-is, an absolute sidecar path read back, a relative path or no carrier → undefined (never a throw)", () => {
  const dir = tmp();
  const f = join(dir, "dot.png");
  writeFileSync(f, PNG_1x1);
  expect(imageData({ kind: "image", mime: "image/png", bytes: "QUJD" })).toBe("QUJD");
  expect(imageData({ kind: "image", mime: "image/png", path: f })).toBe(PNG_1x1_B64);
  expect(imageByteSize({ kind: "image", mime: "image/png", path: f })).toBe(70);
  expect(imageData({ kind: "image", mime: "image/png", path: "attachments/dot.png" })).toBeUndefined();
  expect(imageData({ kind: "image", mime: "image/png" })).toBeUndefined();
  expect(imageByteSize({ kind: "image", mime: "image/png" })).toBeUndefined();
  // F2 parity: a RELATIVE path that does reach a real file from the process cwd is still not stat'ed
  // (describeImage must not leak a size for a path the store refused to hydrate). package.json is
  // always present in the test cwd; path.relative(cwd, tmpfile) is NOT usable here — on Windows it
  // returns an absolute path when cwd and the temp dir sit on different drives.
  const rel = "package.json";
  expect(statSync(rel).size).toBeGreaterThan(0);
  expect(imageByteSize({ kind: "image", mime: "image/png", path: rel })).toBeUndefined();
  rmSync(dir, { recursive: true, force: true });
});

test("imageFromBase64 (ACP/HTTP transport form): the bytes decide the type; a declared mime that disagrees is an error; garbage is not an image", () => {
  expect(ok(imageFromBase64(PNG_1x1_B64, "image/png", { name: "dot.png" })).mime).toBe("image/png");
  expect(ok(imageFromBase64(PNG_1x1_B64, undefined)).width).toBe(1);
  expect(err(imageFromBase64(PNG_1x1_B64, "image/jpeg", { name: "dot.png" }))).toBe("dot.png: declared image/jpeg but the bytes are image/png");
  expect(err(imageFromBase64("aGVsbG8=", "image/png"))).toBe("image: not a png/jpeg/gif/webp image (magic bytes: 68 65 6c 6c)");
});

test("loadImageAttachment never throws: a missing file and a directory both come back as { error }; imageExt maps the four mimes", () => {
  const dir = tmp();
  expect(err(loadImageAttachment(join(dir, "nope.png")))).toMatch(/^nope\.png: cannot read \(/);
  mkdirSync(join(dir, "folder.png"));
  expect(err(loadImageAttachment(join(dir, "folder.png")))).toBe("folder.png: not a file");
  expect(["png", "jpg", "gif", "webp"]).toEqual([imageExt("image/png"), imageExt("image/jpeg"), imageExt("image/gif"), imageExt("image/webp")]);
  rmSync(dir, { recursive: true, force: true });
});
