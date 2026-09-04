import { Fragment } from "react";
import { ArrowUpRight } from "lucide-react";
import { CopyCommand } from "@/components/CopyCommand";
import { CountUp } from "@/components/CountUp";
import { Device } from "@/components/Device";
import { useT } from "@/i18n";
import { HERO, README, REPO, STATS, USAGE } from "@/content";

/** the headline split into words so the marked word (between *asterisks* in every locale) can be set in the accent */
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

/** The opening, on the mist: a pill of small facts, the headline with its one marked word, one sentence, the
 *  command and two buttons — centred in a narrow measure. Under it the real frame in a full-width white card,
 *  then the repository's figures as five pills. */
export function Hero() {
  const t = useT();
  const line = words(t.hero.title);

  return (
    <section id="top" className="mist relative" aria-labelledby="hero-title">
      <div className="mx-auto w-full max-w-[1200px] px-6 pt-[calc(var(--header-h)+4.5rem)] md:px-10 md:pt-[calc(var(--header-h)+7rem)]">
        <div className="mx-auto max-w-[44rem] text-center">
          <ul className="flex flex-wrap items-center justify-center gap-2">
            {t.ui.facts.map((f) => (
              <li key={f} className="chip label px-3 py-1.5 !tracking-[0.1em]">{f}</li>
            ))}
          </ul>

          <h1 id="hero-title" className="display mx-auto mt-8 max-w-[22ch] text-[2.4rem] md:text-[3.5rem]">
            {line.map((w, i) => (
              <Fragment key={i}>
                {w.segs.map((s, j) => (s.marked ? <span key={j} className="text-brand">{s.text}</span> : <Fragment key={j}>{s.text}</Fragment>))}
                {w.space ? " " : ""}
              </Fragment>
            ))}
          </h1>

          <p className="mx-auto mt-7 max-w-[34rem] text-[17px] leading-[1.7] text-text-muted">
            {t.hero.sub}
          </p>

          <div className="mx-auto mt-9 flex max-w-[30rem] flex-col items-center gap-5">
            <CopyCommand command={USAGE} wrap className="w-full" />
            <div className="flex flex-wrap items-center justify-center gap-3 text-[14px]">
              <a href={REPO} target="_blank" rel="noreferrer" className="button-fill group h-11 px-5">
                {t.hero.ctaGithub}
                <ArrowUpRight className="size-4 transition-transform duration-150 group-hover:-translate-y-0.5 group-hover:translate-x-0.5 rtl:-scale-x-100" aria-hidden />
              </a>
              <a href={README} target="_blank" rel="noreferrer" className="button-line group h-11 px-5">
                {t.hero.ctaReadme}
                <ArrowUpRight className="size-4 text-text-muted transition-transform duration-150 group-hover:-translate-y-0.5 group-hover:translate-x-0.5 rtl:-scale-x-100" aria-hidden />
              </a>
            </div>
          </div>
        </div>

        {/* the frame, in a full-width white card */}
        <div className="mt-16 md:mt-20">
          <Device src={HERO.frame} alt={t.hero.frameAlt} title="rovecode · atlas · feature/auth" meta="sextant · night · 160×44" chips={t.hero.chips.map((text) => ({ text }))} />
          <p className="mx-auto mt-6 max-w-[46rem] text-center text-[13.5px] leading-6 text-text-faint">{t.hero.caption}</p>
        </div>

        {/* the figures as pills */}
        <ul className="mx-auto mt-14 flex flex-wrap items-center justify-center gap-3 md:mt-16" aria-label={t.proof.ariaLabel}>
          {STATS.map((s, i) => (
            <li key={s.value} className="chip h-11 px-4 text-[13.5px]">
              <span aria-hidden className="size-2 rounded-full border-[1.5px] border-brand-soft" />
              <span className="reading text-[15px] tabular-nums"><CountUp value={s.value} /></span>
              <span className="font-sans text-text-muted">{t.proof.stats[i]!.label}</span>
            </li>
          ))}
        </ul>
      </div>
      <div aria-hidden className="h-16 md:h-24" />
    </section>
  );
}
