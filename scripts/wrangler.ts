// Runs the Wrangler that bun.lock pins, or refuses.
//
//   bun scripts/wrangler.ts <wrangler args...>     (or: bun run wrangler <args...>)
//
// kintsugi: the guide once handed over whatever tool lay nearest, even one fetched from a
//   stranger's shelf; now it hands over only the tool written in the ledger, or nothing,
//   and the gap where a stranger's tool slipped in is filled with gold.
//
// `bunx wrangler` falls back to downloading a Wrangler of its own when the local install is
// missing, and `bun run` does not stop that either, so neither one guarantees the locked
// version. This refuses unless node_modules holds exactly the version bun.lock resolves, then
// runs that binary with the arguments passed through unchanged (no shell).
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type Check = { ok: true; bin: string; version: string } | { ok: false; reason: string };

export function lockedVersion(lockText: string): string | null {
  const m = lockText.match(/^\s*"wrangler": \["wrangler@([^"]+)"/m);
  return m ? m[1] : null;
}

export function check(root: string): Check {
  const lockPath = join(root, "bun.lock");
  if (!existsSync(lockPath)) return { ok: false, reason: "bun.lock not found" };
  const locked = lockedVersion(readFileSync(lockPath, "utf8"));
  if (!locked) return { ok: false, reason: "bun.lock does not pin wrangler" };

  const pkgPath = join(root, "node_modules", "wrangler", "package.json");
  const bin = join(root, "node_modules", "wrangler", "bin", "wrangler.js");
  if (!existsSync(pkgPath) || !existsSync(bin)) {
    return { ok: false, reason: `Wrangler is not installed; run: bun install --frozen-lockfile` };
  }
  let installed: unknown;
  try {
    installed = JSON.parse(readFileSync(pkgPath, "utf8")).version;
  } catch {
    return { ok: false, reason: "node_modules/wrangler/package.json is unreadable" };
  }
  if (installed !== locked) {
    return {
      ok: false,
      reason: `installed Wrangler ${String(installed)} is not the locked ${locked}; run: bun install --frozen-lockfile`,
    };
  }
  return { ok: true, bin, version: locked };
}

if (import.meta.main) {
  const root = join(dirname(import.meta.path), "..");
  const result = check(root);
  if (!result.ok) {
    console.error(`scripts/wrangler.ts: refusing: ${result.reason}`);
    process.exit(1);
  }
  const proc = Bun.spawn(["node", result.bin, ...process.argv.slice(2)], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  process.exit(await proc.exited);
}
