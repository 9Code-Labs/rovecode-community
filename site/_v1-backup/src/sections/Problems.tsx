import { ArrowRight } from "lucide-react";
import { CodeCard } from "@/components/CodeCard";
import { Glass } from "@/components/Glass";
import { Item, Stagger } from "@/components/Motion";
import { Section } from "@/components/Section";
import { PROBLEMS, PROVIDERS_JSON, PROVIDERS_JSON_HL, type Visual } from "@/content";

function Strip({ v }: { v: Visual }) {
  if (v.kind === "code") {
    return <CodeCard file="~/.cumulus/providers.json" lines={PROVIDERS_JSON.slice(0, 8)} highlight={PROVIDERS_JSON_HL} size="sm" className="h-[190px] overflow-hidden" />;
  }
  return (
    <div className="glass-2 h-[190px] overflow-hidden rounded-[16px]">
      <img src={v.src} alt={v.alt} loading="lazy" decoding="async" className="h-full w-full object-cover" style={{ objectPosition: v.position ?? "center" }} />
    </div>
  );
}

export function Problems() {
  return (
    <Section
      id="problems"
      n="03"
      eyebrow="problems → solutions"
      title="Four things that go wrong with terminal agents, and what nimbus does about each."
      lead="Stated in the words you would use at the keyboard, answered with the mechanism and its limit. Every strip is a real frame crop or the real config file."
    >
      <Stagger as="ol" className="grid gap-4 md:grid-cols-2">
        {PROBLEMS.map((p) => (
          <Item as="li" key={p.n}>
            <Glass hover pad="none" className="flex h-full flex-col overflow-hidden">
              <div className="p-2.5 pb-0"><Strip v={p.visual} /></div>
              <div className="flex flex-1 flex-col p-6 md:p-7">
                <div className="flex items-center justify-between">
                  <span className="mono text-sm text-brand">{p.n}</span>
                  <span className="eyebrow">problem</span>
                </div>
                <p className="mt-3 text-[1.2rem] leading-snug text-text md:text-[1.3rem]">{p.problem}</p>
                <div className="mt-5 flex items-center gap-2 text-text-faint">
                  <ArrowRight className="size-4" aria-hidden />
                  <span className="eyebrow">what nimbus does</span>
                </div>
                <p className="mt-2.5 flex-1 text-[15px] leading-7 text-text-muted">{p.solution}</p>
                <code className="mono mt-5 block truncate rounded-[12px] border border-border bg-black/25 px-3 py-2 text-xs text-text-muted">{p.snippet}</code>
              </div>
            </Glass>
          </Item>
        ))}
      </Stagger>
    </Section>
  );
}
