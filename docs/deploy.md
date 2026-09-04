# Deploying the site and running the server

The site (`site/`) is static: Vite builds it, nginx serves it, and nothing on the server runs Node. This
page is the reference for that setup — what the host holds, how a release lands, and how to roll one back.
Every step described here is idempotent, so re-running any of it on a fresh host reproduces the same state.
The current host was provisioned on 2026-09-04 and last rebooted the same evening (kernel 7.0.0-30);
everything came back on its own — nginx, fail2ban, docker with the webtop container — in about 30 s.

## The server

`root@64.177.43.110` — Ubuntu 26.04, 8 CPU / 30 GB / 600 GB. Key-based SSH; the key that deploys
from GitHub can do nothing else (see below).

Installed: nginx 1.28 (site config in `/etc/nginx/sites-available/rovecode`, the default server
on :80), fail2ban (sshd jail, 1 h ban after 5 failures in 10 min), ufw (22, 80, 443, plus 3001
which was already there for a `webtop` container that is not ours to touch), unattended-upgrades,
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
bun run deploy:site            # build site/ with /docs/ → tar over ssh → new release → flip current → curl 200
scripts/deploy-site.sh --no-docs    # landing page only (bun run build), no /docs/ section
scripts/deploy-site.sh --no-build   # ship the existing site/dist
scripts/deploy-site.sh --rollback   # the previous release becomes current
DEPLOY_HOST=root@1.2.3.4 scripts/deploy-site.sh   # another host
```

`/docs/` (7 pages × 15 locales, `bun run build:docs`) has shipped with the site since release
20260904-191403; the GitHub workflow builds the same target. The flip is the last step, so a
half-uploaded release is never served. Verification is a GET
on the page with a 200 check; `site/scripts/live-check.mjs` (`bun run live-check`) walks every
URL in the live sitemap for the full per-page check (lang, canonical, hreflang, 0 console).

## GitHub Actions

`.github/workflows/site.yml` builds and deploys on every push to `main` that touches `site/`;
`.github/workflows/ci.yml` runs `tsc` + `bun test` on Ubuntu for everything else. The suite is
Linux-clean — tests must not assume `C:/` paths, backslash separators or readdir order.

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
