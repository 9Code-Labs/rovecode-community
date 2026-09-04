import { CodeCard } from "@/components/CodeCard";
import { Pic } from "@/components/Pic";
import { Item, Stagger } from "@/components/Motion";
import { Section } from "@/components/Section";
import { useT } from "@/i18n";
import { PROBLEMS, PROVIDERS_JSON, PROVIDERS_JSON_HL, type Visual } from "@/content";

/** intrinsic sizes of the crops under public/shots/crops, so the browser reserves the box before the image lands */
const CROP_SIZE: Record<string, { width: number; height: number }> = {
  "/shots/crops/messages.png": { width: 1405, height: 476 },
  "/shots/crops/rmrf.png": { width: 1405, height: 476 },
  "/shots/crops/rewind.png": { width: 1137, height: 340 },
};

function Strip({ v, alt }: { v: Visual; alt: string }) {
  if (v.kind === "code") {
    return <CodeCard file="~/.rovecode/providers.json" lines={PROVIDERS_JSON.slice(0, 8)} highlight={PROVIDERS_JSON_HL} size="sm" className="h-[170px] overflow-hidden" />;
  }
  return (
    <div className="panel-2 h-[170px] overflow-hidden">
      <Pic src={v.src} alt={alt} {...CROP_SIZE[v.src]} loading="lazy" decoding="async" className="h-full w-full object-cover" style={{ objectPosition: v.position ?? "center" }} />
    </div>
  );
}

/** four problem → answer pairs, each in a white card with its crop on top */
export function Problems({ n }: { n: string }) {
  const t = useT();
  return (
    <Section id="problems" n={n} eyebrow={t.problems.eyebrow} title={t.problems.title} lead={t.problems.lead}>
      <Stagger as="ol" className="grid gap-6 md:grid-cols-2">
        {PROBLEMS.map((p, i) => (
          <Item as="li" key={p.n} className="panel panel-hover p-3 md:p-4">
            <Strip v={p.visual} alt={p.visual.kind === "crop" ? p.visual.alt : ""} />
            <div className="px-3 pb-4 pt-6 md:px-4">
              <p className="chip label px-3 py-1.5 !tracking-[0.1em]">
                <span className="text-text">{p.n}</span>
                <span aria-hidden className="size-1 rounded-full bg-mist" />
                {t.problems.problemLabel}
              </p>
              <p className="mt-5 text-[1.15rem] leading-snug font-semibold text-text">{t.problems.items[i]!.problem}</p>
              <p className="label mt-7">{t.problems.solutionLabel}</p>
              <p className="mt-3 text-[15px] leading-7 text-text-muted">{t.problems.items[i]!.solution}</p>
              <code className="mono mt-5 block truncate text-[12px] text-text-faint" dir="ltr">{p.snippet}</code>
            </div>
          </Item>
        ))}
      </Stagger>
    </Section>
  );
}
