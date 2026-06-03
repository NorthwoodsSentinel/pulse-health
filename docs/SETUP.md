# Setup — Deploy pulse-health on your own Cloudflare account

This walkthrough takes you from zero to a deployed Worker with a working push channel. Total time: roughly an hour if you're already familiar with Cloudflare; a few hours if you're not. No prior pulse-health knowledge required.

## Prerequisites

- **A Cloudflare account.** Free tier suffices for everything in this guide. Sign up at [dash.cloudflare.com](https://dash.cloudflare.com).
- **A GitHub account** (to clone this repo).
- **A machine with these installed:**
  - [Bun](https://bun.sh) ≥ 1.3 — the JavaScript runtime + package manager.
  - [Wrangler](https://developers.cloudflare.com/workers/wrangler/install-and-update/) ≥ 4.92 — Cloudflare's CLI.
- **An Android phone** (Pixel, Samsung, etc.) for the PWA dashboard. iOS works for installed PWAs since iOS 16.4, but Web Push requires home-screen add first.
- **Optional but recommended:** an Oura ring or Strava account (the substrate is useful without them, but the daily digest has nothing to summarize until at least one upstream is connected).

## 1. Clone and inspect

```bash
git clone https://github.com/NorthwoodsSentinel/pulse-health.git
cd pulse-health
bun install
```

The `bun install` is for type-checking only — the deployed Worker has zero npm dependencies at runtime.

## 2. Authenticate Wrangler

Wrangler needs your Cloudflare credentials. Two options:

**Option A: Browser login (easiest).**
```bash
wrangler login
```
This opens a browser tab; click through. Token is stored locally.

**Option B: API token (for CI or scripted use).**
1. Visit [dash.cloudflare.com/profile/api-tokens](https://dash.cloudflare.com/profile/api-tokens) and create a token with these permissions:
   - Account → Workers Scripts → Edit
   - Account → D1 → Edit
   - Account → Workers KV Storage → Edit (only if you add KV later)
2. Export it:
   ```bash
   export CLOUDFLARE_API_TOKEN=<your token>
   ```

Verify:
```bash
wrangler whoami
```

## 3. Create the D1 database

```bash
wrangler d1 create pulse-health-db
```

Output includes a `database_id`. Copy it.

Edit `wrangler.toml` and paste the ID into the `[[d1_databases]]` block:

```toml
[[d1_databases]]
binding = "DB"
database_name = "pulse-health-db"
database_id = "PASTE-THE-UUID-HERE"
```

Apply the schema:

```bash
wrangler d1 execute pulse-health-db --remote --file=shared/schema.sql
```

You should see six tables created: `subscriptions`, `push_log`, `readings`, `tokens`, `ingest_log`, `oauth_pending`.

## 4. Generate VAPID keypair

Web Push requires a VAPID keypair so push services (FCM, APNs, Mozilla) can verify you. **This is one-time, irreversible. Lose the private key and every subscription you create goes permanently dead.**

```bash
bun shared/generate-vapid.ts
```

Output: a public key and a private key. **Immediately:**

1. Copy the **private key** into a password manager (1Password, Bitwarden, etc.) with the label `pulse-health VAPID private`.
2. Install both into the Worker:
   ```bash
   echo -n '<public key>'  | wrangler secret put VAPID_PUBLIC_KEY
   echo -n '<private key>' | wrangler secret put VAPID_PRIVATE_KEY
   echo -n 'mailto:your-email@example.com' | wrangler secret put VAPID_SUBJECT
   ```
3. Clear your terminal scrollback once the secrets are uploaded.

Detail on key handling, backup, and rotation: [vapid.md](vapid.md).

## 5. Generate admin token

The admin token gates the `/api/test-push`, `/api/subscriptions`, `/api/oura/sync`, and `/api/strava/sync` endpoints.

```bash
ADMIN=$(openssl rand -hex 32)
echo "Admin token: $ADMIN  (save to 1Password now)"
echo -n "$ADMIN" | wrangler secret put ADMIN_TOKEN
```

Save the token to your password manager before clearing scrollback.

## 6. Register OAuth applications

### Oura

1. Go to [developer.ouraring.com/applications](https://developer.ouraring.com/applications), log in with your Oura account.
2. **Create New Application.** Name it anything (e.g., "My pulse-health").
3. After deploying (Step 9), come back and add a Redirect URI:
   ```
   https://<your-worker>.workers.dev/api/oura/callback
   ```
   (`<your-worker>` is whatever you set as `name` in `wrangler.toml`.)
4. Enable scopes: Email, Personal, Daily, Heartrate, Tag, Workout, Session, Stress, Heart Health, SpO2.
5. Copy the Client ID and Client Secret.
6. Install:
   ```bash
   echo -n '<client id>'     | wrangler secret put OURA_CLIENT_ID
   echo -n '<client secret>' | wrangler secret put OURA_CLIENT_SECRET
   ```

### Strava

1. Go to [developers.strava.com/settings/api](https://www.strava.com/settings/api), log in.
2. **Create & Manage Your App.**
3. Fill in app name, category (Wellness), contact email, website, and:
   - **Authorization Callback Domain:** `<your-worker>.workers.dev` (just the domain, no `https://`, no path)
4. Copy the Client ID. Reveal and copy the Client Secret.
5. Install:
   ```bash
   echo -n '<client id>'     | wrangler secret put STRAVA_CLIENT_ID
   echo -n '<client secret>' | wrangler secret put STRAVA_CLIENT_SECRET
   ```

Note: Strava is rolling out paid-subscription gating for API access (effective June 30, 2026 for existing developers). If you plan ongoing use, factor in a Strava subscription.

## 7. Deploy

```bash
wrangler deploy
```

Wrangler reports the live URL — something like `https://<your-worker>.workers.dev`. Note it down.

Verify the basics:

```bash
curl https://<your-worker>.workers.dev/api/health
# expect: {"ok":true,"ts":...,"step":"2-oura"}

curl https://<your-worker>.workers.dev/api/vapid-public-key
# expect your VAPID public key
```

## 8. Install the PWA + subscribe to push

On your phone:

1. Open Chrome (Android) or Safari (iOS) to `https://<your-worker>.workers.dev`.
2. **Install:**
   - Android Chrome will offer "Install app" automatically, or via the three-dot menu.
   - iOS Safari: Share → Add to Home Screen.
3. Open the installed PWA from your home screen.
4. Grant notification permission when prompted.
5. Open the collapsed "Channel status" section at the bottom and tap **Subscribe**.

Test the channel from your machine:

```bash
ADMIN=<your admin token>
curl -X POST https://<your-worker>.workers.dev/api/test-push \
  -H "Authorization: Bearer $ADMIN" \
  -H "Content-Type: application/json" \
  -d '{"title":"hello","body":"first push from your own substrate"}'
```

The notification should land on your phone within a couple seconds. If not, see [INCIDENT.md](INCIDENT.md) → "I'm not getting pushes anymore."

## 9. Connect Oura

In the phone's browser (or any browser):

```
https://<your-worker>.workers.dev/api/oura/connect
```

You'll be redirected to Oura's authorize screen → grant access → redirected back to a green confirmation. The Worker exchanges the code, stores tokens, runs a 30-day backfill, and pushes a notification when the first data lands.

## 10. Connect Strava

Same pattern:

```
https://<your-worker>.workers.dev/api/strava/connect
```

Strava redirects, you authorize, the callback ingests all your activity history (paginated 200 at a time). Push notification when done.

## 11. Verify the daily cron

The Worker has a cron trigger at `0 13 * * *` UTC (08:00 Central). Every morning it pulls the last 2 days from Oura and last 7 days from Strava, ingests anything new, pushes a digest if there are new rows.

Watch the first morning to confirm it fires. If it doesn't push, check `ingest_log` in D1:

```bash
wrangler d1 execute pulse-health-db --remote \
  --command "SELECT datetime(started_at/1000,'unixepoch') AS ts, source, status, rows_added, error
             FROM ingest_log ORDER BY started_at DESC LIMIT 5"
```

## What to do next

- Adjust the cron schedule in `wrangler.toml` if 08:00 CT doesn't suit you.
- Customize the digest message format in `src/index.ts` (the `scheduled()` handler).
- Add Garmin once that step ships (Step 5 on the roadmap).
- Read [ARCHITECTURE.md](ARCHITECTURE.md) to understand how it composes.

## Troubleshooting

Most issues are covered in [INCIDENT.md](INCIDENT.md). Quick first checks:

- **OAuth redirect_uri mismatch** — the URI in your provider portal must exactly match the Worker URL (no trailing slash, exact case, https not http).
- **`{"data":[],"next_token":null}` from Oura** — token is fine; your ring just hasn't synced to Oura's cloud recently. Open the Oura app on your phone to trigger sync, then re-run `/api/oura/sync`.
- **"Pop on screen" notification not showing** — Android's Notification Organizer may be silencing low-priority new apps. In Settings → Apps → pulse → Notifications → General, turn on **Pop on screen** and **Vibration**.

## License

Apache 2.0 — see [LICENSE](../LICENSE).
