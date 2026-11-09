// NOR-161: run ONLY the lockfile-pinned Wrangler. `bunx wrangler` / `bun run wrangler` silently fetch and run a Wrangler
// from Bun's global cache when node_modules is missing, outside bun.lock. This refuses unless the local install exists,
// then runs it with the given arguments. Usage: bun scripts/wrangler.ts <wrangler args…>
import { existsSync } from "node:fs";
import { join } from "node:path";
const root = join(import.meta.dir, "..");
const bin = join(root, "node_modules", ".bin", "wrangler");
if (!existsSync(bin)) {
  console.error("REFUSED: the pinned Wrangler is not installed. Run `bun install --frozen-lockfile` first, then retry.");
  process.exit(2);
}
const p = Bun.spawnSync([bin, ...process.argv.slice(2)], { stdio: ["inherit", "inherit", "inherit"], cwd: root });
process.exit(p.exitCode ?? 1);
