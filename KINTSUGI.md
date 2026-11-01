# Kintsugi

Kintsugi is the Japanese art of mending broken pottery with gold, so the repair becomes part of the object's history instead of something hidden.

This file is the same idea for code. Every fix here leaves a seam in three places, all carrying the same gold line:

- a short `kintsugi:` comment at the repair site;
- a `Kintsugi:` trailer on the commit;
- an entry in this append-only ledger.

The seam shows the break; it doesn't hide it. Security fixes describe what kind of thing was mended, never how to exploit it.

A repair is entered as "review pending". The reviewer is recorded only after the review has happened, in a later commit that names the verdict and the commit it reviewed, so this ledger never claims a review before it exists.

| Date | What broke | How it was mended | Mended by / reviewed by | Gold line |
|---|---|---|---|---|
| 2026-10-31 | The development toolchain (Wrangler 4.92 and what it pulls in) carried ten high advisories onto every contributor machine, and two lockfiles could drift apart. The deployed Worker has no npm dependencies, so it was never exposed. | Wrangler moved to `^4.151.1` (the lockfile resolves 4.156.0), the project keeps a single `bun.lock`, and every documented command uses `bunx wrangler` after `bun install` (the setup guide no longer accepts a global 4.92). Known limit: `bunx` downloads a Wrangler of its own if the local install is missing, so skipping `bun install` bypasses the lockfile (NOR-161). `bun audit`: no vulnerabilities; dry-run build passes. | Margin / Codex read-only audit, 4 rounds: the toolchain fix holds; round 4's remaining finding (bunx download fallback) recorded as a known limit; merge awaits Rob | *The tools on the bench had gone soft at the edges while the work itself stayed sound; now the bench is sharpened too, and the guide hands you the sharpened one.* |
| 2026-11-01 | `tsc --noEmit` failed on main in three places, so the type checker could not be used as a gate: `node:crypto` had no types in the Workers config, `scheduled()` declared the wrong first parameter type, and the WebCrypto calls in `push.ts` were handed byte arrays that TypeScript 5.7+ allows to be shared memory. | Type-only repairs: `ScheduledController` for the cron handler, a `Bytes = Uint8Array<ArrayBuffer>` alias in `push.ts` (every array there is freshly allocated), and the VAPID generator uses the WebCrypto global instead of importing `node:crypto`. `tsc`: 0 errors. The Wrangler dry-run bundle is unchanged except one unused parameter name; the generator still runs. | Margin / review pending | *The checker had been saying three things were wrong while the work ran true; each claim is now stated as it really is, so its warnings mean something again, and the seam runs gold.* |
