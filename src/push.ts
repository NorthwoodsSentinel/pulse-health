// Web Push delivery — VAPID JWT + RFC 8291 payload encryption.
// Hand-rolled on Web Crypto so we don't pull a Node-deps library into Workers.

interface Subscription {
  endpoint: string;
  p256dh_key: string;  // base64url, uncompressed P-256 public key
  auth_secret: string; // base64url, 16 bytes
}

interface VapidKeys {
  publicKey: string;   // base64url
  privateKey: string;  // base64url raw 32-byte scalar
  subject: string;     // "mailto:..."
}

interface PushResult {
  status: number;
  error?: string;
}

// ---------- base64url helpers ----------

function b64urlDecode(s: string): Uint8Array {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const b64 = (s + pad).replaceAll("-", "+").replaceAll("_", "/");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64urlEncode(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function concat(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrays) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}

// ---------- VAPID JWT (ES256) ----------

async function importVapidPrivate(privateB64: string, publicB64: string): Promise<CryptoKey> {
  const d = privateB64;
  const raw = b64urlDecode(publicB64); // 0x04 || X(32) || Y(32)
  if (raw.length !== 65 || raw[0] !== 0x04) {
    throw new Error("VAPID public key must be 65-byte uncompressed P-256");
  }
  const x = b64urlEncode(raw.slice(1, 33));
  const y = b64urlEncode(raw.slice(33, 65));
  const jwk = { kty: "EC", crv: "P-256", d, x, y, ext: true };
  return crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
}

async function vapidJwt(endpoint: string, keys: VapidKeys): Promise<string> {
  const { origin } = new URL(endpoint);
  const header = { typ: "JWT", alg: "ES256" };
  const exp = Math.floor(Date.now() / 1000) + 12 * 3600;
  const claims = { aud: origin, exp, sub: keys.subject };
  const encHeader = b64urlEncode(new TextEncoder().encode(JSON.stringify(header)));
  const encClaims = b64urlEncode(new TextEncoder().encode(JSON.stringify(claims)));
  const signingInput = `${encHeader}.${encClaims}`;
  const privKey = await importVapidPrivate(keys.privateKey, keys.publicKey);
  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privKey,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${b64urlEncode(sig)}`;
}

// ---------- HKDF ----------

async function hkdf(
  salt: Uint8Array,
  ikm: Uint8Array,
  info: Uint8Array,
  length: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", ikm, { name: "HKDF" }, false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt, info },
    key,
    length * 8,
  );
  return new Uint8Array(bits);
}

// ---------- aes128gcm encryption per RFC 8291 ----------

async function encryptPayload(
  plaintext: Uint8Array,
  ua_public: Uint8Array,    // recipient p256dh, uncompressed (65 bytes)
  auth_secret: Uint8Array,  // recipient auth secret (16 bytes)
): Promise<{ body: Uint8Array; salt: Uint8Array; localPublic: Uint8Array }> {
  // Ephemeral local ECDH keypair.
  const local = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  );
  const localPubRaw = new Uint8Array(await crypto.subtle.exportKey("raw", local.publicKey));

  // Shared secret via ECDH with recipient's public key.
  const uaKey = await crypto.subtle.importKey(
    "raw",
    ua_public,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const sharedBits = await crypto.subtle.deriveBits(
    { name: "ECDH", public: uaKey },
    local.privateKey,
    256,
  );
  const ikm_raw = new Uint8Array(sharedBits);

  const salt = crypto.getRandomValues(new Uint8Array(16));

  // PRK_key = HKDF(auth_secret, ikm_raw, "WebPush: info" || 0x00 || ua_public || localPubRaw, 32)
  const keyInfo = concat(
    new TextEncoder().encode("WebPush: info\0"),
    ua_public,
    localPubRaw,
  );
  const ikm = await hkdf(auth_secret, ikm_raw, keyInfo, 32);

  // CEK = HKDF(salt, ikm, "Content-Encoding: aes128gcm" || 0x00, 16)
  const cek = await hkdf(
    salt,
    ikm,
    new TextEncoder().encode("Content-Encoding: aes128gcm\0"),
    16,
  );
  // NONCE = HKDF(salt, ikm, "Content-Encoding: nonce" || 0x00, 12)
  const nonce = await hkdf(
    salt,
    ikm,
    new TextEncoder().encode("Content-Encoding: nonce\0"),
    12,
  );

  // Plaintext padding: append 0x02 (last record marker), no extra padding bytes.
  const padded = concat(plaintext, new Uint8Array([0x02]));

  const aesKey = await crypto.subtle.importKey("raw", cek, { name: "AES-GCM" }, false, [
    "encrypt",
  ]);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aesKey, padded),
  );

  // Assemble aes128gcm content-encoding header:
  // salt(16) || rs(4, big-endian, =4096) || idlen(1, =65) || keyid(localPubRaw, 65) || ciphertext
  const rs = new Uint8Array([0, 0, 0x10, 0]); // 4096
  const idlen = new Uint8Array([localPubRaw.length]); // 65
  const body = concat(salt, rs, idlen, localPubRaw, ciphertext);

  return { body, salt, localPublic: localPubRaw };
}

// ---------- public entry ----------

export async function sendPush(
  sub: Subscription,
  payload: string,
  keys: VapidKeys,
): Promise<PushResult> {
  try {
    const ua_public = b64urlDecode(sub.p256dh_key);
    const auth_secret = b64urlDecode(sub.auth_secret);
    const plaintext = new TextEncoder().encode(payload);

    const { body } = await encryptPayload(plaintext, ua_public, auth_secret);
    const jwt = await vapidJwt(sub.endpoint, keys);

    const res = await fetch(sub.endpoint, {
      method: "POST",
      headers: {
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        "TTL": "60",
        "Urgency": "normal",
        "Authorization": `vapid t=${jwt}, k=${keys.publicKey}`,
      },
      body,
    });

    if (res.ok) {
      return { status: res.status };
    }
    const text = await res.text().catch(() => "");
    return { status: res.status, error: text.slice(0, 500) };
  } catch (e) {
    return { status: 0, error: (e as Error).message };
  }
}
