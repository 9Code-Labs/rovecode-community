import { Reveal } from "@/components/Motion";
import { Section } from "@/components/Section";
import { Transcript } from "@/components/Transcript";
import { useT } from "@/i18n";

/** the frame itself sits in the hero; this section replays its messages panel row for row and explains it */
export function Cockpit({ n }: { n: string }) {
  const t = useT();
  return (
    <Section id="cockpit" n={n} eyebrow={t.cockpit.eyebrow} title={t.cockpit.title} lead={t.cockpit.lead} headMax="max-w-[52rem]">
      <div className="grid gap-8 lg:grid-cols-12 lg:items-start lg:gap-10">
        <Reveal className="lg:col-span-7">
          <Transcript />
        </Reveal>
        <Reveal className="lg:col-span-5" delay={0.1}>
          <div className="flex items-start gap-4">
            <div>
              <p className="label">{t.cockpit.transcriptEyebrow}</p>
              <h3 className="mt-3 text-[1.5rem] leading-snug md:text-[1.75rem]">{t.cockpit.transcriptTitle}</h3>
            </div>
          </div>
          <p className="mt-5 text-[16px] leading-7 text-text-muted">{t.cockpit.transcriptBody1}</p>
          <p className="mt-3 text-[16px] leading-7 text-text-muted">{t.cockpit.transcriptBody2}</p>
        </Reveal>
      </div>
    </Section>
  );
}
