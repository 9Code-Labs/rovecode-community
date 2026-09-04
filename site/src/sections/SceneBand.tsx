import { Reveal } from "@/components/Motion";
import { PetSpot } from "@/components/PetSpot";
import { useT } from "@/i18n";

/** one sentence in a white card, the mascot small beside it — its one appearance above the fold's end */
export function SceneBand() {
  const t = useT();
  return (
    <section aria-label={t.footer.blurb} className="relative py-6 md:py-10">
      <div className="mx-auto w-full max-w-[1200px] px-6 md:px-10">
        <Reveal className="panel mx-auto flex max-w-[44rem] items-center gap-6 px-6 py-6 md:gap-8 md:px-8 md:py-7">
          <PetSpot pose="done" size="md" className="shrink-0" />
          <p className="display text-[1.25rem] leading-[1.35] text-text md:text-[1.5rem]">{t.footer.blurb}</p>
        </Reveal>
      </div>
    </section>
  );
}
