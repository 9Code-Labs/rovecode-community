import { useEffect, useRef } from "react";
import { useReducedMotion } from "motion/react";
import { cn } from "@/lib/utils";

/** ---------------------------------------------------------------------------------------------------------------
 *  A pressure field, drawn live. 3-D simplex noise sampled on a coarse grid gives a scalar field; marching squares
 *  traces its iso-lines at eight levels; time is the third noise axis, so the whole chart drifts the way a synoptic
 *  loop does — slowly, nothing ever jumps. Every third contour is heavier, the way charts mark the 4 hPa lines.
 *  Under prefers-reduced-motion one frame is drawn and left. Decoration only: aria-hidden, pointer-events none.
 *  ------------------------------------------------------------------------------------------------------------ */

/* --- simplex noise (Gustavson's 3-D variant, seeded so the chart is the same on every visit) --- */
const GRAD3 = [[1, 1, 0], [-1, 1, 0], [1, -1, 0], [-1, -1, 0], [1, 0, 1], [-1, 0, 1], [1, 0, -1], [-1, 0, -1], [0, 1, 1], [0, -1, 1], [0, 1, -1], [0, -1, -1]] as const;
function makeNoise(seed: number) {
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  let s = seed >>> 0;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  for (let i = 255; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); const t = p[i]!; p[i] = p[j]!; p[j] = t; }
  const perm = new Uint8Array(512), pm = new Uint8Array(512);
  for (let i = 0; i < 512; i++) { perm[i] = p[i & 255]!; pm[i] = perm[i]! % 12; }
  const F3 = 1 / 3, G3 = 1 / 6;
  return (x: number, y: number, z: number): number => {
    const s0 = (x + y + z) * F3;
    const i = Math.floor(x + s0), j = Math.floor(y + s0), k = Math.floor(z + s0);
    const t = (i + j + k) * G3;
    const x0 = x - (i - t), y0 = y - (j - t), z0 = z - (k - t);
    let i1: number, j1: number, k1: number, i2: number, j2: number, k2: number;
    if (x0 >= y0) {
      if (y0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
      else if (x0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 0; k2 = 1; }
      else { i1 = 0; j1 = 0; k1 = 1; i2 = 1; j2 = 0; k2 = 1; }
    } else {
      if (y0 < z0) { i1 = 0; j1 = 0; k1 = 1; i2 = 0; j2 = 1; k2 = 1; }
      else if (x0 < z0) { i1 = 0; j1 = 1; k1 = 0; i2 = 0; j2 = 1; k2 = 1; }
      else { i1 = 0; j1 = 1; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
    }
    const x1 = x0 - i1 + G3, y1 = y0 - j1 + G3, z1 = z0 - k1 + G3;
    const x2 = x0 - i2 + 2 * G3, y2 = y0 - j2 + 2 * G3, z2 = z0 - k2 + 2 * G3;
    const x3 = x0 - 1 + 3 * G3, y3 = y0 - 1 + 3 * G3, z3 = z0 - 1 + 3 * G3;
    const ii = i & 255, jj = j & 255, kk = k & 255;
    const corner = (tx: number, ty: number, tz: number, gi: number) => {
      let tt = 0.6 - tx * tx - ty * ty - tz * tz;
      if (tt < 0) return 0;
      tt *= tt;
      const g = GRAD3[gi]!;
      return tt * tt * (g[0] * tx + g[1] * ty + g[2] * tz);
    };
    const n0 = corner(x0, y0, z0, pm[ii + perm[jj + perm[kk]!]!]!);
    const n1 = corner(x1, y1, z1, pm[ii + i1 + perm[jj + j1 + perm[kk + k1]!]!]!);
    const n2 = corner(x2, y2, z2, pm[ii + i2 + perm[jj + j2 + perm[kk + k2]!]!]!);
    const n3 = corner(x3, y3, z3, pm[ii + 1 + perm[jj + 1 + perm[kk + 1]!]!]!);
    return 32 * (n0 + n1 + n2 + n3);
  };
}

interface Props {
  /** grid cell in CSS px; smaller is smoother and costlier */
  cell?: number;
  /** noise wavelength in px — how wide the pressure systems are */
  scale?: number;
  /** contour count across the field's range */
  levels?: number;
  /** drift speed; 1 ≈ one full change of weather per ~90 s */
  speed?: number;
  /** where the field is strongest, for the edge mask (CSS lengths / percentages) */
  focus?: { x: string; y: string };
  className?: string;
}

export function Contours({ cell = 10, scale = 420, levels = 9, speed = 1, focus = { x: "70%", y: "40%" }, className }: Props) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const reduce = useReducedMotion();

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const noise = makeNoise(1013);
    let raf = 0, w = 0, h = 0, dpr = 1, t0 = performance.now(), last = 0;
    let field = new Float32Array(0), cols = 0, rows = 0;
    const ink = getComputedStyle(canvas).getPropertyValue("--isobar-rgb").trim() || "21, 36, 44";

    const resize = () => {
      const r = canvas.getBoundingClientRect();
      w = Math.max(1, Math.round(r.width)); h = Math.max(1, Math.round(r.height));
      dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      cols = Math.ceil(w / cell) + 1; rows = Math.ceil(h / cell) + 1;
      field = new Float32Array(cols * rows);
    };

    const sample = (time: number) => {
      const z = time * 0.00002 * speed;
      for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
        const x = (i * cell) / scale, y = (j * cell) / scale;
        // two octaves: broad systems plus a little texture on the lines
        field[j * cols + i] = noise(x, y, z) * 0.78 + noise(x * 2.3 + 7.1, y * 2.3 + 3.3, z * 1.6) * 0.22;
      }
    };

    /* marching squares: for each cell, the two interpolated crossing points per case; drawn as short segments */
    const lerp = (a: number, b: number, v: number) => (v - a) / (b - a || 1e-6);
    const draw = () => {
      ctx.clearRect(0, 0, w, h);
      for (let l = 0; l < levels; l++) {
        const v = -0.72 + (1.44 * (l + 0.5)) / levels;
        const major = l % 3 === 1;
        ctx.beginPath();
        ctx.lineWidth = major ? 1.25 : 0.8;
        ctx.strokeStyle = `rgba(${ink}, ${major ? 0.26 : 0.12})`;
        for (let j = 0; j < rows - 1; j++) {
          for (let i = 0; i < cols - 1; i++) {
            const a = field[j * cols + i]!, b = field[j * cols + i + 1]!, c = field[(j + 1) * cols + i + 1]!, d = field[(j + 1) * cols + i]!;
            const idx = (a > v ? 8 : 0) | (b > v ? 4 : 0) | (c > v ? 2 : 0) | (d > v ? 1 : 0);
            if (idx === 0 || idx === 15) continue;
            const x = i * cell, y = j * cell;
            const top = { x: x + cell * lerp(a, b, v), y };
            const right = { x: x + cell, y: y + cell * lerp(b, c, v) };
            const bottom = { x: x + cell * lerp(d, c, v), y: y + cell };
            const left = { x, y: y + cell * lerp(a, d, v) };
            const seg = (p: { x: number; y: number }, q: { x: number; y: number }) => { ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); };
            switch (idx) {
              case 1: case 14: seg(left, bottom); break;
              case 2: case 13: seg(bottom, right); break;
              case 3: case 12: seg(left, right); break;
              case 4: case 11: seg(top, right); break;
              case 5: seg(left, top); seg(bottom, right); break;
              case 6: case 9: seg(top, bottom); break;
              case 7: case 8: seg(left, top); break;
              case 10: seg(top, right); seg(left, bottom); break;
            }
          }
        }
        ctx.stroke();
      }
    };

    const frame = (now: number) => {
      // 24 fps is plenty for weather
      if (now - last > 41) { last = now; sample(now - t0); draw(); }
      raf = requestAnimationFrame(frame);
    };

    resize();
    sample(0);
    draw();
    const ro = new ResizeObserver(() => { resize(); sample(performance.now() - t0); draw(); });
    ro.observe(canvas);
    if (!reduce) raf = requestAnimationFrame(frame);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); };
  }, [cell, scale, levels, speed, reduce]);

  return (
    <canvas
      ref={ref}
      aria-hidden
      className={cn("pointer-events-none absolute inset-0 -z-10 h-full w-full", className)}
      style={{
        ["--isobar-rgb" as string]: "21, 36, 44",
        // strongest around the focus, thinning towards the copy on the left and the edges
        maskImage: `radial-gradient(95% 90% at ${focus.x} ${focus.y}, #000 28%, rgba(0,0,0,0.5) 55%, rgba(0,0,0,0.18) 78%, transparent 100%)`,
        WebkitMaskImage: `radial-gradient(95% 90% at ${focus.x} ${focus.y}, #000 28%, rgba(0,0,0,0.5) 55%, rgba(0,0,0,0.18) 78%, transparent 100%)`,
      }}
    />
  );
}
