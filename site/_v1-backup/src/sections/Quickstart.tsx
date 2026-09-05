import { CopyCommand } from "@/components/CopyCommand";
import { Glass } from "@/components/Glass";
import { Item, Stagger } from "@/components/Motion";
import { Section } from "@/components/Section";
import { STEPS } from "@/content";

export function Quickstart() {
  return (
    <Section
      id="quickstart"
      n="06"
      eyebrow="quickstart"
      title="Three commands from clone to a running agent."
      lead="Without a provider configured, one-shot runs use a scripted mock provider, which is also how the packaging smoke works."
    >
      <Glass pad="none" className="overflow-hidden">
        <Stagger as="ol" className="relative">
          <span aria-hidden className="absolute bottom-10 left-[2.15rem] top-10 hidden w-px bg-gradient-to-b from-brand/50 via-border-strong to-border md:block" />
          {STEPS.map((s, i) => (
            <Item as="li" key={s.n} className={i > 0 ? "border-t border-border" : ""}>
              <div className="grid gap-5 p-6 md:grid-cols-12 md:gap-8 md:p-8">
                <div className="flex items-start gap-4 md:col-span-5">
                  <span className="glass-pill mono relative z-10 inline-flex size-9 shrink-0 items-center justify-center text-xs text-brand">{s.n}</span>
                  <div>
                    <h3 className="text-[1.2rem] font-[450] leading-snug tracking-normal">{s.title}</h3>
                    <p className="mt-2 text-[14.5px] leading-6 text-text-muted">{s.body}</p>
                  </div>
                </div>
                <div className="grid content-start gap-2 md:col-span-7">
                  <CopyCommand command={s.cmd} size="sm" wrap />
                  {"alt" in s && s.alt && (
                    <div className="flex items-center gap-3">
                      <span className="mono shrink-0 text-[11px] text-text-faint">or</span>
                      <CopyCommand command={s.alt} size="sm" className="flex-1" />
                    </div>
                  )}
                  {"output" in s && s.output && (
                    <div className="glass-2 mt-1 overflow-hidden rounded-[14px]">
                      <div className="flex items-center gap-2 border-b border-border px-3.5 py-1.5">
                        <span aria-hidden className="size-1.5 rounded-full bg-white/[0.18]" />
                        <span className="mono text-[11px] text-text-muted">$ run · exit 0</span>
                      </div>
                      <img src={s.output.src} alt={s.output.alt} loading="lazy" decoding="async" className="block w-full" />
                    </div>
                  )}
                </div>
              </div>
            </Item>
          ))}
        </Stagger>
      </Glass>
    </Section>
  );
}
