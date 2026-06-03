# VAPID key handling

## What VAPID is

VAPID = Voluntary Application Server Identification for Web Push. An ECDSA P-256 keypair that lets push services (Apple, Google, Mozilla) verify *this server* is allowed to push to subscriptions registered with *its public key*.

## Why it matters here

- The public key is embedded in the PWA so the browser binds each subscription to it.
- The private key signs the JWT on every push.
- **Lose the private key → every existing subscription becomes unreachable.** The push services check the JWT against the public key the subscription was issued for. A new keypair = old subscriptions are dead, every device has to re-subscribe.
- **Leak the private key → an attacker can push arbitrary notifications to every active subscription** until you rotate. Rotation invalidates all subscriptions, so it's an expensive remediation.

## Generation

```bash
cd /root/projects/pulse-health
bun shared/generate-vapid.ts
```

Output prints once. Two keys:

- `VAPID_PUBLIC_KEY` — safe to embed in PWA, safe to commit, safe to log
- `VAPID_PRIVATE_KEY` — Worker secret only

## Storage protocol

1. The generator script prints both keys to stdout and does not write to disk.
2. Immediately copy the **private key** into 1Password under label `pulse-health VAPID private`. Include the public key as a note for reference.
3. Install both into the Worker via `wrangler secret put`.
4. Clear terminal scrollback (`clear; history -c`) on the host where you ran the generator.
5. Do not paste the private key into any chat, log, or doc.

## Backup verification

Periodically (quarterly), verify the 1Password copy still matches what's deployed:

```bash
# Server-side: fingerprint of currently-installed public key
curl -s https://<your-worker>.workers.dev/api/vapid-public-key | jq -r .key | sha256sum
```

The same SHA-256 should be computable from the public key stored in 1Password. If they diverge, the deploy was rotated without updating the backup.

## Rotation procedure

Rotation invalidates every existing subscription on every device. Only rotate if the private key is compromised or you're moving to a fresh account.

1. Generate a new keypair with the script above.
2. Install both keys as new Worker secrets.
3. Deploy.
4. Tell every subscribed device to re-open the PWA and tap "Re-subscribe". The PWA will detect the new public key, unsubscribe the dead subscription, and create a new one.
5. The `push_log` table will show 410 GONE responses for old subscriptions on the next push attempt; the Worker auto-marks those rows `active = 0`.
