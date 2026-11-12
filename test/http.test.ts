// Pure cases for src/http.ts fetchWithRetry (NOR-289).
//
// Cases 1-14 were written by Codex (a non-Claude reviewer) on the fixed audit brief, MODE
// tests, 2026-11-12, from the design, before the implementation was audited. Response
// sequences and expected calls, waits and outcomes are transcribed unchanged; `withFetch`
// is the helper the contract described and is the author's.

import { describe, expect, test } from "bun:test";
import { fetchWithRetry, retryConfig } from "../src/http";

type Step = { status: number; retryAfter?: string } | "throw";

async function withFetch(
  responses: Step[],
  fn: () => Promise<Response>,
): Promise<{ result: Response | null; error: Error | null; calls: number; waits: number[] }> {
  const realFetch = globalThis.fetch;
  const realSleep = retryConfig.sleep;
  const realDelays = retryConfig.delaysMs;
  const realMax = retryConfig.maxRetryAfterMs;
  let calls = 0;
  const waits: number[] = [];
  retryConfig.delaysMs = [500, 1500];
  retryConfig.maxRetryAfterMs = 5000;
  retryConfig.sleep = async (ms: number) => {
    waits.push(ms);
  };
  globalThis.fetch = (async () => {
    const step = responses[calls];
    calls++;
    if (step === undefined) throw new Error("test made more requests than the sequence provides");
    if (step === "throw") throw new Error("network error");
    const headers = new Headers();
    if (step.retryAfter !== undefined) headers.set("Retry-After", step.retryAfter);
    // 204 and 3xx must not carry a body.
    const body = step.status === 204 || (step.status >= 300 && step.status < 400) ? null : "body";
    return new Response(body, { status: step.status, headers });
  }) as typeof fetch;
  let result: Response | null = null;
  let error: Error | null = null;
  try {
    result = await fn();
  } catch (e) {
    error = e as Error;
  } finally {
    globalThis.fetch = realFetch;
    retryConfig.sleep = realSleep;
    retryConfig.delaysMs = realDelays;
    retryConfig.maxRetryAfterMs = realMax;
  }
  return { result, error, calls, waits };
}

const URL = "https://example.test/data";

describe("fetchWithRetry (Codex cases 1-14)", () => {
  const returning: [n: number, name: string, responses: Step[], calls: number, waits: number[], status: number][] = [
    [1, "immediate success", [{ status: 200 }], 1, [], 200],
    [2, "redirect is definitive", [{ status: 302 }, { status: 200 }], 1, [], 302],
    [3, "429 recovers using numeric Retry-After", [{ status: 429, retryAfter: "2" }, { status: 200 }], 2, [2000], 200],
    [4, "two different 5xx responses recover on the final attempt", [{ status: 500 }, { status: 599 }, { status: 204 }], 3, [500, 1500], 204],
    [5, "thrown request recovers", ["throw", { status: 200 }], 2, [500], 200],
    [6, "retryable responses terminate after exactly three attempts", [{ status: 500 }, { status: 502 }, { status: 503 }, { status: 200 }], 3, [500, 1500], 503],
    [7, "definitive 403 never retries", [{ status: 403 }, { status: 200 }], 1, [], 403],
    [10, "zero Retry-After does not fall back to the default", [{ status: 429, retryAfter: "0" }, { status: 200 }], 2, [0], 200],
    [11, "huge Retry-After is capped", [{ status: 503, retryAfter: "999999999999999999999999" }, { status: 200 }], 2, [5000], 200],
    [12, "negative Retry-After falls back safely", [{ status: 429, retryAfter: "-1" }, { status: 200 }], 2, [500], 200],
    [13, "HTTP-date Retry-After is ignored", [{ status: 503, retryAfter: "Wed, 21 Oct 2099 07:28:00 GMT" }, { status: 200 }], 2, [500], 200],
    [14, "non-finite or malformed Retry-After cannot crash or wait indefinitely", [{ status: 429, retryAfter: "Infinity" }, { status: 500, retryAfter: "1e309" }, { status: 200 }], 3, [500, 1500], 200],
  ];
  for (const [n, name, responses, calls, waits, status] of returning) {
    test(`${n}. ${name}`, async () => {
      const r = await withFetch(responses, () => fetchWithRetry(URL));
      expect(r.error).toBeNull();
      expect(r.calls).toBe(calls);
      expect(r.waits).toEqual(waits);
      expect(r.result?.status).toBe(status);
    });
  }

  test("8. POST is refused before fetch", async () => {
    const r = await withFetch([{ status: 200 }], () =>
      fetchWithRetry("https://example.test/token", { method: "POST" }),
    );
    expect(r.calls).toBe(0);
    expect(r.waits).toEqual([]);
    expect(r.error?.message).toBe("fetchWithRetry is GET-only");
  });

  test("9. repeated network exceptions terminate and preserve the last error", async () => {
    const r = await withFetch(["throw", "throw", "throw", { status: 200 }], () => fetchWithRetry(URL));
    expect(r.calls).toBe(3);
    expect(r.waits).toEqual([500, 1500]);
    expect(r.error?.message).toBe("network error");
  });
});
