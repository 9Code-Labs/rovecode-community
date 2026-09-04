import { Item, Stagger } from "@/components/Motion";
import { Section } from "@/components/Section";
import { useT } from "@/i18n";
import { LADDER } from "@/content";

/** the safety model as four quiet rows — layer, what it decides, where it stops — then six deployment facts.
 *  No table chrome: alignment does the work. Every line is from the README. */
export function Security({ n }: { n: string }) {
  const t = useT();
  return (
    <Section id="security" n={n} eyebrow={t.security.eyebrow} title={t.security.title} lead={t.security.lead} headMax="max-w-[44rem]">
      <div className="hidden grid-cols-12 gap-8 md:grid">
        {t.security.cols.map((c, i) => (
          <p key={c} className={`label ${i === 0 ? "col-span-2" : "col-span-5"}`}>{c}</p>
        ))}
      </div>
      <Stagger as="ol" className="mt-6 grid gap-12 md:gap-14">
        {t.security.layers.map((l, i) => (
          <Item as="li" key={l.name} className="grid gap-3 md:grid-cols-12 md:gap-8">
            <div className="md:col-span-2">
              <p className="label md:hidden">{t.security.cols[0]} {String(i + 1).padStart(2, "0")}</p>
              <code className="mono mt-1 block text-[15px] text-text md:mt-0">
                <span className="text-text-faint">{String(i + 1).padStart(2, "0")}</span>&nbsp;&nbsp;{LADDER[i]}
              </code>
            </div>
            <p className="text-[15px] leading-7 text-text md:col-span-5">{l.decides}</p>
            <p className="text-[15px] leading-7 text-text-muted md:col-span-5">
              <span className="label mr-3 md:hidden">{t.security.cols[2]}</span>
              {l.limit}
            </p>
          </Item>
        ))}
      </Stagger>

      <p className="label mt-28 mb-10 md:ml-[50%]">{t.security.deployLabel}</p>
      <Stagger as="ul" className="grid gap-x-12 gap-y-12 sm:grid-cols-2 lg:grid-cols-3">
        {t.security.deploy.map((d, k) => (
          <Item as="li" key={d.title}>
            <p className="label">{String(k + 1).padStart(2, "0")}</p>
            <h3 className="mt-3 text-[1.05rem] leading-snug">{d.title}</h3>
            <p className="mt-2.5 text-[14.5px] leading-6 text-text-muted">{d.body}</p>
          </Item>
        ))}
      </Stagger>
    </Section>
  );
}
