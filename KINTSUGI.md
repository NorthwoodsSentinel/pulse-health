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
| 2026-11-08 | `bunx wrangler` (and `bun run wrangler`) ran a Wrangler from Bun's global cache when the local install was missing, outside bun.lock; package.json allowed any 4.x at or above 4.151.1. | Every documented and scripted Wrangler call goes through `scripts/wrangler.ts`, which refuses unless the lockfile-pinned binary is installed; package.json pins 4.156.0 exactly (the locked version) (NOR-161). | CeeCee / tested: refuses with exit 2 without node_modules, runs 4.156.0 with it; review pending | the tool came from whatever shelf was nearest — / now it comes from the one we signed for. |
