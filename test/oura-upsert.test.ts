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
import { OURA_UPSERT_SQL } from "../src/oura";

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
  {
    n: 18,
    name: "A changed same-ID non-sleep payload remains frozen",
    execs: [
      ["daily_stress", T, 10, { id: "stress-1", score: 10 }],
      ["daily_stress", T, 20, { id: "stress-1", score: 90 }],
    ],
    expect: [{ kind: "daily_stress", recordedAt: T, count: 1, id: "stress-1", receivedAt: 10 }],
  },
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
