import { useMemo, useState, type ReactNode } from "react";
import { Search } from "lucide-react";
import { Header } from "@/components/Header";
import { CopyCommand } from "@/components/CopyCommand";
import { Footer } from "@/sections/Footer";
import { useT } from "@/i18n";
import { cn } from "@/lib/utils";

/** the display shape scripts/market.mjs writes: src/market/types.ts MarketItem, with `install` flattened to
 *  the line a visitor types and the spec summarised as `runs` / `alternatives` / `pending` */
export interface MarketEnv { name: string; required: boolean; secret: boolean; description: string }
export interface MarketEntry {
  id: string; kind: "mcp" | "skill" | "plugin"; title: string; publisher: string; description: string;
  source: string; version: string; license: string; repository: string; homepage: string; tags: string[];
  env: MarketEnv[]; runs: string; alternatives: string[]; pending: string[]; install: string; from: string;
}
/** a detail page only ships what its sibling nav draws */
export type MarketStub = Pick<MarketEntry, "id" | "kind" | "title">;
export interface MarketData {
  locale: string; home: string; kinds: { kind: string; count: number }[]; tags: string[];
  entries: (MarketEntry | MarketStub)[]; entry?: MarketEntry;
}

/** one page per item: /market/<id>/. Ids are unique across the catalog and scripts/market.mjs fails the
 *  build if that ever stops being true, so a kind segment would only be noise in the URL. */
const href = (base: string, e: { id: string }) => `${base}${e.id}/`;

function KindPill({ kind }: { kind: string }) {
  const t = useT();
  return <span className="chip shrink-0 self-start px-2.5 py-1 text-[11px] font-medium text-text-muted">{t.market.kinds[kind as keyof typeof t.market.kinds] ?? kind}</span>;
}

/** everything the detail view says about one entry — what it runs, what it needs, where it comes from */
function Detail({ entry, base }: { entry: MarketEntry; base: string }) {
  const t = useT();
  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <KindPill kind={entry.kind} />
        {entry.version && <span className="chip px-2.5 py-1 text-[11px] text-text-muted">v{entry.version}</span>}
        {entry.license && <span className="chip px-2.5 py-1 text-[11px] text-text-muted" title={t.market.licenseLabel}>{entry.license}</span>}
        {entry.tags.map((tag) => <span key={tag} className="chip px-2.5 py-1 text-[11px] text-text-muted">{tag}</span>)}
      </div>
      <h2 className="h2 mt-5 text-[1.6rem] md:text-[1.9rem]">{entry.title}</h2>
      <p className="mt-2 text-[13.5px] text-text-faint">{entry.publisher}</p>
      <p className="mt-5 text-[16px] leading-7 text-text-muted">{entry.description}</p>

      <div className="mt-7">
        <p className="label mb-3">{t.market.installLabel}</p>
        <CopyCommand command={entry.install} size="sm" wrap tone="tint" />
      </div>

      <dl className="mt-8 grid gap-5">
        <div>
          <dt className="label">{t.market.runsLabel}</dt>
          <dd className="mono mt-2 break-all text-[12.5px] leading-6 text-text" dir="ltr">{entry.runs}</dd>
          {entry.alternatives.length > 0 && (
            <dd className="mono mt-2 break-all text-[12px] leading-6 text-text-faint" dir="ltr">{t.market.alsoLabel} {entry.alternatives.join(" · ")}</dd>
          )}
        </div>
        <div>
          <dt className="label">{t.market.envLabel}</dt>
          <dd className="mt-2 text-[14px] leading-6 text-text-muted">
            {entry.env.length === 0 ? t.market.envNone : (
              <ul className="grid gap-2">
                {entry.env.map((v) => (
                  <li key={v.name}>
                    <span className="mono text-[12.5px] text-text" dir="ltr">{v.name}</span>
                    <span className="text-text-faint"> · {v.required ? t.market.required : t.market.optional}{v.secret ? ` · ${t.market.secret}` : ""}</span>
                    {v.description && <span className="block text-[13.5px]">{v.description}</span>}
                  </li>
                ))}
              </ul>
            )}
          </dd>
        </div>
        {entry.pending.length > 0 && (
          <div>
            <dt className="label">{t.market.pendingLabel}</dt>
            <dd className="mt-2 grid gap-1 text-[14px] leading-6 text-text-muted">
              {entry.pending.map((p) => <span key={p}>{p}</span>)}
            </dd>
          </div>
        )}
        <div>
          <dt className="label">{t.market.targetLabel}</dt>
          <dd className="mt-2 text-[14px] leading-6 text-text-muted">{t.market.targetBody}</dd>
        </div>
        <div>
          <dt className="label">{t.market.fromLabel}</dt>
          <dd className="mono mt-2 break-all text-[12.5px] leading-6 text-text-muted" dir="ltr">{entry.from}</dd>
        </div>
      </dl>

      {(entry.repository || entry.homepage) && (
        <p className="mt-7 flex flex-wrap gap-x-6 gap-y-2 text-[13.5px]">
          {[entry.repository, entry.homepage].filter(Boolean).map((l) => (
            <a key={l} href={l} target="_blank" rel="noreferrer" className="text-brand underline decoration-mist underline-offset-4 hover:decoration-brand">
              {l.replace(/^https?:\/\/(www\.)?/, "").split("/")[0]} ↗
            </a>
          ))}
        </p>
      )}
      <p className="mt-8 text-[13.5px]"><a href={base} className="text-text-muted hover:text-text">← {t.market.backToAll}</a></p>
    </div>
  );
}

/** search + kind filter; the prerendered page shows the whole catalog and the client narrows it in place */
function useFiltered(entries: MarketEntry[]) {
  const [q, setQ] = useState("");
  const [kind, setKind] = useState<string>("all");
  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return entries.filter((e) => {
      if (kind !== "all" && e.kind !== kind) return false;
      if (!needle) return true;
      return `${e.title} ${e.publisher} ${e.description} ${e.tags.join(" ")} ${e.id}`.toLowerCase().includes(needle);
    });
  }, [entries, q, kind]);
  return { q, setQ, kind, setKind, list };
}

function Filters({ q, setQ, kind, setKind, kinds, total, shown }: {
  q: string; setQ: (v: string) => void; kind: string; setKind: (v: string) => void;
  kinds: { kind: string; count: number }[]; total: number; shown: number;
}) {
  const t = useT();
  return (
    <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
      <div className="panel !rounded-full !shadow-none flex min-w-0 flex-1 items-center gap-3 px-5 py-3 md:max-w-[24rem]">
        <Search className="size-4 shrink-0 text-text-faint" aria-hidden />
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t.market.searchPlaceholder}
          aria-label={t.market.searchLabel}
          className="min-w-0 flex-1 bg-transparent text-[15px] text-text outline-none placeholder:text-text-faint"
        />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {[{ kind: "all", count: total }, ...kinds].map((k) => (
          <button
            key={k.kind}
            type="button"
            onClick={() => setKind(k.kind)}
            aria-pressed={kind === k.kind}
            className={cn(
              "chip h-9 px-4 text-[13px] font-medium transition-colors duration-150",
              kind === k.kind ? "!bg-brand !text-on-brand" : "text-text-muted hover:text-text",
            )}
          >
            {k.kind === "all" ? t.market.all : t.market.kinds[k.kind as keyof typeof t.market.kinds] ?? k.kind}
            {/* the count on the active pill was white at 80% — 4.02:1 on the accent. Full white is 5.33:1,
                and a count is text a reader uses, not decoration. */}
            <span className={cn("mono text-[11px]", kind === k.kind ? "" : "text-text-faint")}>{k.count}</span>
          </button>
        ))}
        <span className="label ms-1 hidden sm:inline">{shown}/{total}</span>
      </div>
    </div>
  );
}

/** The market: everything rovecode can install in one place — MCP servers, skills and plugins — read from
 *  this repository at build time, each with the one command that installs it. The live MCP registry is not
 *  baked in; the page says so and the CLI reaches it at runtime. */
export function MarketPage({ data }: { data: MarketData }) {
  const t = useT();
  const base = `${data.home}market/`;
  const { q, setQ, kind, setKind, list } = useFiltered(data.entries as MarketEntry[]);

  if (data.entry) {
    const siblings = data.entries.filter((e) => e.kind === data.entry!.kind);
    return (
      <Shell home={data.home}>
        <div className="grid gap-10 lg:grid-cols-12">
          <nav aria-label={t.market.title} className="lg:col-span-3">
            <p className="label mb-4"><a href={base} className="hover:text-text">market</a></p>
            <ol className="grid gap-1">
              {siblings.map((e) => (
                <li key={e.id}>
                  <a href={href(base, e)} aria-current={e.id === data.entry!.id ? "page" : undefined}
                     className={cn("block rounded-full px-3 py-1.5 text-[14px] leading-6 transition-colors duration-150 hover:text-text",
                       e.id === data.entry!.id ? "bg-mist-soft font-medium text-text" : "text-text-muted")}>{e.title}</a>
                </li>
              ))}
            </ol>
          </nav>
          <article className="panel px-6 py-8 lg:col-span-9 lg:max-w-[46rem] md:px-10 md:py-10">
            <h1 id="market-title" className="sr-only">{data.entry.title} — {t.market.title}</h1>
            <Detail entry={data.entry} base={base} />
          </article>
        </div>
      </Shell>
    );
  }

  return (
    <Shell home={data.home}>
      <div className="mb-10">
        <p className="chip label px-3.5 py-1.5 !tracking-[0.1em]">market</p>
        <h1 id="market-title" className="h2 mt-6">{t.market.title}</h1>
        <p className="lead mt-5 max-w-[38rem]">{t.market.lead}</p>
      </div>
      <Filters q={q} setQ={setQ} kind={kind} setKind={setKind} kinds={data.kinds} total={data.entries.length} shown={list.length} />

      {list.length === 0 ? (
        <p className="panel mt-8 px-6 py-12 text-center text-[15px] text-text-muted">{t.market.empty}</p>
      ) : (
        <ul className="mt-8 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {list.map((e) => (
            <li key={e.id} className="panel panel-hover relative flex flex-col p-6">
              <KindPill kind={e.kind} />
              <h2 className="mt-4 text-[1.15rem] leading-snug">
                <a href={href(base, e)} className="hover:text-brand">
                  {/* the whole card is the target: the link stretches over it, the text stays the label */}
                  <span className="absolute inset-0 rounded-[var(--radius-lg)]" aria-hidden />
                  {e.title}
                </a>
              </h2>
              <p className="mt-1 text-[13px] text-text-faint">{e.publisher}</p>
              <p className="mt-3 text-[14.5px] leading-6 text-text-muted">{e.description}</p>
              <p className="mt-auto pt-6 text-[14px] font-semibold text-brand">{t.market.installCta} →</p>
            </li>
          ))}
        </ul>
      )}

      <p className="mt-10 max-w-[46rem] text-[13.5px] leading-6 text-text-faint">{t.market.registryNote}</p>
    </Shell>
  );
}

function Shell({ home, children }: { home: string; children: ReactNode }) {
  const t = useT();
  return (
    <div className="min-h-dvh overflow-x-clip bg-bg">
      <a href="#market-title" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-full focus:bg-brand focus:px-4 focus:py-2 focus:text-on-brand">{t.ui.skip}</a>
      <Header home={home} />
      <main className="relative mx-auto w-full max-w-[1200px] px-6 pt-[calc(var(--header-h)+3rem)] pb-24 md:px-10 md:pt-[calc(var(--header-h)+4rem)]">
        {children}
      </main>
      <Footer />
    </div>
  );
}
