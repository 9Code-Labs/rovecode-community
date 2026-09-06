# Deploying the site and running the server

**The site lives in its own repository since 2026-09-06: [9Code-Labs/rovecode-site](https://github.com/9Code-Labs/rovecode-site)**
(public, Berkay's call). The build and the deploy moved with it — `bun run deploy` over there, from
`scripts/deploy.sh`, which is the old `scripts/deploy-site.sh` with the site root being the repository
root. What stayed here is the CONTENT the site renders and the generators that turn it into data:

```
bun run publish:site         regenerate docs.json / market.json / facts.json → commit → push to the site repo
bun run publish:site --dry-run          show what would change, put the checkout back
SITE_REPO=/path/to/rovecode-site bun run publish:site
```

The boundary is one-way and worth stating: the documentation is `docs/*.md` here, the market is
`src/market/catalogs/*.json`, `src/mcp/market-catalog.ts` and `plugins/` here, and the landing page's
numbers are counted from this tree. `scripts/site-generators/` turns those into three JSON files and
writes them into the site checkout, which builds without ever reading anything outside itself. Editing
those JSON files by hand over there works until the next publish overwrites them.

The site itself is static: Vite builds it, nginx serves it, and nothing on the server runs Node. This
page is the reference for that setup — what the host holds, how a release lands, and how to roll one back.
Every step described here is idempotent, so re-running any of it on a fresh host reproduces the same state.
The current host was provisioned on 2026-09-04 and last rebooted the same evening (kernel 7.0.0-30);
everything came back on its own — nginx, fail2ban, docker — in about 30 s. The `webtop` desktop container
that came with the box was removed on Berkay's word that evening (its data stays in `/opt/webtop/config` and
`/srv/workspace`, the compose file in `/opt/webtop`); port 3001 is closed again.

## The server

`root@64.177.43.110` — Ubuntu 26.04, 8 CPU / 30 GB / 600 GB. Key-based SSH; the key that deploys
from GitHub can do nothing else (see below).

Installed: nginx 1.28 (site config in `/etc/nginx/sites-available/rovecode`, the default server
on :80), fail2ban (sshd jail, 1 h ban after 5 failures in 10 min), ufw (22, 80, 443 — nothing else), unattended-upgrades,
certbot + python3-certbot-nginx (unused until there is a domain), bun and node for builds.
Time zone Europe/Istanbul.

Web root layout — atomic releases:

```
/var/www/rovecode/
  current  → releases/20260904-191403      (symlink; nginx root)
  releases/20260904-173814/ … 20260904-191403/   (five kept)
```

nginx serves `current` with `try_files $uri $uri/ $uri.html =404`, a real `404.html`, gzip,
30-day immutable caching on hashed assets, `no-cache` on html, `server_tokens off`.
Ubuntu's `nginx.conf` already sets `gzip on` and `server_tokens` — a `conf.d` file that repeats
them fails `nginx -t` with "directive is duplicate" (this cost the first bootstrap run).

## Deploying

```
bun run deploy                 # in the SITE repo: build:all → tar over ssh → new release → flip current → curl 200
scripts/deploy.sh --no-docs    # landing page only (bun run build), no /docs/ or /market/
scripts/deploy.sh --no-build   # ship the existing dist/
scripts/deploy.sh --check      # after the flip, walk every URL in the live sitemap
scripts/deploy.sh --rollback   # the previous release becomes current
DEPLOY_HOST=root@1.2.3.4 scripts/deploy.sh   # another host
```

The default build target is `build:all` (`VITE_DOCS=1 VITE_MARKET=1`) — `/docs/` and `/market/`, plus
the markdown mirror, 735 pages in all. The flip is the last step, so a half-uploaded release is never
served. Verification is a GET with a 200 check; `--check` then runs `scripts/live-check.mjs` (in the site repo) over
every URL in the live sitemap (status, lang, canonical, hreflang, console, axe) and **rolls back only
after two failed attempts**, because a headless Chromium that crashes on one page once is not evidence
that the release is bad — it rolled a good release back before that second attempt existed.

**The manual deploy and the CI deploy used to ship different things.** the two-deploy-paths problem is gone with the split: there is one build
script and one deploy script, both in the site repository. `.github/workflows/site.yml` was deleted from
this repo rather than fixed — a workflow that builds a directory this repo no longer has is worse than
no workflow. If CI deploys are wanted again, the workflow belongs in the site repo, where the build is.

A full sweep of 735 pages is memory-hungry: it was killed by the OOM killer on a loaded workstation
mid-run, after the upload and the flip had already succeeded. `--shard i/n` and `--only <substring>`
exist for that — a shard is a sample, not equivalent to the sweep, and the difference is worth stating
when reporting a result.

## What nginx serves, and three things it was doing wrong

Measured 2026-09-05 on the live host and fixed there:

- **The markdown mirror was served without a charset.** `Content-Type: text/markdown` with no
  `charset=utf-8`: HTTP does not default `text/*` to UTF-8, and unlike an HTML page a `.md` file has no
  `<meta charset>` to fall back on, so every em dash and middle dot arrived as mojibake for a client
  that believed the header. That surface exists to be read by other agents, which is exactly the
  audience least likely to guess. Fixed with `charset utf-8; charset_types text/markdown …`.
- **`.md` was not in `gzip_types`.** 404 KB of mirror served uncompressed; the index alone went
  10,465 → 4,397 bytes once added, and it is the same prose that compresses 83% as HTML.
- **`font/woff2` WAS in `gzip_types`.** woff2 is already compressed; gzipping it measurably produced a
  larger response (24,836 → 24,864 bytes) and spent CPU per request to do it. Removed.

Also: hashed assets carried both an `expires 30d` and an `add_header Cache-Control … immutable`, so
every asset answered with two `Cache-Control` headers, and the shorter one contradicted the config's
own comment ("can be cached for a year"). The filenames are content-hashed, so it is now a single
one-year immutable header.

## GitHub Actions

`.github/workflows/site.yml` builds and deploys on every push to `main` that touches `site/`;
`.github/workflows/ci.yml` runs `tsc` + `bun test` on Ubuntu for everything else. The suite is
Linux-clean — tests must not assume `C:/` paths, backslash separators or readdir order. It is also
home-clean: `bunfig.toml` preloads `test/helpers/isolate-home.ts`, which sets `ROVECODE_HOME` to an
empty temp directory before the first test file loads and clears every `*_API_KEY`, `GITHUB_TOKEN`/`GH_TOKEN`
and `ROVECODE_*` variable (except the home and the fuzz seeds), so a run on a developer's machine sees the same
nothing CI does — no installed skills, plugins, MCP servers, credentials, or exported keys and knobs. A test
that needs a home or a variable writes its own and sets it itself; do not write one that reads the real
`~/.rovecode` or the shell's environment.

The deploy key is bound on the server (`~/.ssh/authorized_keys`) to a forced command,
`/usr/local/bin/rovecode-deploy-receive`, with `no-pty` and no forwarding: it reads a tar.gz of
the build on stdin, unpacks it as a new release, refuses without an `index.html`, flips
`current`, keeps five. Secrets: `DEPLOY_SSH_KEY` (private key), `DEPLOY_KNOWN_HOSTS` (the host
key line, `StrictHostKeyChecking=yes`), `DEPLOY_HOST`. Optional repository variable `SITE_URL`
for absolute social tags once a domain exists (the build falls back to the IP).

If the Actions jobs show "not started because recent account payments have failed", that is the
organisation's GitHub billing, not the workflow — deploy by hand with the script meanwhile.

## Open

- No domain → HTTP only. When one points at the IP: `certbot --nginx -d <domain>`, then set
  `SITE_URL` and rebuild so canonical / og:url carry the domain.
- Root password login is still enabled; with the key in place `PermitRootLogin prohibit-password`
  in `/etc/ssh/sshd_config` closes it.
