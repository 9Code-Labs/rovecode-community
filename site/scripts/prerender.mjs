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

const { render, LOCALES, isRtl, localePath } = await import(pathToFileURL(ssr).href);
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

const today = new Date().toISOString().slice(0, 10);
const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
${LOCALES.map(({ code }) => `  <url>
    <loc>${abs(code)}</loc>
    <lastmod>${today}</lastmod>
${LOCALES.map((l) => `    <xhtml:link rel="alternate" hreflang="${l.code}" href="${abs(l.code)}" />`).join("\n")}
    <xhtml:link rel="alternate" hreflang="x-default" href="${abs("en")}" />
  </url>`).join("\n")}
</urlset>
`;
writeFileSync(join(DIST, "sitemap.xml"), sitemap);
writeFileSync(join(DIST, "robots.txt"), `User-agent: *\nAllow: /\n\nSitemap: ${siteUrl}/sitemap.xml\n`);

rmSync(join(SITE, "dist-ssr"), { recursive: true, force: true });
console.log(`prerendered ${LOCALES.length} pages (${(bytes / 1024).toFixed(0)} kB of html), sitemap.xml, robots.txt`);
