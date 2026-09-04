import { Reveal } from "@/components/Motion";
import { PetSpot } from "@/components/PetSpot";
import { useT } from "@/i18n";

/** one sentence in a lot of air, the mascot small beside it — its one appearance above the fold's end */
export function SceneBand() {
  const t = useT();
  return (
    <section aria-label={t.footer.blurb} className="relative py-16 md:py-24">
      <div className="mx-auto w-full max-w-[1200px] px-6 md:px-10">
        <Reveal className="mx-auto flex max-w-[40rem] items-center gap-6 md:gap-8">
          <PetSpot pose="done" size="md" className="shrink-0" />
          <p className="display text-[1.35rem] leading-[1.4] text-text md:text-[1.7rem]">{t.footer.blurb}</p>
        </Reveal>
      </div>
    </section>
  );
}
