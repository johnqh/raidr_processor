# CLAUDE.md

> **Git policy — never auto-commit or auto-push.** Leave your work in the working tree.
> Run `git commit`, `git push`, `gh pr create`, or `push_all.sh` **only when the user
> explicitly asks in that turn**. Approval for an earlier change does not carry forward, and
> finishing a task is not permission to commit it.

## What this is

`@sudobility/raidr_processor` (public on npm, BUSL-1.1) is the pure core of raidr. It holds the
capture bundle format, redaction, coverage, API/route inference and code generation. Callers
supply bytes and records, and this package returns values. It never reads or writes anything
itself.

Where it sits in the raidr family:

| Repo | Role | Relation to this package |
| --- | --- | --- |
| `raidr_extension` | Chrome MV3 capture | Bundles this package into the extension. Uses redaction, coverage, manifest and bundle assembly. |
| `raidr_cli` | Reconstruction CLI and the `raidr-reconstruct` skill | Reads bundles and runs analysis and codegen. Its capture harness also writes bundles. |
| `raidr_crawler` | Headless crawl and the `raidr-publish` skill | Writes bundles. Uses redaction, `buildApiModel` and `toPathTemplate`. |
| `raidr_types` → `raidr_client` → `raidr_lib` → `raidr_app` | Catalog UI stack | Does not depend on this package. |
| `raidr_api` | Catalog and hosted MCP | Does not depend on this package. |
| `raidr_web` | Landing page | Does not depend on this package. |

The release order is defined in `raidr_app/scripts/push_all.sh`: raidr_types, then this repo, then
the others.

## Commands

Use Bun for everything; never npm, yarn or pnpm. Each result below was observed while writing this file.

| Command | What it does | Result |
| --- | --- | --- |
| `bun install` | Install deps (`fflate`, plus `typescript` and `@types/bun` for dev) | pass |
| `bun run typecheck` | `tsc --noEmit` | pass |
| `bun run test:unit` | `bun test`: all of `tests/` | pass, 174 tests in 20 files |
| `bun run build` | `tsc` → `dist/` (JS and `.d.ts`; `dist/` is gitignored) | pass |

There is no `lint` script and no `test` script. `bun test` does the same thing as `test:unit`.

## Architecture

```
src/
  index.ts               public API; also defines RAIDR_FORMAT_VERSION (= 1)
  bundle/
    types.ts             CapturedRequest, CapturedFrame, Gap, RedactionEntry, RaidrManifest, ...
    paths.ts             content/<hash>.<ext>, sourcemaps/<hash>.map, MIME → extension
    manifest.ts          createManifest / validateManifest, JSONL codec
    store.ts             ContentStore interface, MemoryContentStore (hash fn injected)
    assemble.ts          buildBundleFiles (the bundle's directory layout), zipBundle, bundleFilename
  redaction/
    patterns.ts          isSensitiveKey (KEY_KINDS table), classifyValue (value syntax)
    pseudonym.ts         createPseudonymizer: deterministic placeholders + redaction.json entries
    headers.ts           redactHeaders
    json.ts              redactJsonValue / redactJsonText / redactHtmlHydration
    index.ts             redactRequest: picks a strategy per MIME type
  coverage/
    pathTemplate.ts      toPathTemplate (/users/42 → /users/{id}), endpointKey ("GET /users/{id}")
    coverage.ts          computeCoverage (chunks, routes, endpoints)
  analysis/
    sourceMap.ts         parseSourceMap, recoverSources (from sourcesContent only), recoveryRatio
    schema.ts            inferSchema / unifySchemas (JSON Schema subset, enum detection)
    apiModel.ts          buildApiModel: samples → endpoints with request and response schemas
    routeModel.ts        buildRouteModel: route table + navigations → endpoints per route
    navigations.ts       deriveTimeline: navigations recovered from Document requests
    linkAudit.ts         auditLinks: internal links in a mirror that resolve to nothing
  codegen/
    types.ts             schemaToType, declareType, typeNameFor, pascal
    client.ts            generateTypes, generateClient (typed fetch ApiClient)
    replay.ts            generateReplayServer (Hono), templateToHonoPath
    project.ts           generateProject (Vite React/Vue scaffold), pageNameFor
```

The data flow, with every stage a pure function:

1. **Capture.** This runs in the consumer. For each request it calls `redactRequest(…, pseudonym)`,
   stores the bodies in a `ContentStore`, and then calls
   `buildBundleFiles` → `zipBundle`, naming the file with `bundleFilename`.
2. **Bundle layout.** It is fixed by `assemble.ts`:
   - `raidr.json`, `gaps.json`, `redaction.json`
   - `network/{requests,websockets}.jsonl`
   - `runtime/{framework,routes,stores,chunks,coverage,navigations}.json`
   - `content/<hash>.<ext>`
   - `sourcemaps/{index.json,<hash>.map}`
   - `snapshots/{index.json,<hash>.html}`
3. **Reconstruct.** This also runs in the consumer. It uses `validateManifest` and `parseJsonl`, then:
   - `recoverSources` for the source files;
   - `buildApiModel` → `generateTypes` / `generateClient` / `generateReplayServer`;
   - `buildRouteModel` (fed by `deriveTimeline` when there are no router navigations) →
     `generateProject`;
   - `auditLinks` over the mirror.
4. `endpointKey` is the join key for the API model, the route model, coverage and replay
   recordings.

## Invariants that are easy to break

- **No I/O and no DOM in `src/`.** Nothing may use `fs`, `path`, `process`, `Bun`, `document` or
  `window`. The reason is that the extension bundles this package into a Chrome MV3 service
  worker/offscreen page, where Node APIs do not exist, and raidr_cli and raidr_crawler run it under
  Bun.
  - What enforces it: only partially the compiler. `tsconfig.json` sets `lib: ["ES2022"]`, so DOM
    globals fail to typecheck. But `@types/bun` and `@types/node` are auto-included (there is no
    `types` field), so an `import fs from 'fs'` or a `process.env` would still typecheck. Review for
    this by hand.
  - The strings `process.env` and `hono/bun` in `codegen/replay.ts` are generated output, not
    runtime use.
- **Hashing is injected.** `MemoryContentStore` takes a `HashFn` because no platform crypto is
  assumed. All three consumers pass SHA-256 hex.
- **Redaction deliberately does not redact `api_key`, `apikey` or `x-api-key`.** A key the browser
  ships is public, and redacting it breaks the rebuilt app's backend access (see the comment in
  `patterns.ts`). `tests/redaction/headers.test.ts` asserts that `isSensitiveKey('x-api-key')` is
  null.
  - Per-user tokens such as `x-auth-token` and `x-csrf-token` **are** redacted, as kind `session`.
- **No shape-only secret detection.** `classifyValue` recognises only JWT, `Bearer …` and email
  syntax, and never treats UUIDs as secrets. Long random-looking strings were redacted once and
  broke hashes, trace ids and public keys. The `high-entropy` kind still exists in the type but is
  never produced.
- **JS, CSS, images and fonts are never modified** (`isImmutableAsset` in `redaction/index.ts`).
  Changing them corrupts parsing and source-map offsets.
- **`RAIDR_FORMAT_VERSION` is checked exactly.** `validateManifest` rejects any other value, so
  bumping it breaks reading of every existing bundle in raidr_cli and raidr_crawler.
- **`manifest.ts` imports `RAIDR_FORMAT_VERSION` from `../index`.** This is a cycle. It works only
  because the constant is read inside functions. Never read it at module top level.
- **The text of `generateReplayServer` is a contract with raidr_cli.** raidr_cli's `--replay`
  mode rewrites it with exact-string `.replace()` calls in `raidr_cli/src/commands/reconstruct.ts`.
  The lines it matches:
  - `const app = new Hono();`
  - `serveStatic({ root: './dist' })`
  - the `app.get('*', …)` fallback
  - the two-line `pick` body of `respond`

  If you change any of them, the rewrite silently does nothing, and no test in either repo
  catches it.
- **The order of route registration in the replay server matters:** literal routes, then static
  files, then param routes, then 501 gap guards, then the SPA fallback. The comments in the
  generated source explain each step.
- **Gaps fail loudly.** Uncaptured data becomes a 501 `RAIDR-GAP` response, a `RAIDR-GAP` page
  comment, or `RAIDR-GAPS.md`. It is never invented.
- **No silent loss in the route model.** An endpoint that is not claimed by a route goes to
  `unattributed` (see the end of `routeModel.ts`).

## Testing

- `tests/<area>/<module>.test.ts` mirrors `src/`, and `tests/smoke.test.ts` checks the format
  version. They are all pure `bun:test` unit tests and need no browser or network.
- `tests/fixtures/minimal/` (`raidr.json`, `gaps.json`, `network/requests.jsonl`) is used only by
  `tests/bundle/manifest.test.ts`.
- CI uses `.github/workflows/ci-cd.yml`, which calls `johnqh/workflows` `unified-cicd.yml` with
  `npm-access: public`. It runs `bun install`, `typecheck`, `lint` (skipped because there is no
  script), `test:unit` and `build`.
- CI cannot catch:
  - a Node or Bun API creeping into `src/` (see above);
  - breaking changes to consumers, since nothing here tests raidr_extension, raidr_cli or
    raidr_crawler against a local build;
  - whether generated projects actually install and compile. That is exercised by raidr_cli's
    round-trip tests.

## Making common changes

**Add a bundle field or file**

1. `src/bundle/types.ts`: add the field and a doc comment.
2. For a new file, update `src/bundle/assemble.ts` (`buildBundleFiles`), plus `paths.ts` if it is
   content-addressed.
3. If `raidr.json` changes and old bundles must be rejected, update `validateManifest` in
   `src/bundle/manifest.ts`. Only bump `RAIDR_FORMAT_VERSION` for a breaking layout change.
4. Add tests in `tests/bundle/`.
5. Update the writers (raidr_extension, `raidr_cli/src/capture/harness.ts`, raidr_crawler) and the
   readers (`raidr_cli/src/bundle/load.ts`, `raidr_crawler/src/bundle/load.ts`).

**Add a redaction rule**

1. Key-based rules go in the `KEY_KINDS` table in `src/redaction/patterns.ts`. The first match
   wins, so place the rule deliberately. Value-based rules go in `classifyValue`.
2. For a new kind, update `RedactionKind` in `src/bundle/types.ts` and `LABELS` in
   `src/redaction/pseudonym.ts`. `LABELS` is a `Record<RedactionKind, …>`, so typecheck fails until
   you add it.
3. Add tests in `tests/redaction/`. Include a negative case for anything that must stay visible,
   such as x-api-key or UUIDs.

**Add or change an export**

1. Change the module.
2. Re-export it from `src/index.ts`.
3. Update the exports table in `README.md`.
4. Add a test under the matching `tests/` folder.

**Change code generation**

1. Change `src/codegen/*.ts`.
2. Update `tests/codegen/`.
3. For the replay server, check the `.replace()` strings in raidr_cli (see above).

## Consumers, versioning and publishing

- The dependents are raidr_extension, raidr_cli and raidr_crawler. Each pins
  `"@sudobility/raidr_processor": "^0.1.1"`. On 0.x a caret only admits patch releases, so a
  `0.2.0` release needs each dependent's range updated.
- Publishing is done by CI only. On a push to `main`, the unified workflow publishes to npm if the
  `package.json` version is not already on the registry. Pushes to `develop` only run tests.
- Never run `npm publish` by hand, and never bump the version unless the user asks.
  `raidr_app/scripts/push_all.sh` performs the bumps and pushes in dependency order.
- `files` ships `dist/`, `LICENSE.md` and `README.md`. `dist/` is built by CI before publishing;
  there is no `prepublish` script.

## Gotchas

- `redactRequest` does not touch the URL, so query-string tokens pass through. It also treats every
  request body as JSON, so form-encoded bodies are left unredacted.
- `redactJsonText` re-serializes compactly, so a redacted body's bytes, and therefore its hash,
  differ from the original even when nothing was replaced. A non-JSON body comes back unchanged.
- Pseudonym digests are 16 bits, from a salted FNV-1a hash. A collision makes two values share a
  placeholder and resets that entry's occurrence count. Emails and phones use counters, not the
  salt.
- `buildApiModel` detects auth only from lowercase `authorization` and `cookie` header keys.
- `toPathTemplate` reuses placeholder names, so `/a/1/b/2` becomes `/a/{id}/b/{id}`. That has two
  effects:
  - `generateClient` then emits a method with two parameters named `id`, which does not compile.
  - Two different 2xx statuses on one endpoint produce two declarations with the same name in
    `generateTypes`.
- `RouteModel.lazy` is true for every non-root route. The comment in `routeModel.ts` says the chunk
  manifest confirms this during codegen, but `generateProject` uses `lazy` as-is.
- `zipBundle` uses `zipSync` on purpose, because fflate's async `zip` breaks under Bun workers (see
  the comment in `assemble.ts`).
- The design spec and implementation plans in `docs/superpowers/` are dated 2026-08-24, the first
  milestone. The code has moved on since then (redaction rules, snapshots, link audit), so check
  them against `src/` before relying on them.
