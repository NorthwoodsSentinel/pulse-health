// Tests for src/oauth.ts: the stateless OAuth `state` parameter (HMAC-signed
// source, timestamp and nonce). Each case asserts the verdict for one way a
// state can be wrong.

import { afterEach, describe, expect, test, vi } from "vitest";
import { signState, verifyState } from "../src/oauth";

const SECRET = "test-secret-not-a-real-one";

afterEach(() => {
  vi.useRealTimers();
});

describe("signState / verifyState", () => {
  test("a fresh state for the same source verifies", async () => {
    const s = await signState("oura", SECRET);
    expect(s.split(".")).toHaveLength(4);
    expect(s.startsWith("oura.")).toBe(true);
    expect(await verifyState(s, "oura", SECRET)).toBe(true);
  });

  test("two states differ (fresh nonce)", async () => {
    expect(await signState("oura", SECRET)).not.toBe(
      await signState("oura", SECRET),
    );
  });

  test("the wrong source is refused", async () => {
    const s = await signState("oura", SECRET);
    expect(await verifyState(s, "strava", SECRET)).toBe(false);
  });

  test("the wrong secret is refused", async () => {
    const s = await signState("oura", SECRET);
    expect(await verifyState(s, "oura", "other-secret")).toBe(false);
  });

  test("a state with the wrong number of parts is refused", async () => {
    expect(await verifyState("oura.1.n", "oura", SECRET)).toBe(false);
    expect(await verifyState("oura.1.n.s.x", "oura", SECRET)).toBe(false);
  });

  test("a non-numeric timestamp is refused", async () => {
    expect(await verifyState("oura.abc.n.sig", "oura", SECRET)).toBe(false);
  });

  test("a state older than ten minutes is refused", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const s = await signState("oura", SECRET);
    vi.setSystemTime(new Date("2026-01-01T00:09:59Z"));
    expect(await verifyState(s, "oura", SECRET)).toBe(true);
    vi.setSystemTime(new Date("2026-01-01T00:10:01Z"));
    expect(await verifyState(s, "oura", SECRET)).toBe(false);
  });

  test("a tampered payload or signature is refused", async () => {
    const s = await signState("oura", SECRET);
    const [src, ts, nonce, sig] = s.split(".");
    expect(
      await verifyState(`${src}.${ts}.${nonce}x.${sig}`, "oura", SECRET),
    ).toBe(false);
    // A signature of a different length fails the length check.
    expect(
      await verifyState(`${src}.${ts}.${nonce}.${sig}AAAA`, "oura", SECRET),
    ).toBe(false);
    // A signature that is not valid base64 makes verifyState reject (atob
    // throws) rather than return false. Recorded as it is; the caller's
    // try/catch decides what that means.
    await expect(
      verifyState(`${src}.${ts}.${nonce}.${sig}AA`, "oura", SECRET),
    ).rejects.toThrow();
    // Same length, one character changed.
    const flipped = (sig?.[0] === "A" ? "B" : "A") + (sig ?? "").slice(1);
    expect(
      await verifyState(`${src}.${ts}.${nonce}.${flipped}`, "oura", SECRET),
    ).toBe(false);
  });
});
