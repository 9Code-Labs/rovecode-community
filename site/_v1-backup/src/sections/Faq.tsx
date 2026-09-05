import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Reveal } from "@/components/Motion";
import { Section } from "@/components/Section";
import { FAQ } from "@/content";

export function Faq() {
  return (
    <Section
      id="faq"
      n="08"
      eyebrow="faq"
      title="Objections, answered with specifics."
      lead="Seven questions people ask before they trust an agent with a shell. Each answer names the mechanism and where it stops."
    >
      <div className="grid gap-8 lg:grid-cols-12">
        <Reveal className="lg:col-span-4">
          <p className="mono text-xs leading-6 text-text-faint">
            Everything here is lifted from README.md sections Safety model, Known limitations, Observability and License &amp; notices. Where the README says a limit exists, so does this page.
          </p>
        </Reveal>
        <Reveal className="lg:col-span-8">
          <Accordion type="single" collapsible defaultValue="faq-0">
            {FAQ.map((f, i) => (
              <AccordionItem key={f.q} value={`faq-${i}`} className="border-border">
                <AccordionTrigger className="items-center gap-4 py-5 text-left text-[1.1rem] font-[450] leading-snug hover:no-underline md:text-[1.2rem] [&>svg]:size-5 [&>svg]:text-text-muted">
                  <span className="flex items-baseline gap-4">
                    <span className="mono text-xs text-brand">{String(i + 1).padStart(2, "0")}</span>
                    {f.q}
                  </span>
                </AccordionTrigger>
                <AccordionContent className="pb-6 pl-9 text-[16px] leading-[1.65] text-text-muted">{f.a}</AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        </Reveal>
      </div>
    </Section>
  );
}
