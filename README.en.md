# Tối Nay Lọ Gì? 🎰

[Tiếng Việt](README.md) · **English**

A local case-opening app that selects a XXX actress. Its local server crawls XXX.Guru's monthly-view ranking, best-effort enriches profiles from AvBase and Minnano-AV, and refreshes the pool weekly.

<video src="assets/promo.mp4" controls="controls" muted="muted" width="100%"></video>

## Run locally

Node.js 22.12+ and the pnpm version in `package.json` are required.

```sh
pnpm install --frozen-lockfile
cp .env.example .env
redis-server
pnpm dev
```

Open [127.0.0.1:3000](http://127.0.0.1:3000). The first crawl runs in the background; the browser waits for a local snapshot and never fetches XXX.Guru itself. Use `pnpm data:refresh` to force a refresh or debug it. A new snapshot is published only after every list, movie, profile and declared image validates, so a failed refresh preserves the current cache.

```sh
pnpm test
pnpm typecheck
pnpm lint
pnpm build
pnpm preview
# Build smoke test in a temporary directory, without live crawling:
pnpm test:production
```

Use `pnpm start` or `pnpm preview` for a production build, not bare `next start`. The `scripts/serve.mjs` entry serves the existing `/actress-cache/` URLs from the filesystem on each request and passes all other requests to Next.js. Snapshots/images created after startup therefore become available without restarting the server. Only valid manifests, status files, snapshots and images are served; this adds no API and does not expose locks or staging files. Manifests/status use no-store; snapshots/images use ETag revalidation so same-ID edits are also visible.

The server defaults to loopback only. During enrichment, it uses `impit` with a Chrome TLS fingerprint only for AvBase requests; an AvBase error, 403, or 429 never prevents a new XXX.Guru snapshot from publishing. Once a snapshot exists, the browser loads local JSON/images only; XXX.Guru, AvBase, Wikipedia, X, Instagram, and TikTok links open solely after a user click.

## Local data

- Snapshot v4 and crawler images are in gitignored `public/actress-cache/`; existing v3 snapshots remain readable during refresh.
- XXX.Guru determines ranking/tier. AvBase is a best-effort supplement for Japanese name/reading, birthday, measurements, cup, blood type, hometown, hobbies, social links, Wikipedia, and DMM images copied into the local cache.
- Minnano-AV supplies ratings, tags, debut year and its source link. Each refresh reloads enrichment while reusing lookup caches within that run; network/blocking failures are not cached as “not found.”
- Locks live in gitignored `.cache/jav-crawler/refresh.lock/`, with an owner token/PID/hostname. A lock is not stolen merely for running over an hour; automatic recovery requires a confirmed dead PID on this host. Legacy, malformed or uncertain owners require inspection and stopping the owner before manual cleanup. Staging and publish temporary files are placed on the output cache filesystem for atomic renames.
- Client polling is sequential, bounded by a timeout and retried automatically. If the next snapshot cannot load, the last usable list remains visible with a warning rather than a misleading “Ready” status.
- Tier filters, actress exclusions, language, latest choice, and the local spin count use bounded, versioned host-only cookies. The local count belongs only to this browser.
- `SERVER-WIDE OPENS` is the number of completed case openings shared by clients of the same local Next.js server. It is stored in Redis under `toinaylogi:opens`; the connection string is server-only `REDIS_URL` in `.env` (the `.env.example` default is local `redis://localhost:6379`). It is not a hosted/community deployment metric.
- If Redis is down, cases and the local count still work. The server counter shows unavailable and retries when the page reloads or another case completes.

## GitHub Pages, contributing and history

GitHub Pages redirects only to https://truanayangi.com/; only `pages-redirect/` is published to `gh-pages`, while this local app stays on `main`. Issues and fork PRs to `main` are welcome in Vietnamese or English, including drafts.

Inspired by [nagisanzenin/truanayangi](https://github.com/nagisanzenin/truanayangi). This repository preserves history from `nagisanzenin/truanayangi`. See [ATTRIBUTION.md](ATTRIBUTION.md) for asset credits.
