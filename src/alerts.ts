// alerts.ts — when the daily pull speaks, and what it is allowed to say.
//
// kintsugi: a partly failed pull alerted nobody, and the alerts that did exist fired every
// day a condition lasted (2026-11-12, NOR-289). Strava logged `partial` on every cron run
// from 2026-10-17 with no page; an Oura `error` and a stale feed each pushed daily. One
// cadence now governs every standing condition: day 1, then every 7th day after, plus one
// line on recovery. State is derived only from `ingest_log`; there is no new table.
//
// Everything here is pure (functions and SQL text). The handler in index.ts does the I/O.

/** Consecutive non-success cron rows for a source, ending at the given row. ?1 source, ?2 row id. */
export const FAILING_STREAK_SQL = `SELECT count(*) AS n FROM ingest_log
WHERE source = ?1 AND trigger = 'cron' AND id <= ?2
  AND id > COALESCE((SELECT MAX(id) FROM ingest_log
                     WHERE source = ?1 AND trigger = 'cron' AND status = 'success' AND id <= ?2), 0)`;

/** The same streak, counted strictly before the given row. ?1 source, ?2 row id. */
export const PRIOR_STREAK_SQL = `SELECT count(*) AS n FROM ingest_log
WHERE source = ?1 AND trigger = 'cron' AND id < ?2
  AND id > COALESCE((SELECT MAX(id) FROM ingest_log
                     WHERE source = ?1 AND trigger = 'cron' AND status = 'success' AND id < ?2), 0)`;

export const ALERT_CADENCE_DAYS = 7;

/** Day 1, then every 7th day after: 1, 8, 15, 22, … */
function onCadence(day: number): boolean {
  return Number.isInteger(day) && day >= 1 && (day - 1) % ALERT_CADENCE_DAYS === 0;
}

export type IngestAlertDecision =
  | { kind: "none" }
  | { kind: "failing"; day: number }
  | { kind: "recovered"; days: number };

/**
 * status: today's ingest status. streak: FAILING_STREAK_SQL for today's row (includes
 * today). priorStreak: PRIOR_STREAK_SQL for today's row (excludes today).
 */
export function decideIngestAlert(
  status: string,
  streak: number,
  priorStreak: number,
): IngestAlertDecision {
  if (status !== "success") {
    return onCadence(streak) ? { kind: "failing", day: streak } : { kind: "none" };
  }
  return Number.isInteger(priorStreak) && priorStreak > 0
    ? { kind: "recovered", days: priorStreak }
    : { kind: "none" };
}

export type StaleAlertDecision = { due: false } | { due: boolean; staleDay: number };

/** ageHours: hours since the newest reading was received; null when there is none at all. */
export function staleAlertDue(ageHours: number | null, thresholdHours: number): StaleAlertDecision {
  if (ageHours === null || !Number.isFinite(ageHours) || ageHours <= thresholdHours) {
    return { due: false };
  }
  const staleDay = Math.floor((ageHours - thresholdHours) / 24) + 1;
  return { due: onCadence(staleDay), staleDay };
}

const VOCABULARY = ["invalid_client", "invalid_grant", "invalid_request", "no oura token"] as const;

/**
 * A summary of an ingest error that is safe to post to a public topic. It is built only
 * from: a collection label ([a-z_]{1,24}, the text before the first ':' of each ' | '
 * part), a three-digit HTTP status found in that part, and a fixed vocabulary. No other
 * substring of the provider's or runtime's text can appear in the result.
 */
export function summarizeIngestError(errorMsg: string | null): string {
  if (errorMsg === null || errorMsg === undefined || String(errorMsg).trim() === "") return "failed";
  const text = String(errorMsg);
  const parts = text.split(" | ").slice(0, 6);
  const out: string[] = [];
  for (const part of parts) {
    const lower = part.toLowerCase();
    const word = VOCABULARY.find((v) => lower.includes(v));
    if (word === "no oura token") {
      out.push(word);
      continue;
    }
    const labelMatch = /^([a-z_]{1,24}):/.exec(lower);
    const label = labelMatch ? labelMatch[1] : null;
    // A status must stand alone: not part of a longer run of letters or digits.
    const codeMatch = /(?<![a-z0-9])([1-5][0-9]{2})(?![a-z0-9])/.exec(lower);
    const detail = word ?? (codeMatch ? codeMatch[1] : /skipped/.test(lower) ? "skipped" : "failed");
    // No usable label: a bare status reads as "failed 500"; a vocabulary word or the plain
    // "failed" stands alone.
    if (label) out.push(`${label} ${detail}`);
    else out.push(codeMatch && !word ? `failed ${detail}` : detail);
  }
  const joined = out.join(", ").replace(/[^a-z0-9_ ,]/g, "");
  return joined.slice(0, 120) || "failed";
}

export type AlertMessage = { title: string; body: string; priority: "2" | "3" | "4" };

export function failingMessage(
  source: "oura" | "strava",
  status: string,
  day: number,
  errorMsg: string | null,
  rowsAdded: number,
): AlertMessage {
  const safeStatus = status === "partial" || status === "error" ? status : "failed";
  let body = `${summarizeIngestError(errorMsg)}; rows added ${Math.max(0, Math.trunc(rowsAdded) || 0)}`;
  if (source === "oura" && safeStatus === "error") body += ". Re-auth may be needed at /api/oura/connect.";
  return {
    title: `health: ${source} pull ${safeStatus} (day ${day})`,
    body,
    priority: day === 1 ? "4" : "3",
  };
}

export function recoveredMessage(
  source: "oura" | "strava",
  days: number,
  rowsAdded: number,
): AlertMessage {
  return {
    title: `health: ${source} pull recovered after ${days} day(s)`,
    body: `rows added ${Math.max(0, Math.trunc(rowsAdded) || 0)}`,
    priority: "2",
  };
}

export function staleMessage(staleDay: number, ageHours: number): AlertMessage {
  return {
    title: `health: oura has no new data (day ${staleDay})`,
    body: `Last reading ${Math.round(ageHours)} hours ago. Pulls are succeeding; the ring may not have synced.`,
    priority: "3",
  };
}
