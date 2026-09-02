/** Port #34 image fixtures: minimal VALID container headers (magic bytes + the dimension fields
 *  core/images.ts reads) — no decoder involved. Shared by images / wire-messages / session tests. */

/** the classic 70-byte 1x1 transparent PNG */
export const PNG_1x1_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
export const PNG_1x1 = Buffer.from(PNG_1x1_B64, "base64");

/** GIF89a, logical screen 2x3 (little-endian u16 pair at offset 6) */
export const GIF_2x3 = Buffer.from([
  0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x02, 0x00, 0x03, 0x00, 0x80, 0x00, 0x00,
  0x00, 0x00, 0x00, 0xff, 0xff, 0xff, 0x3b,
]);

/** SOI, APP0/JFIF, SOF0 (height 3, width 2, 3 components), EOI */
export const JPEG_2x3 = Buffer.from([
  0xff, 0xd8,
  0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
  0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x03, 0x00, 0x02, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
  0xff, 0xd9,
]);

/** RIFF....WEBP + one chunk */
export function webpChunk(fourcc: string, payload: number[]): Buffer {
  return Buffer.concat([
    Buffer.from("RIFF"), Buffer.from([0, 0, 0, 0]), Buffer.from("WEBP"),
    Buffer.from(fourcc), Buffer.from([payload.length, 0, 0, 0]), Buffer.from(payload),
  ]);
}
/** lossless: signature 0x2f, then 14-bit width-1 = 1, 14-bit height-1 = 2 */
export const WEBP_VP8L_2x3 = webpChunk("VP8L", [0x2f, 0x01, 0x80, 0x00, 0x00, 0, 0, 0, 0, 0]);
/** extended: flags, reserved, 24-bit canvas width-1 = 3, height-1 = 4 */
export const WEBP_VP8X_4x5 = webpChunk("VP8X", [0x00, 0, 0, 0, 0x03, 0x00, 0x00, 0x04, 0x00, 0x00, 0, 0, 0, 0, 0, 0]);
/** lossy: frame tag, start code 9d 01 2a, 14-bit width 6, height 7 */
export const WEBP_VP8_6x7 = webpChunk("VP8 ", [0, 0, 0, 0x9d, 0x01, 0x2a, 0x06, 0x00, 0x07, 0x00, 0, 0, 0, 0, 0, 0]);
