// One-shot VAPID keypair generator. Run with: bun shared/generate-vapid.ts
//
// Writes the keypair to stdout in base64url-encoded uncompressed form,
// matching the format the worker and Web Push subscribe() expect.
//
// IMPORTANT: the private key prints once. Store it in 1Password (or equivalent)
// immediately, then `wrangler secret put VAPID_PRIVATE_KEY` to install it on
// the worker. Do NOT commit it. Do NOT echo it into shell history.

import { webcrypto } from "node:crypto";

function b64url(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

const keyPair = await webcrypto.subtle.generateKey(
  { name: "ECDSA", namedCurve: "P-256" },
  true,
  ["sign", "verify"],
);

const rawPublic = await webcrypto.subtle.exportKey("raw", keyPair.publicKey);
const jwkPrivate = await webcrypto.subtle.exportKey("jwk", keyPair.privateKey);

const publicB64 = b64url(rawPublic);
const privateB64 = b64url(
  Uint8Array.from(atob(jwkPrivate.d!.replaceAll("-", "+").replaceAll("_", "/")), c => c.charCodeAt(0)),
);

console.log("===== VAPID KEYPAIR (generated " + new Date().toISOString() + ") =====");
console.log("");
console.log("VAPID_PUBLIC_KEY  (safe to embed in PWA, safe to commit):");
console.log("  " + publicB64);
console.log("");
console.log("VAPID_PRIVATE_KEY (Worker secret — store offline NOW, install via wrangler):");
console.log("  " + privateB64);
console.log("");
console.log("Next steps:");
console.log("  1. Copy the private key to 1Password (label: 'pulse-health VAPID private')");
console.log("  2. echo -n '<private key>' | wrangler secret put VAPID_PRIVATE_KEY");
console.log("  3. echo -n '<public key>'  | wrangler secret put VAPID_PUBLIC_KEY");
console.log("  4. Clear your terminal scrollback");
