/** Put the English page into dist/index.html so the text is on screen before any script runs, and inline the CSS.
 *
 *  Runs after `vite build` and `vite build --ssr src/entry-server.tsx --outDir dist-ssr` (see package.json "build"):
 *  imports the SSR bundle, renders, splices the markup into <div id="root">, removes dist-ssr. */
import { readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const SITE = join(import.meta.dirname, "..");
const ssr = join(SITE, "dist-ssr", "entry-server.js");
const index = join(SITE, "dist", "index.html");

const { render } = await import(pathToFileURL(ssr).href);
const html = render();
let page = readFileSync(index, "utf8");
if (!page.includes('<div id="root"></div>')) throw new Error("dist/index.html has no empty #root to fill");
page = page.replace('<div id="root"></div>', `<div id="root">${html}</div>`);

// the one stylesheet goes inline: ~14 kB gzipped inside the document beats a render-blocking round trip on a
// slow connection, and the page has exactly one CSS file
page = page.replace(/<link rel="stylesheet"[^>]*href="(\/assets\/[^"]+\.css)"[^>]*>/, (tag, href) => {
  const file = join(SITE, "dist", href);
  return existsSync(file) ? `<style>${readFileSync(file, "utf8")}</style>` : tag;
});
writeFileSync(index, page);
rmSync(join(SITE, "dist-ssr"), { recursive: true, force: true });
console.log(`prerendered ${(html.length / 1024).toFixed(0)} kB of markup into dist/index.html`);
