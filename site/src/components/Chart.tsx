import { useId } from "react";
import { motion, useReducedMotion } from "motion/react";
import { cn } from "@/lib/utils";

/** ---------------------------------------------------------------------------------------------------------------
 *  The chart primitives. The page is drawn like a meteorological chart, so the recurring marks are not boxes and
 *  rules but pressure curves, station circles, route legs and front lines. Everything here is decoration that
 *  carries structure: the isobars centre on the thing a section is about, the route is the safety ladder in order,
 *  a station plots a figure. All of it is aria-hidden — the text says the same thing.
 *  ------------------------------------------------------------------------------------------------------------ */

/** Concentric pressure curves behind a section, centred wherever the content's weight is. `gap` is the spacing
 *  between rings in px; the dotted graticule underneath is the chart's lattice. Fades out at the edges so the
 *  rings never collide with the next section. */
export function Field({
  x = "50%",
  y = "50%",
  gap = 92,
  graticule = true,
  className,
}: { x?: string; y?: string; gap?: number; graticule?: boolean; className?: string }) {
  return (
    <div
      aria-hidden
      className={cn("pointer-events-none absolute inset-0 -z-10 overflow-hidden", className)}
      style={{ maskImage: "radial-gradient(120% 90% at var(--iso-x) var(--iso-y), #000 30%, transparent 78%)", WebkitMaskImage: "radial-gradient(120% 90% at var(--iso-x) var(--iso-y), #000 30%, transparent 78%)", ["--iso-x" as string]: x, ["--iso-y" as string]: y, ["--iso-gap" as string]: `${gap}px` }}
    >
      {graticule && <div className="graticule absolute inset-0 opacity-70" />}
      <div className="isobars absolute inset-0" />
    </div>
  );
}

/** A station circle: the mark a reading is plotted on. Filled when it is the one that matters. */
export function Station({ tone = "ink", size = 10, className }: { tone?: "ink" | "front" | "brand"; size?: number; className?: string }) {
  const stroke = tone === "front" ? "var(--color-front)" : tone === "brand" ? "var(--color-brand)" : "var(--color-text-faint)";
  return (
    <svg aria-hidden width={size} height={size} viewBox="0 0 10 10" className={cn("shrink-0", className)}>
      <circle cx="5" cy="5" r="4" fill="none" stroke={stroke} strokeWidth="1.25" />
      {tone === "front" && <circle cx="5" cy="5" r="1.75" fill={stroke} />}
    </svg>
  );
}

/** A warm-front leg: the semicircle-studded line charts use for an advancing front. Used once per page as the
 *  divider between the two halves of the argument, in place of a rule. */
export function Front({ className }: { className?: string }) {
  const id = useId();
  const reduce = useReducedMotion();
  return (
    <svg aria-hidden viewBox="0 0 1200 24" preserveAspectRatio="none" className={cn("h-6 w-full", className)}>
      <defs>
        <path id={`${id}-bump`} d="M0 14 a7 7 0 0 1 14 0" fill="var(--color-front)" />
      </defs>
      <motion.path
        d="M0 14 C 180 4, 300 22, 480 14 S 820 4, 1200 14"
        fill="none"
        stroke="var(--color-front)"
        strokeWidth="1.5"
        initial={reduce ? undefined : { pathLength: 0 }}
        whileInView={reduce ? undefined : { pathLength: 1 }}
        viewport={{ once: true, amount: 0.6 }}
        transition={{ duration: 1.4, ease: [0.22, 1, 0.36, 1] }}
      />
      {[60, 240, 420, 600, 780, 960, 1140].map((x) => (
        <use key={x} href={`#${id}-bump`} x={x - 7} y={-1} />
      ))}
    </svg>
  );
}

export interface Leg {
  /** the waypoint's short name, e.g. "rules" */
  name: string;
  /** what it decides, one line */
  note?: string;
}

/** The route: the four safety layers as legs of a course, drawn as one curve with waypoints on it. The curve draws
 *  itself once on entry (1.6 s); hovering a waypoint raises it. Horizontal on desktop, vertical on phones. */
export function Route({ legs, active, onHover, className }: { legs: Leg[]; active?: number | null; onHover?: (i: number | null) => void; className?: string }) {
  const reduce = useReducedMotion();
  const n = legs.length;
  const W = 1000, H = 120;
  const pad = 90;
  const step = (W - pad * 2) / (n - 1);
  const at = (i: number) => ({ x: pad + step * i, y: 60 + (i % 2 === 0 ? -16 : 16) });
  const d = legs
    .map((_, i) => {
      const p = at(i);
      if (i === 0) return `M ${p.x} ${p.y}`;
      const q = at(i - 1);
      const mx = (q.x + p.x) / 2;
      return `C ${mx} ${q.y}, ${mx} ${p.y}, ${p.x} ${p.y}`;
    })
    .join(" ");

  return (
    <div className={cn("relative", className)}>
      <svg viewBox={`0 0 ${W} ${H}`} className="hidden h-[120px] w-full md:block" role="img" aria-label={legs.map((l) => l.name).join(" → ")}>
        <motion.path
          d={d}
          fill="none"
          stroke="var(--color-brand)"
          strokeWidth="1.5"
          strokeDasharray="6 5"
          initial={reduce ? undefined : { pathLength: 0 }}
          whileInView={reduce ? undefined : { pathLength: 1 }}
          viewport={{ once: true, amount: 0.5 }}
          transition={{ duration: 1.6, ease: [0.22, 1, 0.36, 1] }}
        />
        {legs.map((l, i) => {
          const p = at(i);
          const on = active === i;
          return (
            <g key={l.name} onMouseEnter={() => onHover?.(i)} onMouseLeave={() => onHover?.(null)} className="cursor-default">
              <circle cx={p.x} cy={p.y} r="22" fill="transparent" />
              <circle cx={p.x} cy={p.y} r={on ? 9 : 7} fill="var(--color-bg)" stroke={on ? "var(--color-front)" : "var(--color-brand)"} strokeWidth="1.5" className="transition-all duration-200" />
              {on && <circle cx={p.x} cy={p.y} r="3" fill="var(--color-front)" />}
              <text
                x={p.x}
                y={p.y + (i % 2 === 0 ? -22 : 34)}
                textAnchor="middle"
                className="label"
                style={{ fill: on ? "var(--color-front)" : "var(--color-text-muted)", fontSize: "13px", letterSpacing: "0.1em" }}
              >
                {l.name}
              </text>
            </g>
          );
        })}
      </svg>

      {/* phones: the same course read down the page */}
      <ol className="grid gap-3 md:hidden">
        {legs.map((l, i) => (
          <li key={l.name} className="flex items-center gap-3">
            <Station tone={active === i ? "front" : "brand"} size={12} />
            <span className="label !text-text">{l.name}</span>
            {i < n - 1 && <span aria-hidden className="text-text-faint">↓</span>}
          </li>
        ))}
      </ol>
    </div>
  );
}
