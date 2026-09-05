import { CodeCard } from "@/components/CodeCard";
import { Glass } from "@/components/Glass";
import { LightField } from "@/components/LightField";
import { Item, Stagger } from "@/components/Motion";
import { Section } from "@/components/Section";
import { BENTO_MEDIUM, BENTO_SMALL, LADDER, PROVIDERS_JSON, PROVIDERS_JSON_HL, type Tile } from "@/content";

function Glyph({ g }: { g: string }) {
  return <span aria-hidden className="mono inline-flex size-8 items-center justify-center rounded-[10px] border border-border bg-black/20 text-[15px] text-brand">{g}</span>;
}

function Small({ t }: { t: Tile }) {
  return (
    <Glass hover pad="sm" className="flex h-full flex-col md:p-5">
      <Glyph g={t.glyph} />
      <h3 className="mt-4 text-[1rem] font-[450] leading-snug tracking-normal text-text">{t.title}</h3>
      <p className="mt-2 flex-1 text-[13.5px] leading-6 text-text-muted">{t.body}</p>
      <code className="mono mt-4 block truncate text-[11px] text-text-muted">{t.tag}</code>
    </Glass>
  );
}

function Medium({ t, i }: { t: Tile; i: number }) {
  return (
    <Glass hover pad="md" className="flex h-full flex-col">
      <div className="flex items-center justify-between">
        <Glyph g={t.glyph} />
        <span className="eyebrow">{["context", "safety", "memory"][i]}</span>
      </div>
      <h3 className="mt-4 text-[1.2rem] font-[450] leading-snug tracking-normal text-text">{t.title}</h3>
      <p className="mt-2.5 flex-1 text-[14.5px] leading-6 text-text-muted">{t.body}</p>
      {i === 1 ? (
        <ol className="mt-5 flex flex-wrap items-center gap-1.5">
          {LADDER.map((step, k) => (
            <li key={step} className="flex items-center gap-1.5">
              <span className="mono glass-pill px-2.5 py-1 text-[11px] text-text">
                <span className="mr-1.5 text-brand">{k + 1}</span>{step}
              </span>
              {k < LADDER.length - 1 && <span aria-hidden className="text-text-faint">→</span>}
            </li>
          ))}
        </ol>
      ) : (
        <code className="mono mt-5 block truncate text-[11px] text-text-muted">{t.tag}</code>
      )}
    </Glass>
  );
}

export function Capabilities() {
  return (
    <Section
      id="capabilities"
      n="04"
      eyebrow="capabilities"
      title="Ten capabilities, each one a port with a file:line trail."
      lead="Nimbus ports evidence-based patterns from pi, opencode, codex, cline, aider, gemini-cli and others. A port lands only after a fresh-context critic verifies it against a bar written before the work began."
      backdrop={<><LightField className="left-[4%] top-[22%]" size={1300} strength={0.18} /><LightField className="right-[-10%] top-[62%]" size={900} strength={0.12} /></>}
    >
      <Stagger className="grid gap-4 lg:grid-cols-6">
        {/* large: the cockpit */}
        <Item className="lg:col-span-3 lg:row-span-2">
          <Glass hover pad="none" className="flex h-full flex-col overflow-hidden">
            <div className="p-6 pb-0 md:p-7 md:pb-0">
              <div className="flex items-center justify-between">
                <Glyph g="◆" />
                <span className="eyebrow">surface</span>
              </div>
              <h3 className="mt-4 text-[1.45rem] font-[450] leading-snug tracking-normal text-text">sextant cockpit</h3>
              <p className="mt-2.5 max-w-[34rem] text-[15px] leading-7 text-text-muted">
                6 panels on a truecolor TTY of at least 100×30: files with git status, code with the highlight band and ± diff, compact tool rows, plan, usage, the pet. 3 palettes, /theme switches live; --classic keeps the pi-tui chat.
              </p>
              <code className="mono mt-4 block text-[11px] text-text-muted">nimbus · NIMBUS_TUI=sextant|classic · /theme night|ember|contrast</code>
            </div>
            <div className="relative mt-6 flex-1 px-2.5 pb-2.5 md:px-3 md:pb-3">
              <div className="glass-2 h-full min-h-[240px] overflow-hidden rounded-[16px]">
                <img src="/shots/crops/cockpit.png" alt="Crop of the sextant frame: files tree and the code panel with the editing highlight band" loading="lazy" decoding="async" className="h-full w-full object-cover object-left-top" />
              </div>
            </div>
          </Glass>
        </Item>

        {/* large: providers, hot-reloaded */}
        <Item className="lg:col-span-3 lg:row-span-2">
          <Glass hover pad="none" className="flex h-full flex-col overflow-hidden">
            <div className="p-6 pb-0 md:p-7 md:pb-0">
              <div className="flex items-center justify-between">
                <Glyph g="·" />
                <span className="eyebrow">providers</span>
              </div>
              <h3 className="mt-4 text-[1.45rem] font-[450] leading-snug tracking-normal text-text">providers, hot-reloaded</h3>
              <p className="mt-2.5 max-w-[34rem] text-[15px] leading-7 text-text-muted">
                16 built-ins plus anything you register in providers.json. Every call resolves the provider against the live snapshot: add one in another terminal and the running cockpit uses it on the next call. No restart.
              </p>
              <code className="mono mt-4 block text-[11px] text-text-muted">nimbus provider add|list|test · nimbus model use provider/model</code>
            </div>
            <div className="mt-6 flex-1 px-2.5 pb-2.5 md:px-3 md:pb-3">
              <CodeCard file="~/.cumulus/providers.json" lines={PROVIDERS_JSON} highlight={PROVIDERS_JSON_HL} className="h-full" />
            </div>
          </Glass>
        </Item>

        {BENTO_MEDIUM.map((t, i) => (
          <Item key={t.title} className="lg:col-span-2">
            <Medium t={t} i={i} />
          </Item>
        ))}
      </Stagger>

      <Stagger className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
        {BENTO_SMALL.map((t) => (
          <Item key={t.title}>
            <Small t={t} />
          </Item>
        ))}
      </Stagger>
    </Section>
  );
}
