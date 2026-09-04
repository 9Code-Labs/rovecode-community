/** One prerendered page per language, hreflang links between them, and a sitemap.
 *
 *  Runs after `vite build` and `vite build --ssr src/entry-server.tsx --outDir dist-ssr` (package.json "build").
 *  For every locale in src/i18n: render the app in that language, put it into a copy of dist/index.html with the
 *  localized <html lang/dir>, <title>, description, canonical, og:url/og:title/og:description/og:locale and the full
 *  <link rel="alternate" hreflang> set (15 + x-default), inline the one stylesheet, and write it to
 *  dist/<code>/index.html — English at dist/index.html. Then dist/sitemap.xml with the same alternates. */
import { readFileSync, writeFileSync, rmSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const SITE = join(import.meta.dirname, "..");
const DIST = join(SITE, "dist");
const ssr = join(SITE, "dist-ssr", "entry-server.js");

const { render, renderDocs, LOCALES, isRtl, localePath } = await import(pathToFileURL(ssr).href);
const template = readFileSync(join(DIST, "index.html"), "utf8");
if (!template.includes('<div id="root"></div>')) throw new Error("dist/index.html has no empty #root to fill");

const siteUrl = (/<link rel="canonical" href="([^"]+)\/"/.exec(template) ?? [])[1];
if (!siteUrl) throw new Error("dist/index.html has no canonical to read the site URL from");
const abs = (code) => siteUrl + localePath(code);
const esc = (s) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

// the stylesheet once, inline: ~14 kB gzipped inside the document beats a render-blocking round trip
const cssMatch = /<link rel="stylesheet"[^>]*href="(\/assets\/[^"]+\.css)"[^>]*>/.exec(template);
const css = cssMatch && existsSync(join(DIST, cssMatch[1])) ? `<style>${readFileSync(join(DIST, cssMatch[1]), "utf8")}</style>` : null;

const alternates = LOCALES.map((l) => `<link rel="alternate" hreflang="${l.code}" href="${abs(l.code)}" />`).concat(`<link rel="alternate" hreflang="x-default" href="${abs("en")}" />`).join("\n    ");
const OG_LOCALE = { en: "en_US", tr: "tr_TR", de: "de_DE", fr: "fr_FR", es: "es_ES", pt: "pt_BR", it: "it_IT", nl: "nl_NL", pl: "pl_PL", ru: "ru_RU", uk: "uk_UA", ja: "ja_JP", ko: "ko_KR", zh: "zh_CN", ar: "ar_AR" };

let bytes = 0;
for (const { code } of LOCALES) {
  const { html, title, description } = await render(code);
  let page = template
    .replace('<div id="root"></div>', `<div id="root">${html}</div>`)
    .replace(/<html lang="en">/, `<html lang="${code}"${isRtl(code) ? ' dir="rtl"' : ""}>`)
    .replace(/<title>[^<]*<\/title>/, `<title>${esc(title)}</title>`)
    .replace(/<meta name="description" content="[^"]*" \/>/, `<meta name="description" content="${esc(description)}" />`)
    .replace(/<meta property="og:title" content="[^"]*" \/>/, `<meta property="og:title" content="${esc(title)}" />`)
    .replace(/<meta property="og:description" content="[^"]*" \/>/, `<meta property="og:description" content="${esc(description)}" />`)
    .replace(/<link rel="canonical" href="[^"]*" \/>/, `<link rel="canonical" href="${abs(code)}" />\n    ${alternates}`)
    .replace(/<meta property="og:url" content="[^"]*" \/>/, `<meta property="og:url" content="${abs(code)}" />\n    <meta property="og:locale" content="${OG_LOCALE[code] ?? code}" />`);
  if (css && cssMatch) page = page.replace(cssMatch[0], css);
  const dir = code === "en" ? DIST : join(DIST, code);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.html"), page);
  bytes += page.length;
}

// ---- /docs/ (a proposal behind VITE_DOCS=1; scripts/docs-build.mjs leaves the list empty otherwise) ----
const docsFile = join(SITE, "src", "generated", "docs.json");
const docsJson = existsSync(docsFile) ? JSON.parse(readFileSync(docsFile, "utf8")) : { enabled: false, docs: [] };
const docPaths = []; // [path-without-locale] e.g. "docs/", "docs/design/"
if (docsJson.enabled && docsJson.docs.length) {
  const list = docsJson.docs.map(({ slug, title, summary, words }) => ({ slug, title, summary, words }));
  const pages = [{ sub: "docs/", doc: undefined }, ...docsJson.docs.map((d) => ({ sub: `docs/${d.slug}/`, doc: d }))];
  for (const p of pages) docPaths.push(p.sub);
  for (const { code } of LOCALES) {
    for (const p of pages) {
      const home = localePath(code);
      const data = { locale: code, home, docs: list, doc: p.doc };
      const { html, title, description } = await renderDocs(code, data);
      const url = siteUrl + home + p.sub;
      const alts = LOCALES.map((l) => `<link rel="alternate" hreflang="${l.code}" href="${siteUrl}${localePath(l.code)}${p.sub}" />`).concat(`<link rel="alternate" hreflang="x-default" href="${siteUrl}/${p.sub}" />`).join("\n    ");
      let page = template
        .replace('<div id="root"></div>', `<div id="root">${html}</div>\n    <script id="docs-data" type="application/json">${JSON.stringify(data).replace(/</g, "\\u003c")}</script>`)
        .replace(/<html lang="en">/, `<html lang="${code}"${isRtl(code) ? ' dir="rtl"' : ""}>`)
        .replace(/<title>[^<]*<\/title>/, `<title>${esc(title)}</title>`)
        .replace(/<meta name="description" content="[^"]*" \/>/, `<meta name="description" content="${esc(description)}" />`)
        .replace(/<meta property="og:title" content="[^"]*" \/>/, `<meta property="og:title" content="${esc(title)}" />`)
        .replace(/<meta property="og:description" content="[^"]*" \/>/, `<meta property="og:description" content="${esc(description)}" />`)
        .replace(/<link rel="canonical" href="[^"]*" \/>/, `<link rel="canonical" href="${url}" />\n    ${alts}`)
        .replace(/<meta property="og:url" content="[^"]*" \/>/, `<meta property="og:url" content="${url}" />\n    <meta property="og:locale" content="${OG_LOCALE[code] ?? code}" />`);
      if (css && cssMatch) page = page.replace(cssMatch[0], css);
      const dir = join(code === "en" ? DIST : join(DIST, code), p.sub);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "index.html"), page);
      bytes += page.length;
    }
  }
  console.log(`docs: ${pages.length} pages × ${LOCALES.length} locales`);
}

const today = new Date().toISOString().slice(0, 10);
const entry = (path) => `  <url>
    <loc>${siteUrl}${path}</loc>
    <lastmod>${today}</lastmod>
${LOCALES.map((l) => `    <xhtml:link rel="alternate" hreflang="${l.code}" href="${siteUrl}${localePath(l.code)}${path.replace(/^\/([a-z]{2}\/)?/, "")}" />`).join("\n")}
    <xhtml:link rel="alternate" hreflang="x-default" href="${siteUrl}/${path.replace(/^\/([a-z]{2}\/)?/, "")}" />
  </url>`;
const urls = [];
for (const { code } of LOCALES) { urls.push(localePath(code)); for (const p of docPaths) urls.push(localePath(code) + p); }
const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
${urls.map(entry).join("\n")}
</urlset>
`;
writeFileSync(join(DIST, "sitemap.xml"), sitemap);
writeFileSync(join(DIST, "robots.txt"), `User-agent: *\nAllow: /\n\nSitemap: ${siteUrl}/sitemap.xml\n`);

rmSync(join(SITE, "dist-ssr"), { recursive: true, force: true });
console.log(`prerendered ${LOCALES.length} pages (${(bytes / 1024).toFixed(0)} kB of html), sitemap.xml, robots.txt`);
