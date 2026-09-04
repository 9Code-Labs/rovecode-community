import { renderToString } from "react-dom/server";
import App from "./App";
import { I18nProvider, LOCALES, isRtl, loadDict, localePath, type LocaleCode } from "./i18n";

export { LOCALES, isRtl, localePath };
export type { LocaleCode };

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
