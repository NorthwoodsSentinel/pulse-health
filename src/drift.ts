// drift.ts — the watcher Rob asked for on 2026-08-15 ("what watches and makes sure I am
// regulated"). Evaluates his own FLOW_ALIGNMENT drift signals from data already in D1 and,
// when two or more fire, surfaces one line from his own grounding set — never a plan, never
// a lecture. Also fires the five monthly questions on the 1st. Witness, never police.
//
// Signals (his hand, FLOW_ALIGNMENT.md, Feb 2026): ride frequency dropping · HRV down 5–7 days ·
// worse sleep · (AEBS >50h/wk is not in D1 — asked monthly). G9: four rides a week is the normal.

export interface DriftSignal { key: string; fired: boolean; detail: string }
export interface DriftReport {
  as_of: string; ride_days_28: number; rides_28: number; ride_target_28: number;
  hrv_last7: number | null; hrv_prior21: number | null; sleep_last7: number | null; sleep_prior21: number | null;
  signals: DriftSignal[]; fired: number; verdict: "steady" | "watch" | "drift";
}

const DAY = 86400000;
const RIDE_RE = /ride|cycl|bike|mountain|gravel|velomobile|ebike/i;

async function avgField(db: D1Database, kind: string, jsonPaths: string[], fromMs: number, toMs: number): Promise<number | null> {
  const exprs = jsonPaths.map((p) => `json_extract(payload, '${p}')`);
  const coalesce = exprs.length > 1 ? `COALESCE(${exprs.join(", ")})` : exprs[0]; // SQLite COALESCE needs ≥2 args
  const row = await db
    .prepare(`SELECT AVG(v) AS a, COUNT(v) AS n FROM (SELECT ${coalesce} AS v FROM readings WHERE source='oura' AND kind=?1 AND recorded_at >= ?2 AND recorded_at < ?3) WHERE v IS NOT NULL`)
    .bind(kind, fromMs, toMs).first<{ a: number | null; n: number }>();
  return row && row.n >= 3 && row.a != null ? Math.round(row.a * 10) / 10 : null;
}

export async function evaluateDrift(db: D1Database, now = Date.now()): Promise<DriftReport> {
  const d28 = now - 28 * DAY, d7 = now - 7 * DAY;
  // Rides: distinct days with a ride-type Strava activity in the last 28 days.
  const acts = await db
    .prepare(`SELECT recorded_at, json_extract(payload,'$.sport_type') AS st, json_extract(payload,'$.type') AS t FROM readings WHERE source='strava' AND kind='activity' AND recorded_at >= ?1`)
    .bind(d28).all<{ recorded_at: number; st: string | null; t: string | null }>();
  const rides = (acts.results || []).filter((r) => RIDE_RE.test(`${r.st || ""} ${r.t || ""}`));
  const rideDays = new Set(rides.map((r) => new Date(r.recorded_at).toISOString().slice(0, 10))).size;
  const rideTarget = 16; // G9: 4/week × 4 weeks

  // HRV and sleep: last 7 nights vs the 21 before.
  const [hrv7, hrv21, sl7, sl21] = await Promise.all([
    avgField(db, "sleep", ["$.average_hrv", "$.hrv.average"], d7, now),
    avgField(db, "sleep", ["$.average_hrv", "$.hrv.average"], d28, d7),
    avgField(db, "daily_sleep", ["$.score"], d7, now),
    avgField(db, "daily_sleep", ["$.score"], d28, d7),
  ]);

  const signals: DriftSignal[] = [
    { key: "rides_dropping", fired: rideDays < Math.ceil(rideTarget * 0.6), detail: `${rideDays} ride days / 28 (G9 target ${rideTarget})` },
    { key: "hrv_down", fired: hrv7 != null && hrv21 != null && hrv7 < hrv21 * 0.9, detail: `HRV last 7 nights ${hrv7 ?? "?"} vs prior 21 ${hrv21 ?? "?"} ms` },
    { key: "sleep_worse", fired: sl7 != null && sl21 != null && sl7 < sl21 * 0.9, detail: `sleep score last 7 ${sl7 ?? "?"} vs prior 21 ${sl21 ?? "?"}` },
  ];
  const fired = signals.filter((s) => s.fired).length;
  return {
    as_of: new Date(now).toISOString(), ride_days_28: rideDays, rides_28: rides.length, ride_target_28: rideTarget,
    hrv_last7: hrv7, hrv_prior21: hrv21, sleep_last7: sl7, sleep_prior21: sl21,
    signals, fired, verdict: fired >= 2 ? "drift" : fired === 1 ? "watch" : "steady",
  };
}

// His own words, from his own vault (GROUNDING_PRACTICES.md). One line per push, rotated.
const GROUNDING = [
  "Your Feb note said: \"Ride more.\"",
  "Five seconds in. Five seconds out. \"Calm was not the absence of fear. Calm was coherence.\"",
  "\"Most people avoid the woods at night. I go there to remember myself.\"",
  "\"Rocks did not lie. Roots did not blame. Gravity did not gaslight.\"",
  "\"Regulate. Then reveal.\" — regulation before revelation.",
  "\"Stability is a valid outcome.\" (Integration Time Is Work, 2025-12-20)",
];

export function driftMessage(r: DriftReport, now = Date.now()): { title: string; body: string } | null {
  const day = new Date(now).getUTCDate();
  const monthly = day === 1;
  if (r.verdict !== "drift" && !monthly) return null;
  const line = GROUNDING[Math.floor(now / DAY) % GROUNDING.length];
  const fired = r.signals.filter((s) => s.fired).map((s) => s.detail).join(" · ");
  if (monthly) {
    return { title: "Flow alignment — the month", body: `Rides: ${r.ride_days_28}/28 days (G9 16). HRV ${r.hrv_last7 ?? "?"} vs ${r.hrv_prior21 ?? "?"}. Sleep ${r.sleep_last7 ?? "?"} vs ${r.sleep_prior21 ?? "?"}.\nFive questions, one line each: weight · ride days · AEBS hrs/wk · creative income % · debt delta.\n${line}` };
  }
  return { title: "Drift signal — two fired", body: `${fired}\n${line}\nGROUNDING_PRACTICES has the rest. Witness, not a plan.` };
}

export async function logDrift(db: D1Database, r: DriftReport, pushed: boolean): Promise<void> {
  await db.prepare(`CREATE TABLE IF NOT EXISTS drift_log (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, verdict TEXT NOT NULL, fired INTEGER NOT NULL, report TEXT NOT NULL, pushed INTEGER NOT NULL)`).run();
  await db.prepare(`INSERT INTO drift_log (at, verdict, fired, report, pushed) VALUES (?1, ?2, ?3, ?4, ?5)`)
    .bind(Date.now(), r.verdict, r.fired, JSON.stringify(r), pushed ? 1 : 0).run();
}
