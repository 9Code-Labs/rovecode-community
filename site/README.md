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
  location / { try_files $uri $uri/ /index.html; }
}
```

Single-page: every route falls back to `index.html`. Hashed assets under `/assets/` are immutable.

## Notes

- Root-absolute asset URLs (`/assets`, `/brand`, `/shots`). To host under a sub-path, set `base` in `vite.config.ts`.
- No canonical tag and no absolute `og:url`; `og:image` is root-relative — add the domain to both once there is one.
- Locale: 15 languages, picked from `navigator.language`, persisted in `localStorage` (`rovecode.locale`).
- Design direction is recorded in `.rovecode/design.json` (read by rovecode's `design_audit`).
- `media-src/` (raw and encoded video, ~120 MB) and `screenshots/` are working files, git-ignored.
- Regenerate the terminal frames after a copy change in `scripts/out/*.html`: `node scripts/shoot.ts frames`.
- Dev server: `bun run dev` → http://localhost:5173/.
