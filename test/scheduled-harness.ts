// scheduled-harness.ts — runs the Worker's real `scheduled` handler once, against an
// in-memory SQLite database behind a minimal D1 shim, with the network and Web Push
// stubbed. Used by test/scheduled.test.ts. The fixture and result shapes are the contract
// given to the test author (Codex, MODE tests, 2026-11-12, NOR-289).

import { mock, setSystemTime } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "fs";
import { join } from "path";

export type Fixture = {
  priorIngestLog?: Array<{ source: "oura" | "strava"; status: string; trigger?: "cron" | "manual" }>;
  ouraToken?: boolean;
  stravaToken?: boolean;
  oura?: "ok" | "partial" | "throw";
  strava?: "ok" | "partial" | "throw";
  ouraNewRows?: boolean;
  lastOuraReadingAgeHours?: number | null;
  ntfy?: "ok" | "429" | "throw";
  push?: "ok" | "throw";
};

export type RunResult = {
  ingestLog: Array<{ source: string; status: string; trigger: string; rows_added: number; error: string | null }>;
  ntfy: Array<{ title: string; body: string; priority: string }>;
  pushes: Array<{ title: string; body: string }>;
  driftLogged: boolean;
  threw: boolean;
};

const SCHEMA = readFileSync(join(import.meta.dir, "..", "shared", "schema.sql"), "utf8");
// A fixed instant, mid-month, at the cron hour: the drift watcher's first-of-month message
// and anything else date-dependent stays out of the way.
export const NOW = new Date("2026-11-12T13:00:00Z");
const TODAY = "2026-11-12";

// ---- Web Push stub: the real pushAll runs; only the network send is replaced. ----
let pushMode: "ok" | "throw" = "ok";
let pushCalls: Array<{ title: string; body: string }> = [];
mock.module("../src/push", () => ({
  sendPush: async (_sub: unknown, payload: string) => {
    const p = JSON.parse(payload) as { title: string; body: string };
    pushCalls.push({ title: p.title, body: p.body });
    if (pushMode === "throw") throw new Error("SECRET-PUSH-THROW");
    return { status: 201 };
  },
}));

// ---- Minimal D1 shim over bun:sqlite (prepare / bind / run / all / first / batch). ----
function d1(db: Database) {
  const make = (sql: string, args: unknown[] = []) => ({
    bind: (...a: unknown[]) => make(sql, a),
    run: async () => {
      const r = db.prepare(sql).run(...(args as never[]));
      return { success: true, meta: { changes: r.changes, last_row_id: Number(r.lastInsertRowid) } };
    },
    all: async <T>() => ({ results: db.prepare(sql).all(...(args as never[])) as T[], success: true }),
    first: async <T>() => (db.prepare(sql).get(...(args as never[])) as T | undefined) ?? null,
    __run: () => {
      const r = db.prepare(sql).run(...(args as never[]));
      return { success: true, meta: { changes: r.changes, last_row_id: Number(r.lastInsertRowid) } };
    },
  });
  return {
    prepare: (sql: string) => make(sql),
    batch: async (stmts: Array<{ __run: () => unknown }>) => stmts.map((s) => s.__run()),
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export async function runScheduled(fx: Fixture = {}): Promise<RunResult> {
  const f = {
    priorIngestLog: [],
    ouraToken: true,
    stravaToken: true,
    oura: "ok" as const,
    strava: "ok" as const,
    ouraNewRows: true,
    lastOuraReadingAgeHours: 1 as number | null,
    ntfy: "ok" as const,
    push: "ok" as const,
    ...fx,
  };

  setSystemTime(NOW);
  const now = NOW.getTime();
  const db = new Database(":memory:");
  db.exec(SCHEMA);

  for (const r of f.priorIngestLog) {
    db.prepare(
      `INSERT INTO ingest_log (source, started_at, finished_at, kinds, rows_added, rows_seen, status, trigger, error)
       VALUES (?1, ?2, ?2, '', 0, 0, ?3, ?4, NULL)`,
    ).run(r.source, now - 86400000, r.status, r.trigger ?? "cron");
  }
  const priorCount = (db.prepare("SELECT count(*) AS n FROM ingest_log").get() as { n: number }).n;

  // A token that is valid for a day needs no refresh; "throw" stores an expired one so the
  // refresh path runs and the stubbed token endpoint throws.
  const tokenRow = (source: string, expired: boolean) =>
    db.prepare(
      `INSERT INTO tokens (source, access_token, refresh_token, expires_at, scopes, updated_at)
       VALUES (?1, 'access-token-value', 'refresh-token-value', ?2, 'all', ?3)`,
    ).run(source, expired ? now - 1000 : now + 86400000, now);
  if (f.ouraToken) tokenRow("oura", f.oura === "throw");
  if (f.stravaToken) tokenRow("strava", f.strava === "throw");

  if (f.lastOuraReadingAgeHours !== null) {
    db.prepare(
      `INSERT INTO readings (source, kind, recorded_at, received_at, payload)
       VALUES ('oura', 'daily_readiness', ?1, ?2, ?3)`,
    ).run(
      new Date("2026-01-01T00:00:00Z").getTime(),
      now - f.lastOuraReadingAgeHours * 3600 * 1000,
      JSON.stringify({ id: "seed", day: "2026-01-01", score: 80 }),
    );
  }

  db.prepare(
    `INSERT INTO subscriptions (endpoint, p256dh_key, auth_secret, created_at, active)
     VALUES ('https://push.example/sub1', 'k', 'a', ?1, 1)`,
  ).run(now);

  pushMode = f.push;
  pushCalls = [];
  const ntfyCalls: RunResult["ntfy"] = [];

  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

    if (url.startsWith("https://ntfy.sh/")) {
      const h = new Headers(init?.headers);
      ntfyCalls.push({
        title: h.get("Title") ?? "",
        body: typeof init?.body === "string" ? init.body : "",
        priority: h.get("Priority") ?? "",
      });
      if (f.ntfy === "throw") throw new Error("SECRET-NTFY-THROW");
      return new Response(f.ntfy === "429" ? "rate limited" : "ok", { status: f.ntfy === "429" ? 429 : 200 });
    }

    if (url.startsWith("https://api.ouraring.com/oauth/token")) {
      throw new Error("SECRET-OURA-THROW");
    }
    if (url.startsWith("https://api.ouraring.com/v2/usercollection/")) {
      const kind = url.slice("https://api.ouraring.com/v2/usercollection/".length).split("?")[0];
      if (f.oura === "partial" && kind === "daily_stress") {
        return new Response("SECRET-OURA-BODY", { status: 500 });
      }
      if (!f.ouraNewRows) return jsonResponse({ data: [], next_token: null });
      const item: Record<string, unknown> = { id: `${kind}-new`, day: TODAY };
      if (kind === "sleep") Object.assign(item, { type: "long_sleep", total_sleep_duration: 25200, average_hrv: 100 });
      if (kind === "daily_stress") Object.assign(item, { stress_high: 0, recovery_high: 0, day_summary: null });
      if (kind === "daily_sleep" || kind === "daily_readiness") Object.assign(item, { score: 80 });
      return jsonResponse({ data: [item], next_token: null });
    }

    if (url.startsWith("https://www.strava.com/oauth/token")) {
      throw new Error("SECRET-STRAVA-THROW");
    }
    if (url.startsWith("https://www.strava.com/api/v3/athlete/activities")) {
      return jsonResponse([]);
    }
    if (url.startsWith("https://www.strava.com/api/v3/athletes/")) {
      return jsonResponse({ all_ride_totals: { count: 0 } });
    }
    if (url.startsWith("https://www.strava.com/api/v3/athlete")) {
      if (f.strava === "partial") return new Response("SECRET-STRAVA-BODY", { status: 403 });
      return jsonResponse({ id: 1 });
    }

    throw new Error(`unexpected fetch in test: ${url}`);
  }) as typeof fetch;

  const worker = (await import("../src/index")).default as {
    scheduled: (e: unknown, env: unknown, ctx: { waitUntil: (p: Promise<unknown>) => void }) => Promise<void>;
  };
  const env = {
    DB: d1(db),
    ASSETS: {},
    ADMIN_TOKEN: "admin",
    OURA_CLIENT_ID: "oura-client-id",
    OURA_CLIENT_SECRET: "oura-client-secret",
    STRAVA_CLIENT_ID: "strava-client-id",
    STRAVA_CLIENT_SECRET: "strava-client-secret",
    VAPID_PUBLIC_KEY: "pub",
    VAPID_PRIVATE_KEY: "priv",
    VAPID_SUBJECT: "mailto:test@example.com",
  };

  let threw = false;
  const pending: Promise<unknown>[] = [];
  try {
    await worker.scheduled({ scheduledTime: now, cron: "0 13 * * *" }, env, {
      waitUntil: (p) => void pending.push(p),
    });
    const settled = await Promise.allSettled(pending);
    threw = settled.some((s) => s.status === "rejected");
  } catch {
    threw = true;
  } finally {
    globalThis.fetch = realFetch;
    setSystemTime();
  }

  const ingestLog = db
    .prepare("SELECT source, status, trigger, rows_added, error FROM ingest_log WHERE id > ?1 ORDER BY id")
    .all(priorCount) as RunResult["ingestLog"];
  const hasDrift =
    (db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='drift_log'").get() as { n: number }).n > 0;
  const driftLogged = hasDrift && (db.prepare("SELECT count(*) AS n FROM drift_log").get() as { n: number }).n > 0;
  db.close();

  return { ingestLog, ntfy: ntfyCalls, pushes: [...pushCalls], driftLogged, threw };
}
