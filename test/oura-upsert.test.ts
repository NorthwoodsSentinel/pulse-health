// Adversarial cases for OURA_UPSERT_SQL (the sleep-record collision mend, NOR-289).
//
// The 19 cases below were written by Codex (a non-Claude reviewer) on the fixed audit
// brief, MODE tests, 2026-11-12, against the design before the code was audited. Their
// inputs and expected results are transcribed unchanged; only the harness around them
// is the author's. Each case runs on a fresh in-memory database holding the schema from
// shared/schema.sql, and rows are written only by executing the exported statement with
// (kind, recorded_at, received_at, payload).
//
// Not covered here (stated by the reviewer): Cloudflare D1 equivalence and true
// concurrent executions. Those are checked on production D1 after deploy.

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "fs";
import { join } from "path";
import { OURA_DIGEST_SQL, OURA_UPSERT_SQL, hasValidDay } from "../src/oura";

const SCHEMA = readFileSync(join(import.meta.dir, "..", "shared", "schema.sql"), "utf8");
const T = 1700000000000;
const T2 = 1700086400000;
const NOT_JSON = "not-json";

type Exec = [kind: string, recordedAt: number, receivedAt: number, payload: object | string];
type Expect = { kind: string; recordedAt: number; count: number; id?: string; receivedAt?: number };
type Case = { n: number; name: string; execs: Exec[]; expect: Expect[]; totalSleepRows?: number };

const CASES: Case[] = [
  {
    n: 1,
    name: "Night repairs a stored short period",
    execs: [
      ["sleep", T, 10, { id: "rest-1", type: "rest", total_sleep_duration: 1800 }],
      ["sleep", T, 20, { id: "night-1", type: "long_sleep", total_sleep_duration: 25200 }],
    ],
    expect: [{ kind: "sleep", recordedAt: T, count: 1, id: "night-1", receivedAt: 20 }],
  },
  {
    n: 2,
    name: "A later short period cannot displace the night",
    execs: [
      ["sleep", T, 10, { id: "night-1", type: "long_sleep", total_sleep_duration: 25200 }],
      ["sleep", T, 20, { id: "rest-1", type: "rest", total_sleep_duration: 1800 }],
    ],
    expect: [{ kind: "sleep", recordedAt: T, count: 1, id: "night-1", receivedAt: 10 }],
  },
  {
    n: 3,
    name: "Longer ordinary sleep replaces shorter ordinary sleep",
    execs: [
      ["sleep", T, 10, { id: "short", type: "sleep", total_sleep_duration: 1800 }],
      ["sleep", T, 20, { id: "longer", type: "sleep", total_sleep_duration: 3600 }],
    ],
    expect: [{ kind: "sleep", recordedAt: T, count: 1, id: "longer", receivedAt: 20 }],
  },
  {
    n: 4,
    name: "Shorter ordinary sleep does not replace longer ordinary sleep",
    execs: [
      ["sleep", T, 10, { id: "longer", type: "sleep", total_sleep_duration: 3600 }],
      ["sleep", T, 20, { id: "short", type: "sleep", total_sleep_duration: 1800 }],
    ],
    expect: [{ kind: "sleep", recordedAt: T, count: 1, id: "longer", receivedAt: 10 }],
  },
  {
    n: 5,
    name: "long_sleep beats an extreme non-long duration",
    execs: [
      ["sleep", T, 10, { id: "ordinary", type: "sleep", total_sleep_duration: 999999999999 }],
      ["sleep", T, 20, { id: "night", type: "long_sleep", total_sleep_duration: 0 }],
    ],
    expect: [{ kind: "sleep", recordedAt: T, count: 1, id: "night", receivedAt: 20 }],
  },
  {
    n: 6,
    name: "Extreme non-long duration cannot beat long_sleep",
    execs: [
      ["sleep", T, 10, { id: "night", type: "long_sleep", total_sleep_duration: 0 }],
      ["sleep", T, 20, { id: "ordinary", type: "sleep", total_sleep_duration: 999999999999 }],
    ],
    expect: [{ kind: "sleep", recordedAt: T, count: 1, id: "night", receivedAt: 10 }],
  },
  {
    n: 7,
    name: "Any non-deleted document replaces a different deleted document",
    execs: [
      ["sleep", T, 10, { id: "deleted-1", type: "deleted", total_sleep_duration: 999999 }],
      ["sleep", T, 20, { id: "rest-1", type: "rest", total_sleep_duration: 0 }],
    ],
    expect: [{ kind: "sleep", recordedAt: T, count: 1, id: "rest-1", receivedAt: 20 }],
  },
  {
    n: 8,
    name: "A different deleted document cannot replace a non-deleted document",
    execs: [
      ["sleep", T, 10, { id: "rest-1", type: "rest", total_sleep_duration: 0 }],
      ["sleep", T, 20, { id: "deleted-1", type: "deleted", total_sleep_duration: 999999 }],
    ],
    expect: [{ kind: "sleep", recordedAt: T, count: 1, id: "rest-1", receivedAt: 10 }],
  },
  {
    n: 9,
    name: "A shorter changed revision of the same ID replaces the stored revision",
    execs: [
      ["sleep", T, 10, { id: "night-1", type: "long_sleep", total_sleep_duration: 25200, revision: 1 }],
      ["sleep", T, 20, { id: "night-1", type: "long_sleep", total_sleep_duration: 24000, revision: 2 }],
    ],
    expect: [{ kind: "sleep", recordedAt: T, count: 1, id: "night-1", receivedAt: 20 }],
  },
  {
    n: 10,
    name: "A same-ID deletion revision replaces the prior document",
    execs: [
      ["sleep", T, 10, { id: "night-1", type: "long_sleep", total_sleep_duration: 25200 }],
      ["sleep", T, 20, { id: "night-1", type: "deleted" }],
    ],
    expect: [{ kind: "sleep", recordedAt: T, count: 1, id: "night-1", receivedAt: 20 }],
  },
  {
    n: 11,
    name: "Identical replay does not refresh received_at",
    execs: [
      ["sleep", T, 10, { id: "night-1", type: "long_sleep", total_sleep_duration: 25200 }],
      ["sleep", T, 20, { id: "night-1", type: "long_sleep", total_sleep_duration: 25200 }],
    ],
    expect: [{ kind: "sleep", recordedAt: T, count: 1, id: "night-1", receivedAt: 10 }],
  },
  {
    n: 12,
    name: "Equal-ranked different documents cannot flip-flop",
    execs: [
      ["sleep", T, 10, { id: "night-a", type: "long_sleep", total_sleep_duration: 25200 }],
      ["sleep", T, 20, { id: "night-b", type: "long_sleep", total_sleep_duration: 25200 }],
      ["sleep", T, 30, { id: "night-a", type: "long_sleep", total_sleep_duration: 25200 }],
      ["sleep", T, 40, { id: "night-b", type: "long_sleep", total_sleep_duration: 25200 }],
    ],
    expect: [{ kind: "sleep", recordedAt: T, count: 1, id: "night-a", receivedAt: 10 }],
  },
  {
    n: 13,
    name: "A missing duration is safely ranked as zero",
    execs: [
      ["sleep", T, 10, { id: "missing-duration", type: "sleep" }],
      ["sleep", T, 20, { id: "positive", type: "sleep", total_sleep_duration: 1 }],
    ],
    expect: [{ kind: "sleep", recordedAt: T, count: 1, id: "positive", receivedAt: 20 }],
  },
  {
    n: 14,
    name: "Negative and nonnumeric durations do not create a positive rank",
    execs: [
      ["sleep", T, 10, { id: "negative", type: "sleep", total_sleep_duration: -500 }],
      ["sleep", T, 20, { id: "text", type: "sleep", total_sleep_duration: "not-a-number" }],
      ["sleep", T, 30, { id: "positive", type: "sleep", total_sleep_duration: 1 }],
    ],
    expect: [{ kind: "sleep", recordedAt: T, count: 1, id: "positive", receivedAt: 30 }],
  },
  {
    n: 15,
    name: "A valid night repairs a pre-existing malformed payload without throwing",
    execs: [
      ["sleep", T, 10, NOT_JSON],
      ["sleep", T, 20, { id: "night-1", type: "long_sleep", total_sleep_duration: 25200 }],
    ],
    expect: [{ kind: "sleep", recordedAt: T, count: 1, id: "night-1", receivedAt: 20 }],
  },
  {
    n: 16,
    name: "Malformed incoming JSON neither throws nor displaces valid sleep",
    execs: [
      ["sleep", T, 10, { id: "night-1", type: "long_sleep", total_sleep_duration: 25200 }],
      ["sleep", T, 20, NOT_JSON],
    ],
    expect: [{ kind: "sleep", recordedAt: T, count: 1, id: "night-1", receivedAt: 10 }],
  },
  {
    n: 17,
    name: "Non-sleep rows remain first-write-wins even when the second payload appears better",
    execs: [
      ["daily_sleep", T, 10, { id: "daily-a", type: "rest", total_sleep_duration: 1 }],
      ["daily_sleep", T, 20, { id: "daily-b", type: "long_sleep", total_sleep_duration: 999999 }],
    ],
    expect: [{ kind: "daily_sleep", recordedAt: T, count: 1, id: "daily-a", receivedAt: 10 }],
  },
  // Case 18 ("A changed same-ID non-sleep payload remains frozen", on daily_stress) was
  // superseded on 2026-11-12 when daily_stress stopped being first-write-wins. Codex's
  // replacement expectation is case 20; case 34 covers the kinds that stay frozen.
  {
    n: 19,
    name: "Conflict handling cannot rewrite another timestamp",
    execs: [
      ["sleep", T, 10, { id: "day-a", type: "rest", total_sleep_duration: 1800 }],
      ["sleep", T2, 20, { id: "day-b", type: "long_sleep", total_sleep_duration: 25200 }],
      ["sleep", T, 30, { id: "day-a-night", type: "long_sleep", total_sleep_duration: 24000 }],
    ],
    expect: [
      { kind: "sleep", recordedAt: T, count: 1, id: "day-a-night", receivedAt: 30 },
      { kind: "sleep", recordedAt: T2, count: 1, id: "day-b", receivedAt: 20 },
    ],
    totalSleepRows: 2,
  },

  // ---- Cases 20-36: the daily_stress snapshot mend. Written by Codex on the fixed brief,
  // MODE tests, 2026-11-12, before the audit. Transcribed unchanged. String payloads are
  // passed to the statement as raw text, exactly as written.
  {
    n: 20,
    name: "Replacement for superseded case 18: differing zero-measurement stress revisions replace",
    execs: [
      ["daily_stress", T, 10, { id: "stress-1", score: 10 }],
      ["daily_stress", T, 20, { id: "stress-1", score: 90 }],
    ],
    expect: [{ kind: "daily_stress", recordedAt: T, count: 1, receivedAt: 20 }],
  },
  {
    n: 21,
    name: "A completed two-number reading replaces the two-zero morning snapshot",
    execs: [
      ["daily_stress", T, 10, { day: "2023-11-14", stress_high: 0, recovery_high: 0, day_summary: null }],
      ["daily_stress", T, 20, { day: "2023-11-14", stress_high: 28800, recovery_high: 600, day_summary: "stressful" }],
    ],
    expect: [{ kind: "daily_stress", recordedAt: T, count: 1, receivedAt: 20 }],
  },
  {
    n: 22,
    name: "A downward two-number revision is accepted",
    execs: [
      ["daily_stress", T, 10, { stress_high: 28800, recovery_high: 600 }],
      ["daily_stress", T, 20, { stress_high: 1200, recovery_high: 0 }],
    ],
    expect: [{ kind: "daily_stress", recordedAt: T, count: 1, receivedAt: 20 }],
  },
  {
    n: 23,
    name: "Identical replay does not refresh received_at",
    execs: [
      ["daily_stress", T, 10, { stress_high: 1200, recovery_high: 300 }],
      ["daily_stress", T, 20, { stress_high: 1200, recovery_high: 300 }],
    ],
    expect: [{ kind: "daily_stress", recordedAt: T, count: 1, receivedAt: 10 }],
  },
  {
    n: 24,
    name: "A one-number partial payload cannot replace a two-number reading",
    execs: [
      ["daily_stress", T, 10, { stress_high: 1200, recovery_high: 300 }],
      ["daily_stress", T, 20, { stress_high: 1500 }],
    ],
    expect: [{ kind: "daily_stress", recordedAt: T, count: 1, receivedAt: 10 }],
  },
  {
    n: 25,
    name: "A zero-number payload cannot replace a one-number reading",
    execs: [
      ["daily_stress", T, 10, { stress_high: 1200 }],
      ["daily_stress", T, 20, { stress_high: null, recovery_high: "300", day_summary: "restored" }],
    ],
    expect: [{ kind: "daily_stress", recordedAt: T, count: 1, receivedAt: 10 }],
  },
  {
    n: 26,
    name: "Equal numeric counts permit replacement even when the measured field changes",
    execs: [
      ["daily_stress", T, 10, { stress_high: 1200 }],
      ["daily_stress", T, 20, { recovery_high: 300 }],
    ],
    expect: [{ kind: "daily_stress", recordedAt: T, count: 1, receivedAt: 20 }],
  },
  {
    n: 27,
    name: "A JSON real counts as a numeric measurement",
    execs: [
      ["daily_stress", T, 10, { stress_high: 1200 }],
      ["daily_stress", T, 20, { stress_high: 1200.5 }],
    ],
    expect: [{ kind: "daily_stress", recordedAt: T, count: 1, receivedAt: 20 }],
  },
  {
    n: 28,
    name: "Booleans, arrays, and objects do not count as measurements",
    execs: [
      ["daily_stress", T, 10, { stress_high: 1, recovery_high: 2 }],
      ["daily_stress", T, 20, { stress_high: true, recovery_high: [2] }],
      ["daily_stress", T, 30, { stress_high: { value: 3 }, recovery_high: false }],
    ],
    expect: [{ kind: "daily_stress", recordedAt: T, count: 1, receivedAt: 10 }],
  },
  {
    n: 29,
    name: "Valid non-object JSON cannot displace a numeric reading or break the statement",
    execs: [
      ["daily_stress", T, 10, { stress_high: 1 }],
      ["daily_stress", T, 20, "null"],
      ["daily_stress", T, 30, "[]"],
    ],
    expect: [{ kind: "daily_stress", recordedAt: T, count: 1, receivedAt: 10 }],
  },
  {
    n: 30,
    name: "Malformed incoming JSON cannot replace valid stress data",
    execs: [
      ["daily_stress", T, 10, { stress_high: 1, recovery_high: 2 }],
      ["daily_stress", T, 20, NOT_JSON],
    ],
    expect: [{ kind: "daily_stress", recordedAt: T, count: 1, receivedAt: 10 }],
  },
  {
    n: 31,
    name: "Any valid differing stress document repairs malformed stored JSON",
    execs: [
      ["daily_stress", T, 10, NOT_JSON],
      ["daily_stress", T, 20, { day_summary: "restored" }],
    ],
    expect: [{ kind: "daily_stress", recordedAt: T, count: 1, receivedAt: 20 }],
  },
  {
    n: 32,
    name: "Malformed JSON cannot replace an already malformed stored payload",
    execs: [
      ["daily_stress", T, 10, NOT_JSON],
      ["daily_stress", T, 20, NOT_JSON],
    ],
    expect: [{ kind: "daily_stress", recordedAt: T, count: 1, receivedAt: 10 }],
  },
  {
    n: 33,
    name: "Byte-different but semantically equivalent JSON is a differing version",
    execs: [
      ["daily_stress", T, 10, '{"stress_high":1,"recovery_high":2}'],
      ["daily_stress", T, 20, '{ "recovery_high":2, "stress_high":1 }'],
    ],
    expect: [{ kind: "daily_stress", recordedAt: T, count: 1, receivedAt: 20 }],
  },
  {
    n: 34,
    name: "Kinds other than sleep and daily_stress remain first-write-wins",
    execs: [
      ["daily_readiness", T, 10, { score: 10 }],
      ["daily_readiness", T, 20, { score: 99, stress_high: 1, recovery_high: 2 }],
    ],
    expect: [{ kind: "daily_readiness", recordedAt: T, count: 1, receivedAt: 10 }],
  },
  {
    n: 35,
    name: "The stress branch does not change existing sleep behavior",
    execs: [
      ["sleep", T, 10, { id: "rest", type: "rest", total_sleep_duration: 1800 }],
      ["sleep", T, 20, { id: "night", type: "long_sleep", total_sleep_duration: 25200 }],
    ],
    expect: [{ kind: "sleep", recordedAt: T, count: 1, receivedAt: 20 }],
  },
  {
    n: 36,
    name: "Conflict handling cannot rewrite another stress timestamp",
    execs: [
      ["daily_stress", T, 10, { stress_high: 0, recovery_high: 0 }],
      ["daily_stress", T2, 20, { stress_high: 9, recovery_high: 8 }],
      ["daily_stress", T, 30, { stress_high: 7, recovery_high: 6 }],
    ],
    expect: [
      { kind: "daily_stress", recordedAt: T, count: 1, receivedAt: 30 },
      { kind: "daily_stress", recordedAt: T2, count: 1, receivedAt: 20 },
    ],
  },
];

// hasValidDay cases, written by Codex in the same round. Transcribed unchanged.
const DAY_CASES: [n: number, input: unknown, expected: boolean][] = [
  [1, { day: "2024-02-29" }, true],
  [2, { day: "2023-02-29" }, false],
  [3, { day: "2026-11-12", stress_high: 0 }, true],
  [4, { day: "2026-11-31" }, false],
  [5, { day: "2026-04-31" }, false],
  [6, { day: "2026-1-01" }, false],
  [7, { day: "26-01-01" }, false],
  [8, { day: "2026-01-01T00:00:00Z" }, false],
  [9, { day: " 2026-01-01" }, false],
  [10, { day: "2026-01-01 " }, false],
  [11, { day: "" }, false],
  [12, { day: 20261112 }, false],
  [13, { day: null }, false],
  [14, {}, false],
  [15, null, false],
  [16, "2026-11-12", false],
  [17, [], false],
  [18, { day: "2026-12-31", extra: { arbitrary: true } }, true],
];

function freshDb(): Database {
  const db = new Database(":memory:");
  db.exec(SCHEMA);
  return db;
}

describe("OURA_UPSERT_SQL (Codex adversarial cases, NOR-289)", () => {
  for (const c of CASES) {
    test(`${c.n}. ${c.name}`, () => {
      const db = freshDb();
      const stmt = db.prepare(OURA_UPSERT_SQL);
      for (const [kind, recordedAt, receivedAt, payload] of c.execs) {
        const text = typeof payload === "string" ? payload : JSON.stringify(payload);
        // Must not throw, including on malformed stored or incoming JSON.
        stmt.run(kind, recordedAt, receivedAt, text);
      }
      for (const e of c.expect) {
        const rows = db
          .query("SELECT source, received_at, payload FROM readings WHERE kind = ?1 AND recorded_at = ?2")
          .all(e.kind, e.recordedAt) as { source: string; received_at: number; payload: string }[];
        expect(rows.length).toBe(e.count);
        expect(rows[0].source).toBe("oura");
        if (e.receivedAt !== undefined) expect(rows[0].received_at).toBe(e.receivedAt);
        // The stored payload must be, byte for byte, the payload of the execution that
        // the case says won (identified by its received_at). Checking only `id` would let
        // a same-ID revision pass while the old content was kept (Codex audit of a6c807b).
        if (e.receivedAt !== undefined) {
          const winner = c.execs.find(
            ([k, rec, recv]) => k === e.kind && rec === e.recordedAt && recv === e.receivedAt,
          );
          expect(winner).toBeDefined();
          const winnerText = typeof winner![3] === "string" ? winner![3] : JSON.stringify(winner![3]);
          expect(rows[0].payload).toBe(winnerText);
        }
        if (e.id !== undefined) expect(JSON.parse(rows[0].payload).id).toBe(e.id);
      }
      if (c.totalSleepRows !== undefined) {
        const n = db.query("SELECT count(*) AS n FROM readings WHERE kind = 'sleep'").get() as { n: number };
        expect(n.n).toBe(c.totalSleepRows);
        const sources = db.query("SELECT DISTINCT source FROM readings").all() as { source: string }[];
        expect(sources.map((s) => s.source)).toEqual(["oura"]);
      }
      db.close();
    });
  }
});

// Regression for the Codex audit finding on 24e91c9: the digest selected the 12 newest
// rows across four kinds, so a kind lagging by four days was omitted. The scenario is the
// one the reviewer reproduced (one stress row, then four later days of the other kinds);
// the assertions are the author's.
describe("OURA_DIGEST_SQL returns the newest row of each kind", () => {
  test("a stress row older than twelve other rows is still returned", () => {
    const db = freshDb();
    const up = db.prepare(OURA_UPSERT_SQL);
    const DAY = 86400000;
    up.run("daily_stress", T, 1, JSON.stringify({ day: "2023-11-14", stress_high: 3600, recovery_high: 60 }));
    for (let d = 1; d <= 4; d++) {
      for (const kind of ["daily_sleep", "daily_readiness", "sleep"]) {
        up.run(kind, T + d * DAY, 1, JSON.stringify({ id: `${kind}-${d}`, type: "long_sleep", total_sleep_duration: 25000 }));
      }
    }
    const rows = db.query(OURA_DIGEST_SQL).all() as { kind: string; payload: string; recorded_at: number }[];
    const byKind = Object.fromEntries(rows.map((r) => [r.kind, r]));
    expect(rows.length).toBe(4);
    expect(JSON.parse(byKind["daily_stress"].payload).stress_high).toBe(3600);
    expect(byKind["daily_stress"].recorded_at).toBe(T);
    for (const kind of ["daily_sleep", "daily_readiness", "sleep"]) {
      expect(byKind[kind].recorded_at).toBe(T + 4 * DAY);
    }
    db.close();
  });

  test("a kind with no rows is simply absent", () => {
    const db = freshDb();
    db.prepare(OURA_UPSERT_SQL).run("sleep", T, 1, JSON.stringify({ id: "n", type: "long_sleep", total_sleep_duration: 1 }));
    const rows = db.query(OURA_DIGEST_SQL).all() as { kind: string }[];
    expect(rows.map((r) => r.kind)).toEqual(["sleep"]);
    db.close();
  });
});

describe("hasValidDay (Codex cases, NOR-289)", () => {
  for (const [n, input, expected] of DAY_CASES) {
    test(`${n}. ${JSON.stringify(input)} -> ${expected}`, () => {
      expect(hasValidDay(input)).toBe(expected);
    });
  }
});
