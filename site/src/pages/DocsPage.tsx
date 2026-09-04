import { Header } from "@/components/Header";
import { Footer } from "@/sections/Footer";
import { useT } from "@/i18n";

export interface DocEntry { slug: string; title: string; source: string; summary: string; toc: { id: string; text: string; depth: number }[]; html: string; words: number }
export interface DocsData { locale: string; home: string; docs: Pick<DocEntry, "slug" | "title" | "summary" | "words">[]; doc?: DocEntry }

/** The documentation pages: the same chrome as the landing page (header, footer, tokens), a left index of all
 *  documents with the current one's headings under it, and the document body set as prose inside a white card.
 *  The body is English in every locale — it is documentation; the chrome follows the page's language. */
export function DocsPage({ data }: { data: DocsData }) {
  const t = useT();
  const base = `${data.home}docs/`;
  const doc = data.doc;
  return (
    <div className="min-h-dvh overflow-x-clip bg-bg">
      <a href="#docs-title" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-full focus:bg-brand focus:px-4 focus:py-2 focus:text-on-brand">{t.ui.skip}</a>
      <Header home={data.home} />
      <main className="relative mx-auto w-full max-w-[1200px] px-6 pt-[calc(var(--header-h)+3rem)] pb-24 md:px-10 md:pt-[calc(var(--header-h)+4rem)]">
        <div className="grid gap-10 lg:grid-cols-12 lg:gap-12">
          <nav aria-label="Documentation" className="lg:col-span-3">
            <p className="label mb-5"><a href={base} className="hover:text-text">docs</a></p>
            <ol className="grid gap-1">
              {data.docs.map((d) => (
                <li key={d.slug}>
                  <a href={`${base}${d.slug}/`} aria-current={doc?.slug === d.slug ? "page" : undefined} className={`block rounded-full px-3 py-1.5 text-[14px] leading-6 transition-colors duration-150 hover:text-text ${doc?.slug === d.slug ? "bg-mist-soft font-medium text-text" : "text-text-muted"}`}>{d.title}</a>
                  {doc?.slug === d.slug && doc.toc.length > 1 && (
                    <ol className="mt-2 mb-3 grid gap-1.5 border-s border-border ms-4 ps-4">
                      {doc.toc.filter((h) => h.depth === 2).map((h) => (
                        <li key={h.id}><a href={`#${h.id}`} className="block text-[13px] leading-5 text-text-faint transition-colors duration-150 hover:text-text">{h.text}</a></li>
                      ))}
                    </ol>
                  )}
                </li>
              ))}
            </ol>
          </nav>

          <div className="min-w-0 lg:col-span-9">
            {doc ? (
              <article className="panel px-6 py-8 md:px-12 md:py-12 lg:max-w-[52rem]">
                <p className="chip label px-3.5 py-1.5 !tracking-[0.1em]">docs <span aria-hidden className="size-1 rounded-full bg-mist" /> {doc.slug}</p>
                <h1 id="docs-title" className="h2 mt-6">{doc.title}</h1>
                <p className="mt-4 text-[13px] text-text-faint">{doc.words.toLocaleString("en-US")} words · <a href={`https://github.com/9Code-Labs/rovecode/blob/main/${doc.source}`} target="_blank" rel="noreferrer" className="hover:text-text">{doc.source}</a></p>
                <div className="prose mt-10" dangerouslySetInnerHTML={{ __html: doc.html }} />
              </article>
            ) : (
              <div>
                <p className="chip label px-3.5 py-1.5 !tracking-[0.1em]">docs</p>
                <h1 id="docs-title" className="h2 mt-6">Documentation</h1>
                <p className="lead mt-5 max-w-[34rem]">The design notes, the thinking dial, the MCP market, plugins and deployment — rendered from the repository's docs/ at build time, plus the command reference from the README.</p>
                <ol className="mt-12 grid gap-6 md:grid-cols-2">
                  {data.docs.map((d, i) => (
                    <li key={d.slug} className="panel panel-hover p-6 md:p-7">
                      <p className="chip size-8 justify-center text-[11px] text-text">{String(i + 1).padStart(2, "0")}</p>
                      <h2 className="mt-4 text-[1.2rem] leading-snug"><a href={`${base}${d.slug}/`} className="hover:text-brand">{d.title}</a></h2>
                      <p className="mt-2 text-[15px] leading-7 text-text-muted">{d.summary}</p>
                      <p className="mono mt-3 text-[12px] text-text-faint">{d.words.toLocaleString("en-US")} words</p>
                    </li>
                  ))}
                </ol>
              </div>
            )}
          </div>
        </div>
      </main>
      <Footer />
    </div>
  );
}
