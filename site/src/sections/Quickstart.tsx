import { CopyCommand } from "@/components/CopyCommand";
import { Pic } from "@/components/Pic";
import { Item, Stagger } from "@/components/Motion";
import { Section } from "@/components/Section";
import { useT } from "@/i18n";
import { STEPS } from "@/content";

/** the steps, each in its own white card: a numbered pill, title and sentence on the left, the command(s) and the
 *  real output on the right */
export function Quickstart({ n }: { n: string }) {
  const t = useT();
  return (
    <Section id="quickstart" n={n} eyebrow={t.quickstart.eyebrow} title={t.quickstart.title} lead={t.quickstart.lead}>
      <Stagger as="ol" className="grid gap-6">
        {STEPS.map((s, i) => (
          <Item as="li" key={s.n} className="panel panel-hover">
            <div className="grid gap-5 p-6 md:grid-cols-12 md:gap-8 md:p-8">
              <div className="flex items-start gap-4 md:col-span-5">
                <span className="chip size-9 shrink-0 justify-center text-xs text-text">{s.n}</span>
                <div className="min-w-0">
                  <h3 className="text-[1.2rem] leading-snug">{t.quickstart.steps[i]!.title}</h3>
                  <p className="mt-2 text-[14.5px] leading-6 text-text-muted">{t.quickstart.steps[i]!.body}</p>
                </div>
              </div>
              <div className="grid content-start gap-2 md:col-span-7">
                <CopyCommand command={s.cmd} size="sm" wrap tone="tint" />
                {"alt" in s && s.alt && (
                  <div className="flex items-center gap-3">
                    <span className="mono shrink-0 text-[11px] text-text-faint">{t.ui.or}</span>
                    <CopyCommand command={s.alt} size="sm" wrap tone="tint" className="flex-1" />
                  </div>
                )}
                {"output" in s && s.output && (
                  <div className="panel-2 mt-1 overflow-hidden">
                    <div className="flex items-center border-b border-border/70 px-4 py-2">
                      <span className="mono text-[11px] text-text-muted" dir="ltr">{t.quickstart.runLabel}</span>
                    </div>
                    <Pic src={s.output.src} alt={t.quickstart.outputAlt} width={1374} height={170} loading="lazy" decoding="async" className="block w-full" />
                  </div>
                )}
              </div>
            </div>
          </Item>
        ))}
      </Stagger>
    </Section>
  );
}
