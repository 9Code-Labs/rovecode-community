import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { FRAME_SIZES, FRAME_WIDTHS, Pic } from "./Pic";
import type { Shot as ShotData } from "@/content";

const COLS = 160, ROWS = 44;
/** the lens: how far the frame zooms in on the hovered callout */
const ZOOM = 2;

interface Props extends ShotData {
  /** legend on the left at lg (alternate per row) */
  flip?: boolean;
  index: number;
}

interface Line { x1: number; y1: number; x2: number; y2: number; xm: number }

/** a real 160×44 frame in a flat bezel; numbered markers sit on the frame at cell coordinates and 1 px leader
 *  lines join them to the explanation rows (desktop). Hovering (or focusing, on touch: tapping) a row or a marker
 *  turns the frame into a lens: it zooms 2× on that cell, the marker staying put as the fixed point, and pans to the
 *  next callout when the pointer moves on. */
export function Shot({ file, alt, title, lead, callouts, flip }: Props) {
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

  // the lens: scale about the origin, then translate so the hot cell maps onto itself (p → Z·p + t = p ⇒ t = −p·(Z−1))
  const focus = callouts.find((c) => c.n === hot);
  const fx = focus ? ((focus.x + 0.5) / COLS) * 100 : 0, fy = focus ? ((focus.y + 0.5) / ROWS) * 100 : 0;
  const lens = focus ? `translate(${(-fx * (ZOOM - 1)).toFixed(3)}%, ${(-fy * (ZOOM - 1)).toFixed(3)}%) scale(${ZOOM})` : "translate(0%, 0%) scale(1)";

  const hotProps = (n: number) => ({
    onMouseEnter: () => setHot(n),
    onMouseLeave: () => setHot(null),
  });

  return (
    <article ref={root} className="relative grid items-center gap-6 lg:grid-cols-12 lg:gap-10">
      <div className={cn("lg:col-span-8", flip && "lg:order-2")}>
        <div className="panel panel-hover relative overflow-visible">
          <div className="flex items-center justify-between rounded-t-[calc(var(--radius-lg)-1px)] bg-surface-2 px-4 py-2">
            <span className="mono text-xs text-text-muted">rovecode · atlas · feature/auth · 160×44</span>
            <span className={cn("mono text-xs transition-colors duration-200", focus ? "text-brand" : "text-text-faint")}>{focus ? `${ZOOM}× · ${focus.short}` : "real frame"}</span>
          </div>
          <div className="p-1.5 md:p-2">
            <div className="relative">
              <div className="overflow-hidden rounded-md">
                <Pic
                  src={file}
                  widths={FRAME_WIDTHS}
                  sizes={FRAME_SIZES}
                  alt={alt}
                  width={2497}
                  height={1496}
                  loading="lazy"
                  decoding="async"
                  onLoad={measure}
                  style={{ transform: lens, transformOrigin: "0 0" }}
                  className="block w-full transition-transform duration-500 ease-(--ease-out-soft) will-change-transform motion-reduce:transition-none"
                />
              </div>
              {callouts.map((c) => (
                <span
                  key={c.n}
                  ref={(el) => { if (el) pills.current.set(c.n, el); else pills.current.delete(c.n); }}
                  aria-hidden
                  {...hotProps(c.n)}
                  style={{ left: `${((c.x + 0.5) / COLS) * 100}%`, top: `${((c.y + 0.5) / ROWS) * 100}%` }}
                  className={cn(
                    "mono absolute flex -translate-x-1/2 -translate-y-1/2 cursor-default select-none items-center gap-1.5 rounded-sm px-1.5 py-0.5 text-[11px] leading-[18px] shadow-[var(--shadow-sm)] transition-[background-color,opacity] duration-300 md:text-xs md:leading-5",
                    hot === c.n ? "bg-brand text-on-brand" : "bg-surface",
                    hot !== null && hot !== c.n && "pointer-events-none opacity-0",
                  )}
                >
                  <span className="inline-flex size-4 items-center justify-center rounded-sm bg-brand text-[10px] font-bold text-on-brand">{c.n}</span>
                  <span className="hidden text-text md:inline">{c.short}</span>
                </span>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className={cn("lg:col-span-4", flip && "lg:order-1")}>
        <h3 className="text-[1.4rem] leading-snug md:text-[1.65rem]">{title}</h3>
        <p className="mt-3 text-[15.5px] leading-7 text-text-muted">{lead}</p>
        <ol className="mt-6 grid gap-1">
          {callouts.map((c) => (
            <li
              key={c.n}
              ref={(el) => { if (el) rows.current.set(c.n, el); else rows.current.delete(c.n); }}
              {...hotProps(c.n)}
              onFocus={() => setHot(c.n)}
              onBlur={() => setHot(null)}
              tabIndex={0}
              className={cn("flex cursor-default items-baseline gap-3 rounded-md px-3 py-2.5 text-[15px] leading-6 transition-colors duration-150 focus-visible:outline-none", hot === c.n ? "bg-surface-2 text-text" : "text-text-muted")}
            >
              <span className={cn("mono inline-flex size-5 shrink-0 translate-y-0.5 items-center justify-center rounded-sm text-[10px] font-bold transition-colors duration-150", hot === c.n ? "bg-brand text-on-brand" : "bg-surface-2 text-text-muted")}>{c.n}</span>
              {c.text}
            </li>
          ))}
        </ol>
      </div>

      {lines.length > 0 && (
        <svg aria-hidden className="pointer-events-none absolute inset-0 hidden h-full w-full overflow-visible lg:block">
          {lines.map((l, i) => (
            <g key={i} className="transition-opacity duration-300" style={{ opacity: hot === null ? 1 : hot === callouts[i]?.n ? 1 : 0 }}>
              <path d={`M ${l.x1} ${l.y1} L ${l.xm} ${l.y1} L ${l.xm} ${l.y2} L ${l.x2} ${l.y2}`} fill="none" stroke="rgba(22,105,178,0.55)" strokeWidth="1" />
              <circle cx={l.x2} cy={l.y2} r="2" fill="#1669b2" />
            </g>
          ))}
        </svg>
      )}
    </article>
  );
}
