import { Reveal } from "@/components/Motion";
import { Section } from "@/components/Section";
import { Shot } from "@/components/Shot";
import { useT } from "@/i18n";
import { SHOTS } from "@/content";

export function Terminal({ n }: { n: string }) {
  const t = useT();
  return (
    <Section id="terminal" n={n} eyebrow={t.terminal.eyebrow} title={t.terminal.title} lead={t.terminal.lead} headMax="max-w-[52rem]">
      <div className="grid gap-20 md:gap-28">
        {SHOTS.map((s, i) => (
          <Reveal key={s.file}>
            <Shot
              file={s.file}
              alt={t.terminal.shots[i]!.alt}
              title={t.terminal.shots[i]!.title}
              lead={t.terminal.shots[i]!.lead}
              callouts={s.callouts.map((c, k) => ({ ...c, text: t.terminal.shots[i]!.callouts[k]! }))}
              index={i}
              flip={i % 2 === 1}
            />
          </Reveal>
        ))}
      </div>
    </Section>
  );
}
