# Incident response

What to do when something rings the wrong bell.

## "I'm not getting pushes anymore"

1. Open the PWA on the Pixel. Look at the three pills.
   - Notification permission `denied` → fix in system settings, return.
   - Service worker not registered → tap "Re-subscribe", read the log panel.
   - Subscribed but pushes silent → continue to #2.
2. From any shell:
   ```bash
   curl -X POST https://health.robert-chuvala.workers.dev/api/test-push \
     -H "Authorization: Bearer $ADMIN_TOKEN" \
     -d '{"title": "diag", "body": "diag"}'
   ```
   Read the JSON response. Each subscription has a `status`:
   - `201` or `200` — push delivered to FCM/APNs; if your phone didn't show it, the OS suppressed it (Do Not Disturb, focus mode, battery saver).
   - `404`/`410` — subscription is dead, Worker auto-disabled it. Re-subscribe from the PWA.
   - `403` — VAPID JWT rejected. Most likely the private key was rotated or `VAPID_SUBJECT` is missing/invalid.
   - `0` — exception inside the Worker. Check Workers logs.
3. Check Workers logs in real-time:
   ```bash
   wrangler tail health
   ```

## "Pushes are going to the wrong place"

This was the original Signal-cli bug — `signal_send.py` sent to a contact thread instead of Note to Self. Web Push doesn't have this failure mode: notifications land in the system tray of the device that registered the subscription, full stop. If you're seeing them on a device you didn't expect, that device subscribed to the PWA.

To see every active subscription:

```bash
wrangler d1 execute pulse-health-db --remote \
  --command "SELECT id, user_agent, created_at FROM subscriptions WHERE active = 1"
```

To kill one:

```bash
wrangler d1 execute pulse-health-db --remote \
  --command "UPDATE subscriptions SET active = 0 WHERE id = ?"
```

## "Worker is returning 500s"

```bash
wrangler tail health           # live logs
wrangler deployments list      # what's deployed
wrangler rollback              # back out the last deploy
```

## "D1 is full"

Free tier ceiling is 100 MB. Paid tier is 10 GB per database.

```bash
wrangler d1 info pulse-health-db
```

If `readings` is the dominant table (Step 2+), partition cold data to R2:

```bash
# export everything older than 90 days
wrangler d1 execute pulse-health-db --remote \
  --command "SELECT * FROM readings WHERE recorded_at < strftime('%s', 'now', '-90 days') * 1000" \
  --json > cold.json
# upload to R2 (separate bucket setup)
# then delete from D1
```

## "Overwatch paged me"

(Step 6+ — overwatch probes don't run yet.) When implemented, the push payload includes `probe_name`, `status`, and `detail`. Tap the notification to open the dashboard, which deep-links to the probe history. Default response: open Workers logs for the relevant service, check D1 for the most recent `readings` row from that upstream, decide whether the upstream is down or the fetcher is broken.

## "I rotated/lost the VAPID private key"

See `docs/vapid.md` → Rotation procedure. Every device has to re-subscribe.

## "I rotated/lost the admin token"

```bash
ADMIN=$(openssl rand -hex 32)
echo "$ADMIN" >> ~/1password-pending.txt  # then move to 1Password
echo -n "$ADMIN" | wrangler secret put ADMIN_TOKEN
wrangler deploy
```

Old tokens stop working immediately on next request — Worker reads secrets at request time.
