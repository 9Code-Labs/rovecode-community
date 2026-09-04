import { renderToString } from "react-dom/server";
import App from "./App";
import { I18nProvider } from "./i18n";

/** The page as static HTML, in English, for scripts/prerender.mjs to put inside <div id="root"> at build time.
 *  Components read STATIC (src/lib/boot.ts) and render their finished state, so the markup is complete and
 *  visible without a script. main.tsx then replaces it with the live tree in the visitor's language. */
export function render(): string {
  return renderToString(
    <I18nProvider initial="en">
      <App />
    </I18nProvider>,
  );
}
