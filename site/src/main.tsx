import { StrictMode, type ReactNode } from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
import "./index.css";
import App from "./App.tsx";
import { I18nProvider, initialLocale, isCode, loadDict, localeFromPath, type LocaleCode } from "./i18n";

// a docs page carries its data inline (scripts/prerender.mjs), and its locale is in the path: /docs/… or /tr/docs/…
const docsMatch = /^\/(?:([a-z]{2})\/)?docs\//.exec(window.location.pathname);
const docsData = docsMatch ? document.getElementById("docs-data")?.textContent : null;

const locale: LocaleCode = docsMatch ? (isCode(docsMatch[1]) ? docsMatch[1] : "en") : initialLocale();
await loadDict(locale);

const root = document.getElementById("root")!;
let app: ReactNode;
if (docsData) {
  const { DocsPage } = await import("./pages/DocsPage.tsx");
  app = (
    <StrictMode>
      <I18nProvider initial={locale} manageMeta={false}>
        <DocsPage data={JSON.parse(docsData)} />
      </I18nProvider>
    </StrictMode>
  );
} else {
  // the opening locale's dictionary was awaited above, so a visitor at the root whose browser asks for Turkish never
  // sees the English prerender replaced word by word — it is swapped in one frame
  app = (
    <StrictMode>
      <I18nProvider initial={locale}>
        <App />
      </I18nProvider>
    </StrictMode>
  );
}

// every page arrives prerendered in its own language. When the prerendered language is the one we are about to
// show, the DOM is hydrated and kept — the static and live trees are identical (src/lib/boot.ts STATIC), so
// nothing repaints. Only the root page with a non-English browser replaces its tree, in one frame.
const prerendered = docsMatch ? locale : (localeFromPath(window.location.pathname) ?? "en");
if (locale === prerendered && root.childElementCount > 0) {
  hydrateRoot(root, app);
} else {
  root.replaceChildren();
  createRoot(root).render(app);
}
