# rovecode — site

Static landing page for rovecode. React 19 + Vite 7 + Tailwind 4, built with Bun. No server-side rendering,
no runtime process: the build is plain files.

## Build

```sh
cd site
bun install --frozen-lockfile
bun run build          # facts → tsc -b → vite build → SSR build → prerender  →  dist/
```

`build` runs, in order: `scripts/facts.mjs` (reads test/provider/locale/licence counts from the repository into
`src/generated/facts.json`), the type check, the client build, an SSR build of `src/entry-server.tsx`, and
`scripts/prerender.mjs`, which puts the English page into `dist/index.html` so the text is on screen before any
script runs (the live tree replaces it in the visitor's language). Image variants (`scripts/images.mjs`, AVIF/WebP
twins of every PNG under `public/shots`) are committed; re-run `bun run images` after re-shooting frames.

Output: `site/dist/` (index.html, assets/, brand/, shots/). Serve it from the domain (or IP) root.

## Serve (nginx)

```nginx
server {
  listen 80;
  root /var/www/rovecode-site;      # contents of site/dist
  index index.html;
  location /assets/ { add_header Cache-Control "public, max-age=31536000, immutable"; }
  error_page 404 /404.html;
  location / { try_files $uri $uri/ =404; }
}
```

One page, no client routes: unknown paths return `404.html`. Hashed assets under `/assets/` are immutable.

## Notes

- Root-absolute asset URLs (`/assets`, `/brand`, `/shots`). To host under a sub-path, set `base` in `vite.config.ts`.
- Canonical, `og:url` and `og:image` are absolute, built from `VITE_SITE_URL`: `.env` holds the current fallback
  (`http://64.177.43.110`); set the variable in the deploy environment to override (`VITE_SITE_URL=https://… bun run build`).
- Routes are only the 15 locale directories (served as directory indexes); every other path should 404 (`public/404.html`), not fall back to index.html.
- Languages: 15, one prerendered page each — `/` (English; auto-detects the browser language on the client and swaps in one frame), `/tr/`, `/de/`, … Each page carries its own title/description, `<html lang dir>`, canonical, `og:locale` and the full hreflang set (15 + x-default); `dist/sitemap.xml` lists them. The language picker navigates to the language's URL and remembers the choice for `/`. English is in the main bundle; each other dictionary is its own chunk.
- Design direction is recorded in `.rovecode/design.json` (read by rovecode's `design_audit`).
- Social card: `public/brand/og.png` (1200×630) is rendered from the page's own fonts and tokens by `node scripts/og.mjs`; `og:image` points at it.
- No animation library: the page arrives prerendered and holds still; the transcript replay and the count-up (dev only) use `src/lib/motion.ts`.
- `media-src/` (raw and encoded video, ~120 MB) and `screenshots/` are working files, git-ignored.
- Regenerate the terminal frames after a copy change in `scripts/out/*.html`: `node scripts/shoot.ts frames`.
- `bun run lighthouse [url]` runs Lighthouse (mobile + desktop) against the live site by default, or any URL, on the local Playwright Chromium; Lighthouse itself is installed on first use into `scripts/.lh/` (git-ignored), not a dependency of the site. `bun run og` re-renders the social card, `bun run images` the image variants.
- `scripts/prerender.mjs` also inlines the single stylesheet into `dist/index.html` (one fewer render-blocking request on slow links).
- Dev server: `bun run dev` → http://localhost:5173/. In dev the root is empty, so entrances animate; in production the page arrives prerendered and components render their finished state (see `src/lib/boot.ts`).
- Fonts are self-hosted under `public/fonts` (latin + latin-ext subsets); the two latin files are preloaded.
