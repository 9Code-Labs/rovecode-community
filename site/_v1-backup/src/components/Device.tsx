import { useRef } from "react";
import { motion, useReducedMotion, useScroll, useTransform } from "motion/react";
import { EASE } from "./Motion";
import { Mascot } from "./Mascot";
import { cn } from "@/lib/utils";

interface Chip { text: string; className: string }

interface Props {
  src: string;
  alt: string;
  title: string;
  meta?: string;
  chips?: Chip[];
  quip?: string;
  mood?: string;
  className?: string;
}

/** the hero frame as a staged device: glass bezel, deep shadow, 4° rotateX that settles once over 800 ms,
 *  then a ≤ 12 px parallax on scroll; floating glass chips + the pet badge anchor to the bezel (desktop) */
export function Device({ src, alt, title, meta, chips = [], quip, mood, className }: Props) {
  const reduce = useReducedMotion();
  const ref = useRef<HTMLDivElement | null>(null);
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start end", "end start"] });
  const y = useTransform(scrollYProgress, [0, 1], reduce ? [0, 0] : [12, -12]);

  return (
    <div ref={ref} className={cn("relative", className)} style={{ perspective: 1400 }}>
      <motion.div
        style={{ y, transformStyle: "preserve-3d" }}
        initial={reduce ? false : { opacity: 0, rotateX: 4, y: 28 }}
        animate={reduce ? undefined : { opacity: 1, rotateX: 0, y: 0 }}
        transition={{ duration: 0.8, ease: EASE, delay: 0.15 }}
        className="relative"
      >
        <div className="glass overflow-hidden rounded-[22px] md:rounded-[28px]" style={{ boxShadow: "inset 0 1px 0 0 rgba(255,255,255,.08), 0 40px 120px rgba(0,0,0,.55), 0 12px 32px rgba(0,0,0,.35)" }}>
          <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-2.5">
            <div className="flex items-center gap-2">
              <span aria-hidden className="size-2.5 rounded-full bg-white/[0.14]" />
              <span aria-hidden className="size-2.5 rounded-full bg-white/[0.14]" />
              <span aria-hidden className="size-2.5 rounded-full bg-white/[0.14]" />
              <span className="mono ml-2 text-xs text-text-muted">
                {title}
                {meta && <span className="hidden text-text-faint sm:inline"> · {meta}</span>}
              </span>
            </div>
          </div>
          <div className="p-1.5 md:p-2.5">
            <img src={src} alt={alt} width={2497} height={1496} fetchPriority="high" decoding="async" className="block w-full rounded-[14px] md:rounded-[18px]" />
          </div>
        </div>

        {chips.map((c, i) => (
          <motion.div
            key={c.text}
            initial={reduce ? false : { opacity: 0, y: 8 }}
            animate={reduce ? undefined : { opacity: 1, y: 0 }}
            transition={{ duration: 0.6, ease: EASE, delay: 0.9 + i * 0.12 }}
            className={cn("glass-pill mono absolute hidden items-center gap-2 px-3.5 py-2 text-xs text-text lg:flex", c.className)}
          >
            <span aria-hidden className="size-1.5 rounded-full bg-brand" />
            {c.text}
          </motion.div>
        ))}

        {quip && (
          <motion.div
            initial={reduce ? false : { opacity: 0, y: 8 }}
            animate={reduce ? undefined : { opacity: 1, y: 0 }}
            transition={{ duration: 0.6, ease: EASE, delay: 1.3 }}
            className="absolute -top-[4.25rem] right-6 hidden lg:block"
          >
            <Mascot quip={quip} mood={mood} />
          </motion.div>
        )}
      </motion.div>
    </div>
  );
}
