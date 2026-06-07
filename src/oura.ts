// Oura API client — OAuth + daily fetchers.
// Docs: https://cloud.ouraring.com/docs/

const OAUTH_AUTHORIZE = "https://cloud.ouraring.com/oauth/authorize";
const OAUTH_TOKEN = "https://api.ouraring.com/oauth/token";
const API_BASE = "https://api.ouraring.com/v2/usercollection";

const REFRESH_THRESHOLD_MS = 60 * 60 * 1000; // refresh if token expires within 1 hour

// Match Oura's example authorization URL exactly (developer.ouraring.com → app).
const SCOPES = [
  "email",
  "personal",
  "daily",
  "heartrate",
  "tag",
  "workout",
  "session",
  "stress",
  "heart_health",
  "spo2",
].join(" ");

const FETCHED_KINDS = [
  "daily_sleep",
  "daily_readiness",
  "daily_activity",
  "daily_stress",
  "sleep",
  "workout",
];

interface OuraToken {
  access_token: string;
  refresh_token: string;
  expires_in: number;   // seconds
  token_type: string;
  scope?: string;
}

interface IngestResult {
  rowsAdded: number;
  rowsSeen: number;
  kinds: string[];
  errors: string[];
}

function b64url(bytes: Uint8Array | ArrayBuffer): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = "";
  for (const b of arr) bin += String.fromCharCode(b);
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

// PKCE verifier: 32 random bytes → 43-char base64url string (RFC 7636 §4.1).
export function generateCodeVerifier(): string {
  return b64url(crypto.getRandomValues(new Uint8Array(32)));
}

// S256 code challenge: base64url(SHA-256(verifier)).
export async function deriveCodeChallenge(verifier: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return b64url(hash);
}

export function authorizeUrl(
  clientId: string,
  redirectUri: string,
  state: string,
  codeChallenge: string,
): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    state,
    scope: SCOPES,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });
  return `${OAUTH_AUTHORIZE}?${params.toString()}`;
}

// Per reference impl (mitchhankins01/oura-ring-mcp) and Oura's OpenAPI
// spec: credentials go in the body, not HTTP Basic header.
export async function exchangeCode(
  code: string,
  clientId: string,
  clientSecret: string,
  redirectUri: string,
  codeVerifier: string,
): Promise<OuraToken> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
  });
  const res = await fetch(OAUTH_TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const text = await res.text();
  if (!res.ok) {
    console.log("oura.exchangeCode FAIL", {
      status: res.status,
      body: text,
      sent: {
        url: OAUTH_TOKEN,
        grant_type: "authorization_code",
        code_len: code.length,
        client_id: clientId,
        client_secret_len: clientSecret.length,
        redirect_uri: redirectUri,
        code_verifier_len: codeVerifier.length,
      },
    });
    throw new Error(`Oura token exchange failed: ${res.status} ${text.slice(0, 800)}`);
  }
  // Log the EXACT shape of Oura's success response so we know what fields they return.
  // Redact actual token values; keep token_type, expires_in, scope, and the key names present.
  try {
    const parsed = JSON.parse(text);
    console.log("oura.exchangeCode OK", {
      keys: Object.keys(parsed),
      token_type: parsed.token_type,
      expires_in: parsed.expires_in,
      scope: parsed.scope,
      access_token_len: typeof parsed.access_token === "string" ? parsed.access_token.length : null,
      refresh_token_len: typeof parsed.refresh_token === "string" ? parsed.refresh_token.length : null,
      access_token_prefix: typeof parsed.access_token === "string" ? parsed.access_token.slice(0, 8) : null,
    });
  } catch {}
  return JSON.parse(text) as OuraToken;
}

export async function refreshAccessToken(
  refreshToken: string,
  clientId: string,
  clientSecret: string,
): Promise<OuraToken> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  });
  const res = await fetch(OAUTH_TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const text = await res.text();
  if (!res.ok) {
    console.log("oura.refreshAccessToken FAIL", { status: res.status, body: text });
    throw new Error(`Oura token refresh failed: ${res.status} ${text.slice(0, 800)}`);
  }
  return JSON.parse(text) as OuraToken;
}

export async function storeToken(
  db: D1Database,
  token: OuraToken,
): Promise<void> {
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO tokens (source, access_token, refresh_token, expires_at, scopes, updated_at)
       VALUES ('oura', ?1, ?2, ?3, ?4, ?5)
       ON CONFLICT(source) DO UPDATE SET
         access_token = excluded.access_token,
         refresh_token = COALESCE(excluded.refresh_token, tokens.refresh_token),
         expires_at = excluded.expires_at,
         scopes = excluded.scopes,
         updated_at = excluded.updated_at`,
    )
    .bind(
      token.access_token,
      token.refresh_token,
      now + token.expires_in * 1000,
      token.scope ?? null,
      now,
    )
    .run();
}

interface StoredToken {
  access_token: string;
  refresh_token: string;
  expires_at: number;
}

export async function getValidAccessToken(
  db: D1Database,
  clientId: string,
  clientSecret: string,
): Promise<string | null> {
  const row = await db
    .prepare(
      "SELECT access_token, refresh_token, expires_at FROM tokens WHERE source = 'oura'",
    )
    .first<StoredToken>();
  if (!row) return null;
  if (row.expires_at - Date.now() > REFRESH_THRESHOLD_MS) {
    return row.access_token;
  }
  // Refresh.
  const refreshed = await refreshAccessToken(row.refresh_token, clientId, clientSecret);
  await storeToken(db, refreshed);
  return refreshed.access_token;
}

function fmtDate(d: Date): string {
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

async function fetchPaged(
  endpoint: string,
  token: string,
  params: Record<string, string>,
): Promise<unknown[]> {
  const items: unknown[] = [];
  let nextToken: string | null = null;
  do {
    const qs = new URLSearchParams(params);
    if (nextToken) qs.set("next_token", nextToken);
    const url = `${API_BASE}${endpoint}?${qs.toString()}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      throw new Error(`Oura ${endpoint} ${res.status}: ${t.slice(0, 300)}`);
    }
    const body = (await res.json()) as { data?: unknown[]; next_token?: string | null };
    items.push(...(body.data ?? []));
    nextToken = body.next_token ?? null;
  } while (nextToken);
  return items;
}

function recordedAtFromItem(kind: string, item: any): number {
  // Oura returns ISO timestamps in different fields per kind.
  // daily_*: { day: "2026-06-01" }  → midnight UTC of that day
  // sleep:   { bedtime_start: "2026-06-01T22:00:00+00:00", ... }
  // workout: { start_datetime: "...", end_datetime: "..." }
  if (item?.day) {
    return new Date(`${item.day}T00:00:00Z`).getTime();
  }
  if (item?.bedtime_end) return new Date(item.bedtime_end).getTime();
  if (item?.bedtime_start) return new Date(item.bedtime_start).getTime();
  if (item?.end_datetime) return new Date(item.end_datetime).getTime();
  if (item?.start_datetime) return new Date(item.start_datetime).getTime();
  if (item?.timestamp) return new Date(item.timestamp).getTime();
  return Date.now(); // fallback — should rarely hit
}

export async function ingestRange(
  db: D1Database,
  token: string,
  startDate: Date,
  endDate: Date,
): Promise<IngestResult> {
  const result: IngestResult = { rowsAdded: 0, rowsSeen: 0, kinds: [], errors: [] };
  const start = fmtDate(startDate);
  const end = fmtDate(endDate);
  const now = Date.now();

  for (const kind of FETCHED_KINDS) {
    try {
      const params: Record<string, string> = { start_date: start, end_date: end };
      const items = await fetchPaged(`/${kind}`, token, params);
      result.rowsSeen += items.length;
      if (items.length === 0) continue;
      result.kinds.push(kind);

      // Batch insert with ON CONFLICT IGNORE
      const stmt = db.prepare(
        `INSERT INTO readings (source, kind, recorded_at, received_at, payload)
         VALUES ('oura', ?1, ?2, ?3, ?4)
         ON CONFLICT(source, kind, recorded_at) DO NOTHING`,
      );
      const batch = items.map((item) =>
        stmt.bind(kind, recordedAtFromItem(kind, item), now, JSON.stringify(item)),
      );
      const results = await db.batch(batch);
      for (const r of results) {
        if (r.meta?.changes && r.meta.changes > 0) result.rowsAdded += r.meta.changes;
      }
    } catch (e) {
      result.errors.push(`${kind}: ${(e as Error).message}`);
    }
  }

  return result;
}

export async function latestReadings(
  db: D1Database,
): Promise<{ kind: string; recorded_at: number; received_at: number }[]> {
  const rows = await db
    .prepare(
      `SELECT kind, recorded_at, received_at
       FROM readings
       WHERE source = 'oura'
       GROUP BY kind
       HAVING recorded_at = MAX(recorded_at)
       ORDER BY recorded_at DESC`,
    )
    .all<{ kind: string; recorded_at: number; received_at: number }>();
  return rows.results ?? [];
}

// Pull the most-recent stored payload for a kind, JSON-parsed.
async function latestPayload(db: D1Database, kind: string): Promise<{ recorded_at: number; payload: any } | null> {
  const row = await db
    .prepare(
      `SELECT recorded_at, payload FROM readings
       WHERE source = 'oura' AND kind = ?1
       ORDER BY recorded_at DESC LIMIT 1`,
    )
    .bind(kind)
    .first<{ recorded_at: number; payload: string }>();
  if (!row) return null;
  try {
    return { recorded_at: row.recorded_at, payload: JSON.parse(row.payload) };
  } catch {
    return { recorded_at: row.recorded_at, payload: null };
  }
}

// One-line recovery brief — readiness, HRV, sleep, temp delta, derived signal.
// Built for the morning brief's nervous-system-load line. Open read (matches /latest).
export async function briefForToday(db: D1Database): Promise<{
  as_of: number | null;
  readiness: number | null;
  hrv_avg_ms: number | null;
  sleep_score: number | null;
  activity_score: number | null;
  body_temperature_deviation_c: number | null;
  recovery_signal: "recovering" | "balanced" | "strained" | "unknown";
  sources: Record<string, number | null>;
}> {
  const [readiness, sleep, dailySleep, dailyActivity] = await Promise.all([
    latestPayload(db, "daily_readiness"),
    latestPayload(db, "sleep"),
    latestPayload(db, "daily_sleep"),
    latestPayload(db, "daily_activity"),
  ]);

  // Oura v2 known fields (defensive: optional chaining throughout):
  //   daily_readiness.payload.score                       (int 0-100)
  //   daily_readiness.payload.temperature_deviation       (float °C, may be null)
  //   sleep.payload.average_hrv                           (int ms; sometimes hrv.average)
  //   daily_sleep.payload.score                           (int 0-100)
  //   daily_activity.payload.score                        (int 0-100)
  const readinessScore: number | null = readiness?.payload?.score ?? null;
  const sleepScore: number | null = dailySleep?.payload?.score ?? null;
  const activityScore: number | null = dailyActivity?.payload?.score ?? null;
  const tempDelta: number | null = readiness?.payload?.temperature_deviation ?? null;
  const hrvAvg: number | null =
    sleep?.payload?.average_hrv ?? sleep?.payload?.hrv?.average ?? null;

  // Recovery signal — simple threshold off readiness + HRV trend slot.
  // Not a clinical claim; a hint for the morning brief's one-line nervous-system-load criterion.
  let recovery: "recovering" | "balanced" | "strained" | "unknown" = "unknown";
  if (readinessScore !== null) {
    if (readinessScore >= 80) recovery = "recovering";
    else if (readinessScore >= 65) recovery = "balanced";
    else recovery = "strained";
  }

  // as_of = most recent recorded_at across the four kinds (so callers know data freshness).
  const recordedAts = [readiness?.recorded_at, sleep?.recorded_at, dailySleep?.recorded_at, dailyActivity?.recorded_at].filter(
    (v): v is number => typeof v === "number",
  );
  const asOf = recordedAts.length ? Math.max(...recordedAts) : null;

  return {
    as_of: asOf,
    readiness: readinessScore,
    hrv_avg_ms: hrvAvg,
    sleep_score: sleepScore,
    activity_score: activityScore,
    body_temperature_deviation_c: tempDelta,
    recovery_signal: recovery,
    sources: {
      daily_readiness: readiness?.recorded_at ?? null,
      sleep: sleep?.recorded_at ?? null,
      daily_sleep: dailySleep?.recorded_at ?? null,
      daily_activity: dailyActivity?.recorded_at ?? null,
    },
  };
}
