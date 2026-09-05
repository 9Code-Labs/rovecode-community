import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { cn } from "@/lib/utils";
import type { Shot as ShotData } from "@/content";

const COLS = 160, ROWS = 44;

interface Props extends ShotData {
  /** legend on the left at lg (alternate per row) */
  flip?: boolean;
  index: number;
}

interface Line { x1: number; y1: number; x2: number; y2: number; xm: number }

/** a real 160×44 frame in a tilted glass bezel (flattens on hover); numbered glass pills sit on the frame at
 *  cell coordinates and 1 px leader lines join them to the explanation rows (desktop) */
export function Shot({ file, alt, title, lead, callouts, flip, index }: Props) {
  const reduce = useReducedMotion();
  const [hot, setHot] = useState<number | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const root = useRef<HTMLElement | null>(null);
  const pills = useRef<Map<number, HTMLElement>>(new Map());
  const rows = useRef<Map<number, HTMLElement>>(new Map());

  const measure = useCallback(() => {
    const el = root.current;
    if (!el || el.clientWidth < 960) { setLines([]); return; }
    const R = el.getBoundingClientRect();
    const out: Line[] = [];
    for (const c of callouts) {
      const p = pills.current.get(c.n), r = rows.current.get(c.n);
      if (!p || !r) continue;
      const pb = p.getBoundingClientRect(), rb = r.getBoundingClientRect();
      const x1 = (flip ? pb.left : pb.right) - R.left, y1 = pb.top + pb.height / 2 - R.top;
      const x2 = (flip ? rb.right : rb.left) - R.left, y2 = rb.top + rb.height / 2 - R.top;
      const xm = flip ? x2 + 18 : x2 - 18;
      out.push({ x1, y1, x2, y2, xm });
    }
    setLines(out);
  }, [callouts, flip]);

  useLayoutEffect(() => { measure(); }, [measure]);
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(el);
    window.addEventListener("resize", measure);
    const t = window.setTimeout(measure, 900);
    return () => { ro.disconnect(); window.removeEventListener("resize", measure); window.clearTimeout(t); };
  }, [measure]);

  return (
    <article ref={root} className="relative grid items-center gap-6 lg:grid-cols-12 lg:gap-10">
      <div className={cn("lg:col-span-8", flip && "lg:order-2")} style={{ perspective: 1600 }}>
        <motion.div
          initial={reduce ? false : { rotateY: flip ? 2.5 : -2.5 }}
          whileHover={reduce ? undefined : { rotateY: 0 }}
          transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
          onAnimationComplete={measure}
          onUpdate={measure}
          className="glass glass-hover relative overflow-visible rounded-[22px] md:rounded-[26px]"
          style={{ transformStyle: "preserve-3d" }}
        >
          <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
            <span aria-hidden className="size-2.5 rounded-full bg-white/[0.14]" />
            <span aria-hidden className="size-2.5 rounded-full bg-white/[0.14]" />
            <span aria-hidden className="size-2.5 rounded-full bg-white/[0.14]" />
            <span className="mono ml-2 text-xs text-text-muted">nimbus · atlas · feature/auth · 160×44</span>
          </div>
          <div className="p-1.5 md:p-2.5">
            <div className="relative">
              <img src={file} alt={alt} width={2497} height={1496} loading={index === 0 ? "eager" : "lazy"} decoding="async" onLoad={measure} className="block w-full rounded-[14px] md:rounded-[18px]" />
              {callouts.map((c) => (
                <span
                  key={c.n}
                  ref={(el) => { if (el) pills.current.set(c.n, el); else pills.current.delete(c.n); }}
                  aria-hidden
                  style={{ left: `${((c.x + 0.5) / COLS) * 100}%`, top: `${((c.y + 0.5) / ROWS) * 100}%` }}
                  className={cn(
                    "glass-pill mono absolute flex -translate-x-1/2 -translate-y-1/2 select-none items-center gap-1.5 px-2 py-0.5 text-[11px] leading-[18px] transition-[border-color,transform] duration-200 md:text-xs md:leading-5",
                    hot === c.n ? "scale-110 !border-brand/60" : "",
                  )}
                >
                  <span className={cn("inline-flex size-4 items-center justify-center rounded-full text-[10px] font-semibold", hot === c.n ? "bg-brand-hover text-on-brand" : "bg-brand text-on-brand")}>{c.n}</span>
                  <span className="hidden text-text md:inline">{c.short}</span>
                </span>
              ))}
            </div>
          </div>
        </motion.div>
      </div>

      <div className={cn("lg:col-span-4", flip && "lg:order-1")}>
        <h3 className="text-[1.4rem] leading-snug md:text-[1.65rem]">{title}</h3>
        <p className="mt-3 text-[15.5px] leading-7 text-text-muted">{lead}</p>
        <ol className="mt-6 divide-y divide-border">
          {callouts.map((c) => (
            <li
              key={c.n}
              ref={(el) => { if (el) rows.current.set(c.n, el); else rows.current.delete(c.n); }}
              onMouseEnter={() => setHot(c.n)}
              onMouseLeave={() => setHot(null)}
              onFocus={() => setHot(c.n)}
              onBlur={() => setHot(null)}
              tabIndex={0}
              className={cn("flex cursor-default items-baseline gap-3 py-3 text-[15px] leading-6 transition-colors duration-150 focus-visible:outline-none", hot === c.n ? "text-text" : "text-text-muted")}
            >
              <span className={cn("mono inline-flex size-5 shrink-0 translate-y-0.5 items-center justify-center rounded-full text-[10px] font-semibold", hot === c.n ? "bg-brand text-on-brand" : "border border-brand/50 text-brand")}>{c.n}</span>
              {c.text}
            </li>
          ))}
        </ol>
      </div>

      {lines.length > 0 && (
        <svg aria-hidden className="pointer-events-none absolute inset-0 hidden h-full w-full overflow-visible lg:block">
          {lines.map((l, i) => (
            <g key={i} className="transition-opacity duration-200" style={{ opacity: hot === null || hot === callouts[i]?.n ? 1 : 0.35 }}>
              <path d={`M ${l.x1} ${l.y1} L ${l.xm} ${l.y1} L ${l.xm} ${l.y2} L ${l.x2} ${l.y2}`} fill="none" stroke="rgba(92,184,255,0.38)" strokeWidth="1" />
              <circle cx={l.x2} cy={l.y2} r="2" fill="#5cb8ff" />
            </g>
          ))}
        </svg>
      )}
    </article>
  );
}
