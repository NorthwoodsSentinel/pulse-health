// pulse-health worker.
// Routes:
//   GET  /api/health                → status JSON
//   GET  /api/vapid-public-key      → public key for PWA subscribe()
//   POST /api/subscribe             → stores a push subscription
//   POST /api/test-push             → fires a test push to all active subs (admin)
//   GET  /api/subscriptions         → count of active subs (admin)
//
//   GET  /api/oura/connect          → redirects to Oura authorize
//   GET  /api/oura/callback         → handles code exchange + initial 30-day ingest
//   POST /api/oura/sync             → manual ingest of last N days (admin)
//   GET  /api/oura/latest           → latest reading per kind
//
// Scheduled: daily Oura fetch at 13:00 UTC (08:00 CT).

import { sendPush } from "./push";
import { signState, verifyState } from "./oauth";
import * as oura from "./oura";

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  VAPID_PUBLIC_KEY: string;
  VAPID_PRIVATE_KEY: string;
  VAPID_SUBJECT: string;
  ADMIN_TOKEN: string;
  OURA_CLIENT_ID: string;
  OURA_CLIENT_SECRET: string;
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

function ouraRedirectUri(req: Request): string {
  return `${new URL(req.url).origin}/api/oura/callback`;
}

async function pushAll(env: Env, title: string, body: string, url = "/"): Promise<number> {
  const subs = await env.DB.prepare(
    "SELECT id, endpoint, p256dh_key, auth_secret FROM subscriptions WHERE active = 1",
  ).all<{ id: number; endpoint: string; p256dh_key: string; auth_secret: string }>();
  let delivered = 0;
  for (const sub of subs.results ?? []) {
    const payload = JSON.stringify({ title, body, url });
    const res = await sendPush(sub, payload, {
      publicKey: env.VAPID_PUBLIC_KEY,
      privateKey: env.VAPID_PRIVATE_KEY,
      subject: env.VAPID_SUBJECT,
    });
    await env.DB.prepare(
      `INSERT INTO push_log (sent_at, subscription_id, title, body, status_code, error)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    )
      .bind(Date.now(), sub.id, title, body, res.status, res.error ?? null)
      .run();
    if (res.status === 404 || res.status === 410) {
      await env.DB.prepare("UPDATE subscriptions SET active = 0 WHERE id = ?1")
        .bind(sub.id)
        .run();
    } else if (res.status >= 200 && res.status < 300) {
      delivered++;
    }
  }
  return delivered;
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    // -------- Status --------
    if (path === "/api/health" && method === "GET") {
      return json({ ok: true, ts: Date.now(), step: "2-oura" });
    }

    // -------- Push channel --------
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
      const body = (await req.json().catch(() => ({}))) as { title?: string; body?: string };
      const delivered = await pushAll(
        env,
        body.title ?? "pulse-health",
        body.body ?? `Test push — ${new Date().toLocaleString()}`,
      );
      return json({ delivered });
    }

    // -------- Oura --------

    if (path === "/api/oura/connect" && method === "GET") {
      const state = await signState("oura", env.ADMIN_TOKEN);
      const verifier = oura.generateCodeVerifier();
      const challenge = await oura.deriveCodeChallenge(verifier);
      // Stash verifier keyed by state. PKCE requires it at /callback.
      await env.DB.prepare(
        `INSERT INTO oauth_pending (state, source, code_verifier, created_at) VALUES (?1, 'oura', ?2, ?3)`,
      )
        .bind(state, verifier, Date.now())
        .run();
      const redirect = oura.authorizeUrl(env.OURA_CLIENT_ID, ouraRedirectUri(req), state, challenge);
      return Response.redirect(redirect, 302);
    }

    if (path === "/api/oura/callback" && method === "GET") {
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const error = url.searchParams.get("error");
      if (error) {
        return new Response(`Oura authorization failed: ${error}`, { status: 400 });
      }
      if (!code || !state) {
        return new Response("Missing code or state", { status: 400 });
      }
      const valid = await verifyState(state, "oura", env.ADMIN_TOKEN);
      if (!valid) {
        return new Response("Invalid or expired state", { status: 400 });
      }
      // Retrieve PKCE verifier matching this state, single-use.
      const pending = await env.DB.prepare(
        `SELECT code_verifier FROM oauth_pending WHERE state = ?1 AND source = 'oura'`,
      )
        .bind(state)
        .first<{ code_verifier: string }>();
      if (!pending) {
        return new Response("PKCE verifier not found for this state", { status: 400 });
      }
      await env.DB.prepare(`DELETE FROM oauth_pending WHERE state = ?1`).bind(state).run();

      try {
        const token = await oura.exchangeCode(
          code,
          env.OURA_CLIENT_ID,
          env.OURA_CLIENT_SECRET,
          ouraRedirectUri(req),
          pending.code_verifier,
        );
        await oura.storeToken(env.DB, token);

        // Initial 30-day ingest.
        const startedAt = Date.now();
        const end = new Date();
        const start = new Date(end.getTime() - 30 * 24 * 3600 * 1000);
        const result = await oura.ingestRange(env.DB, token.access_token, start, end);

        await env.DB.prepare(
          `INSERT INTO ingest_log (source, started_at, finished_at, kinds, rows_added, rows_seen, status, trigger, error)
           VALUES ('oura', ?1, ?2, ?3, ?4, ?5, ?6, 'oauth_callback', ?7)`,
        )
          .bind(
            startedAt,
            Date.now(),
            result.kinds.join(","),
            result.rowsAdded,
            result.rowsSeen,
            result.errors.length === 0 ? "success" : "partial",
            result.errors.join(" | ") || null,
          )
          .run();

        ctx.waitUntil(
          pushAll(
            env,
            "Oura connected",
            `${result.rowsAdded} new readings ingested (${result.kinds.length} kinds). Substrate is live.`,
          ),
        );

        return new Response(
          `<!doctype html><html><body style="background:#0f172a;color:#f1f5f9;font-family:system-ui;padding:24px;">
          <h1>Oura connected ✅</h1>
          <p>${result.rowsAdded} new readings ingested across ${result.kinds.length} kinds.</p>
          <p>Kinds: ${result.kinds.join(", ") || "(none)"}.</p>
          ${result.errors.length ? `<p style="color:#f87171">Errors: ${result.errors.join("; ")}</p>` : ""}
          <p><a href="/" style="color:#38bdf8;">Back to dashboard</a></p>
          </body></html>`,
          { headers: { "content-type": "text/html; charset=utf-8" } },
        );
      } catch (e) {
        return new Response(`Token exchange or initial ingest failed: ${(e as Error).message}`, {
          status: 500,
        });
      }
    }

    if (path === "/api/oura/sync" && method === "POST") {
      const denied = requireAdmin(req, env);
      if (denied) return denied;
      const body = (await req.json().catch(() => ({}))) as { days?: number };
      const days = Math.max(1, Math.min(90, body.days ?? 2));
      const access = await oura.getValidAccessToken(
        env.DB,
        env.OURA_CLIENT_ID,
        env.OURA_CLIENT_SECRET,
      );
      if (!access) return json({ error: "no oura token; visit /api/oura/connect first" }, 400);
      const startedAt = Date.now();
      const end = new Date();
      const start = new Date(end.getTime() - days * 24 * 3600 * 1000);
      const result = await oura.ingestRange(env.DB, access, start, end);
      await env.DB.prepare(
        `INSERT INTO ingest_log (source, started_at, finished_at, kinds, rows_added, rows_seen, status, trigger, error)
         VALUES ('oura', ?1, ?2, ?3, ?4, ?5, ?6, 'manual', ?7)`,
      )
        .bind(
          startedAt,
          Date.now(),
          result.kinds.join(","),
          result.rowsAdded,
          result.rowsSeen,
          result.errors.length === 0 ? "success" : "partial",
          result.errors.join(" | ") || null,
        )
        .run();
      return json({ days, ...result });
    }

    if (path === "/api/oura/latest" && method === "GET") {
      const rows = await oura.latestReadings(env.DB);
      return json({ source: "oura", latest: rows });
    }

    // -------- Static assets --------
    return env.ASSETS.fetch(req);
  },

  // Daily cron — pulls last 2 days to catch any backfill.
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      (async () => {
        const startedAt = Date.now();
        let status = "success";
        let errorMsg: string | null = null;
        let rowsAdded = 0;
        let kindsList = "";
        try {
          const access = await oura.getValidAccessToken(
            env.DB,
            env.OURA_CLIENT_ID,
            env.OURA_CLIENT_SECRET,
          );
          if (!access) {
            status = "error";
            errorMsg = "no oura token";
            return;
          }
          const end = new Date();
          const start = new Date(end.getTime() - 2 * 24 * 3600 * 1000);
          const result = await oura.ingestRange(env.DB, access, start, end);
          rowsAdded = result.rowsAdded;
          kindsList = result.kinds.join(",");
          if (result.errors.length > 0) {
            status = "partial";
            errorMsg = result.errors.join(" | ");
          }
          if (rowsAdded > 0) {
            await pushAll(
              env,
              "Oura digest",
              `${rowsAdded} new readings — ${result.kinds.join(", ") || "?"}`,
            );
          }
        } catch (e) {
          status = "error";
          errorMsg = (e as Error).message;
        } finally {
          await env.DB.prepare(
            `INSERT INTO ingest_log (source, started_at, finished_at, kinds, rows_added, rows_seen, status, trigger, error)
             VALUES ('oura', ?1, ?2, ?3, ?4, 0, ?5, 'cron', ?6)`,
          )
            .bind(startedAt, Date.now(), kindsList, rowsAdded, status, errorMsg)
            .run();
        }
      })(),
    );
  },
} satisfies ExportedHandler<Env>;
