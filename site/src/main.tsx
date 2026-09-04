import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/hanken-grotesk";
import "@fontsource/ibm-plex-mono";
import "@fontsource/ibm-plex-mono/500.css";
import "./index.css";
import App from "./App.tsx";
import { I18nProvider, initialLocale, loadDict } from "./i18n";

// the opening locale's dictionary is fetched before the first paint, so a Turkish visitor never sees English flash
const locale = initialLocale();
await loadDict(locale);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <I18nProvider initial={locale}>
      <App />
    </I18nProvider>
  </StrictMode>,
);
