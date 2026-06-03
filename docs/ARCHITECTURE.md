# Architecture

Cloudflare-native replacement for the Hostinger Clive digest pipeline.

## Decision: one Worker, not Pages + Worker

The PWA shell and the push backend live in the **same Worker**, using the `[assets]` binding to serve static files alongside the dynamic `/api/*` routes. Reasons:

- Token has Workers + D1 permissions; Pages requires a separate scope.
- One deploy command, one set of logs, one wrangler.toml.
- Same-origin by construction — no CORS, no separate auth between PWA and backend.
- Workers Static Assets is GA and well-supported in wrangler 4.x.

If we later split (e.g. CF Pages for richer build pipelines), the Worker keeps the API path and Pages serves the UI on a custom domain. Not a Step 1 concern.

## Step 1 — channel proof-of-life

Goal: prove a push notification can be triggered from a Worker and land on the Pixel as a system notification. Zero upstream credentials.

Components:

- **Worker `health`** at `<your-worker>.workers.dev`
  - Serves PWA static files via `ASSETS` binding
  - `GET /api/health` — status
  - `GET /api/vapid-public-key` — public key for PWA `pushManager.subscribe()`
  - `POST /api/subscribe` — stores the endpoint + keys in D1
  - `POST /api/test-push` — fires a push to all active subscriptions (admin bearer)
  - `GET /api/subscriptions` — count of active subs (admin bearer)

- **D1 `pulse-health-db`**
  - `subscriptions` — push endpoints, one row per device, soft-deletable
  - `push_log` — audit row per push attempt (status, error)

- **Web Push delivery** — hand-rolled on Web Crypto (`src/push.ts`)
  - VAPID JWT, ES256
  - RFC 8291 aes128gcm payload encryption
  - No npm push library — smaller attack surface, no Node compat layer

- **PWA** — plain HTML + ESM, no framework
  - `index.html` — three-pill status panel + subscribe button + log
  - `app.js` — registers SW, requests permission, calls `pushManager.subscribe`, POSTs to `/api/subscribe`
  - `sw.js` — handles `push` events and notification click-through
  - `manifest.webmanifest` — installable PWA on Chrome / Pixel

## Steps 2+

- Step 2: Oura fetcher (cron Worker, pulls daily, writes `readings`)
- Step 3: Strava fetcher
- Step 4: Garmin push receiver + parser
- Step 5: fusion + classifier + daily digest push
- Step 6: Brook-style overwatch probes
- Step 7: retire Clive timers on the Hostinger VPS

## Security model

See `docs/INCIDENT.md` for response procedures and `docs/vapid.md` for key handling.

- VAPID private key: Worker secret only. Backed up offline. Loss = all subscriptions permanently dark.
- Admin token: gates `/api/test-push` and `/api/subscriptions`. Bearer in `Authorization` header.
- `/api/subscribe` is open in Step 1 (worst case: garbage rows). Closes behind Cloudflare Access once a custom domain is added in Step 2.
- D1: bound to the Worker, no public read.
- Refresh tokens (added Step 2): encrypted at rest in D1 with `D1_TOKEN_ENC_KEY`.

## Account

Cloudflare account: **Northwoods Sentinel Command Center** (`359bbec67c35603c232096900443f5f5`).
Co-located with: brook, daemon, big-head-todd, sentinel, mycelia-api.
