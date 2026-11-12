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
  // Cases 36, 37, 38 (staleness on the superseded floor formula) and 39 (whose age of 198h
  // is day 7 under the corrected rule and so proved nothing) were re-issued by Codex as
  // 36R-42R; see the describe block below the table.
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

// Cases 36R-42R: written by Codex (fixed brief, MODE tests, 2026-11-12) to replace 36-39
// after the stale-day rule changed to ceil((age - threshold) / 24) measured from the cron's
// scheduled time. Fixtures and expectations are transcribed unchanged.
describe("staleness cadence (Codex cases 36R-42R, replacing 36-39)", () => {
  test("36R. first instant stale", async () => {
    const r = await runScheduled({ ouraNewRows: false, lastOuraReadingAgeHours: 30.0001, oura: "ok", ntfy: "ok" });
    expect(r.ingestLog).toContainEqual(expect.objectContaining({ source: "oura", status: "success", trigger: "cron" }));
    expect(r.ntfy.filter((n) => n.title === "health: oura has no new data (day 1)")).toHaveLength(1);
    expect(r.threw).toBe(false);
    expect(r.driftLogged).toBe(true);
  });

  test("37R. first instant of stale day 2 is quiet", async () => {
    const r = await runScheduled({ ouraNewRows: false, lastOuraReadingAgeHours: 54.0001, oura: "ok", ntfy: "ok" });
    expect(r.ntfy.some((n) => n.title === "health: oura has no new data (day 2)")).toBe(false);
    expect(r.ntfy.some((n) => n.title.includes("health: oura has no new data"))).toBe(false);
    expect(r.threw).toBe(false);
    expect(r.driftLogged).toBe(true);
  });

  test("38R. first instant of stale day 8 repeats", async () => {
    const r = await runScheduled({ ouraNewRows: false, lastOuraReadingAgeHours: 198.0001, oura: "ok", ntfy: "ok" });
    expect(r.ntfy.filter((n) => n.title === "health: oura has no new data (day 8)")).toHaveLength(1);
    expect(r.threw).toBe(false);
    expect(r.driftLogged).toBe(true);
  });

  test("39R-A/39R-B. transition from threshold to threshold plus 24 hours", async () => {
    const atThreshold = await runScheduled({ ouraNewRows: false, lastOuraReadingAgeHours: 30, oura: "ok", ntfy: "ok" });
    const oneDayLater = await runScheduled({ ouraNewRows: false, lastOuraReadingAgeHours: 54, oura: "ok", ntfy: "ok" });
    expect(atThreshold.ntfy.some((n) => n.title.includes("health: oura has no new data"))).toBe(false);
    expect(oneDayLater.ntfy.filter((n) => n.title === "health: oura has no new data (day 1)")).toHaveLength(1);
    expect(atThreshold.threw).toBe(false);
    expect(oneDayLater.threw).toBe(false);
  });

  test("40R. daily sweep through stale days 1-9", async () => {
    const ages = [54, 78, 102, 126, 150, 174, 198, 222, 246];
    const runs = [];
    for (const age of ages) {
      runs.push(await runScheduled({ ouraNewRows: false, lastOuraReadingAgeHours: age, oura: "ok", ntfy: "ok" }));
    }
    const expectedTitles = [
      "health: oura has no new data (day 1)",
      null,
      null,
      null,
      null,
      null,
      null,
      "health: oura has no new data (day 8)",
      null,
    ];
    for (let i = 0; i < runs.length; i++) {
      const stale = runs[i].ntfy.filter((n) => n.title.includes("health: oura has no new data"));
      if (expectedTitles[i] === null) {
        expect(stale).toHaveLength(0);
      } else {
        expect(stale).toHaveLength(1);
        expect(stale[0].title).toBe(expectedTitles[i]);
      }
      expect(runs[i].threw).toBe(false);
      expect(runs[i].driftLogged).toBe(true);
    }
  });

  test("41R. failed Oura pull suppresses a stale alert that would otherwise be due", async () => {
    const r = await runScheduled({ oura: "throw", ouraNewRows: false, lastOuraReadingAgeHours: 222, ntfy: "ok" });
    expect(r.ingestLog).toContainEqual(expect.objectContaining({ source: "oura", status: "error", trigger: "cron" }));
    expect(r.ntfy.filter((n) => n.title === "health: oura pull error (day 1)")).toHaveLength(1);
    expect(r.ntfy.some((n) => n.title.includes("health: oura has no new data"))).toBe(false);
    expect(r.threw).toBe(false);
    expect(r.driftLogged).toBe(true);
  });

  test("42R. partial Oura pull also suppresses otherwise-due staleness", async () => {
    const r = await runScheduled({ oura: "partial", ouraNewRows: false, lastOuraReadingAgeHours: 222, ntfy: "ok" });
    expect(r.ingestLog).toContainEqual(expect.objectContaining({ source: "oura", status: "partial", trigger: "cron" }));
    expect(r.ntfy.filter((n) => n.title === "health: oura pull partial (day 1)")).toHaveLength(1);
    expect(r.ntfy.some((n) => n.title.includes("health: oura has no new data"))).toBe(false);
    expect(r.threw).toBe(false);
    expect(r.driftLogged).toBe(true);
  });
});

describe("scheduled handler (Codex cases 27-35 and 40-50, NOR-289)", () => {
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

// Cases 51-63: retry of data requests, and "no log row, no alert". Written by Codex (fixed
// brief, MODE tests, 2026-11-12) from the design, before the audit. Fixtures and
// expectations are transcribed unchanged.
describe("retry and the log-row gate (Codex cases 51-63, NOR-289)", () => {
  const all = (r: RunResult) => [...r.ntfy.map((n) => n.title), ...r.pushes.map((p) => p.title)];
  const absentOrZero = (r: RunResult, key: string) => expect(r.requests[key] ?? 0).toBe(0);
  const OURA_KINDS = ["daily_sleep", "daily_readiness", "daily_activity", "daily_stress", "sleep", "workout"];

  test("51. successful stale pull whose Oura log write fails emits no alert", async () => {
    const r = await runScheduled({ ingestLogWriteFails: "oura", oura: "ok", ouraNewRows: false, lastOuraReadingAgeHours: 222, ntfy: "ok" });
    expect(r.ingestLog.filter((x) => x.source === "oura")).toHaveLength(0);
    expect(all(r)).not.toContain("health: oura has no new data (day 8)");
    expect(all(r).some((t) => t.includes("health: oura pull"))).toBe(false);
    expect(r.threw).toBe(false);
    expect(r.driftLogged).toBe(true);
  });

  test("52. failing pull whose Oura log write fails emits no failure or stale alert", async () => {
    const r = await runScheduled({ ingestLogWriteFails: "oura", oura: "partial", ouraNewRows: false, lastOuraReadingAgeHours: 222, ntfy: "ok" });
    expect(r.ingestLog.filter((x) => x.source === "oura")).toHaveLength(0);
    expect(r.requests["oura:daily_stress"]).toBe(3);
    expect(all(r)).not.toContain("health: oura pull partial (day 1)");
    expect(all(r)).not.toContain("health: oura has no new data (day 8)");
    expect(all(r).some((t) => t.includes("health: oura pull"))).toBe(false);
    expect(all(r).some((t) => t.includes("health: oura has no new data"))).toBe(false);
    expect(r.threw).toBe(false);
    expect(r.driftLogged).toBe(true);
  });

  test("53. Oura 429 recovers on the second request", async () => {
    const r = await runScheduled({ ouraTransient: { kind: "daily_stress", failures: 1, mode: 429 }, ntfy: "ok" });
    expect(r.requests["oura:daily_stress"]).toBe(2);
    expect(r.ingestLog).toContainEqual(expect.objectContaining({ source: "oura", status: "success", trigger: "cron" }));
    expect(all(r)).not.toContain("health: oura pull partial (day 1)");
    expect(all(r)).not.toContain("health: oura pull error (day 1)");
    expect(r.threw).toBe(false);
  });

  test("54. Oura thrown request recovers on the third request", async () => {
    const r = await runScheduled({ ouraTransient: { kind: "sleep", failures: 2, mode: "throw" }, ntfy: "ok" });
    expect(r.requests["oura:sleep"]).toBe(3);
    expect(r.ingestLog.find((x) => x.source === "oura")?.status).toBe("success");
    expect(all(r)).not.toContain("health: oura pull partial (day 1)");
    expect(all(r)).not.toContain("health: oura pull error (day 1)");
    expect(r.threw).toBe(false);
  });

  test("55. Oura exhausted 502 remains partial with unchanged error text", async () => {
    const r = await runScheduled({ ouraTransient: { kind: "daily_stress", failures: 3, mode: 502 }, ntfy: "ok" });
    expect(r.requests["oura:daily_stress"]).toBe(3);
    const row = r.ingestLog.find((x) => x.source === "oura");
    expect(row?.status).toBe("partial");
    expect(row?.trigger).toBe("cron");
    expect(row?.error).toBe("daily_stress: Oura /daily_stress 502: SECRET-OURA-BODY");
    expect(r.ntfy.filter((n) => n.title === "health: oura pull partial (day 1)")).toHaveLength(1);
    expect(all(r).some((t) => t.includes("health: oura has no new data"))).toBe(false);
    expect(r.threw).toBe(false);
  });

  test("56. all unaffected Oura collections remain single-request", async () => {
    const r = await runScheduled({ ouraTransient: { kind: "daily_stress", failures: 1, mode: 500 } });
    expect(r.requests["oura:daily_stress"]).toBe(2);
    for (const kind of ["daily_sleep", "daily_readiness", "daily_activity", "sleep", "workout"]) {
      expect(r.requests[`oura:${kind}`]).toBe(1);
    }
    absentOrZero(r, "oura:token");
  });

  test("57. Strava athlete 500 recovers", async () => {
    const r = await runScheduled({ stravaTransient: { endpoint: "athlete", failures: 1, mode: 500 }, ntfy: "ok" });
    expect(r.requests["strava:athlete"]).toBe(2);
    expect(r.requests["strava:stats"]).toBe(1);
    expect(r.requests["strava:activities"]).toBe(1);
    expect(r.ingestLog.find((x) => x.source === "strava")?.status).toBe("success");
    expect(all(r)).not.toContain("health: strava pull partial (day 1)");
    expect(all(r)).not.toContain("health: strava pull error (day 1)");
  });

  test("58. Strava stats 429 recovers on the third request", async () => {
    const r = await runScheduled({ stravaTransient: { endpoint: "stats", failures: 2, mode: 429 }, ntfy: "ok" });
    expect(r.requests["strava:athlete"]).toBe(1);
    expect(r.requests["strava:stats"]).toBe(3);
    expect(r.requests["strava:activities"]).toBe(1);
    expect(r.ingestLog.find((x) => x.source === "strava")?.status).toBe("success");
    expect(all(r)).not.toContain("health: strava pull partial (day 1)");
    expect(all(r)).not.toContain("health: strava pull error (day 1)");
  });

  test("59. Strava activities network exception recovers", async () => {
    const r = await runScheduled({ stravaTransient: { endpoint: "activities", failures: 1, mode: "throw" }, ntfy: "ok" });
    expect(r.requests["strava:athlete"]).toBe(1);
    expect(r.requests["strava:stats"]).toBe(1);
    expect(r.requests["strava:activities"]).toBe(2);
    expect(r.ingestLog.find((x) => x.source === "strava")?.status).toBe("success");
    expect(all(r)).not.toContain("health: strava pull partial (day 1)");
    expect(all(r)).not.toContain("health: strava pull error (day 1)");
  });

  test("60. Strava exhausted activities failures remain partial", async () => {
    const r = await runScheduled({ stravaTransient: { endpoint: "activities", failures: 3, mode: 500 }, ntfy: "ok" });
    expect(r.requests["strava:activities"]).toBe(3);
    const row = r.ingestLog.find((x) => x.source === "strava");
    expect(row?.status).toBe("partial");
    expect(row?.trigger).toBe("cron");
    expect(r.ntfy.filter((n) => n.title === "health: strava pull partial (day 1)")).toHaveLength(1);
    expect(r.threw).toBe(false);
  });

  test("61. definitive Strava 403 costs one request", async () => {
    const r = await runScheduled({ strava: "partial", ntfy: "ok" });
    expect(r.requests["strava:athlete"]).toBe(1);
    absentOrZero(r, "strava:stats");
    expect(r.requests["strava:activities"]).toBe(1);
    const row = r.ingestLog.find((x) => x.source === "strava");
    expect(row?.error).toBe("athlete: Strava /athlete 403: SECRET-STRAVA-BODY");
    expect(row?.status).toBe("partial");
    expect(r.ntfy.filter((n) => n.title === "health: strava pull partial (day 1)")).toHaveLength(1);
  });

  test("62. Oura refresh exception is never retried", async () => {
    const r = await runScheduled({ oura: "throw", ntfy: "ok" });
    expect(r.requests["oura:token"]).toBe(1);
    for (const kind of OURA_KINDS) absentOrZero(r, `oura:${kind}`);
    expect(r.ingestLog.find((x) => x.source === "oura")?.status).toBe("error");
    expect(r.ntfy.filter((n) => n.title === "health: oura pull error (day 1)")).toHaveLength(1);
    expect(r.threw).toBe(false);
  });

  test("63. Strava refresh exception is never retried", async () => {
    const r = await runScheduled({ strava: "throw", ntfy: "ok" });
    expect(r.requests["strava:token"]).toBe(1);
    absentOrZero(r, "strava:athlete");
    absentOrZero(r, "strava:stats");
    absentOrZero(r, "strava:activities");
    expect(r.ingestLog.find((x) => x.source === "strava")?.status).toBe("error");
    expect(r.ntfy.filter((n) => n.title === "health: strava pull error (day 1)")).toHaveLength(1);
    expect(r.threw).toBe(false);
  });
});

// The design review of the retry change (2026-11-12) found that the digest pushes were not
// covered by "no log row, no alert" and that the planned evidence never reached them. The
// scenario is the reviewer's (a successful pull that adds rows, with that source's log
// write failing); the assertions are the author's.
describe("no log row, no digest either (design-review regression)", () => {
  test("Oura pull adds rows but its log write fails: nothing is sent for Oura", async () => {
    const r = await runScheduled({ ingestLogWriteFails: "oura", oura: "ok", ntfy: "ok" });
    expect(r.ingestLog.filter((x) => x.source === "oura")).toHaveLength(0);
    expect(r.pushes.some((p) => p.title === "Oura digest")).toBe(false);
    expect([...r.ntfy, ...r.pushes].some((m) => m.title.toLowerCase().includes("oura"))).toBe(false);
    // The other source is unaffected and still reports normally.
    expect(r.ingestLog.find((x) => x.source === "strava")?.status).toBe("success");
    expect(r.pushes.some((p) => p.title === "Strava digest")).toBe(true);
    expect(r.driftLogged).toBe(true);
    expect(r.threw).toBe(false);
  });

  test("Strava pull adds rows but its log write fails: nothing is sent for Strava", async () => {
    const r = await runScheduled({ ingestLogWriteFails: "strava", strava: "ok", ntfy: "ok" });
    expect(r.ingestLog.filter((x) => x.source === "strava")).toHaveLength(0);
    expect(r.pushes.some((p) => p.title === "Strava digest")).toBe(false);
    expect([...r.ntfy, ...r.pushes].some((m) => m.title.toLowerCase().includes("strava"))).toBe(false);
    expect(r.ingestLog.find((x) => x.source === "oura")?.status).toBe("success");
    expect(r.pushes.some((p) => p.title === "Oura digest")).toBe(true);
    expect(r.driftLogged).toBe(true);
    expect(r.threw).toBe(false);
  });

  test("control: with the log write working, both digests are sent", async () => {
    const r = await runScheduled({ ntfy: "ok" });
    expect(r.pushes.some((p) => p.title === "Oura digest")).toBe(true);
    expect(r.pushes.some((p) => p.title === "Strava digest")).toBe(true);
  });
});
