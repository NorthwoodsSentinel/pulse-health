# pulse-health

Personal health-data substrate on Cloudflare. Pulls Oura, Strava, and (planned) Garmin into your own D1 database; pushes morning digests to an installed PWA on your phone. Replaces hosted dashboards (Whoop, Garmin Connect, Apple Health) with infrastructure you own end to end.

> **Status.** Step 2 verified. Oura and Strava ingest working; Web Push channel live; PWA dashboard renders last night's sleep, readiness, and most recent activity. Garmin integration scaffold pending. Designed to run on YOUR Cloudflare account — no shared platform, no SaaS layer.

## What it does

- **Single Cloudflare Worker** serves both the PWA dashboard and the push backend (no separate Pages project needed; uses Workers Static Assets binding).
- **D1 stores every reading** — sleep, readiness, HRV, activities, workouts — with the raw provider payload preserved. Years-deep history is a query, not a guess.
- **VAPID-signed Web Push** delivers daily digests to your phone. No Signal, no Twilio, no Apple Developer Program. The PWA installs from Chrome on Android; iOS works after home-screen add.
- **PKCE-compliant OAuth for Oura**, standard OAuth2 for Strava, refresh-token rotation built in.
- **Daily cron** pulls fresh data and pushes a notification when there's something new.
- **Channel decoupled from ingest** — if an upstream is down, the substrate continues. Push log records every delivery attempt for audit.

## Why it exists

Most health-tracking platforms hold your data. They surface dashboards that disappear when you cancel a subscription or they pivot. They sell aggregate insights about you to third parties. The OAuth tokens they hold can be revoked at any time without notice.

pulse-health holds the data on YOUR Cloudflare account. The dashboard lives at a URL you control. The notifications come from your Worker, signed by your VAPID keypair. There's no middleware to fail. If Oura changes their API, you patch one file. If you stop wanting it, you delete one Worker and the data goes with it.

This is part of the [Northwoods stack](https://github.com/NorthwoodsSentinel) — substrate-first personal AI infrastructure on Cloudflare.

## Quickstart

Full deploy walkthrough: **[docs/SETUP.md](docs/SETUP.md)**.

Short version:

1. Clone this repo.
2. Have a Cloudflare account, install `wrangler` and `bun`.
3. Create the D1 database and apply the schema.
4. Generate VAPID keys (one script).
5. Register OAuth apps with Oura and Strava (their developer portals — links in SETUP.md).
6. Install secrets via `wrangler secret put`.
7. `wrangler deploy`.
8. Open the deployed URL on your phone, install the PWA, subscribe.
9. Visit `/api/oura/connect` and `/api/strava/connect` on the phone to authorize each upstream.

The push channel is the first thing that comes alive; data ingest follows once you authorize.

## Architecture

See **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** for the full design — Worker layout, D1 schema, OAuth flow, PKCE for Oura, push delivery hand-rolled on Web Crypto.

## Operations

- **[docs/INCIDENT.md](docs/INCIDENT.md)** — runbook for when pushes stop, tokens expire, D1 fills, the worker 500s.
- **[docs/vapid.md](docs/vapid.md)** — VAPID key handling, backup, rotation.

## Status & roadmap

- [x] Step 1: Channel proof-of-life (PWA + Web Push)
- [x] Step 2: Oura fetcher with PKCE + historical backfill + daily cron
- [x] Step 3: Strava fetcher + activity backfill
- [x] Step 4: Dashboard view in the PWA showing latest digest
- [ ] Step 5: Garmin webhook receiver (OAuth + push subscription registration)
- [ ] Step 6: Fusion + classification (replace VPS Clive's morning digest logic)
- [ ] Step 7: Overwatch probes (Brook-style outcome verification — did fresh data land, are tokens expiring, are endpoints reachable)
- [ ] Step 8: CGM source (Dexcom Stelo when its API opens, or Libre via Nightscout bridge)

## License

Apache 2.0. See [LICENSE](LICENSE).

The license allows commercial redistribution. The social request: please don't repackage this as your own product. Build on top of it, fork it, deploy it for your own use, share modifications — that's the point. Just don't relabel it.

## Acknowledgments

- The Web Push payload encryption (RFC 8291) implementation is hand-rolled on Web Crypto, following the spec directly. No npm push library is used, so the dependency surface stays small.
- The Oura PKCE flow was figured out by reading the [Raycast Oura extension](https://github.com/raycast/extensions/tree/main/extensions/oura) and [meimakes/oura-mcp-server](https://github.com/meimakes/oura-mcp-server) source — both verified-current implementations that surfaced the migration from non-PKCE to PKCE that older references (mitchhankins, eei) hadn't caught up to.
