import { ArrowUpRight } from "lucide-react";
import { CopyCommand } from "@/components/CopyCommand";
import { PetSpot } from "@/components/PetSpot";
import { Reveal } from "@/components/Motion";
import { useT } from "@/i18n";
import { INSTALL, REPO } from "@/content";

/** the close: the same centred measure on the same mist as the opening — one line, the install command, one
 *  filled button, the mascot small underneath */
export function Cta({ n }: { n: string }) {
  const t = useT();
  return (
    <section id="get" className="mist section-pad relative" aria-labelledby="cta-title">
      <div className="mx-auto w-full max-w-[1200px] px-6 md:px-10">
        <Reveal className="mx-auto max-w-[40rem] text-center">
          <p className="chip label px-3.5 py-1.5 !tracking-[0.1em]">
            <span className="text-text">{n}</span>
            <span aria-hidden className="size-1 rounded-full bg-mist" />
            {t.cta.eyebrow}
          </p>
          <h2 id="cta-title" className="h2 mt-6">{t.cta.title}</h2>
          <div className="mx-auto mt-10 flex max-w-[34rem] flex-col items-center gap-5">
            <CopyCommand command={INSTALL} wrap className="w-full" />
            <a href={REPO} target="_blank" rel="noreferrer" className="button-fill group h-11 px-5 text-[14px]">
              {t.cta.button}
              <ArrowUpRight className="size-4 transition-transform duration-150 group-hover:-translate-y-0.5 group-hover:translate-x-0.5 rtl:-scale-x-100" aria-hidden />
            </a>
          </div>
          <div className="mt-14 flex justify-center">
            <PetSpot pose="done" size="sm" labelled />
          </div>
        </Reveal>
      </div>
    </section>
  );
}
