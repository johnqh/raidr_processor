# raidr — Design

**Date:** 2026-08-24
**Status:** Approved (brainstorming complete, pending implementation plan)

## Summary

raidr is a Chrome extension plus a companion TypeScript library that capture a
running web app's complete network traffic and live runtime state, then
reconstruct a faithful clone of that app as a new project.

Capture happens in the browser, where the runtime is alive. Reconstruction
happens offline in Claude Code, where context and iteration are cheap. The two
halves meet at a documented on-disk bundle format.

## Goals

- Record every byte a target web app loads: API calls, HTML, JavaScript, CSS, assets, WebSocket frames.
- Extract, during capture, the runtime facts that no offline analyzer can recover: framework and versions, router tables, state store shapes, bundler chunk manifests.
- Drive the operator toward complete coverage with a live meter, so no lazy module or route is missed.
- Redact credentials and personal data at capture time without destroying the app's reconstructable structure.
- From one bundle, generate a new project that faithfully mirrors the observed stack, typechecks, builds, and serves the same routes.

## Non-goals

- Autonomous crawling. The operator navigates; the extension measures.
- Byte-identical reproduction of minified output. The target is a faithful, readable clone.
- Function-level execution coverage (`Profiler.startPreciseCoverage`). Valuable, deferred; the design leaves the hook.
- A hosted backend. Reconstruction is local.

## Legal note

Reverse-engineering shipped bundles is routine for interop, security research,
and rebuilding one's own applications. Aiming this at a third party's property
may implicate their terms of service and, by jurisdiction, more. Scope of use is
the operator's responsibility.

## Architecture

### Repositories

| Repo | Package | Role |
|---|---|---|
| `raidr_processor` | `@sudobility/raidr_processor`, BUSL-1.1 | Bundle format types and pure analysis: redaction, coverage, schema inference |
| `raidr_extension` | private | MV3 extension: capture, introspection, coverage UI, redaction, export |
| `raidr_cli` | `@sudobility/raidr_cli`, BUSL-1.1 | Reconstruction CLI and the Claude Code `reconstruct` skill |

The dependency shape is a diamond, not a chain:

```
raidr_processor              pure: bundle format, redaction, coverage, inference
   ├── raidr_extension   browser: CDP capture, offscreen buffer, side panel
   └── raidr_cli         node: unzip, filesystem, codegen + the reconstruct skill
```

`raidr_processor` performs **no I/O** — no filesystem, and no `DOM` in its tsconfig
`lib`. That constraint is mechanically enforced rather than merely intended,
and it is what lets the package be imported into a Chrome MV3 bundle and tested
in milliseconds with no environment.

A CLI is the opposite: it needs `fs`, `path`, `process`, and zip extraction.
Placing it in `raidr_processor` would put Node-only code in the dependency graph of a
browser artifact and end that enforcement the moment one file reads from disk.
Hence the third repository. The two consumers never depend on each other.

Stack follows the existing extension family (`testomniac_extension`): Vite,
`@crxjs/vite-plugin`, React, TypeScript, Bun, Tailwind. `raidr_cli` is a Bun
binary.

The bundle format types live in `raidr_processor` alone and are imported by both
consumers. The format cannot drift between producer and consumer, and
`formatVersion` makes a mismatch fail loudly at `validateManifest` rather than
producing a subtly wrong reconstruction.

**Cost of this split, stated plainly:** a change to the bundle format moves
three repositories in lockstep. That is accepted in exchange for keeping Node
out of a package that ships to the browser.

### Runtime topology

Three contexts. The split is forced by MV3 lifecycle rules, not preference.

**Service worker** — owns the `chrome.debugger` attachment and no durable state.
MV3 terminates an idle service worker after roughly 30 seconds; a capture
session with a minute of reading would lose any in-memory buffer. The worker
therefore forwards CDP events immediately and holds nothing.

**Offscreen document** — the capture buffer, created with
`chrome.offscreen.createDocument({ reasons: ['BLOBS'] })`. It persists for the
session, owns the IndexedDB connection and the content-addressed store, and
builds the export archive with `fflate`.

**Side panel (React)** — start/stop, live counters, coverage checklist,
redaction review, export.

## Capture

`chrome.debugger.attach({ tabId }, '1.3')`, enabling `Network`, `Page`,
`Debugger`, and `Runtime`.

### Response bodies

Chrome evicts response bodies from its buffer. `Network.getResponseBody` is
therefore called on `loadingFinished`, not `responseReceived`, and
`Network.enable` raises `maxResourceBufferSize` and `maxTotalBufferSize` so
large JavaScript bundles are not dropped. Any failure to retrieve a body is
recorded in `gaps.json` with its reason.

### Event sources

| CDP source | Yields |
|---|---|
| `Network.requestWillBeSent` | URL, method, headers, `postData` |
| `Network.responseReceived` + `loadingFinished` → `getResponseBody` | status, headers, full body bytes |
| `Network.webSocketFrameSent` / `webSocketFrameReceived` | realtime protocol traffic |
| `Debugger.scriptParsed` | script→URL mapping and `sourceMapURL` even when stripped from the served file |
| `Runtime.evaluate` | live-page introspection |

Introspection runs through `Runtime.evaluate` rather than a content script or
injected main-world script. One mechanism, no message-passing, and it executes
in the page's real world where framework globals live.

### Live introspection

Fired on load and on each SPA navigation:

- **Framework and version** — `__REACT_DEVTOOLS_GLOBAL_HOOK__.renderers`, `__VUE_DEVTOOLS_GLOBAL_HOOK__`, plus bundler fingerprints (`__webpack_require__`, `__vite__mapDeps`).
- **Router table** — read directly: React Router's data-router `router.routes`, or Vue Router's `$router.getRoutes()`. Yields real path patterns, param names, and lazy-component boundaries.
- **State stores** — Redux, Zustand, Pinia, Vuex detection with a redacted snapshot of store shape.
- **Chunk manifest** — `__webpack_require__.u` and the chunk-id map, or Vite's dependency graph: the complete set of chunks that exist. This is the basis of the coverage meter.
- **Source-map probe** — for every script, attempt the declared `sourceMapURL`, then speculatively `<url>.map`. A map containing `sourcesContent` is recorded as a first-class find.

### Storage

Content-addressed. Every body is SHA-256 hashed and stored once as a Blob in
IndexedDB, referenced by hash. Apps refetch chunks constantly and API responses
repeat heavily; deduplication is the difference between a 60 MB and a 600 MB
bundle. Sessions are resumable across reloads and browser restarts.

## Bundle format

```
raidr-<host>-<YYYYMMDD-HHmm>/
  raidr.json            manifest — the skill's entry point
  network/
    requests.jsonl     one redacted request/response per line, bodies by hash
    websockets.jsonl   frames, same shape
  content/
    <sha256>.<ext>     deduped bodies: JS, HTML, JSON, CSS, assets
  sourcemaps/
    <sha256>.map       discovered maps, sourcesContent intact
  runtime/
    framework.json     detection, versions, bundler fingerprint
    routes.json        router tables snapshotted per navigation
    stores.json        state store shapes
    chunks.json        chunk manifest, loaded vs known
    coverage.json      final meter state
  redaction.json       pseudonym map: placeholder → kind. Never values.
  gaps.json            every body not captured, and why
```

JSONL for the two large files: the extension appends rather than rewrites, and
a bundle stays inspectable with `grep` and `jq`.

`gaps.json` is load-bearing. A reconstruction built over silently missing chunks
produces confident, wrong output. Recorded failures let the pipeline say
"route `/admin` references chunk 47, never captured" instead of inventing it.

## Coverage meter

Three tracks in the side panel, each a percentage with a drill-down:

- **Chunks** — from the bundler's own manifest: loaded vs known, with unloaded chunk URLs named.
- **Routes** — from the live router table: which path patterns have been visited.
- **Endpoints** — observed calls clustered into path templates (`/api/users/1138` and `/api/users/2049` → `/api/users/{id}`), with call counts and the number of distinct response shapes each produced. Multiple shapes for one endpoint signal a polymorphic response the reconstruction must model as a union.

## Redaction

Runs at capture time, before anything reaches IndexedDB. Raw credentials are
never at rest.

**Headers** — denylist (`authorization`, `cookie`, `set-cookie`, `x-api-key`,
`proxy-authorization`) plus a `/key|token|secret|auth|session/i` name match.

**JSON bodies** — recursive walk, flagged by key name (`password`,
`access_token`, `refresh_token`, `apiKey`, `ssn`) and by value shape (JWT
`eyJ…`, bearer strings, high-entropy hex/base64 above a length threshold).
UUIDs are preserved: they are structural, and destroying them would break the
relational shape of the data.

**Stable pseudonyms.** A redacted value becomes `<JWT:a1b2>`, where the suffix
is a short stable hash of the original. The same token across forty requests
keeps the same placeholder. This preserves referential integrity — the
reconstructor can see that the token returned by `POST /login` is the one
carried in every later `Authorization` header, and model the auth flow —
without a credential leaving the browser. Flat `<REDACTED>` would make the auth
flow unreconstructable, which is precisely the behaviour most worth reproducing.
Emails and phone numbers are pseudonymized consistently (`user1@example.com`).

**Not redacted: JavaScript and CSS.** They are public code, and mutating them
would corrupt parsing and source-map offsets. The exception is inline `<script>`
state hydration (`window.__INITIAL_STATE__ = {…}`) in HTML, parsed as JSON and
redacted like any other body.

**Review gate** — the side panel shows the redaction report (counts by kind,
sample placeholders) and allows adding or dropping rules with a re-run over the
stored capture. Export is available only after that report has been shown.

## Reconstruction

`raidr_processor` provides the pure transformations; `raidr_cli` wraps them in a binary
that owns all filesystem work; the `reconstruct` skill drives that binary.

A skill is markdown instructions, with no import mechanism — Claude Code
executes it through Bash, Read, and Write. It can therefore only reach library
code across a process boundary, which is precisely why the CLI exists:

```bash
raidr reconstruct <bundle.zip|dir> --out <dir>
```

Each stage writes an intermediate artifact, so any stage can be re-run without
re-capturing. The division of labour matters for testability: everything the
CLI does is covered by `bun test`, and only genuinely model-shaped work (stage
8) lives in prose the skill carries.

1. **Load and validate** — parse the bundle, read `gaps.json` first so every downstream stage knows what is missing.
2. **Source-map recovery** — unpack `sourcesContent` into an original file tree. Compute a recovery ratio: the share of bundle bytes covered by maps. Above 80 percent the pipeline enters *recovery mode*, emitting real original files and inferring only the remainder. This fork is decided by data, not configuration.
3. **Bundle unpacking** (maps absent) — split chunks into modules via the webpack module registry or Vite's dependency graph, beautify with Prettier, re-associate modules with the routes that loaded them.
4. **API model** — deterministic, no LLM. Cluster calls into path templates; infer JSON Schema per endpoint per status code by unifying the captured samples: optionality from presence across samples, enums when a field has few distinct values, nullability, homogeneous-array element types. Conflicting shapes become an explicit union with a review flag, never a silent pick.
5. **Route model** — the router table joined against the request timeline, so each route carries the endpoints that fired while it was mounted. This turns a list of API calls into a statement of each page's data dependencies.
6. **Stack decision** — from `framework.json`: React or Vue, router, state library, HTTP client, and real dependency versions reported by the runtime. The generated `package.json` pins what the app actually shipped.
7. **Deterministic codegen** — project scaffold, Vite config, router file with genuine paths, TypeScript types from the inferred schemas, a typed API client, and a standalone Hono replay server that serves the captured responses on a local origin, so the generated app runs unmodified against it.
8. **LLM pass** — the skill, working per route so context stays bounded: implement components from recovered or unpacked source, wire routes to components, name things sensibly. The LLM does only what it is uniquely suited to; everything mechanical was completed in stage 7.
9. **Verification** — the output must pass `bun install && bun run typecheck && bun run build`. Then the replay server and app are booted and every route exercised, with per-route status reported.

## Failure handling

Governing rule: **gaps propagate as gaps.** Nothing is invented to cover
missing capture.

- Uncaptured body → `// RAIDR-GAP: chunk 47 (route /admin) never captured` in generated source, plus a line in the final report.
- Another debugger attaches, or the operator detaches → session pauses, panel warns, capture resumes with the buffer intact.
- IndexedDB quota pressure → warn at threshold and offer partial export rather than failing at 95 percent.
- Opaque or CORS-blocked responses → recorded as a gap with reason, not skipped.
- Schema conflicts → union plus review flag.

## Testing

`raidr_processor` is pure functions over fixtures, developed test-first with `bun test`.
Golden-file tests take a fixture bundle and snapshot `api-model.json`. Schema
inference and path-template clustering carry the heaviest unit coverage; subtle
wrongness hides there.

In the extension, redaction, hashing, and coverage math are pure modules tested
directly. Chrome APIs sit behind a thin adapter interface, consistent with the
existing dependency-injection pattern.

Integration: Playwright launches Chrome with the unpacked extension against two
locally served sample apps, one React and one Vue, with known routes, known lazy
chunks, and a known API surface. Assertions cover the exported bundle's coverage
numbers and content hashes.

Round-trip is the test that proves the product: capture the sample app,
reconstruct it, assert the output builds and serves the same routes.

## Build order

1. `raidr_processor` bundle types and fixtures
2. Extension capture core (CDP → offscreen → IndexedDB) and export
3. Redaction and review UI
4. Introspection and coverage meter
5. `raidr_processor` analysis: source maps, schema inference, route model
6. Deterministic codegen and replay server
7. `raidr_cli` binary and the `reconstruct` skill
8. Round-trip end-to-end test

Each milestone is independently useful. After milestone 2 the tool is already a
better recorder than the alternatives.
