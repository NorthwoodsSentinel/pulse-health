// Pure and SQL cases for src/alerts.ts (the pull-alert cadence, NOR-289).
//
// Cases 1-26 were written by Codex (a non-Claude reviewer) on the fixed audit brief, MODE
// tests, 2026-11-12, from the design, before the implementation was audited. Inputs and
// expected outputs are transcribed unchanged; only the harness around them is the author's.

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "fs";
import { join } from "path";
import {
  FAILING_STREAK_SQL,
  PRIOR_STREAK_SQL,
  decideIngestAlert,
  staleAlertDue,
  summarizeIngestError,
} from "../src/alerts";

const SCHEMA = readFileSync(join(import.meta.dir, "..", "shared", "schema.sql"), "utf8");

describe("decideIngestAlert (Codex cases 1-9)", () => {
  const cases: [n: number, name: string, args: [string, number, number], expected: unknown][] = [
    [1, "begins a partial streak", ["partial", 1, 0], { kind: "failing", day: 1 }],
    [2, "begins an error streak", ["error", 1, 0], { kind: "failing", day: 1 }],
    [3, "no daily repeat", ["partial", 2, 1], { kind: "none" }],
    [4, "seventh quiet day", ["error", 7, 6], { kind: "none" }],
    [5, "first repeat cadence", ["partial", 8, 7], { kind: "failing", day: 8 }],
    [6, "second repeat cadence", ["error", 15, 14], { kind: "failing", day: 15 }],
    [7, "recovery after one failure", ["success", 0, 1], { kind: "recovered", days: 1 }],
    [8, "recovery preserves the full prior streak", ["success", 0, 8], { kind: "recovered", days: 8 }],
    [9, "no false recovery", ["success", 0, 0], { kind: "none" }],
  ];
  for (const [n, name, args, expected] of cases) {
    test(`${n}. ${name}`, () => {
      expect(decideIngestAlert(...args)).toEqual(expected as never);
    });
  }
});

// Cases 10-14 encoded staleDay = floor((age - threshold) / 24) + 1, which the audit of
// 118e475 showed skips day 1 across an exact daily boundary. Codex re-issued them as
// 10R-16R for staleDay = ceil((age - threshold) / 24). Transcribed unchanged.
describe("staleAlertDue (Codex cases 10R-16R, replacing 10-14)", () => {
  const cases: [n: string, name: string, args: [number | null, number], expected: unknown][] = [
    ["10R", "exact threshold is not stale", [30, 30], { due: false }],
    ["11R", "first instant over threshold is stale day 1", [30.0001, 30], { due: true, staleDay: 1 }],
    ["12R", "exact threshold plus 24 hours remains stale day 1", [54, 30], { due: true, staleDay: 1 }],
    ["13R", "exact end of stale day 7 is quiet", [198, 30], { due: false, staleDay: 7 }],
    ["14R", "no reading is not stale", [null, 30], { due: false }],
  ];
  for (const [n, name, args, expected] of cases) {
    test(`${n}. ${name}`, () => {
      expect(staleAlertDue(...args)).toEqual(expected as never);
    });
  }

  test("15R. the transition that exposed the defect", () => {
    expect(staleAlertDue(30, 30)).toEqual({ due: false });
    expect(staleAlertDue(54, 30)).toEqual({ due: true, staleDay: 1 });
  });

  test("16R. daily cadence sweep through stale days 1-9", () => {
    expect(staleAlertDue(54, 30)).toEqual({ due: true, staleDay: 1 });
    expect(staleAlertDue(78, 30)).toEqual({ due: false, staleDay: 2 });
    expect(staleAlertDue(102, 30)).toEqual({ due: false, staleDay: 3 });
    expect(staleAlertDue(126, 30)).toEqual({ due: false, staleDay: 4 });
    expect(staleAlertDue(150, 30)).toEqual({ due: false, staleDay: 5 });
    expect(staleAlertDue(174, 30)).toEqual({ due: false, staleDay: 6 });
    expect(staleAlertDue(198, 30)).toEqual({ due: false, staleDay: 7 });
    expect(staleAlertDue(222, 30)).toEqual({ due: true, staleDay: 8 });
    expect(staleAlertDue(246, 30)).toEqual({ due: false, staleDay: 9 });
  });
});

describe("summarizeIngestError (Codex cases 15-18)", () => {
  test("15. provider bodies are discarded", () => {
    const out = summarizeIngestError(
      'athlete: Strava /athlete 403: {"message":"SECRET-STRAVA-BODY"} | activity: Strava /athlete/activities 403: SECRET-SECOND',
    );
    expect(out).toBe("athlete 403, activity 403");
    for (const bad of ["SECRET", "Strava", "/athlete", "{", "}", '"', ":"]) expect(out).not.toContain(bad);
  });

  test("16. allowed fixed error vocabulary only", () => {
    const out = summarizeIngestError("token: invalid_grant SECRET-TOKEN-DESCRIPTION");
    expect(out).toBe("token invalid_grant");
    for (const bad of ["SECRET", "DESCRIPTION"]) expect(out).not.toContain(bad);
  });

  test("17. hostile label cannot escape the character policy", () => {
    const out = summarizeIngestError("evil-title\\nInjected: 500 SECRET-PAYLOAD");
    expect(out).toBe("failed 500");
    expect(out).toMatch(/^[a-z0-9_ ,]{1,120}$/);
    for (const bad of ["evil", "Injected", "SECRET", "-", "\n", ":"]) expect(out).not.toContain(bad);
  });

  test("18. part and length caps", () => {
    const out = summarizeIngestError(
      "a: 500 secret-a | b: 501 secret-b | c: 502 secret-c | d: 503 secret-d | e: 504 secret-e | f: 505 secret-f | g: 506 secret-g",
    );
    expect(out).toBe("a 500, b 501, c 502, d 503, e 504, f 505");
    expect(out.length).toBeLessThanOrEqual(120);
  });
});

describe("streak SQL (Codex cases 19-26)", () => {
  type Row = [source: string, status: string, trigger: string];
  const cases: [n: number, name: string, rows: Row[], sql: "FAILING" | "PRIOR", q: [string, number], expected: number][] = [
    [19, "first failure", [["strava", "partial", "cron"]], "FAILING", ["strava", 1], 1],
    [20, "success resets the streak", [["strava", "partial", "cron"], ["strava", "success", "cron"], ["strava", "error", "cron"]], "FAILING", ["strava", 3], 1],
    [21, "recovery reads only rows before itself", [["oura", "partial", "cron"], ["oura", "error", "cron"], ["oura", "success", "cron"]], "PRIOR", ["oura", 3], 2],
    [22, "no false recovery after success", [["oura", "success", "cron"], ["oura", "success", "cron"]], "PRIOR", ["oura", 2], 0],
    [23, "manual rows do not count or reset", [["strava", "partial", "cron"], ["strava", "success", "manual"], ["strava", "error", "manual"], ["strava", "partial", "cron"]], "FAILING", ["strava", 4], 2],
    [24, "another source does not count or reset", [["strava", "partial", "cron"], ["oura", "success", "cron"], ["oura", "error", "cron"], ["strava", "error", "cron"]], "FAILING", ["strava", 4], 2],
    [25, "later rows cannot change an anchored verdict", [["strava", "partial", "cron"], ["strava", "error", "cron"], ["strava", "partial", "cron"]], "FAILING", ["strava", 2], 2],
    [26, "first failure after success has no prior streak", [["oura", "error", "cron"], ["oura", "success", "cron"], ["oura", "partial", "cron"]], "PRIOR", ["oura", 3], 0],
  ];
  for (const [n, name, rows, which, q, expected] of cases) {
    test(`${n}. ${name}`, () => {
      const db = new Database(":memory:");
      db.exec(SCHEMA);
      const ins = db.prepare(
        `INSERT INTO ingest_log (source, started_at, finished_at, kinds, rows_added, rows_seen, status, trigger, error)
         VALUES (?1, 0, 0, '', 0, 0, ?2, ?3, NULL)`,
      );
      rows.forEach((r, i) => {
        const res = ins.run(...r);
        expect(Number(res.lastInsertRowid)).toBe(i + 1); // ids are 1, 2, 3 … in the order given
      });
      const sql = which === "FAILING" ? FAILING_STREAK_SQL : PRIOR_STREAK_SQL;
      const got = db.prepare(sql).get(...q) as { n: number };
      expect(got.n).toBe(expected);
      db.close();
    });
  }
});
