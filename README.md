# raidr_processor

The pure core of **raidr** — a bundle format, redaction engine, and analysis
pipeline for capturing a running web app and reconstructing a working
approximation of it.

```bash
npm install @sudobility/raidr_processor
```

## What it does

`raidr_processor` holds everything about raidr that is a pure function. Given the raw
material of a capture — requests, responses, chunks, source maps, DOM
snapshots — it produces the derived artifacts that reconstruction needs:

| Area | Exports |
|---|---|
| **Bundle format** | `createManifest`, `validateManifest`, `buildBundleFiles`, `zipBundle`, `contentPath` |
| **Redaction** | `redactRequest`, `redactHeaders`, `redactJsonValue`, `redactHtmlHydration`, `createPseudonymizer` |
| **Coverage** | `computeCoverage`, `toPathTemplate`, `endpointKey` |
| **Analysis** | `parseSourceMap`, `recoverSources`, `inferSchema`, `buildApiModel`, `buildRouteModel`, `auditLinks`, `deriveTimeline` |
| **Codegen** | `generateTypes`, `generateClient`, `generateReplayServer`, `generateProject` |

## The no-I/O constraint

This package performs **no I/O**. No `fs`, no `path`, no `process`, and no
`DOM` in its tsconfig `lib`. That is not a style preference — it is what makes
the package safe to bundle into a Chrome MV3 extension, and what keeps every
one of these stages testable without fixtures on disk.

Callers supply bytes; `raidr_processor` returns values. The consumers below sit on
opposite sides of that line and never see each other:

```
raidr_processor              pure: bundle format, redaction, coverage, inference, codegen
   ├── raidr_extension   browser: CDP capture, offscreen buffer, side panel
   ├── raidr_cli         bun:     unzip, filesystem, project emit, replay server
   └── raidr_crawler     bun:     headless crawl, bundle writing
```

## Development

```bash
bun install
bun run typecheck
bun test
bun run build     # → dist/
```

Design spec and implementation plans live in `docs/superpowers/`.

## The raidr project

| Repository | Role |
|---|---|
| [`raidr_processor`](https://github.com/johnqh/raidr_processor) | Bundle format and pure analysis — this repo |
| [`raidr_extension`](https://github.com/johnqh/raidr_extension) | Chrome MV3 extension that performs the capture |
| [`raidr_cli`](https://github.com/johnqh/raidr_cli) | Reconstruction CLI and the agent skill |
| [`raidr_crawler`](https://github.com/johnqh/raidr_crawler) | Headless crawler and the publish skill |
| [`raidr_web`](https://github.com/johnqh/raidr_web) | Landing site |

## License

BUSL-1.1 — see [LICENSE.md](LICENSE.md).
