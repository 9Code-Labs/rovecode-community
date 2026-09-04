import { CodeCard } from "@/components/CodeCard";
import { Item, Reveal, Stagger } from "@/components/Motion";
import { Section } from "@/components/Section";
import { useT } from "@/i18n";
import { BENTO_MEDIUM, BENTO_SMALL, LADDER, PROVIDERS_JSON, PROVIDERS_JSON_HL } from "@/content";

/** ten capabilities as a quiet index: two lead entries with their evidence, then eight lines in three columns.
 *  No tiles, no glyph plates — a title, a sentence, a tag. */
export function Capabilities({ n }: { n: string }) {
  const t = useT();
  return (
    <Section id="capabilities" n={n} eyebrow={t.capabilities.eyebrow} title={t.capabilities.title} lead={t.capabilities.lead} shift>
      <div className="grid gap-16 lg:grid-cols-2 lg:gap-20">
        <Reveal>
          <p className="label">{t.capabilities.surfaceLabel}</p>
          <h3 className="mt-4 text-[1.25rem] leading-snug">{t.capabilities.surfaceTitle}</h3>
          <p className="mt-3 max-w-[30rem] text-[15px] leading-7 text-text-muted">{t.capabilities.surfaceBody}</p>
          <code className="mono mt-4 block text-[12px] text-text-faint" dir="ltr">rovecode · ROVECODE_TUI=sextant|classic · /theme night|ember|contrast</code>
          <div className="panel-2 mt-8 h-[260px] overflow-hidden">
            <img src="/shots/crops/cockpit.png" alt={t.capabilities.surfaceAlt} width={1942} height={1020} loading="lazy" decoding="async" className="h-full w-full object-cover object-left-top" />
          </div>
        </Reveal>
        <Reveal delay={0.1}>
          <p className="label">{t.capabilities.providersLabel}</p>
          <h3 className="mt-4 text-[1.25rem] leading-snug">{t.capabilities.providersTitle}</h3>
          <p className="mt-3 max-w-[30rem] text-[15px] leading-7 text-text-muted">{t.capabilities.providersBody}</p>
          <code className="mono mt-4 block text-[12px] text-text-faint" dir="ltr">rovecode provider add|list|test · rovecode model use provider/model</code>
          <CodeCard file="~/.rovecode/providers.json" lines={PROVIDERS_JSON} highlight={PROVIDERS_JSON_HL} size="sm" className="mt-8" />
        </Reveal>
      </div>

      <Stagger as="ul" className="mt-24 grid gap-x-12 gap-y-14 sm:grid-cols-2 lg:grid-cols-3">
        {BENTO_MEDIUM.map((tile, i) => (
          <Item as="li" key={tile.glyph + i}>
            <p className="label">{t.capabilities.mediumLabels[i]}</p>
            <h3 className="mt-3 text-[1.05rem] leading-snug">{t.capabilities.medium[i]!.title}</h3>
            <p className="mt-2.5 text-[14.5px] leading-6 text-text-muted">{t.capabilities.medium[i]!.body}</p>
            {i === 1 ? (
              <p className="mono mt-4 text-[12px] text-text-faint" dir="ltr">{LADDER.join(" → ")}</p>
            ) : (
              <code className="mono mt-4 block truncate text-[12px] text-text-faint" dir="ltr">{tile.tag}</code>
            )}
          </Item>
        ))}
        {BENTO_SMALL.map((tile, i) => (
          <Item as="li" key={tile.tag}>
            <h3 className="text-[1.05rem] leading-snug">{t.capabilities.small[i]!.title}</h3>
            <p className="mt-2.5 text-[14.5px] leading-6 text-text-muted">{t.capabilities.small[i]!.body}</p>
            <code className="mono mt-4 block truncate text-[12px] text-text-faint" dir="ltr">{tile.tag}</code>
          </Item>
        ))}
      </Stagger>
    </Section>
  );
}
