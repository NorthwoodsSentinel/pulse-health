// Stateless OAuth state parameter — HMAC-signed timestamp + nonce.
// Avoids storing per-flow state in D1.

const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes

function b64urlEncode(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function b64urlDecode(s: string): Uint8Array {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const b64 = (s + pad).replaceAll("-", "+").replaceAll("_", "/");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function signState(source: string, secret: string): Promise<string> {
  const nonce = b64urlEncode(crypto.getRandomValues(new Uint8Array(12)));
  const payload = `${source}.${Date.now()}.${nonce}`;
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return `${payload}.${b64urlEncode(sig)}`;
}

export async function verifyState(
  state: string,
  expectedSource: string,
  secret: string,
): Promise<boolean> {
  const parts = state.split(".");
  if (parts.length !== 4) return false;
  const [source, tsStr, nonce, sigB64] = parts;
  if (source !== expectedSource) return false;
  const ts = parseInt(tsStr, 10);
  if (!Number.isFinite(ts)) return false;
  if (Date.now() - ts > STATE_TTL_MS) return false;
  const payload = `${source}.${tsStr}.${nonce}`;
  const key = await hmacKey(secret);
  const expected = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload)),
  );
  const got = b64urlDecode(sigB64);
  return timingSafeEqual(expected, got);
}
