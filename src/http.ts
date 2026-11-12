// http.ts — one bounded retry policy for the data GETs the daily pull makes.
//
// kintsugi: a failed request was never retried (2026-11-12, NOR-289). One 429 or 5xx on a
// collection lost that collection for the day, and a record that first appeared on the
// last day of the lookback window could be missed for good.
//
// Deliberately NOT used for OAuth token requests. Oura rotates the refresh token on every
// use: a refresh that reached the server but whose response was lost has already spent the
// token, and a blind retry would send the spent one (incident 2026-07-08). Token calls
// stay single-attempt.

export const retryConfig = {
  /** Wait before retry 1, retry 2, …  Attempts = 1 + delaysMs.length. */
  delaysMs: [500, 1500] as number[],
  /** A numeric Retry-After is honoured up to this many milliseconds. */
  maxRetryAfterMs: 5000,
  sleep: (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)),
};

function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

/** Seconds form only ("120"). An HTTP-date or anything else is ignored. */
function retryAfterMs(res: Response): number | null {
  const raw = res.headers.get("Retry-After");
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return null;
  const seconds = Number(trimmed);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return Math.min(seconds * 1000, retryConfig.maxRetryAfterMs);
}

/**
 * GET with a small, bounded retry. Retries only when the attempt threw or returned 429 or
 * 5xx. Every other response (2xx, 3xx, and any 4xx except 429) is returned at once: a 401
 * or 403 is an answer, not an accident. After the last attempt the last response is
 * returned, or the last error rethrown, so callers' own error handling is unchanged.
 */
export async function fetchWithRetry(url: string, init?: RequestInit): Promise<Response> {
  const method = (init?.method ?? "GET").toUpperCase();
  if (method !== "GET") throw new Error("fetchWithRetry is GET-only");

  const delays = retryConfig.delaysMs;
  for (let attempt = 0; ; attempt++) {
    const isLast = attempt >= delays.length;
    let res: Response | null = null;
    let err: unknown = null;
    try {
      res = await fetch(url, init);
    } catch (e) {
      err = e;
    }

    if (res !== null && !isRetryableStatus(res.status)) return res;
    if (isLast) {
      if (res !== null) return res;
      throw err;
    }

    const asked = res !== null ? retryAfterMs(res) : null;
    // Drain the body of a response we are discarding so the connection can be reused.
    if (res !== null) {
      try {
        await res.body?.cancel();
      } catch {
        // nothing to do
      }
    }
    await retryConfig.sleep(asked ?? delays[attempt]);
  }
}
