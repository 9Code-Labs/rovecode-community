import { Glass } from "@/components/Glass";
import { Item, Reveal, Stagger } from "@/components/Motion";
import { STATS } from "@/content";

export function Proof() {
  return (
    <section id="proof" className="py-6 md:py-10" aria-label="Numbers from the repository">
      <div className="mx-auto w-full max-w-[1200px] px-5 md:px-8">
        <Reveal>
          <p className="eyebrow mb-4 flex items-center gap-3">
            <span className="text-brand">02</span>
            <span aria-hidden className="h-px w-6 bg-border-strong" />
            from the repository, 2026-09-02
          </p>
        </Reveal>
        <Stagger as="ul" className="grid grid-cols-2 gap-3 lg:grid-cols-5">
          {STATS.map((s) => (
            <Item as="li" key={s.label}>
              <Glass hover pad="sm" className="flex h-full flex-col justify-between gap-5 md:p-5">
                <span className={s.value.length > 5 ? "whitespace-nowrap text-[1.6rem] leading-none tracking-tight md:text-[2.1rem]" : "text-[2.2rem] leading-none tracking-tight md:text-[2.75rem]"}>{s.value}</span>
                <span>
                  <span className="block text-[15px] text-text">{s.label}</span>
                  <span className="mono mt-1 block text-[11px] leading-4 text-text-faint">{s.note}</span>
                </span>
              </Glass>
            </Item>
          ))}
        </Stagger>
      </div>
    </section>
  );
}
