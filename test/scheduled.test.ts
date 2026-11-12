// Integration cases for the Worker's scheduled handler (the pull-alert rework, NOR-289).
//
// Cases 27-50 were written by Codex (a non-Claude reviewer) on the fixed audit brief, MODE
// tests, 2026-11-12, from the design, before the implementation was audited. Each fixture
// and each constrained expectation is transcribed unchanged into the table below; the
// checker that reads the table is the author's. The handler under test is the real one,
// run by test/scheduled-harness.ts.

import { describe, expect, test } from "bun:test";
import { runScheduled, type Fixture, type RunResult } from "./scheduled-harness";

const repeat = (n: number, row: { source: "oura" | "strava"; status: string; trigger: "cron" | "manual" }) =>
  Array.from({ length: n }, () => ({ ...row }));

type Checks = {
  logStatus?: Partial<Record<"oura" | "strava", string>>; // that source's row has this status and trigger "cron"
  logRowExact?: RunResult["ingestLog"][number]; // a row equal to this exists
  noLogRowFor?: "oura" | "strava";
  ntfyHas?: Array<{ title: string; priority: string }>; // an entry with this title and priority exists
  ntfyTitleExactlyOnce?: string[];
  ntfyNoTitleEquals?: string[];
  ntfyNoTitleContains?: string[];
  pushHasTitle?: string[];
  pushNoTitleEquals?: string[];
  forbidAnywhere?: string[]; // must not appear in any ntfy or push title or body
  threw?: boolean;
  driftLogged?: boolean;
};

const CASES: Array<{ n: number; name: string; fixture: Fixture; checks: Checks }> = [
  {
    n: 27,
    name: "Strava partial surfaces on day 1",
    fixture: { strava: "partial", ntfy: "ok" },
    checks: {
      logStatus: { strava: "partial" },
      ntfyHas: [{ title: "health: strava pull partial (day 1)", priority: "4" }],
      threw: false,
      driftLogged: true,
    },
  },
  {
    n: 28,
    name: "standing failure is quiet on day 2",
    fixture: { priorIngestLog: [{ source: "strava", status: "partial", trigger: "cron" }], strava: "partial", ntfy: "ok" },
    checks: {
      logStatus: { strava: "partial" },
      ntfyNoTitleEquals: ["health: strava pull partial (day 2)"],
      threw: false,
      driftLogged: true,
    },
  },
  {
    n: 29,
    name: "standing failure repeats on day 8",
    fixture: { priorIngestLog: repeat(7, { source: "strava", status: "partial", trigger: "cron" }), strava: "partial", ntfy: "ok" },
    checks: {
      ntfyHas: [{ title: "health: strava pull partial (day 8)", priority: "3" }],
      ntfyTitleExactlyOnce: ["health: strava pull partial (day 8)"],
      threw: false,
      driftLogged: true,
    },
  },
  {
    n: 30,
    name: "manual failures cannot suppress day 1",
    fixture: { priorIngestLog: repeat(7, { source: "strava", status: "partial", trigger: "manual" }), strava: "partial", ntfy: "ok" },
    checks: { ntfyHas: [{ title: "health: strava pull partial (day 1)", priority: "4" }] },
  },
  {
    n: 31,
    name: "pre-existing day 27 remains quiet",
    fixture: { priorIngestLog: repeat(26, { source: "strava", status: "partial", trigger: "cron" }), strava: "partial", ntfy: "ok" },
    checks: { ntfyNoTitleEquals: ["health: strava pull partial (day 27)"] },
  },
  {
    n: 32,
    name: "pre-existing streak alerts at its next cadence",
    fixture: { priorIngestLog: repeat(28, { source: "strava", status: "partial", trigger: "cron" }), strava: "partial", ntfy: "ok" },
    checks: {
      ntfyHas: [{ title: "health: strava pull partial (day 29)", priority: "3" }],
      ntfyTitleExactlyOnce: ["health: strava pull partial (day 29)"],
    },
  },
  {
    n: 33,
    name: "recovery after mixed failure statuses",
    fixture: {
      priorIngestLog: [
        { source: "strava", status: "partial", trigger: "cron" },
        { source: "strava", status: "error", trigger: "cron" },
        { source: "strava", status: "partial", trigger: "cron" },
      ],
      strava: "ok",
      ntfy: "ok",
    },
    checks: {
      logStatus: { strava: "success" },
      ntfyHas: [{ title: "health: strava pull recovered after 3 day(s)", priority: "2" }],
      ntfyTitleExactlyOnce: ["health: strava pull recovered after 3 day(s)"],
    },
  },
  {
    n: 34,
    name: "manual failure does not create recovery",
    fixture: { priorIngestLog: [{ source: "strava", status: "partial", trigger: "manual" }], strava: "ok", ntfy: "ok" },
    checks: { ntfyNoTitleContains: ["strava pull recovered"] },
  },
  {
    n: 35,
    name: "another source does not create recovery",
    fixture: { priorIngestLog: [{ source: "oura", status: "partial", trigger: "cron" }], strava: "ok", ntfy: "ok" },
    checks: { ntfyNoTitleContains: ["strava pull recovered"] },
  },
  {
    n: 36,
    name: "first stale day",
    fixture: { ouraNewRows: false, lastOuraReadingAgeHours: 31, oura: "ok", ntfy: "ok" },
    checks: {
      logStatus: { oura: "success" },
      ntfyHas: [{ title: "health: oura has no new data (day 1)", priority: "3" }],
      ntfyTitleExactlyOnce: ["health: oura has no new data (day 1)"],
      threw: false,
      driftLogged: true,
    },
  },
  {
    n: 37,
    name: "standing staleness does not page daily",
    fixture: { ouraNewRows: false, lastOuraReadingAgeHours: 54, oura: "ok", ntfy: "ok" },
    checks: { ntfyNoTitleEquals: ["health: oura has no new data (day 2)"], threw: false, driftLogged: true },
  },
  {
    n: 38,
    name: "stale day 8 repeats",
    fixture: { ouraNewRows: false, lastOuraReadingAgeHours: 198, oura: "ok", ntfy: "ok" },
    checks: {
      ntfyHas: [{ title: "health: oura has no new data (day 8)", priority: "3" }],
      ntfyTitleExactlyOnce: ["health: oura has no new data (day 8)"],
    },
  },
  {
    n: 39,
    name: "failed Oura pull suppresses the stale alert",
    fixture: { oura: "throw", ouraNewRows: false, lastOuraReadingAgeHours: 198, ntfy: "ok" },
    checks: {
      logStatus: { oura: "error" },
      ntfyHas: [{ title: "health: oura pull error (day 1)", priority: "4" }],
      ntfyNoTitleContains: ["oura has no new data"],
      threw: false,
      driftLogged: true,
    },
  },
  {
    n: 40,
    name: "missing Oura token is a real failure",
    fixture: { ouraToken: false, ntfy: "ok" },
    checks: {
      logRowExact: { source: "oura", status: "error", trigger: "cron", rows_added: 0, error: "no oura token" },
      ntfyHas: [{ title: "health: oura pull error (day 1)", priority: "4" }],
      threw: false,
      driftLogged: true,
    },
  },
  {
    n: 41,
    name: "missing Strava token skips only Strava",
    fixture: { stravaToken: false },
    checks: { noLogRowFor: "strava", ntfyNoTitleContains: ["strava pull"], driftLogged: true, threw: false },
  },
  {
    n: 42,
    name: "digest push failure cannot rewrite pull truth",
    fixture: { oura: "ok", strava: "ok", push: "throw" },
    checks: { logStatus: { oura: "success", strava: "success" }, driftLogged: true, threw: false },
  },
  {
    n: 43,
    name: "ntfy 429 invokes Web Push fallback",
    fixture: { oura: "throw", ntfy: "429", push: "ok" },
    checks: {
      ntfyHas: [{ title: "health: oura pull error (day 1)", priority: "4" }],
      pushHasTitle: ["health: oura pull error (day 1)"],
      logStatus: { oura: "error", strava: "success" },
      driftLogged: true,
      threw: false,
    },
  },
  {
    n: 44,
    name: "ntfy exception invokes Web Push fallback",
    fixture: { strava: "throw", ntfy: "throw", push: "ok" },
    checks: {
      ntfyHas: [{ title: "health: strava pull error (day 1)", priority: "4" }],
      pushHasTitle: ["health: strava pull error (day 1)"],
      logStatus: { strava: "error" },
      driftLogged: true,
      threw: false,
    },
  },
  {
    n: 45,
    name: "both alert channels may fail without stopping the handler",
    fixture: { oura: "throw", ntfy: "throw", push: "throw" },
    checks: {
      logStatus: { oura: "error", strava: "success" },
      driftLogged: true,
      threw: false,
      forbidAnywhere: ["SECRET-OURA-THROW"],
    },
  },
  {
    n: 46,
    name: "Oura provider response never reaches either channel",
    fixture: { oura: "partial", ntfy: "429", push: "ok" },
    checks: {
      logStatus: { oura: "partial" },
      ntfyHas: [{ title: "health: oura pull partial (day 1)", priority: "4" }],
      pushHasTitle: ["health: oura pull partial (day 1)"],
      forbidAnywhere: ["SECRET-OURA-BODY"],
    },
  },
  {
    n: 47,
    name: "Strava provider response never reaches either channel",
    fixture: { strava: "partial", ntfy: "429", push: "ok" },
    checks: {
      logStatus: { strava: "partial" },
      ntfyHas: [{ title: "health: strava pull partial (day 1)", priority: "4" }],
      pushHasTitle: ["health: strava pull partial (day 1)"],
      forbidAnywhere: ["SECRET-STRAVA-BODY"],
    },
  },
  {
    n: 48,
    name: "Oura exception text never reaches either channel",
    fixture: { oura: "throw", ntfy: "429", push: "ok" },
    checks: {
      logStatus: { oura: "error" },
      ntfyHas: [{ title: "health: oura pull error (day 1)", priority: "4" }],
      pushHasTitle: ["health: oura pull error (day 1)"],
      forbidAnywhere: ["SECRET-OURA-THROW"],
    },
  },
  {
    n: 49,
    name: "Strava exception text never reaches either channel",
    fixture: { strava: "throw", ntfy: "429", push: "ok" },
    checks: {
      logStatus: { strava: "error" },
      ntfyHas: [{ title: "health: strava pull error (day 1)", priority: "4" }],
      pushHasTitle: ["health: strava pull error (day 1)"],
      forbidAnywhere: ["SECRET-STRAVA-THROW"],
    },
  },
  {
    n: 50,
    name: "successful ntfy must not duplicate the alert through Web Push",
    fixture: { oura: "throw", ntfy: "ok", push: "ok" },
    checks: {
      ntfyTitleExactlyOnce: ["health: oura pull error (day 1)"],
      pushNoTitleEquals: ["health: oura pull error (day 1)"],
      threw: false,
      driftLogged: true,
    },
  },
];

// Regressions for the Codex audit of 9f20451: the staleness decision used an age rounded
// to one decimal. The two boundary ages are the reviewer's; the assertions are the author's.
describe("staleness is decided on the exact age (audit regression)", () => {
  test("30.04 hours is stale day 1 and alerts", async () => {
    const r = await runScheduled({ ouraNewRows: false, lastOuraReadingAgeHours: 30.04, oura: "ok", ntfy: "ok" });
    expect(r.ntfy.filter((n) => n.title === "health: oura has no new data (day 1)").length).toBe(1);
    expect(r.threw).toBe(false);
  });

  test("197.96 hours is still stale day 7 and stays quiet", async () => {
    const r = await runScheduled({ ouraNewRows: false, lastOuraReadingAgeHours: 197.96, oura: "ok", ntfy: "ok" });
    expect(r.ntfy.some((n) => n.title.includes("oura has no new data"))).toBe(false);
    expect(r.threw).toBe(false);
  });

  test("exactly 30 hours is not stale", async () => {
    const r = await runScheduled({ ouraNewRows: false, lastOuraReadingAgeHours: 30, oura: "ok", ntfy: "ok" });
    expect(r.ntfy.some((n) => n.title.includes("oura has no new data"))).toBe(false);
  });
});

describe("scheduled handler (Codex cases 27-50, NOR-289)", () => {
  for (const c of CASES) {
    test(`${c.n}. ${c.name}`, async () => {
      const r = await runScheduled(c.fixture);
      const k = c.checks;

      for (const [source, status] of Object.entries(k.logStatus ?? {})) {
        const rows = r.ingestLog.filter((x) => x.source === source);
        expect(rows.length).toBe(1);
        expect(rows[0].status).toBe(status);
        expect(rows[0].trigger).toBe("cron");
      }
      if (k.logRowExact) expect(r.ingestLog).toContainEqual(k.logRowExact);
      if (k.noLogRowFor) expect(r.ingestLog.filter((x) => x.source === k.noLogRowFor).length).toBe(0);

      for (const want of k.ntfyHas ?? []) {
        expect(r.ntfy.some((n) => n.title === want.title && n.priority === want.priority)).toBe(true);
      }
      for (const t of k.ntfyTitleExactlyOnce ?? []) expect(r.ntfy.filter((n) => n.title === t).length).toBe(1);
      for (const t of k.ntfyNoTitleEquals ?? []) expect(r.ntfy.some((n) => n.title === t)).toBe(false);
      for (const t of k.ntfyNoTitleContains ?? []) expect(r.ntfy.some((n) => n.title.includes(t))).toBe(false);
      for (const t of k.pushHasTitle ?? []) expect(r.pushes.some((p) => p.title === t)).toBe(true);
      for (const t of k.pushNoTitleEquals ?? []) expect(r.pushes.some((p) => p.title === t)).toBe(false);

      for (const bad of k.forbidAnywhere ?? []) {
        for (const m of [...r.ntfy, ...r.pushes]) {
          expect(m.title).not.toContain(bad);
          expect(m.body).not.toContain(bad);
        }
      }
      if (k.threw !== undefined) expect(r.threw).toBe(k.threw);
      if (k.driftLogged !== undefined) expect(r.driftLogged).toBe(k.driftLogged);
    });
  }
});
