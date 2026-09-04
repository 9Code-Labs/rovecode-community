import { StrictMode } from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
import "./index.css";
import App from "./App.tsx";
import { I18nProvider, initialLocale, loadDict, localeFromPath } from "./i18n";

// the opening locale's dictionary is fetched before the first client paint, so a visitor at the root whose browser
// asks for Turkish never sees the English prerender replaced word by word — it is swapped in one frame
const locale = initialLocale();
await loadDict(locale);

// every page arrives prerendered in its own language (scripts/prerender.mjs): /tr/ in Turkish, / in English. When
// the prerendered language is the one we are about to show, the DOM is hydrated and kept — the static and live
// trees are identical (src/lib/boot.ts STATIC), so nothing repaints. Only the root page with a non-English
// browser replaces its tree, in one frame.
const root = document.getElementById("root")!;
const prerendered = localeFromPath(window.location.pathname) ?? "en";
const app = (
  <StrictMode>
    <I18nProvider initial={locale}>
      <App />
    </I18nProvider>
  </StrictMode>
);
if (locale === prerendered && root.childElementCount > 0) {
  hydrateRoot(root, app);
} else {
  root.replaceChildren();
  createRoot(root).render(app);
}
