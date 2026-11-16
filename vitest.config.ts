// Vitest configuration: which tests run, and the per-file coverage bar.
//
// Vitest and its V8 coverage provider are the MCP Inspector's test tools at
// its exact pins (4.1.12). The thresholds block is the Inspector's own
// (modelcontextprotocol/inspector, clients/launcher/vitest.config.ts at commit
// d330df96): 90 on all four dimensions, per file. Record: PROVENANCE.md.
//
// `test.include` names each test file by path, not by a glob. Vitest reads
// those entries as patterns, so a listed file that is renamed or deleted
// would simply match nothing; the check below makes it fail instead, and
// also fails on a `*.test.ts` file under src/ or test/, at any depth, that
// is listed nowhere, and on a `*.test.mjs` under scripts/ that `test:scripts`
// does not run (AGENTS.md: keep a test file's exact filename).
//
// `coverage.include` is every source folder (src/, shared/; tests live in
// test/), so a new file there is measured without anyone remembering to add
// it. A file no test loads is
// reported at 0 and fails. Every exclusion below is a named line with its
// reason.
//
// `testTimeout` is stated once, here. `retry` stays unset: a retry would turn
// a real red into a quiet green.

/// <reference types="node" />
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";

const TEST_FILES = ["test/oauth.test.ts"];
const missing = TEST_FILES.filter((f) => !existsSync(f));
// Every `*.test.ts` under the source and test folders, at any depth.
const unlisted = ["src", "test"]
  .flatMap((dir) =>
    existsSync(dir)
      ? readdirSync(dir, { recursive: true, encoding: "utf8" }).map(
          (f) => `${dir}/${f.split("\\").join("/")}`,
        )
      : [],
  )
  .filter((f) => f.endsWith(".test.ts"))
  .filter((f) => !TEST_FILES.includes(f));
// The guards' own tests run under `node --test`, one file per entry in the
// `test:scripts` script: a `*.test.mjs` under scripts/ that it does not name
// would never run, so it fails here too.
const scriptTests = (
  JSON.parse(readFileSync("package.json", "utf8")) as {
    scripts: Record<string, string>;
  }
).scripts["test:scripts"];
const unlistedScripts = readdirSync("scripts", {
  recursive: true,
  encoding: "utf8",
})
  .map((f) => `scripts/${f.split("\\").join("/")}`)
  .filter((f) => f.endsWith(".test.mjs"))
  .filter((f) => !(scriptTests ?? "").split(" ").includes(f));
unlisted.push(...unlistedScripts);
if (missing.length > 0 || unlisted.length > 0)
  throw new Error(
    `vitest.config.ts: listed test files missing: [${missing.join(", ")}]; ` +
      `test files listed nowhere: [${unlisted.join(", ")}]`,
  );

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    include: TEST_FILES,
    testTimeout: 10_000,
    hookTimeout: 10_000,
    coverage: {
      provider: "v8",
      // `skipFull: false`: list every measured file, including one at 100%.
      reporter: [["text", { skipFull: false }], "json-summary"],
      include: ["src/**/*.{ts,tsx,mts,cts}", "shared/**/*.{ts,tsx,mts,cts}"],
      exclude: [
        // Existing first-party files with no tests yet, excluded by exact
        // path until they have them; follow-up: NOR-392. Each reads D1, a
        // third-party API or the push service, so its tests need stand-ins.
        "src/drift.ts",
        "src/index.ts",
        "src/oura.ts",
        "src/push.ts",
        "src/strava.ts",
        // A one-shot local key generator run by hand (it prints a private
        // key), not code the Worker runs.
        "shared/generate-vapid.ts",
      ],
      thresholds: {
        perFile: true,
        lines: 90,
        statements: 90,
        functions: 90,
        branches: 90,
      },
    },
  },
});
