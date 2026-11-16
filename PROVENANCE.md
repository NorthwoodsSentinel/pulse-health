# Provenance

Where this repo's rules, gate and guards came from. Everything listed here was
copied from a public source at a recorded commit and then edited; nothing was
rewritten from a summary. Each copied file also says what was changed in its
own header.

Source: **Inspector**, `modelcontextprotocol/inspector`, branch `v2/main`,
commit `d330df9617e44ec893bc1a53618662239342d433`.

## Rules file

| This repo   | Source                | How                                                                                                                                                                                                                                                       |
| ----------- | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AGENTS.md` | Inspector `AGENTS.md` | Section by section. Kept: issue-driven work, review handling, testing and the per-file 90 bar, timeouts, the pre-push gate, waiting, build output, lint with no warning tier, TypeScript rules, skills maintenance. Left out: his folder tree, web, React, auth-token and npm-release sections. Added: Cloudflare work (ours), and a rule that the owner's data never enters an issue, PR, fixture or log. |
| `CLAUDE.md` | Inspector `CLAUDE.md` | Same one line: `@./AGENTS.md`.                                                                                                                                                                                                                            |

## Gate

| This repo                               | Source                                                     | Edits                                                                                                                                              |
| --------------------------------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.github/workflows/main.yml`            | Inspector `.github/workflows/main.yml`                     | One `validate` job; pushes limited to `main`; every action SHA-pinned; never deploys.                                                              |
| `.github/workflows/dco.yml`             | Inspector `.github/workflows/dco.yml`                      | Branch `main`; PR job on every base; the PR's commits fetched from a second credential-free checkout; on the PR that first adds the script (the base has none), the Inspector's own copy at d330df96 is fetched and hash-checked, and runs instead; nothing from the PR runs. |
| `scripts/dco-check.mjs`, test           | Inspector `scripts/dco-check.mjs`, `.test.mjs`             | The `--base` example names `origin/main`.                                                       |
| `scripts/lib/main-module.mjs`, test     | Inspector `scripts/lib/main-module.mjs`, `.test.mjs`       | Also compares the symlink-resolved entry path.                                                                                                     |
| `scripts/entry-points.test.mjs`         | Written here                                               | Runs each guard through a symlinked checkout and asserts a terminal verdict line.                                                                  |
| `scripts/verify-action-pins.mjs`, test  | Inspector `scripts/verify-action-pins.mjs`, `.test.mjs`    | Every job checked; local `./` refs, zero workflow files, a workflow with no jobs, and non-regular entries are findings; one descriptor per file.                              |
| `vitest.config.ts`                      | Inspector `clients/launcher/vitest.config.ts` (thresholds) | Test files named by path, and the config fails on a listed file that is missing, a test file listed nowhere, or a `scripts/**/*.test.mjs` that `test:scripts` does not run; coverage over `src/` and `shared/` in all four TypeScript extensions; 90 on all four, per file.                                                                    |
| `eslint.config.js`                      | Inspector `eslint.config.js`                               | One TypeScript scope; `no-floating-promises` at `error`; `--max-warnings 0`.                                                                        |

## Changes to the repo's own code and tooling

- `package.json`: the gate scripts are added; the existing `deploy`, `dev`,
  `db:apply`, `db:migrate` and `vapid:generate` scripts are unchanged.
- `src/*.ts`, `shared/*.ts`, `public/*.js`: reformatted by Prettier.
- Type errors the repo already had under its own TypeScript 5.9.3 (it had no
  typecheck step) are fixed with type-only edits: the cron handler's first
  parameter is typed `ScheduledController`, and `Uint8Array` values passed to
  WebCrypto and `fetch` in `src/push.ts` carry `as BufferSource` /
  `as BodyInit` casts. No expression that runs changed.
- Lint: four `payload: any` / `item: any` sites holding Oura API JSON carry
  an inline disable with its reason; an empty `catch {}` in `src/oura.ts`
  holds a comment saying why it is empty; `public/app.js` drops an unused
  catch binding and `public/sw.js` an unused handler parameter.
- New: `test/oauth.test.ts` (the OAuth `state` sign and verify).
- Coverage exclusions by exact path, follow-up NOR-392: `src/drift.ts`,
  `src/index.ts`, `src/oura.ts`, `src/push.ts`, `src/strava.ts`,
  `shared/generate-vapid.ts`.
