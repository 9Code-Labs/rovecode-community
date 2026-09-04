import { CodeCard } from "@/components/CodeCard";
import { CopyCommand } from "@/components/CopyCommand";
import { Item, Reveal, Stagger } from "@/components/Motion";
import { Section } from "@/components/Section";
import { useT } from "@/i18n";
import { PROVIDERS_HOSTED, PROVIDERS_JSON, PROVIDERS_JSON_HL, PROVIDERS_LOCAL } from "@/content";

/** sixteen names set as text in a quiet grid; the live-registry example beside them */
export function Providers({ n }: { n: string }) {
  const t = useT();
  const code = (s: string) => <code className="mono text-[0.92em] text-text" dir="ltr">{s}</code>;
  return (
    <Section
      id="providers"
      n={n}
      eyebrow={t.providers.eyebrow}
      title={t.providers.title}
      lead={<>{t.providers.leadA}{code("<NAME>_API_KEY")}{t.providers.leadB}{code("ROVECODE_BASE_URL")} / {code("ROVECODE_API_KEY")}{t.providers.leadC}</>}
      shift
    >
      <div className="grid gap-16 lg:grid-cols-12 lg:gap-12">
        <div className="lg:col-span-7">
          <div className="flex items-baseline justify-between gap-6">
            <p className="label">{t.providers.hosted} · {PROVIDERS_HOSTED.length}</p>
            <p className="label">{t.providers.local} · {PROVIDERS_LOCAL.length}</p>
          </div>
          <Stagger as="ul" className="mt-8 grid grid-cols-2 gap-x-8 gap-y-4 sm:grid-cols-4">
            {[...PROVIDERS_HOSTED, ...PROVIDERS_LOCAL].map((p, i) => (
              <Item as="li" key={p}>
                <span className={`mono block text-[14px] ${i >= PROVIDERS_HOSTED.length ? "text-text-muted" : "text-text"}`} dir="ltr">{p}</span>
              </Item>
            ))}
          </Stagger>
          <p className="mt-10 max-w-[30rem] text-[13.5px] leading-6 text-text-muted">{t.providers.keyNote}</p>
        </div>
        <Reveal className="lg:col-span-5">
          <p className="label">{t.providers.liveLabel}</p>
          <h3 className="mt-3 text-[1.1rem] leading-snug">{t.providers.liveTitle}</h3>
          <CopyCommand command="rovecode provider add homelab http://10.0.0.7:8000/v1 --no-key" size="sm" wrap className="mt-5" />
          <CodeCard file="~/.rovecode/providers.json" lines={PROVIDERS_JSON} highlight={PROVIDERS_JSON_HL} size="sm" className="mt-3" />
        </Reveal>
      </div>
    </Section>
  );
}
