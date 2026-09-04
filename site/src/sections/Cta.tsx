import { ArrowUpRight } from "lucide-react";
import { CopyCommand } from "@/components/CopyCommand";
import { PetSpot } from "@/components/PetSpot";
import { Reveal } from "@/components/Motion";
import { useT } from "@/i18n";
import { INSTALL, REPO } from "@/content";

/** the close: the same quiet centre as the opening — one line, the install command, one link */
export function Cta({ n }: { n: string }) {
  const t = useT();
  return (
    <section id="get" className="section-pad relative" aria-labelledby="cta-title">
      <div className="mx-auto w-full max-w-[1200px] px-6 md:px-10">
        <Reveal className="mx-auto max-w-[40rem] text-center">
          <p className="label mb-6">
            <span className="text-text-muted">{n}</span>
            <span className="mx-3 text-border-strong">/</span>
            {t.cta.eyebrow}
          </p>
          <h2 id="cta-title" className="h2">{t.cta.title}</h2>
          <div className="mx-auto mt-10 flex max-w-[34rem] flex-col items-center gap-5">
            <CopyCommand command={INSTALL} wrap className="w-full" />
            <a href={REPO} target="_blank" rel="noreferrer" className="group inline-flex items-center gap-1 text-[14px] text-text transition-colors duration-150 hover:text-brand">
              {t.cta.button}
              <ArrowUpRight className="size-3.5 transition-transform duration-150 group-hover:-translate-y-0.5 group-hover:translate-x-0.5 rtl:-scale-x-100" aria-hidden />
            </a>
          </div>
          <div className="mt-16 flex justify-center">
            <PetSpot pose="done" size="sm" labelled />
          </div>
        </Reveal>
      </div>
    </section>
  );
}
