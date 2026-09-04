import { Reveal } from "@/components/Motion";
import { Section } from "@/components/Section";
import { Transcript } from "@/components/Transcript";
import { useT } from "@/i18n";

/** the frame itself sits in the hero; this section shows its messages panel row for row inside a white card and
 *  explains it beside */
export function Cockpit({ n }: { n: string }) {
  const t = useT();
  return (
    <Section id="cockpit" n={n} eyebrow={t.cockpit.eyebrow} title={t.cockpit.title} lead={t.cockpit.lead} headMax="max-w-[52rem]">
      <div className="grid gap-8 lg:grid-cols-12 lg:items-start lg:gap-10">
        <Reveal className="panel p-2 lg:col-span-7 md:p-3">
          <Transcript />
        </Reveal>
        <Reveal className="lg:col-span-5 lg:pt-4" delay={0.1}>
          <p className="label">{t.cockpit.transcriptEyebrow}</p>
          <h3 className="mt-3 text-[1.5rem] leading-snug md:text-[1.75rem]">{t.cockpit.transcriptTitle}</h3>
          <p className="mt-5 text-[16px] leading-7 text-text-muted">{t.cockpit.transcriptBody1}</p>
          <p className="mt-3 text-[16px] leading-7 text-text-muted">{t.cockpit.transcriptBody2}</p>
        </Reveal>
      </div>
    </Section>
  );
}
