import type { ImgHTMLAttributes } from "react";

interface Props extends ImgHTMLAttributes<HTMLImageElement> {
  /** the PNG under public/, e.g. "/shots/approval-160x44.png" — the fallback and the key for the variants */
  src: string;
  /** widths that scripts/images.mjs produced for this PNG (`<stem>-<w>.avif|webp`); omit for a single natural-size pair */
  widths?: readonly number[];
  /** the img `sizes` attribute; required when widths are given */
  sizes?: string;
}

const stem = (src: string) => src.replace(/\.png$/, "");

/** A PNG with its AVIF and WebP twins from scripts/images.mjs: <picture> with two <source>s and the PNG as the
 *  fallback <img>. Every attribute other than src/widths/sizes lands on the <img> (alt, width, height, loading…). */
export function Pic({ src, widths, sizes, ...img }: Props) {
  const s = stem(src);
  const set = (ext: string) => (widths ? widths.map((w) => `${s}-${w}.${ext} ${w}w`).join(", ") : `${s}.${ext}`);
  return (
    <picture>
      <source type="image/avif" srcSet={set("avif")} sizes={sizes} />
      <source type="image/webp" srcSet={set("webp")} sizes={sizes} />
      <img src={src} sizes={sizes} {...img} />
    </picture>
  );
}

/** the widths scripts/images.mjs renders for the 160×44 frames (2497 px native) */
export const FRAME_WIDTHS = [640, 960, 1400, 2400] as const;
/** the frame is at most 1136 px wide on the page (1200 container − padding); phones get the viewport width */
export const FRAME_SIZES = "(min-width: 1200px) 1136px, calc(100vw - 48px)";
