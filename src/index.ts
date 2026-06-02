// pulse-health worker.
// Routes:
//   GET  /api/vapid-public-key  → returns the public key for PWA subscribe()
//   POST /api/subscribe         → stores a push subscription in D1
//   POST /api/test-push         → fires a test notification to all active subs (bearer-gated)
//   GET  /api/health            → status JSON
//   GET  /api/subscriptions     → count of active subs (bearer-gated)
//   *                           → static asset (PWA) via ASSETS binding

import { sendPush } from "./push";

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  VAPID_PUBLIC_KEY: string;
  VAPID_PRIVATE_KEY: string;
  VAPID_SUBJECT: string;        // mailto:robert.chuvala@gmail.com
  ADMIN_TOKEN: string;          // gates /api/test-push and /api/subscriptions
}

function json(data: unknown, status = 200, extra: HeadersInit = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extra,
    },
  });
}

function requireAdmin(req: Request, env: Env): Response | null {
  const auth = req.headers.get("authorization") ?? "";
  const want = `Bearer ${env.ADMIN_TOKEN}`;
  if (!env.ADMIN_TOKEN || auth !== want) {
    return json({ error: "unauthorized" }, 401);
  }
  return null;
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    // --- API routes ---
    if (path === "/api/health" && method === "GET") {
      return json({ ok: true, ts: Date.now(), step: "1-channel-proof-of-life" });
    }

    if (path === "/api/vapid-public-key" && method === "GET") {
      return json({ key: env.VAPID_PUBLIC_KEY });
    }

    if (path === "/api/subscribe" && method === "POST") {
      let body: { endpoint?: string; keys?: { p256dh?: string; auth?: string }; userAgent?: string };
      try {
        body = await req.json();
      } catch {
        return json({ error: "invalid json" }, 400);
      }
      const endpoint = body.endpoint?.trim();
      const p256dh = body.keys?.p256dh?.trim();
      const auth = body.keys?.auth?.trim();
      if (!endpoint || !p256dh || !auth) {
        return json({ error: "missing endpoint or keys" }, 400);
      }
      const ua = body.userAgent ?? req.headers.get("user-agent") ?? null;
      const now = Date.now();
      await env.DB.prepare(
        `INSERT INTO subscriptions (user_id, endpoint, p256dh_key, auth_secret, user_agent, created_at, last_seen_at, active)
         VALUES ('rob', ?1, ?2, ?3, ?4, ?5, ?5, 1)
         ON CONFLICT(endpoint) DO UPDATE SET
           p256dh_key = excluded.p256dh_key,
           auth_secret = excluded.auth_secret,
           user_agent = excluded.user_agent,
           last_seen_at = excluded.last_seen_at,
           active = 1`,
      )
        .bind(endpoint, p256dh, auth, ua, now)
        .run();
      return json({ ok: true });
    }

    if (path === "/api/subscriptions" && method === "GET") {
      const denied = requireAdmin(req, env);
      if (denied) return denied;
      const row = await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM subscriptions WHERE active = 1",
      ).first<{ n: number }>();
      return json({ active: row?.n ?? 0 });
    }

    if (path === "/api/test-push" && method === "POST") {
      const denied = requireAdmin(req, env);
      if (denied) return denied;
      const body = await req.json().catch(() => ({}));
      const title = (body as any)?.title ?? "pulse-health";
      const message =
        (body as any)?.body ??
        `Test push from health.robert-chuvala.workers.dev — ${new Date().toLocaleString()}`;

      const subs = await env.DB.prepare(
        "SELECT id, endpoint, p256dh_key, auth_secret FROM subscriptions WHERE active = 1",
      ).all<{ id: number; endpoint: string; p256dh_key: string; auth_secret: string }>();

      const results = [];
      for (const sub of subs.results ?? []) {
        const payload = JSON.stringify({ title, body: message, url: "/" });
        const res = await sendPush(sub, payload, {
          publicKey: env.VAPID_PUBLIC_KEY,
          privateKey: env.VAPID_PRIVATE_KEY,
          subject: env.VAPID_SUBJECT,
        });
        await env.DB.prepare(
          `INSERT INTO push_log (sent_at, subscription_id, title, body, status_code, error)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
        )
          .bind(Date.now(), sub.id, title, message, res.status, res.error ?? null)
          .run();
        if (res.status === 404 || res.status === 410) {
          // endpoint dead — mark inactive
          await env.DB.prepare("UPDATE subscriptions SET active = 0 WHERE id = ?1")
            .bind(sub.id)
            .run();
        }
        results.push({ id: sub.id, status: res.status, error: res.error ?? null });
      }
      return json({ sent: results.length, results });
    }

    // --- Static assets (PWA) ---
    return env.ASSETS.fetch(req);
  },
} satisfies ExportedHandler<Env>;
