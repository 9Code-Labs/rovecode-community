import { CountUp } from "@/components/CountUp";
import { Station } from "@/components/Chart";
import { Item, Stagger } from "@/components/Motion";
import { useT } from "@/i18n";
import { STATS } from "@/content";

/** five readings from the repository, plotted as weather stations: a circle, the figure, the station name and its
 *  note. Alternate rows sit lower, the way plotted stations scatter across a chart rather than line up. */
export function Proof({ n }: { n: string }) {
  const t = useT();
  return (
    <section id="proof" className="relative pb-8 pt-16 md:pb-14 md:pt-24" aria-label={t.proof.ariaLabel}>
      <div className="mx-auto w-full max-w-[1200px] px-5 md:px-8">
        <p className="label mb-10 flex items-center gap-3 md:ml-[8%]">
          <Station tone="front" size={12} />
          <span className="text-front">{n}</span>
          <span>{t.proof.eyebrow}</span>
        </p>
        <Stagger as="ul" className="grid grid-cols-2 gap-x-6 gap-y-10 md:grid-cols-3 lg:grid-cols-5">
          {STATS.map((s, i) => (
            <Item as="li" key={s.value} className={`${i % 2 === 1 ? "lg:mt-14" : ""} ${i === STATS.length - 1 ? "col-span-2 md:col-span-1" : ""}`}>
              <div className="flex items-start gap-3">
                <Station tone={i === 0 ? "front" : "ink"} size={12} className="mt-3" />
                <div>
                  <span className={`reading block text-text ${s.value.length > 5 ? "whitespace-nowrap text-[1.9rem] md:text-[2.3rem]" : "text-[2.6rem] md:text-[3.1rem]"}`}>
                    <CountUp value={s.value} />
                  </span>
                  <span className="label mt-3 block !text-text">{t.proof.stats[i]!.label}</span>
                  <span className="mt-1.5 block text-[13px] leading-5 text-text-muted">{t.proof.stats[i]!.note}</span>
                </div>
              </div>
            </Item>
          ))}
        </Stagger>
      </div>
    </section>
  );
}
