import { renderToString } from "react-dom/server";
import App from "./App";
import { DocsPage, type DocsData } from "./pages/DocsPage";
import { I18nProvider, LOCALES, isRtl, loadDict, localePath, type LocaleCode } from "./i18n";

export { LOCALES, isRtl, localePath };
export type { LocaleCode, DocsData };

/** The page as static HTML in one language, for scripts/prerender.mjs to put inside <div id="root"> at build
 *  time — once per locale, into that locale's directory. Components read STATIC (src/lib/boot.ts) and render their
 *  finished state, so the markup is complete and visible without a script. */
export async function render(code: LocaleCode): Promise<{ html: string; title: string; description: string }> {
  const dict = await loadDict(code);
  const html = renderToString(
    <I18nProvider initial={code}>
      <App />
    </I18nProvider>,
  );
  return { html, title: dict.meta.title, description: dict.meta.description };
}

/** a docs page (index when `data.doc` is absent) in one locale's chrome; the body is English */
export async function renderDocs(code: LocaleCode, data: DocsData): Promise<{ html: string; title: string; description: string }> {
  await loadDict(code);
  const html = renderToString(
    <I18nProvider initial={code} manageMeta={false}>
      <DocsPage data={data} />
    </I18nProvider>,
  );
  const title = data.doc ? `${data.doc.title} — rovecode docs` : "Documentation — rovecode";
  const description = data.doc ? data.doc.summary || `${data.doc.title}, from the rovecode repository.` : "rovecode documentation: design, the thinking dial, the MCP market, plugins, deployment and the command reference.";
  return { html, title, description };
}
