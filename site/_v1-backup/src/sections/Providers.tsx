import { CodeCard } from "@/components/CodeCard";
import { CopyCommand } from "@/components/CopyCommand";
import { Glass } from "@/components/Glass";
import { Item, Reveal, Stagger } from "@/components/Motion";
import { Section } from "@/components/Section";
import { PROVIDERS_HOSTED, PROVIDERS_JSON, PROVIDERS_JSON_HL, PROVIDERS_LOCAL } from "@/content";

function Pill({ name, local }: { name: string; local?: boolean }) {
  return (
    <Item as="li">
      <span className="glass-2 glass-hover-2 mono group flex items-center justify-between gap-2 rounded-pill px-4 py-2.5 text-sm text-text transition-colors duration-200 hover:text-brand">
        {name}
        <span className={`size-1.5 rounded-full transition-colors duration-200 ${local ? "bg-text-faint group-hover:bg-brand" : "bg-border-strong group-hover:bg-brand"}`} aria-hidden />
      </span>
    </Item>
  );
}

export function Providers() {
  return (
    <Section
      id="providers"
      n="07"
      eyebrow="providers"
      title="16 built-in providers, or any OpenAI-compatible URL."
      lead={<>Stored credentials beat <code className="mono text-[0.92em] text-text">&lt;NAME&gt;_API_KEY</code> env vars; an explicit <code className="mono text-[0.92em] text-text">NIMBUS_BASE_URL</code> / <code className="mono text-[0.92em] text-text">NIMBUS_API_KEY</code> pair beats both.</>}
    >
      <div className="grid gap-4 lg:grid-cols-12">
        <Glass pad="lg" className="lg:col-span-7">
          <div className="flex items-center justify-between">
            <p className="eyebrow">hosted apis · {PROVIDERS_HOSTED.length}</p>
            <p className="eyebrow">local runtimes · {PROVIDERS_LOCAL.length}</p>
          </div>
          <Stagger as="ul" className="mt-5 grid grid-cols-2 gap-2 sm:grid-cols-4">
            {PROVIDERS_HOSTED.map((p) => <Pill key={p} name={p} />)}
            {PROVIDERS_LOCAL.map((p) => <Pill key={p} name={p} local />)}
          </Stagger>
          <p className="mono mt-7 text-xs leading-5 text-text-faint">
            ● local runtimes need no key · nimbus auth set &lt;name&gt; stores a key in ~/.cumulus/credentials.json, prompted on the terminal and never echoed.
          </p>
        </Glass>
        <Reveal className="lg:col-span-5">
          <Glass pad="md" className="flex h-full flex-col">
            <p className="eyebrow">any endpoint · live</p>
            <h3 className="mt-3 text-[1.25rem] font-[450] leading-snug tracking-normal">Add a provider in another terminal; the running cockpit picks it up on the next call. No restart.</h3>
            <CopyCommand command="nimbus provider add homelab http://10.0.0.7:8000/v1 --no-key" size="sm" wrap className="mt-4" />
            <CodeCard file="~/.cumulus/providers.json" lines={PROVIDERS_JSON} highlight={PROVIDERS_JSON_HL} size="sm" className="mt-3 flex-1" />
          </Glass>
        </Reveal>
      </div>
    </Section>
  );
}
