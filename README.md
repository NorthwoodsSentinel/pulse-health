# pulse-health

Personal health-data substrate. Cloudflare Workers + D1 + Web Push to the Pixel.

Replaces the Hostinger VPS Clive digest (Oura / Strava / Garmin → fusion → Signal-cli to phone) with a Cloudflare-native substrate that pushes notifications to an installed PWA.

## Status

**Step 1 — channel proof-of-life.** PWA + push backend, no upstreams. Validates the delivery loop end-to-end before any health data flows.

Subsequent steps land Oura, Strava, Garmin, fusion, and Brook-style overwatch. See `docs/ARCHITECTURE.md`.

## Stack

- Single Cloudflare Worker (`health`) with `[assets]` binding — serves the PWA and runs the push backend
- D1 database (`pulse-health-db`) for subscriptions, readings, tokens, digests, probes
- Web Push via VAPID, hand-rolled with Web Crypto (no Node deps)
- Account: Northwoods Sentinel Command Center

## Public URL

`https://health.robert-chuvala.workers.dev`

## Maintenance

Documented in `docs/INCIDENT.md`. Overwatch probes (added in a later step) page on red transitions and write a state row readable from the dashboard.
