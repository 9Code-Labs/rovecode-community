# rovecode — site

Static landing page for rovecode. React 19 + Vite 7 + Tailwind 4, built with Bun. No server-side rendering,
no runtime process: the build is plain files.

## Build

```sh
cd site
bun install --frozen-lockfile
bun run build          # tsc -b && vite build  →  dist/
```

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
- Single page, no client-side routes: unknown paths should 404 (`public/404.html`), not fall back to index.html.
- Locale: 15 languages, picked from `navigator.language`, persisted in `localStorage` (`rovecode.locale`). English is in the main bundle; each other language is its own chunk, fetched on first use.
- Design direction is recorded in `.rovecode/design.json` (read by rovecode's `design_audit`).
- `media-src/` (raw and encoded video, ~120 MB) and `screenshots/` are working files, git-ignored.
- Regenerate the terminal frames after a copy change in `scripts/out/*.html`: `node scripts/shoot.ts frames`.
- Dev server: `bun run dev` → http://localhost:5173/.
