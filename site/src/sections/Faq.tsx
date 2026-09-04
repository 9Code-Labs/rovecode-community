import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Reveal } from "@/components/Motion";
import { Section } from "@/components/Section";
import { useT } from "@/i18n";

/** the questions in one white card, the aside beside it */
export function Faq({ n }: { n: string }) {
  const t = useT();
  return (
    <Section id="faq" n={n} eyebrow={t.faq.eyebrow} title={t.faq.title} lead={t.faq.lead}>
      <div className="grid gap-6 lg:grid-cols-12">
        <Reveal className="lg:col-span-4">
          <p className="mono text-xs leading-6 text-text-faint">{t.faq.aside}</p>
        </Reveal>
        <Reveal className="panel px-6 py-2 lg:col-span-8 md:px-8">
          <Accordion type="single" collapsible defaultValue="faq-0">
            {t.faq.items.map((f, i) => (
              <AccordionItem key={f.q} value={`faq-${i}`} className="border-border">
                <AccordionTrigger className="items-center gap-4 py-5 text-left text-[1.05rem] font-semibold leading-snug hover:no-underline md:text-[1.15rem] [&>svg]:size-5 [&>svg]:text-text-muted rtl:text-right">
                  <span className="flex items-baseline gap-4">
                    <span className="chip size-7 shrink-0 translate-y-1 justify-center text-[11px] text-text">{String(i + 1).padStart(2, "0")}</span>
                    {f.q}
                  </span>
                </AccordionTrigger>
                <AccordionContent className="pb-6 ps-11 text-[16px] leading-[1.65] text-text-muted">{f.a}</AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        </Reveal>
      </div>
    </Section>
  );
}
