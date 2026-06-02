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
    const res = await fetch(`${API_BASE}${endpoint}?${qs.toString()}`, {
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
