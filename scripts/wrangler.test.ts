import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { check, lockedVersion } from "./wrangler";

const LOCK_LINE = `    "wrangler": ["wrangler@4.156.0", "", { "bin": { "wrangler": "bin/wrangler.js" } }, "sha512-x"],\n`;
const roots: string[] = [];

// A temp project root; the space in the prefix keeps paths-with-spaces honest.
function project(opts: { lock?: string | null; installed?: string | null; bin?: boolean } = {}): string {
  const root = mkdtempSync(join(tmpdir(), "pulse wrangler-"));
  roots.push(root);
  const lock = opts.lock === undefined ? `{\n  "packages": {\n${LOCK_LINE}  }\n}\n` : opts.lock;
  if (lock !== null) writeFileSync(join(root, "bun.lock"), lock);
  const installed = opts.installed === undefined ? "4.156.0" : opts.installed;
  if (installed !== null) {
    const dir = join(root, "node_modules", "wrangler");
    mkdirSync(join(dir, "bin"), { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ version: installed }));
    if (opts.bin !== false) writeFileSync(join(dir, "bin", "wrangler.js"), "");
  }
  return root;
}

afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

test("reads the resolved version, not the package.json range", () => {
  const lock = `{\n  "workspaces": { "": { "devDependencies": { "wrangler": "^4.151.1" } } },\n  "packages": {\n${LOCK_LINE}  }\n}\n`;
  expect(lockedVersion(lock)).toBe("4.156.0");
});

test("runs when the installed version is the locked one", () => {
  const root = project();
  const r = check(root);
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.bin).toBe(join(root, "node_modules", "wrangler", "bin", "wrangler.js"));
});

test("refuses when Wrangler is not installed", () => {
  const r = check(project({ installed: null }));
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.reason).toContain("not installed");
});

test("refuses when the binary is missing", () => {
  expect(check(project({ bin: false })).ok).toBe(false);
});

test("refuses a stale install that differs from the lock", () => {
  const r = check(project({ installed: "4.92.0" }));
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.reason).toContain("4.92.0");
});

test("refuses without bun.lock", () => {
  expect(check(project({ lock: null })).ok).toBe(false);
});

test("refuses when bun.lock does not pin wrangler", () => {
  const r = check(project({ lock: `{ "packages": {} }\n` }));
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.reason).toContain("does not pin");
});

test("end to end: refuses with exit 1 when nothing is installed", async () => {
  const root = project({ installed: null });
  mkdirSync(join(root, "scripts"));
  writeFileSync(join(root, "scripts", "wrangler.ts"), await Bun.file(join(import.meta.dir, "wrangler.ts")).text());
  const proc = Bun.spawn(["bun", join(root, "scripts", "wrangler.ts"), "--version"], { stdout: "pipe", stderr: "pipe" });
  const err = await new Response(proc.stderr).text();
  expect(await proc.exited).toBe(1);
  // Only the refusal line: nothing was spawned after it.
  expect(err.trim().split("\n")).toEqual(["scripts/wrangler.ts: refusing: Wrangler is not installed; run: bun install --frozen-lockfile"]);
});

test("end to end: runs the locked Wrangler in this checkout", async () => {
  const locked = lockedVersion(await Bun.file(join(import.meta.dir, "..", "bun.lock")).text());
  const proc = Bun.spawn(["bun", join(import.meta.dir, "wrangler.ts"), "--version"], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  expect(await proc.exited).toBe(0);
  expect(out).toContain(locked!);
});
