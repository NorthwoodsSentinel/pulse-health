// Strava API client — OAuth + activity fetcher.
// Docs: https://developers.strava.com/docs/

const OAUTH_AUTHORIZE = "https://www.strava.com/oauth/authorize";
const OAUTH_TOKEN = "https://www.strava.com/oauth/token";
const API_BASE = "https://www.strava.com/api/v3";

const REFRESH_THRESHOLD_MS = 60 * 60 * 1000;

// Strava scopes use comma-separated, not space.
const SCOPES = ["read", "activity:read_all", "profile:read_all"].join(",");

interface StravaToken {
  access_token: string;
  refresh_token: string;
  expires_at: number;        // SECONDS since epoch (unlike Oura's expires_in)
  expires_in?: number;
  token_type: string;
  scope?: string;
  athlete?: { id: number; firstname?: string; lastname?: string };
}

interface IngestResult {
  rowsAdded: number;
  rowsSeen: number;
  kinds: string[];
  errors: string[];
}

export function authorizeUrl(clientId: string, redirectUri: string, state: string): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: SCOPES,
    approval_prompt: "auto",
    state,
  });
  return `${OAUTH_AUTHORIZE}?${params.toString()}`;
}

export async function exchangeCode(
  code: string,
  clientId: string,
  clientSecret: string,
): Promise<StravaToken> {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    grant_type: "authorization_code",
  });
  const res = await fetch(OAUTH_TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const text = await res.text();
  if (!res.ok) {
    console.log("strava.exchangeCode FAIL", { status: res.status, body: text });
    throw new Error(`Strava token exchange failed: ${res.status} ${text.slice(0, 600)}`);
  }
  return JSON.parse(text) as StravaToken;
}

export async function refreshAccessToken(
  refreshToken: string,
  clientId: string,
  clientSecret: string,
): Promise<StravaToken> {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
  const res = await fetch(OAUTH_TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const text = await res.text();
  if (!res.ok) {
    console.log("strava.refreshAccessToken FAIL", { status: res.status, body: text });
    throw new Error(`Strava token refresh failed: ${res.status} ${text.slice(0, 600)}`);
  }
  return JSON.parse(text) as StravaToken;
}

export async function storeToken(db: D1Database, token: StravaToken): Promise<void> {
  const now = Date.now();
  // Strava's expires_at is in SECONDS — convert to ms for our schema.
  const expiresAtMs = token.expires_at * 1000;
  await db
    .prepare(
      `INSERT INTO tokens (source, access_token, refresh_token, expires_at, scopes, updated_at)
       VALUES ('strava', ?1, ?2, ?3, ?4, ?5)
       ON CONFLICT(source) DO UPDATE SET
         access_token = excluded.access_token,
         refresh_token = COALESCE(excluded.refresh_token, tokens.refresh_token),
         expires_at = excluded.expires_at,
         scopes = excluded.scopes,
         updated_at = excluded.updated_at`,
    )
    .bind(token.access_token, token.refresh_token, expiresAtMs, token.scope ?? null, now)
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
    .prepare("SELECT access_token, refresh_token, expires_at FROM tokens WHERE source = 'strava'")
    .first<StoredToken>();
  if (!row) return null;
  if (row.expires_at - Date.now() > REFRESH_THRESHOLD_MS) {
    return row.access_token;
  }
  const refreshed = await refreshAccessToken(row.refresh_token, clientId, clientSecret);
  await storeToken(db, refreshed);
  return refreshed.access_token;
}

interface StravaActivity {
  id: number;
  name: string;
  start_date: string;        // ISO UTC
  start_date_local: string;
  type: string;
  sport_type?: string;
  distance?: number;
}

async function fetchAthlete(token: string): Promise<unknown> {
  const res = await fetch(`${API_BASE}/athlete`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(`Strava /athlete ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  return res.json();
}

async function fetchAthleteStats(token: string, athleteId: number): Promise<unknown> {
  const res = await fetch(`${API_BASE}/athletes/${athleteId}/stats`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(`Strava /athletes/{id}/stats ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  return res.json();
}

async function fetchActivitiesPaged(
  token: string,
  after?: number,            // epoch seconds
  perPage = 200,
): Promise<StravaActivity[]> {
  const items: StravaActivity[] = [];
  let page = 1;
  while (true) {
    const qs = new URLSearchParams({
      page: String(page),
      per_page: String(perPage),
    });
    if (after) qs.set("after", String(after));
    const res = await fetch(`${API_BASE}/athlete/activities?${qs.toString()}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      throw new Error(`Strava /athlete/activities ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    const batch = (await res.json()) as StravaActivity[];
    if (batch.length === 0) break;
    items.push(...batch);
    if (batch.length < perPage) break;
    page++;
    // Strava rate limit: 200 req / 15min. Backfill of 5000 activities = 25 pages — safe.
  }
  return items;
}

export async function ingest(
  db: D1Database,
  token: string,
  sinceDays?: number,
): Promise<IngestResult> {
  const result: IngestResult = { rowsAdded: 0, rowsSeen: 0, kinds: [], errors: [] };
  const now = Date.now();
  const after = sinceDays ? Math.floor((now - sinceDays * 24 * 3600 * 1000) / 1000) : undefined;

  // 1. Athlete profile
  try {
    const athlete = (await fetchAthlete(token)) as { id: number };
    await db
      .prepare(
        `INSERT INTO readings (source, kind, recorded_at, received_at, payload)
         VALUES ('strava', 'athlete', ?1, ?1, ?2)
         ON CONFLICT(source, kind, recorded_at) DO UPDATE SET payload = excluded.payload, received_at = excluded.received_at`,
      )
      .bind(now, JSON.stringify(athlete))
      .run();
    result.kinds.push("athlete");
    result.rowsAdded++;
    result.rowsSeen++;

    // 2. Cumulative stats
    try {
      const stats = await fetchAthleteStats(token, athlete.id);
      await db
        .prepare(
          `INSERT INTO readings (source, kind, recorded_at, received_at, payload)
           VALUES ('strava', 'athlete_stats', ?1, ?1, ?2)
           ON CONFLICT(source, kind, recorded_at) DO UPDATE SET payload = excluded.payload, received_at = excluded.received_at`,
        )
        .bind(now, JSON.stringify(stats))
        .run();
      result.kinds.push("athlete_stats");
      result.rowsAdded++;
      result.rowsSeen++;
    } catch (e) {
      result.errors.push(`athlete_stats: ${(e as Error).message}`);
    }
  } catch (e) {
    result.errors.push(`athlete: ${(e as Error).message}`);
  }

  // 3. Activities
  try {
    const activities = await fetchActivitiesPaged(token, after);
    result.rowsSeen += activities.length;
    if (activities.length > 0) {
      result.kinds.push("activity");
      const stmt = db.prepare(
        `INSERT INTO readings (source, kind, recorded_at, received_at, payload)
         VALUES ('strava', 'activity', ?1, ?2, ?3)
         ON CONFLICT(source, kind, recorded_at) DO NOTHING`,
      );
      const batch = activities.map((a) =>
        stmt.bind(new Date(a.start_date).getTime(), now, JSON.stringify(a)),
      );
      // D1 batch size — split into chunks of 100 for safety.
      for (let i = 0; i < batch.length; i += 100) {
        const slice = batch.slice(i, i + 100);
        const results = await db.batch(slice);
        for (const r of results) {
          if (r.meta?.changes && r.meta.changes > 0) result.rowsAdded += r.meta.changes;
        }
      }
    }
  } catch (e) {
    result.errors.push(`activity: ${(e as Error).message}`);
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
       WHERE source = 'strava'
       GROUP BY kind
       HAVING recorded_at = MAX(recorded_at)
       ORDER BY recorded_at DESC`,
    )
    .all<{ kind: string; recorded_at: number; received_at: number }>();
  return rows.results ?? [];
}
