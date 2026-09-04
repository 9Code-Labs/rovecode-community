import { Fragment } from "react";
import { ArrowUpRight } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { EASE } from "@/components/Motion";
import { CopyCommand } from "@/components/CopyCommand";
import { CountUp } from "@/components/CountUp";
import { Device } from "@/components/Device";
import { useT } from "@/i18n";
import { HERO, README, REPO, STATS, USAGE } from "@/content";

/** the headline as animatable words (see earlier rounds); the marked word is set in the ink, not in a colour */
type Seg = { text: string; marked: boolean };
type Word = { segs: Seg[]; space: boolean };

function words(title: string): Word[] {
  const out: Word[] = [];
  let cur: Seg[] = [];
  const flush = (space: boolean) => { if (cur.length) { out.push({ segs: cur, space }); cur = []; } else if (space && out.length) out[out.length - 1]!.space = true; };
  for (const part of title.split(/(\*[^*]+\*)/)) {
    if (!part) continue;
    if (part.startsWith("*") && part.endsWith("*")) { cur.push({ text: part.slice(1, -1), marked: true }); continue; }
    for (const w of part.split(/(\s+)/)) {
      if (!w) continue;
      if (w.trim()) cur.push({ text: w, marked: false });
      else flush(true);
    }
  }
  flush(false);
  return out;
}

/** The opening: a line of small type, the headline, one sentence, the command — all centred in a narrow measure
 *  and surrounded by air — then the real frame, large, alone. Under it, the repository's figures in one quiet row. */
export function Hero() {
  const t = useT();
  const reduce = useReducedMotion();
  const enter = (delay: number) => (reduce ? {} : { initial: { opacity: 0, y: 10 }, animate: { opacity: 1, y: 0 }, transition: { duration: 0.9, ease: EASE, delay } });
  const line = words(t.hero.title);

  return (
    <section id="top" className="relative" aria-labelledby="hero-title">
      <div className="mx-auto w-full max-w-[1200px] px-6 pt-[calc(var(--header-h)+6rem)] md:px-10 md:pt-[calc(var(--header-h)+9rem)]">
        <div className="mx-auto max-w-[44rem] text-center">
          <motion.p {...enter(0)} className="label">
            {t.ui.facts.join("  ·  ")}
          </motion.p>

          <h1 id="hero-title" className="display mx-auto mt-10 max-w-[22ch] text-[2.25rem] md:text-[3.25rem]">
            {line.map((w, i) => {
              const inner = w.segs.map((s, j) => (s.marked ? <span key={j} className="font-normal text-text">{s.text}</span> : <Fragment key={j}>{s.text}</Fragment>));
              if (reduce) return <Fragment key={i}>{inner}{w.space ? " " : ""}</Fragment>;
              return (
                <Fragment key={i}>
                  <span className="inline-block overflow-hidden pb-[0.12em] -mb-[0.12em] align-bottom">
                    <motion.span className="inline-block" initial={{ y: "110%", opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={{ duration: 0.9, ease: EASE, delay: 0.1 + i * 0.045 }}>
                      {inner}
                    </motion.span>
                  </span>
                  {w.space && " "}
                </Fragment>
              );
            })}
          </h1>

          <motion.p {...enter(0.5)} className="mx-auto mt-8 max-w-[32rem] text-[16px] leading-[1.75] text-text-muted">
            {t.hero.sub}
          </motion.p>

          <motion.div {...enter(0.65)} className="mx-auto mt-10 flex max-w-[26rem] flex-col items-center gap-5">
            <CopyCommand command={USAGE} wrap className="w-full" />
            <div className="flex flex-wrap items-center justify-center gap-x-8 gap-y-3 text-[14px]">
              <a href={REPO} target="_blank" rel="noreferrer" className="group inline-flex items-center gap-1 text-text transition-colors duration-150 hover:text-brand">
                {t.hero.ctaGithub}
                <ArrowUpRight className="size-3.5 transition-transform duration-150 group-hover:-translate-y-0.5 group-hover:translate-x-0.5 rtl:-scale-x-100" aria-hidden />
              </a>
              <a href={README} target="_blank" rel="noreferrer" className="group inline-flex items-center gap-1 text-text-muted transition-colors duration-150 hover:text-text">
                {t.hero.ctaReadme}
                <ArrowUpRight className="size-3.5 transition-transform duration-150 group-hover:-translate-y-0.5 group-hover:translate-x-0.5 rtl:-scale-x-100" aria-hidden />
              </a>
            </div>
          </motion.div>
        </div>

        {/* the frame: the page's one image, at its full width */}
        <motion.div {...enter(0.85)} className="mt-24 md:mt-32">
          <Device src={HERO.frame} alt={t.hero.frameAlt} title="rovecode · atlas · feature/auth" meta="sextant · night · 160×44" chips={t.hero.chips.map((text) => ({ text }))} />
          <p className="label mx-auto mt-6 max-w-[46rem] text-center !normal-case !tracking-normal">{t.hero.caption}</p>
        </motion.div>

        {/* the figures, one row, no boxes */}
        <motion.ul {...enter(1)} className="mx-auto mt-24 grid max-w-[64rem] grid-cols-2 gap-x-8 gap-y-12 md:mt-32 md:grid-cols-5" aria-label={t.proof.ariaLabel}>
          {STATS.map((s, i) => (
            <li key={s.value} className={`text-center ${i === STATS.length - 1 ? "col-span-2 md:col-span-1" : ""}`}>
              <span className={`reading block ${s.value.length > 5 ? "whitespace-nowrap text-[1.6rem] md:text-[1.9rem]" : "text-[2.1rem] md:text-[2.5rem]"}`}>
                <CountUp value={s.value} />
              </span>
              <span className="label mt-4 block">{t.proof.stats[i]!.label}</span>
            </li>
          ))}
        </motion.ul>
      </div>
    </section>
  );
}
