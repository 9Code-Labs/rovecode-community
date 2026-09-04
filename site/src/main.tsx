import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.tsx";
import { I18nProvider, initialLocale, loadDict } from "./i18n";

// the opening locale's dictionary is fetched before the first client paint, so a Turkish visitor never sees the
// English prerender replaced word by word — it is swapped in one frame once the dictionary is here
const locale = initialLocale();
await loadDict(locale);

// production HTML arrives prerendered (scripts/prerender.mjs); the live tree takes over from it in one frame.
// A plain replace rather than hydration: the static markup deliberately differs from the live one (no motion
// wrappers), and a mismatch-recovery would cost a console error for nothing.
const root = document.getElementById("root")!;
root.replaceChildren();
createRoot(root).render(
  <StrictMode>
    <I18nProvider initial={locale}>
      <App />
    </I18nProvider>
  </StrictMode>,
);
