import { ArrowUpRight } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { EASE } from "@/components/Motion";
import { CopyCommand } from "@/components/CopyCommand";
import { Device } from "@/components/Device";
import { GitHubMark } from "@/components/GitHubMark";
import { LightField } from "@/components/LightField";
import { HERO, INSTALL, README, REPO, USAGE } from "@/content";

const BADGES = ["open source", "AGPL-3.0", "v0.2.0", "Bun ≥ 1.3.14", "TypeScript"] as const;

export function Hero() {
  const reduce = useReducedMotion();
  const enter = (delay: number) => (reduce ? {} : { initial: { opacity: 0, y: 16 }, animate: { opacity: 1, y: 0 }, transition: { duration: 0.7, ease: EASE, delay } });
  return (
    <section id="top" className="relative overflow-x-clip pt-10 pb-12 md:pt-16 md:pb-20" aria-labelledby="hero-title">
      <LightField className="left-1/2 top-[40%] -translate-x-1/2" size={1500} strength={0.22} />
      <LightField className="-right-40 top-[2%]" size={760} strength={0.12} />
      <div className="relative mx-auto w-full max-w-[1200px] px-5 md:px-8">
        <motion.ul {...enter(0)} className="mb-8 flex flex-wrap gap-2" aria-label="Project facts">
          {BADGES.map((b) => (
            <li key={b} className="glass-pill mono whitespace-nowrap px-3 py-1 text-xs text-text-muted">{b}</li>
          ))}
        </motion.ul>
        <motion.h1
          {...enter(0.05)}
          id="hero-title"
          className="max-w-[17ch] text-[2.75rem] leading-[1.02] tracking-[-0.02em] md:text-[4.25rem] lg:text-[5rem]"
        >
          {HERO.title}
        </motion.h1>
        <motion.p {...enter(0.12)} className="lead mt-7 max-w-[40rem]">
          {HERO.sub}
        </motion.p>

        <motion.div {...enter(0.2)} className="mt-9 grid gap-3 lg:grid-cols-12">
          <div className="grid min-w-0 gap-2 lg:col-span-8">
            <CopyCommand command={INSTALL} wrap />
            <CopyCommand command={USAGE} size="sm" className="max-w-[26rem]" />
          </div>
          <div className="flex min-w-0 flex-wrap items-center gap-x-5 gap-y-3 lg:col-span-4 lg:justify-end lg:self-start">
            <a
              href={REPO}
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-12 items-center gap-2.5 rounded-pill bg-brand pl-5 pr-6 text-[15px] font-medium text-on-brand shadow-[0_12px_32px_rgba(92,184,255,0.25)] transition-[background-color,transform,box-shadow] duration-150 hover:bg-brand-hover hover:shadow-[0_16px_40px_rgba(92,184,255,0.32)] active:scale-[0.98]"
            >
              <GitHubMark className="size-[18px]" />
              View on GitHub
            </a>
            <a href={README} target="_blank" rel="noreferrer" className="group inline-flex items-center gap-1 rounded-pill text-[15px] text-text-muted transition-colors duration-150 hover:text-text">
              Read the README
              <ArrowUpRight className="size-4 transition-transform duration-150 group-hover:-translate-y-0.5 group-hover:translate-x-0.5" aria-hidden />
            </a>
          </div>
        </motion.div>

        <div className="mt-14 md:mt-20 lg:px-6">
          <Device
            src={HERO.frame}
            alt={HERO.frameAlt}
            title="nimbus · atlas · feature/auth"
            meta="sextant · night · 160×44"
            chips={HERO.chips}
            quip={HERO.quip}
            mood={HERO.mood}
          />
          <p className="mono mt-8 text-xs leading-5 text-text-faint lg:mt-10">{HERO.caption}</p>
        </div>
      </div>
    </section>
  );
}
