import { StrictMode } from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
import "./index.css";
import App from "./App.tsx";
import { I18nProvider, initialLocale, loadDict } from "./i18n";

// the opening locale's dictionary is fetched before the first client paint, so a Turkish visitor never sees the
// English prerender replaced word by word — it is swapped in one frame once the dictionary is here
const locale = initialLocale();
await loadDict(locale);

// production HTML arrives prerendered in English (scripts/prerender.mjs). An English visitor gets a real hydration —
// the static and live trees are identical (src/lib/boot.ts STATIC), so the DOM is kept and nothing repaints, which
// is what keeps LCP at first paint. Any other language replaces the tree in one frame instead.
const root = document.getElementById("root")!;
const app = (
  <StrictMode>
    <I18nProvider initial={locale}>
      <App />
    </I18nProvider>
  </StrictMode>
);
if (locale === "en" && root.childElementCount > 0) {
  hydrateRoot(root, app);
} else {
  root.replaceChildren();
  createRoot(root).render(app);
}
