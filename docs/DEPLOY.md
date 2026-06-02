# Deploy

## Prerequisites

- `wrangler` ≥ 4.92 (`npm i -g wrangler` or `bun i -g wrangler`)
- `CLOUDFLARE_API_TOKEN` exported (read from `/root/.claude-leroy-archive/.secrets/cf_deploy_token` on Lares)
- `bun` ≥ 1.3

## One-time setup

```bash
cd /root/projects/pulse-health
export CLOUDFLARE_API_TOKEN=$(cat /root/.claude-leroy-archive/.secrets/cf_deploy_token)
export CLOUDFLARE_ACCOUNT_ID=359bbec67c35603c232096900443f5f5

# 1. Create the D1 database
wrangler d1 create pulse-health-db
# → copy the `database_id` into wrangler.toml

# 2. Apply the schema
wrangler d1 execute pulse-health-db --remote --file=shared/schema.sql

# 3. Generate VAPID keys
bun shared/generate-vapid.ts
# → copy the private key to 1Password IMMEDIATELY, then:
echo -n '<private>'  | wrangler secret put VAPID_PRIVATE_KEY
echo -n '<public>'   | wrangler secret put VAPID_PUBLIC_KEY
echo -n 'mailto:robert.chuvala@gmail.com' | wrangler secret put VAPID_SUBJECT

# 4. Generate and install admin token
ADMIN=$(openssl rand -hex 32)
echo "Admin token (save to 1Password): $ADMIN"
echo -n "$ADMIN" | wrangler secret put ADMIN_TOKEN

# 5. Deploy
wrangler deploy
```

After deploy, the worker lives at `https://health.robert-chuvala.workers.dev`.

## Subsequent deploys

```bash
cd /root/projects/pulse-health
wrangler deploy
```

## Test push (after subscribing on the Pixel)

```bash
curl -X POST https://health.robert-chuvala.workers.dev/api/test-push \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"title": "pulse-health", "body": "Hello from the substrate."}'
```

## Rollback

Cloudflare keeps the previous N deploys. To revert:

```bash
wrangler rollback
```

D1 schema migrations are forward-only by default — back up before destructive changes:

```bash
wrangler d1 export pulse-health-db --remote --output=backup-$(date +%Y%m%d).sql
```
