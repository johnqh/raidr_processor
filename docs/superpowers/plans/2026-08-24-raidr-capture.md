# raidr Capture Extension Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the raidr capture extension — a Chrome MV3 extension that records a web app's complete network traffic and live runtime state, redacts secrets at capture time, tracks coverage, and exports a documented bundle.

**Architecture:** All pure logic (bundle types, redaction, path templating, coverage math) lives in `raidr_processor`, a browser-free Bun/TypeScript package tested with `bun test`. The extension (`raidr_extension`) is Chrome glue only: a service worker owning the `chrome.debugger` attachment, an offscreen document owning the IndexedDB capture buffer and zip export, and a React side panel. Chrome APIs sit behind an adapter interface so the glue is testable too.

**Tech Stack:** Bun, TypeScript 5.7+, Vite 5, `@crxjs/vite-plugin` 2.x, React 18, Tailwind 3, `fflate` (zip), Chrome DevTools Protocol 1.3, IndexedDB.

**Spec:** `docs/superpowers/specs/2026-08-24-raidr-design.md` (in `raidr_processor`)

**Scope:** Milestones 1–4 of the spec's build order. Milestones 5–8 (offline analysis, codegen, reconstruct skill) are a separate plan written later, against real captured bundles.

## Global Constraints

- Package manager is **Bun**. Never npm, yarn, or pnpm.
- `raidr_processor` is published as `@sudobility/raidr_processor`, license **BUSL-1.1**.
- `raidr_processor` contains **zero browser APIs** — no `chrome.*`, no `window`, no `indexedDB`, no `crypto.subtle`. It must run under `bun test` with no DOM.
- `raidr_extension` is `private: true`, not published.
- Bundle `formatVersion` is `1` for all of milestones 1–4.
- Redaction runs **before** anything reaches IndexedDB. Raw credentials are never at rest.
- The pseudonym salt is generated per session and **never written to the bundle**.
- Gaps propagate as gaps. No code path may invent, guess, or silently drop missing capture data.
- JavaScript and CSS response bodies are **never** redacted (mutating them corrupts parsing and source-map offsets).
- Extension follows `testomniac_extension` conventions: `src/manifest.json` imported by `vite.config.ts`, side panel at `src/sidepanel/index.html`, path alias `@` → `./src`.

---

## File Structure

### `raidr_processor`

| File | Responsibility |
|---|---|
| `src/bundle/types.ts` | Every bundle format type. The contract between capture and reconstruction. |
| `src/bundle/paths.ts` | Bundle-relative path helpers (`contentPath`, `sourcemapPath`). |
| `src/bundle/manifest.ts` | `RaidrManifest` construction and validation. |
| `src/redaction/pseudonym.ts` | Stable pseudonym generator. |
| `src/redaction/patterns.ts` | Key-name and value-shape detectors. |
| `src/redaction/headers.ts` | Header redaction. |
| `src/redaction/json.ts` | Recursive JSON body redaction. |
| `src/redaction/index.ts` | `redactRequest` — the one entry point the extension calls. |
| `src/coverage/pathTemplate.ts` | URL path → endpoint template. |
| `src/coverage/coverage.ts` | Chunk / route / endpoint coverage computation. |
| `src/index.ts` | Public exports. |
| `tests/fixtures/` | Fixture bundles for golden tests. |

### `raidr_extension`

| File | Responsibility |
|---|---|
| `src/manifest.json` | MV3 manifest. |
| `src/shared/messages.ts` | Typed message protocol across all three contexts. |
| `src/adapters/ChromeAdapter.ts` | Interface over `chrome.debugger`, `chrome.offscreen`, `chrome.downloads`. |
| `src/background/index.ts` | Service worker entry: message routing, session lifecycle. |
| `src/background/cdpSession.ts` | Attach/detach, domain enable, event subscription, body fetch. |
| `src/offscreen/index.html` | Offscreen document host page. |
| `src/offscreen/index.ts` | Buffer owner: receives events, redacts, hashes, stores. |
| `src/offscreen/store.ts` | IndexedDB content-addressed store. |
| `src/offscreen/exporter.ts` | Bundle assembly and zip via `fflate`. |
| `src/introspect/probes.ts` | Page-context probe sources evaluated via `Runtime.evaluate`. |
| `src/sidepanel/SidePanel.tsx` | Root UI. |
| `src/sidepanel/components/CoverageMeter.tsx` | Three-track coverage display. |
| `src/sidepanel/components/RedactionReport.tsx` | Pre-export redaction review gate. |
| `src/sidepanel/hooks/useSession.ts` | Session state subscription. |

---

# Milestone 1 — Bundle types and fixtures

### Task 1: Scaffold `raidr_processor`

**Files:**
- Create: `~/projects/raidr_processor/package.json`
- Create: `~/projects/raidr_processor/tsconfig.json`
- Create: `~/projects/raidr_processor/src/index.ts`
- Test: `~/projects/raidr_processor/tests/smoke.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: a `bun test` harness; `RAIDR_FORMAT_VERSION: 1` exported from `src/index.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/smoke.test.ts
import { expect, test } from 'bun:test';
import { RAIDR_FORMAT_VERSION } from '../src/index';

test('exports the bundle format version', () => {
  expect(RAIDR_FORMAT_VERSION).toBe(1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/projects/raidr_processor && bun test`
Expected: FAIL — cannot resolve `../src/index`

- [ ] **Step 3: Create package.json**

```json
{
  "name": "@sudobility/raidr_processor",
  "version": "0.0.1",
  "description": "Bundle format, redaction, and analysis for raidr web app capture",
  "license": "BUSL-1.1",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "files": ["dist"],
  "scripts": {
    "build": "tsc",
    "typecheck": "tsc --noEmit",
    "test": "bun test"
  },
  "devDependencies": {
    "@types/bun": "^1.3.14",
    "typescript": "^5.7.3"
  }
}
```

- [ ] **Step 4: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "declaration": true,
    "outDir": "dist",
    "rootDir": "src",
    "skipLibCheck": true,
    "verbatimModuleSyntax": true
  },
  "include": ["src"]
}
```

Note: `lib` deliberately omits `DOM`. This is the mechanical enforcement of the "zero browser APIs" constraint — a stray `window` reference fails typecheck.

- [ ] **Step 5: Create src/index.ts**

```ts
export const RAIDR_FORMAT_VERSION = 1 as const;
```

- [ ] **Step 6: Install and run tests**

Run: `cd ~/projects/raidr_processor && bun install && bun test`
Expected: PASS, 1 test

- [ ] **Step 7: Commit**

```bash
cd ~/projects/raidr_processor
git add -A
git commit -m "feat: scaffold raidr_processor package"
```

---

### Task 2: Bundle format types and path helpers

**Files:**
- Create: `~/projects/raidr_processor/src/bundle/types.ts`
- Create: `~/projects/raidr_processor/src/bundle/paths.ts`
- Modify: `~/projects/raidr_processor/src/index.ts`
- Test: `~/projects/raidr_processor/tests/bundle/paths.test.ts`

**Interfaces:**
- Consumes: `RAIDR_FORMAT_VERSION` from Task 1
- Produces:
  - types `CapturedRequest`, `CapturedFrame`, `Gap`, `GapReason`, `RedactionKind`, `RedactionEntry`, `RaidrManifest`, `StackFingerprint`
  - `contentPath(hash: string, ext: string): string`
  - `sourcemapPath(hash: string): string`
  - `extensionForMime(mime: string | null): string`

- [ ] **Step 1: Write the failing test**

```ts
// tests/bundle/paths.test.ts
import { expect, test } from 'bun:test';
import { contentPath, sourcemapPath, extensionForMime } from '../../src/bundle/paths';

test('content path is content-addressed with extension', () => {
  expect(contentPath('abc123', 'js')).toBe('content/abc123.js');
});

test('sourcemap path lives in its own directory', () => {
  expect(sourcemapPath('abc123')).toBe('sourcemaps/abc123.map');
});

test('maps common mime types to extensions', () => {
  expect(extensionForMime('application/javascript')).toBe('js');
  expect(extensionForMime('text/javascript')).toBe('js');
  expect(extensionForMime('application/json')).toBe('json');
  expect(extensionForMime('text/html')).toBe('html');
  expect(extensionForMime('text/css')).toBe('css');
  expect(extensionForMime('image/png')).toBe('png');
});

test('falls back to bin for unknown or missing mime', () => {
  expect(extensionForMime('application/x-weird')).toBe('bin');
  expect(extensionForMime(null)).toBe('bin');
});

test('strips mime parameters before matching', () => {
  expect(extensionForMime('application/json; charset=utf-8')).toBe('json');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/projects/raidr_processor && bun test tests/bundle/paths.test.ts`
Expected: FAIL — cannot resolve `../../src/bundle/paths`

- [ ] **Step 3: Write src/bundle/types.ts**

```ts
export type GapReason =
  | 'body-evicted'
  | 'cors-opaque'
  | 'detached'
  | 'quota'
  | 'too-large'
  | 'cdp-error';

export type RedactionKind =
  | 'jwt'
  | 'bearer'
  | 'cookie'
  | 'api-key'
  | 'password'
  | 'email'
  | 'phone'
  | 'high-entropy';

/** One captured request/response pair. Bodies are referenced by SHA-256 hash. */
export interface CapturedRequest {
  /** CDP requestId, unique within a session. */
  id: string;
  /** Epoch milliseconds when the request was sent. */
  ts: number;
  method: string;
  url: string;
  /** CDP resource type: Document, Script, XHR, Fetch, Stylesheet, Image, ... */
  resourceType: string;
  requestHeaders: Record<string, string>;
  requestBodyHash: string | null;
  status: number | null;
  responseHeaders: Record<string, string>;
  responseBodyHash: string | null;
  mimeType: string | null;
  fromCache: boolean;
  /** Navigation id this request occurred under, joining requests to routes. */
  navigationId: string | null;
}

export interface CapturedFrame {
  /** CDP requestId of the WebSocket connection. */
  id: string;
  ts: number;
  direction: 'sent' | 'received';
  opcode: number;
  payloadHash: string;
}

export interface Gap {
  requestId: string;
  url: string;
  reason: GapReason;
  ts: number;
  /** Human-readable detail, e.g. the CDP error message. */
  detail: string | null;
}

export interface RedactionEntry {
  /** e.g. "<JWT:a1b2>" */
  placeholder: string;
  kind: RedactionKind;
  occurrences: number;
}

export interface StackFingerprint {
  framework: 'react' | 'vue' | 'unknown';
  frameworkVersion: string | null;
  router: string | null;
  routerVersion: string | null;
  stateLibraries: string[];
  bundler: 'webpack' | 'vite' | 'unknown';
}

export interface RaidrManifest {
  formatVersion: 1;
  sessionId: string;
  origin: string;
  startedAt: string;
  endedAt: string | null;
  counts: {
    requests: number;
    frames: number;
    bodies: number;
    gaps: number;
  };
  stack: StackFingerprint | null;
}
```

- [ ] **Step 4: Write src/bundle/paths.ts**

```ts
const MIME_EXTENSIONS: Record<string, string> = {
  'application/javascript': 'js',
  'text/javascript': 'js',
  'application/x-javascript': 'js',
  'module/javascript': 'js',
  'application/json': 'json',
  'text/json': 'json',
  'text/html': 'html',
  'text/css': 'css',
  'text/plain': 'txt',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
  'image/webp': 'webp',
  'font/woff2': 'woff2',
  'font/woff': 'woff',
};

export function extensionForMime(mime: string | null): string {
  if (!mime) return 'bin';
  const base = mime.split(';')[0]?.trim().toLowerCase() ?? '';
  return MIME_EXTENSIONS[base] ?? 'bin';
}

export function contentPath(hash: string, ext: string): string {
  return `content/${hash}.${ext}`;
}

export function sourcemapPath(hash: string): string {
  return `sourcemaps/${hash}.map`;
}
```

- [ ] **Step 5: Re-export from src/index.ts**

```ts
export const RAIDR_FORMAT_VERSION = 1 as const;

export type {
  CapturedRequest,
  CapturedFrame,
  Gap,
  GapReason,
  RedactionEntry,
  RedactionKind,
  StackFingerprint,
  RaidrManifest,
} from './bundle/types';

export { contentPath, sourcemapPath, extensionForMime } from './bundle/paths';
```

- [ ] **Step 6: Run tests and typecheck**

Run: `cd ~/projects/raidr_processor && bun test && bun run typecheck`
Expected: PASS, 6 tests; typecheck clean

- [ ] **Step 7: Commit**

```bash
cd ~/projects/raidr_processor
git add -A
git commit -m "feat: bundle format types and path helpers"
```

---

### Task 3: Manifest construction and fixture bundle

**Files:**
- Create: `~/projects/raidr_processor/src/bundle/manifest.ts`
- Create: `~/projects/raidr_processor/tests/fixtures/minimal/raidr.json`
- Create: `~/projects/raidr_processor/tests/fixtures/minimal/network/requests.jsonl`
- Create: `~/projects/raidr_processor/tests/fixtures/minimal/gaps.json`
- Modify: `~/projects/raidr_processor/src/index.ts`
- Test: `~/projects/raidr_processor/tests/bundle/manifest.test.ts`

**Interfaces:**
- Consumes: types from Task 2
- Produces:
  - `createManifest(input: CreateManifestInput): RaidrManifest`
  - `validateManifest(value: unknown): { ok: true; manifest: RaidrManifest } | { ok: false; errors: string[] }`
  - `parseJsonl<T>(text: string): T[]`
  - `toJsonl(rows: unknown[]): string`

- [ ] **Step 1: Write the failing test**

```ts
// tests/bundle/manifest.test.ts
import { expect, test } from 'bun:test';
import { createManifest, validateManifest, parseJsonl, toJsonl } from '../../src/bundle/manifest';
import type { CapturedRequest } from '../../src/bundle/types';

test('creates a manifest with zeroed counts', () => {
  const m = createManifest({
    sessionId: 's1',
    origin: 'https://example.com',
    startedAt: '2026-08-24T10:00:00.000Z',
  });
  expect(m.formatVersion).toBe(1);
  expect(m.endedAt).toBeNull();
  expect(m.counts).toEqual({ requests: 0, frames: 0, bodies: 0, gaps: 0 });
  expect(m.stack).toBeNull();
});

test('validates a well-formed manifest', () => {
  const m = createManifest({
    sessionId: 's1',
    origin: 'https://example.com',
    startedAt: '2026-08-24T10:00:00.000Z',
  });
  const result = validateManifest(m);
  expect(result.ok).toBe(true);
});

test('rejects a manifest from a future format version', () => {
  const result = validateManifest({ formatVersion: 99, sessionId: 's1' });
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.errors[0]).toContain('formatVersion');
  }
});

test('rejects a non-object', () => {
  const result = validateManifest(null);
  expect(result.ok).toBe(false);
});

test('round-trips JSONL', () => {
  const rows = [{ a: 1 }, { a: 2 }];
  expect(parseJsonl(toJsonl(rows))).toEqual(rows);
});

test('parseJsonl ignores blank trailing lines', () => {
  expect(parseJsonl('{"a":1}\n\n')).toEqual([{ a: 1 }]);
});

test('reads the committed minimal fixture bundle', async () => {
  const manifestText = await Bun.file('tests/fixtures/minimal/raidr.json').text();
  const result = validateManifest(JSON.parse(manifestText));
  expect(result.ok).toBe(true);

  const requestsText = await Bun.file('tests/fixtures/minimal/network/requests.jsonl').text();
  const requests = parseJsonl<CapturedRequest>(requestsText);
  expect(requests).toHaveLength(2);
  expect(requests[0]!.url).toBe('https://example.com/');
  expect(requests[1]!.responseBodyHash).not.toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/projects/raidr_processor && bun test tests/bundle/manifest.test.ts`
Expected: FAIL — cannot resolve `../../src/bundle/manifest`

- [ ] **Step 3: Write src/bundle/manifest.ts**

```ts
import { RAIDR_FORMAT_VERSION } from '../index';
import type { RaidrManifest } from './types';

export interface CreateManifestInput {
  sessionId: string;
  origin: string;
  startedAt: string;
}

export function createManifest(input: CreateManifestInput): RaidrManifest {
  return {
    formatVersion: RAIDR_FORMAT_VERSION,
    sessionId: input.sessionId,
    origin: input.origin,
    startedAt: input.startedAt,
    endedAt: null,
    counts: { requests: 0, frames: 0, bodies: 0, gaps: 0 },
    stack: null,
  };
}

export type ValidateResult =
  | { ok: true; manifest: RaidrManifest }
  | { ok: false; errors: string[] };

export function validateManifest(value: unknown): ValidateResult {
  const errors: string[] = [];
  if (typeof value !== 'object' || value === null) {
    return { ok: false, errors: ['manifest must be an object'] };
  }
  const v = value as Record<string, unknown>;

  if (v.formatVersion !== RAIDR_FORMAT_VERSION) {
    errors.push(
      `formatVersion must be ${RAIDR_FORMAT_VERSION}, got ${String(v.formatVersion)}`
    );
  }
  for (const key of ['sessionId', 'origin', 'startedAt'] as const) {
    if (typeof v[key] !== 'string') errors.push(`${key} must be a string`);
  }
  if (typeof v.counts !== 'object' || v.counts === null) {
    errors.push('counts must be an object');
  }

  return errors.length > 0
    ? { ok: false, errors }
    : { ok: true, manifest: value as RaidrManifest };
}

export function toJsonl(rows: unknown[]): string {
  return rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
}

export function parseJsonl<T>(text: string): T[] {
  return text
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as T);
}
```

- [ ] **Step 4: Create the fixture bundle**

`tests/fixtures/minimal/raidr.json`:

```json
{
  "formatVersion": 1,
  "sessionId": "fixture-minimal",
  "origin": "https://example.com",
  "startedAt": "2026-08-24T10:00:00.000Z",
  "endedAt": "2026-08-24T10:01:00.000Z",
  "counts": { "requests": 2, "frames": 0, "bodies": 2, "gaps": 1 },
  "stack": {
    "framework": "react",
    "frameworkVersion": "18.3.1",
    "router": "react-router",
    "routerVersion": "6.28.0",
    "stateLibraries": ["zustand"],
    "bundler": "vite"
  }
}
```

`tests/fixtures/minimal/network/requests.jsonl` (exactly two lines, each valid JSON):

```
{"id":"1","ts":1756029600000,"method":"GET","url":"https://example.com/","resourceType":"Document","requestHeaders":{"accept":"text/html"},"requestBodyHash":null,"status":200,"responseHeaders":{"content-type":"text/html"},"responseBodyHash":"aaa111","mimeType":"text/html","fromCache":false,"navigationId":"nav1"}
{"id":"2","ts":1756029601000,"method":"GET","url":"https://example.com/api/users/1138","resourceType":"XHR","requestHeaders":{"authorization":"<JWT:a1b2>"},"requestBodyHash":null,"status":200,"responseHeaders":{"content-type":"application/json"},"responseBodyHash":"bbb222","mimeType":"application/json","fromCache":false,"navigationId":"nav1"}
```

`tests/fixtures/minimal/gaps.json`:

```json
[
  {
    "requestId": "3",
    "url": "https://cdn.example.com/chunk-47.js",
    "reason": "body-evicted",
    "ts": 1756029602000,
    "detail": "No resource with given identifier found"
  }
]
```

- [ ] **Step 5: Export from src/index.ts**

Add to `src/index.ts`:

```ts
export {
  createManifest,
  validateManifest,
  toJsonl,
  parseJsonl,
} from './bundle/manifest';
export type { CreateManifestInput, ValidateResult } from './bundle/manifest';
```

- [ ] **Step 6: Run tests**

Run: `cd ~/projects/raidr_processor && bun test && bun run typecheck`
Expected: PASS, 13 tests total; typecheck clean

- [ ] **Step 7: Commit**

```bash
cd ~/projects/raidr_processor
git add -A
git commit -m "feat: manifest construction, JSONL helpers, minimal fixture bundle"
```

---
# Milestone 2 — Capture core

### Task 4: Scaffold `raidr_extension` and the message protocol

**Files:**
- Create: `~/projects/raidr_extension/package.json`
- Create: `~/projects/raidr_extension/tsconfig.json`
- Create: `~/projects/raidr_extension/vite.config.ts`
- Create: `~/projects/raidr_extension/src/manifest.json`
- Create: `~/projects/raidr_extension/src/shared/messages.ts`
- Create: `~/projects/raidr_extension/src/background/index.ts`
- Create: `~/projects/raidr_extension/src/sidepanel/index.html`
- Create: `~/projects/raidr_extension/src/sidepanel/main.tsx`
- Create: `~/projects/raidr_extension/src/sidepanel/SidePanel.tsx`
- Test: `~/projects/raidr_extension/tests/messages.test.ts`

**Interfaces:**
- Consumes: `@sudobility/raidr_processor` types via a `file:` dependency (Bun's `link:` means a globally `bun link`-ed package, not a path)
- Produces:
  - `type RaidrMessage` — discriminated union on `kind`
  - `isRaidrMessage(value: unknown): value is RaidrMessage`

- [ ] **Step 1: Write the failing test**

```ts
// tests/messages.test.ts
import { expect, test } from 'bun:test';
import { isRaidrMessage } from '../src/shared/messages';

test('accepts a known message kind', () => {
  expect(isRaidrMessage({ kind: 'session/start', tabId: 7 })).toBe(true);
});

test('rejects an unknown kind', () => {
  expect(isRaidrMessage({ kind: 'nope' })).toBe(false);
});

test('rejects non-objects', () => {
  expect(isRaidrMessage(null)).toBe(false);
  expect(isRaidrMessage('session/start')).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/projects/raidr_extension && bun test`
Expected: FAIL — cannot resolve `../src/shared/messages`

- [ ] **Step 3: Create package.json**

```json
{
  "name": "raidr_extension",
  "version": "0.0.1",
  "description": "raidr — capture a web app's traffic and runtime for reconstruction",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "typecheck": "tsc --noEmit",
    "test": "bun test"
  },
  "dependencies": {
    "@sudobility/raidr_processor": "file:../raidr_processor",
    "fflate": "^0.8.2",
    "react": "^18.3.1",
    "react-dom": "^18.3.1"
  },
  "devDependencies": {
    "@crxjs/vite-plugin": "^2.2.1",
    "@types/bun": "^1.3.14",
    "@types/chrome": "^0.1.31",
    "@types/react": "^18.2.79",
    "@types/react-dom": "^18.2.25",
    "@vitejs/plugin-react": "^4.5.1",
    "autoprefixer": "^10.4.22",
    "fake-indexeddb": "^6.0.0",
    "postcss": "^8.5.6",
    "tailwindcss": "^3.4.18",
    "typescript": "^5.7.3",
    "vite": "^5.4.21"
  }
}
```

- [ ] **Step 4: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noEmit": true,
    "skipLibCheck": true,
    "verbatimModuleSyntax": true,
    "types": ["chrome", "bun"],
    "baseUrl": ".",
    "paths": { "@/*": ["src/*"] }
  },
  "include": ["src", "tests"]
}
```

- [ ] **Step 5: Create src/manifest.json**

```json
{
  "manifest_version": 3,
  "name": "raidr",
  "version": "0.0.1",
  "description": "Capture a web app's traffic and runtime for reconstruction",
  "minimum_chrome_version": "116",
  "permissions": [
    "debugger",
    "offscreen",
    "storage",
    "downloads",
    "tabs",
    "sidePanel"
  ],
  "host_permissions": ["<all_urls>"],
  "background": {
    "service_worker": "src/background/index.ts",
    "type": "module"
  },
  "side_panel": {
    "default_path": "src/sidepanel/index.html"
  },
  "action": {
    "default_title": "raidr"
  },
  "content_security_policy": {
    "extension_pages": "default-src 'self'; script-src 'self'; object-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'"
  }
}
```

Note: `minimum_chrome_version` is 116 because `chrome.offscreen` with the `BLOBS` reason and `sidePanel` both require it. `downloads` is needed for bundle export.

- [ ] **Step 6: Create vite.config.ts**

```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { crx } from '@crxjs/vite-plugin';
import path from 'path';
import manifest from './src/manifest.json';

const CRX_PORT = 7176;

export default defineConfig(({ mode }) => {
  process.env.PORT = String(CRX_PORT);

  const baseCsp = manifest.content_security_policy.extension_pages;
  const devCsp =
    mode === 'development'
      ? `${baseCsp} ws://localhost:${CRX_PORT} http://localhost:${CRX_PORT}`
      : baseCsp;

  return {
    plugins: [
      react({ jsxRuntime: 'automatic' }),
      crx({
        manifest: {
          ...manifest,
          content_security_policy: { extension_pages: devCsp },
        },
      }),
    ],
    resolve: {
      alias: { '@': path.resolve(__dirname, './src') },
    },
    server: {
      port: CRX_PORT,
      strictPort: true,
      hmr: { protocol: 'ws', host: 'localhost', port: CRX_PORT },
    },
    build: {
      rollupOptions: {
        input: {
          sidepanel: path.resolve(__dirname, 'src/sidepanel/index.html'),
          offscreen: path.resolve(__dirname, 'src/offscreen/index.html'),
        },
      },
    },
  };
});
```

Note: the `offscreen` input is declared now so Task 7 only has to add the files, not revisit the build config.

- [ ] **Step 7: Create src/shared/messages.ts**

```ts
import type { Gap, RaidrManifest } from '@sudobility/raidr_processor';

export interface SessionStats {
  requests: number;
  bodies: number;
  bytes: number;
  gaps: number;
}

export type RaidrMessage =
  | { kind: 'session/start'; tabId: number }
  | { kind: 'session/stop' }
  | { kind: 'session/stats'; stats: SessionStats }
  | { kind: 'capture/request'; row: unknown }
  | { kind: 'capture/body'; hash: string; bytesBase64: string; ext: string }
  | { kind: 'capture/gap'; gap: Gap }
  | { kind: 'export/start' }
  | { kind: 'export/ready'; blobUrl: string; filename: string }
  | { kind: 'export/manifest'; manifest: RaidrManifest };

const KINDS: ReadonlySet<string> = new Set([
  'session/start',
  'session/stop',
  'session/stats',
  'capture/request',
  'capture/body',
  'capture/gap',
  'export/start',
  'export/ready',
  'export/manifest',
]);

export function isRaidrMessage(value: unknown): value is RaidrMessage {
  if (typeof value !== 'object' || value === null) return false;
  const kind = (value as { kind?: unknown }).kind;
  return typeof kind === 'string' && KINDS.has(kind);
}
```

- [ ] **Step 8: Create the minimal side panel and background stubs**

`src/background/index.ts`:

```ts
import { isRaidrMessage } from '@/shared/messages';

chrome.runtime.onMessage.addListener((message) => {
  if (!isRaidrMessage(message)) return;
  console.debug('[raidr] message', message.kind);
});

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error: unknown) => console.error('[raidr] side panel', error));
```

`src/sidepanel/index.html`:

```html
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>raidr</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="./main.tsx"></script>
  </body>
</html>
```

`src/sidepanel/main.tsx`:

```tsx
import { createRoot } from 'react-dom/client';
import { SidePanel } from './SidePanel';

const container = document.getElementById('root');
if (!container) throw new Error('root container missing');
createRoot(container).render(<SidePanel />);
```

`src/sidepanel/SidePanel.tsx`:

```tsx
export function SidePanel() {
  return <main className="p-4 text-sm">raidr</main>;
}
```

- [ ] **Step 9: Install, test, and build**

Run:
```bash
cd ~/projects/raidr_processor && bun run build
cd ~/projects/raidr_extension && bun install && bun test && bun run build
```
Expected: 3 tests PASS; `dist/` produced with a valid `manifest.json`

- [ ] **Step 10: Load in Chrome and verify**

Open `chrome://extensions`, enable Developer mode, "Load unpacked", select `~/projects/raidr_extension/dist`. Click the toolbar icon.
Expected: side panel opens showing "raidr", no console errors in the service worker.

- [ ] **Step 11: Commit**

```bash
cd ~/projects/raidr_extension
git init && git add -A
git commit -m "feat: scaffold raidr extension and typed message protocol"
```

---

### Task 5: Chrome adapter and its fake

**Files:**
- Create: `~/projects/raidr_extension/src/adapters/ChromeAdapter.ts`
- Create: `~/projects/raidr_extension/tests/support/FakeChromeAdapter.ts`
- Test: `~/projects/raidr_extension/tests/adapters/fakeChromeAdapter.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `interface ChromeAdapter` with `attach`, `detach`, `sendCommand`, `onEvent`, `onDetach`
  - `class LiveChromeAdapter implements ChromeAdapter`
  - `class FakeChromeAdapter implements ChromeAdapter` with `emit(method, params)` and `commands: Array<{method, params}>` and `respondWith(method, handler)`

- [ ] **Step 1: Write the failing test**

```ts
// tests/adapters/fakeChromeAdapter.test.ts
import { expect, test } from 'bun:test';
import { FakeChromeAdapter } from '../support/FakeChromeAdapter';

test('records commands sent to the debuggee', async () => {
  const fake = new FakeChromeAdapter();
  await fake.attach(1);
  await fake.sendCommand(1, 'Network.enable', { maxResourceBufferSize: 10 });
  expect(fake.attached).toContain(1);
  expect(fake.commands).toEqual([
    { tabId: 1, method: 'Network.enable', params: { maxResourceBufferSize: 10 } },
  ]);
});

test('delivers emitted events to listeners', async () => {
  const fake = new FakeChromeAdapter();
  const seen: string[] = [];
  fake.onEvent((_tabId, method) => seen.push(method));
  fake.emit(1, 'Network.requestWillBeSent', { requestId: 'r1' });
  expect(seen).toEqual(['Network.requestWillBeSent']);
});

test('returns configured command responses', async () => {
  const fake = new FakeChromeAdapter();
  fake.respondWith('Network.getResponseBody', () => ({
    body: 'hello',
    base64Encoded: false,
  }));
  const result = await fake.sendCommand(1, 'Network.getResponseBody', { requestId: 'r1' });
  expect(result).toEqual({ body: 'hello', base64Encoded: false });
});

test('rejects when a command is configured to fail', async () => {
  const fake = new FakeChromeAdapter();
  fake.respondWith('Network.getResponseBody', () => {
    throw new Error('No resource with given identifier found');
  });
  await expect(fake.sendCommand(1, 'Network.getResponseBody', {})).rejects.toThrow(
    'No resource with given identifier found'
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/projects/raidr_extension && bun test tests/adapters/fakeChromeAdapter.test.ts`
Expected: FAIL — cannot resolve `../support/FakeChromeAdapter`

- [ ] **Step 3: Write src/adapters/ChromeAdapter.ts**

```ts
export type CdpEventListener = (
  tabId: number,
  method: string,
  params: Record<string, unknown>
) => void;

export type DetachListener = (tabId: number, reason: string) => void;

export interface ChromeAdapter {
  attach(tabId: number): Promise<void>;
  detach(tabId: number): Promise<void>;
  sendCommand(
    tabId: number,
    method: string,
    params?: Record<string, unknown>
  ): Promise<unknown>;
  onEvent(listener: CdpEventListener): void;
  onDetach(listener: DetachListener): void;
}

const CDP_VERSION = '1.3';

export class LiveChromeAdapter implements ChromeAdapter {
  async attach(tabId: number): Promise<void> {
    await chrome.debugger.attach({ tabId }, CDP_VERSION);
  }

  async detach(tabId: number): Promise<void> {
    await chrome.debugger.detach({ tabId });
  }

  async sendCommand(
    tabId: number,
    method: string,
    params: Record<string, unknown> = {}
  ): Promise<unknown> {
    return chrome.debugger.sendCommand({ tabId }, method, params);
  }

  onEvent(listener: CdpEventListener): void {
    chrome.debugger.onEvent.addListener((source, method, params) => {
      if (source.tabId === undefined) return;
      listener(source.tabId, method, (params ?? {}) as Record<string, unknown>);
    });
  }

  onDetach(listener: DetachListener): void {
    chrome.debugger.onDetach.addListener((source, reason) => {
      if (source.tabId === undefined) return;
      listener(source.tabId, reason);
    });
  }
}
```

- [ ] **Step 4: Write tests/support/FakeChromeAdapter.ts**

```ts
import type {
  ChromeAdapter,
  CdpEventListener,
  DetachListener,
} from '../../src/adapters/ChromeAdapter';

type CommandHandler = (params: Record<string, unknown>) => unknown;

export class FakeChromeAdapter implements ChromeAdapter {
  readonly attached: number[] = [];
  readonly commands: Array<{
    tabId: number;
    method: string;
    params: Record<string, unknown>;
  }> = [];

  private handlers = new Map<string, CommandHandler>();
  private eventListeners: CdpEventListener[] = [];
  private detachListeners: DetachListener[] = [];

  respondWith(method: string, handler: CommandHandler): void {
    this.handlers.set(method, handler);
  }

  async attach(tabId: number): Promise<void> {
    this.attached.push(tabId);
  }

  async detach(tabId: number): Promise<void> {
    const index = this.attached.indexOf(tabId);
    if (index >= 0) this.attached.splice(index, 1);
  }

  async sendCommand(
    tabId: number,
    method: string,
    params: Record<string, unknown> = {}
  ): Promise<unknown> {
    this.commands.push({ tabId, method, params });
    const handler = this.handlers.get(method);
    return handler ? handler(params) : undefined;
  }

  onEvent(listener: CdpEventListener): void {
    this.eventListeners.push(listener);
  }

  onDetach(listener: DetachListener): void {
    this.detachListeners.push(listener);
  }

  emit(tabId: number, method: string, params: Record<string, unknown>): void {
    for (const listener of this.eventListeners) listener(tabId, method, params);
  }

  emitDetach(tabId: number, reason: string): void {
    for (const listener of this.detachListeners) listener(tabId, reason);
  }
}
```

- [ ] **Step 5: Run tests**

Run: `cd ~/projects/raidr_extension && bun test`
Expected: PASS, 7 tests total

- [ ] **Step 6: Commit**

```bash
cd ~/projects/raidr_extension
git add -A
git commit -m "feat: chrome adapter interface with test fake"
```

---

### Task 6: CDP request assembler

**Files:**
- Create: `~/projects/raidr_extension/src/background/requestAssembler.ts`
- Test: `~/projects/raidr_extension/tests/background/requestAssembler.test.ts`

**Interfaces:**
- Consumes: `CapturedRequest`, `Gap` from `@sudobility/raidr_processor`
- Produces:
  - `class RequestAssembler` with:
    - `onRequestWillBeSent(params: Record<string, unknown>): void`
    - `onResponseReceived(params: Record<string, unknown>): void`
    - `onLoadingFinished(requestId: string): CapturedRequest | null`
    - `onLoadingFailed(requestId: string, errorText: string, canceled: boolean): Gap | null`
    - `setNavigationId(navigationId: string): void`
    - `pendingCount(): number`

This class is pure — no Chrome APIs, no I/O. It turns the CDP event stream into complete records.

- [ ] **Step 1: Write the failing test**

```ts
// tests/background/requestAssembler.test.ts
import { expect, test } from 'bun:test';
import { RequestAssembler } from '../../src/background/requestAssembler';

function willBeSent(requestId: string, url: string) {
  return {
    requestId,
    wallTime: 1756029600,
    request: {
      url,
      method: 'GET',
      headers: { accept: 'application/json' },
    },
    type: 'XHR',
  };
}

function responseReceived(requestId: string) {
  return {
    requestId,
    response: {
      status: 200,
      headers: { 'content-type': 'application/json' },
      mimeType: 'application/json',
      fromDiskCache: false,
    },
    type: 'XHR',
  };
}

test('assembles a complete request from the CDP lifecycle', () => {
  const assembler = new RequestAssembler();
  assembler.setNavigationId('nav1');
  assembler.onRequestWillBeSent(willBeSent('r1', 'https://example.com/api/users'));
  assembler.onResponseReceived(responseReceived('r1'));
  const record = assembler.onLoadingFinished('r1');

  expect(record).not.toBeNull();
  expect(record!.id).toBe('r1');
  expect(record!.method).toBe('GET');
  expect(record!.url).toBe('https://example.com/api/users');
  expect(record!.status).toBe(200);
  expect(record!.mimeType).toBe('application/json');
  expect(record!.resourceType).toBe('XHR');
  expect(record!.navigationId).toBe('nav1');
});

test('converts CDP wallTime seconds into epoch milliseconds', () => {
  const assembler = new RequestAssembler();
  assembler.onRequestWillBeSent(willBeSent('r1', 'https://example.com/'));
  assembler.onResponseReceived(responseReceived('r1'));
  expect(assembler.onLoadingFinished('r1')!.ts).toBe(1756029600000);
});

test('captures the request body when present', () => {
  const assembler = new RequestAssembler();
  assembler.onRequestWillBeSent({
    requestId: 'r1',
    wallTime: 1756029600,
    request: {
      url: 'https://example.com/api/login',
      method: 'POST',
      headers: {},
      postData: '{"user":"a"}',
    },
    type: 'Fetch',
  });
  assembler.onResponseReceived(responseReceived('r1'));
  const record = assembler.onLoadingFinished('r1');
  expect(record!.requestBody).toBe('{"user":"a"}');
});

test('returns null for an unknown requestId', () => {
  const assembler = new RequestAssembler();
  expect(assembler.onLoadingFinished('nope')).toBeNull();
});

test('finishing a request clears it from pending', () => {
  const assembler = new RequestAssembler();
  assembler.onRequestWillBeSent(willBeSent('r1', 'https://example.com/'));
  assembler.onResponseReceived(responseReceived('r1'));
  expect(assembler.pendingCount()).toBe(1);
  assembler.onLoadingFinished('r1');
  expect(assembler.pendingCount()).toBe(0);
});

test('a failed load becomes a gap, not a silent drop', () => {
  const assembler = new RequestAssembler();
  assembler.onRequestWillBeSent(willBeSent('r1', 'https://cdn.example.com/chunk-47.js'));
  const gap = assembler.onLoadingFailed('r1', 'net::ERR_FAILED', false);

  expect(gap).not.toBeNull();
  expect(gap!.url).toBe('https://cdn.example.com/chunk-47.js');
  expect(gap!.reason).toBe('cors-opaque');
  expect(gap!.detail).toBe('net::ERR_FAILED');
  expect(assembler.pendingCount()).toBe(0);
});

test('a canceled load is recorded with the cdp-error reason', () => {
  const assembler = new RequestAssembler();
  assembler.onRequestWillBeSent(willBeSent('r1', 'https://example.com/x.js'));
  const gap = assembler.onLoadingFailed('r1', 'net::ERR_ABORTED', true);
  expect(gap!.reason).toBe('cdp-error');
});

test('marks cache hits so the exporter can skip refetching', () => {
  const assembler = new RequestAssembler();
  assembler.onRequestWillBeSent(willBeSent('r1', 'https://example.com/app.js'));
  assembler.onResponseReceived({
    requestId: 'r1',
    response: {
      status: 200,
      headers: {},
      mimeType: 'application/javascript',
      fromDiskCache: true,
    },
    type: 'Script',
  });
  expect(assembler.onLoadingFinished('r1')!.fromCache).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/projects/raidr_extension && bun test tests/background/requestAssembler.test.ts`
Expected: FAIL — cannot resolve `../../src/background/requestAssembler`

- [ ] **Step 3: Write src/background/requestAssembler.ts**

Note the `requestBody` field: the assembler carries the raw body string, and the offscreen document hashes it into `requestBodyHash` after redaction. `AssembledRequest` is therefore `CapturedRequest` with the hash fields replaced by raw values.

```ts
import type { CapturedRequest, Gap } from '@sudobility/raidr_processor';

export interface AssembledRequest
  extends Omit<CapturedRequest, 'requestBodyHash' | 'responseBodyHash'> {
  requestBody: string | null;
}

interface Pending {
  id: string;
  ts: number;
  method: string;
  url: string;
  resourceType: string;
  requestHeaders: Record<string, string>;
  requestBody: string | null;
  navigationId: string | null;
  status: number | null;
  responseHeaders: Record<string, string>;
  mimeType: string | null;
  fromCache: boolean;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function asHeaders(value: unknown): Record<string, string> {
  const source = asRecord(value);
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(source)) {
    out[key.toLowerCase()] = String(raw);
  }
  return out;
}

export class RequestAssembler {
  private pending = new Map<string, Pending>();
  private navigationId: string | null = null;

  setNavigationId(navigationId: string): void {
    this.navigationId = navigationId;
  }

  pendingCount(): number {
    return this.pending.size;
  }

  onRequestWillBeSent(params: Record<string, unknown>): void {
    const requestId = String(params.requestId ?? '');
    if (!requestId) return;
    const request = asRecord(params.request);
    const wallTime = Number(params.wallTime ?? 0);

    this.pending.set(requestId, {
      id: requestId,
      ts: Math.round(wallTime * 1000),
      method: String(request.method ?? 'GET'),
      url: String(request.url ?? ''),
      resourceType: String(params.type ?? 'Other'),
      requestHeaders: asHeaders(request.headers),
      requestBody:
        typeof request.postData === 'string' ? request.postData : null,
      navigationId: this.navigationId,
      status: null,
      responseHeaders: {},
      mimeType: null,
      fromCache: false,
    });
  }

  onResponseReceived(params: Record<string, unknown>): void {
    const requestId = String(params.requestId ?? '');
    const entry = this.pending.get(requestId);
    if (!entry) return;

    const response = asRecord(params.response);
    entry.status = Number(response.status ?? 0);
    entry.responseHeaders = asHeaders(response.headers);
    entry.mimeType =
      typeof response.mimeType === 'string' ? response.mimeType : null;
    entry.fromCache = response.fromDiskCache === true;
    if (typeof params.type === 'string') entry.resourceType = params.type;
  }

  onLoadingFinished(requestId: string): AssembledRequest | null {
    const entry = this.pending.get(requestId);
    if (!entry) return null;
    this.pending.delete(requestId);

    return {
      id: entry.id,
      ts: entry.ts,
      method: entry.method,
      url: entry.url,
      resourceType: entry.resourceType,
      requestHeaders: entry.requestHeaders,
      requestBody: entry.requestBody,
      status: entry.status,
      responseHeaders: entry.responseHeaders,
      mimeType: entry.mimeType,
      fromCache: entry.fromCache,
      navigationId: entry.navigationId,
    };
  }

  onLoadingFailed(
    requestId: string,
    errorText: string,
    canceled: boolean
  ): Gap | null {
    const entry = this.pending.get(requestId);
    if (!entry) return null;
    this.pending.delete(requestId);

    return {
      requestId,
      url: entry.url,
      reason: canceled ? 'cdp-error' : 'cors-opaque',
      ts: entry.ts,
      detail: errorText,
    };
  }
}
```

- [ ] **Step 4: Run tests**

Run: `cd ~/projects/raidr_extension && bun test && bun run typecheck`
Expected: PASS, 15 tests total; typecheck clean

- [ ] **Step 5: Commit**

```bash
cd ~/projects/raidr_extension
git add -A
git commit -m "feat: CDP request assembler with gap recording"
```

---

### Task 7: Offscreen content-addressed store

**Files:**
- Create: `~/projects/raidr_extension/src/offscreen/hash.ts`
- Create: `~/projects/raidr_extension/src/offscreen/store.ts`
- Create: `~/projects/raidr_extension/src/offscreen/index.html`
- Test: `~/projects/raidr_extension/tests/offscreen/store.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `sha256Hex(bytes: Uint8Array): Promise<string>`
  - `interface ContentStore` with `put`, `get`, `has`, `count`, `totalBytes`
  - `class IdbContentStore implements ContentStore` — constructor `(dbName: string, factory: IDBFactory)`

The `factory` parameter exists so tests inject `fake-indexeddb` and the extension injects the real `indexedDB`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/offscreen/store.test.ts
import { expect, test } from 'bun:test';
import 'fake-indexeddb/auto';
import { sha256Hex } from '../../src/offscreen/hash';
import { IdbContentStore } from '../../src/offscreen/store';

const encoder = new TextEncoder();
let dbCounter = 0;
function freshStore() {
  dbCounter += 1;
  return new IdbContentStore(`raidr-test-${dbCounter}`, indexedDB);
}

test('hashes bytes to stable lowercase hex', async () => {
  const hash = await sha256Hex(encoder.encode('hello'));
  expect(hash).toBe(
    '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'
  );
});

test('put returns the content hash', async () => {
  const store = freshStore();
  const hash = await store.put(encoder.encode('hello'));
  expect(hash).toBe(await sha256Hex(encoder.encode('hello')));
});

test('round-trips stored bytes', async () => {
  const store = freshStore();
  const hash = await store.put(encoder.encode('payload'));
  const got = await store.get(hash);
  expect(new TextDecoder().decode(got!)).toBe('payload');
});

test('get returns null for an unknown hash', async () => {
  const store = freshStore();
  expect(await store.get('deadbeef')).toBeNull();
});

test('deduplicates identical content', async () => {
  const store = freshStore();
  await store.put(encoder.encode('same'));
  await store.put(encoder.encode('same'));
  expect(await store.count()).toBe(1);
});

test('tracks total stored bytes without double counting duplicates', async () => {
  const store = freshStore();
  await store.put(encoder.encode('12345'));
  await store.put(encoder.encode('12345'));
  await store.put(encoder.encode('123'));
  expect(await store.totalBytes()).toBe(8);
});

test('has reports presence', async () => {
  const store = freshStore();
  const hash = await store.put(encoder.encode('x'));
  expect(await store.has(hash)).toBe(true);
  expect(await store.has('nope')).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/projects/raidr_extension && bun test tests/offscreen/store.test.ts`
Expected: FAIL — cannot resolve `../../src/offscreen/hash`

- [ ] **Step 3: Write src/offscreen/hash.ts**

```ts
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // TypeScript 5.7+ types Uint8Array as Uint8Array<ArrayBufferLike>, which is
  // not assignable to BufferSource (SharedArrayBuffer cannot be excluded).
  // Re-wrapping produces a definitely-ArrayBuffer-backed view.
  const view = new Uint8Array(bytes);
  const digest = await crypto.subtle.digest('SHA-256', view);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
```

- [ ] **Step 4: Write src/offscreen/store.ts**

```ts
import { sha256Hex } from './hash';

const STORE_NAME = 'content';

export interface ContentStore {
  put(bytes: Uint8Array): Promise<string>;
  get(hash: string): Promise<Uint8Array | null>;
  has(hash: string): Promise<boolean>;
  count(): Promise<number>;
  totalBytes(): Promise<number>;
}

interface ContentRow {
  hash: string;
  bytes: Uint8Array;
  size: number;
}

function promisify<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export class IdbContentStore implements ContentStore {
  private dbPromise: Promise<IDBDatabase> | null = null;

  constructor(
    private readonly dbName: string,
    private readonly factory: IDBFactory
  ) {}

  private open(): Promise<IDBDatabase> {
    if (this.dbPromise) return this.dbPromise;
    this.dbPromise = new Promise((resolve, reject) => {
      const request = this.factory.open(this.dbName, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'hash' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return this.dbPromise;
  }

  private async tx(mode: IDBTransactionMode): Promise<IDBObjectStore> {
    const db = await this.open();
    return db.transaction(STORE_NAME, mode).objectStore(STORE_NAME);
  }

  async put(bytes: Uint8Array): Promise<string> {
    const hash = await sha256Hex(bytes);
    if (await this.has(hash)) return hash;
    const store = await this.tx('readwrite');
    const row: ContentRow = { hash, bytes, size: bytes.byteLength };
    await promisify(store.put(row));
    return hash;
  }

  async get(hash: string): Promise<Uint8Array | null> {
    const store = await this.tx('readonly');
    const row = await promisify<ContentRow | undefined>(store.get(hash));
    return row ? row.bytes : null;
  }

  async has(hash: string): Promise<boolean> {
    const store = await this.tx('readonly');
    const key = await promisify<IDBValidKey | undefined>(store.getKey(hash));
    return key !== undefined;
  }

  async count(): Promise<number> {
    const store = await this.tx('readonly');
    return promisify(store.count());
  }

  async totalBytes(): Promise<number> {
    const store = await this.tx('readonly');
    const rows = await promisify<ContentRow[]>(store.getAll());
    return rows.reduce((sum, row) => sum + row.size, 0);
  }
}
```

- [ ] **Step 5: Create src/offscreen/index.html**

```html
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>raidr offscreen</title>
  </head>
  <body>
    <script type="module" src="./index.ts"></script>
  </body>
</html>
```

Also create a placeholder `src/offscreen/index.ts` so the Vite input resolves; Task 8 fills it in:

```ts
console.debug('[raidr] offscreen document ready');
```

- [ ] **Step 6: Run tests**

Run: `cd ~/projects/raidr_extension && bun test && bun run typecheck`
Expected: PASS, 22 tests total; typecheck clean

- [ ] **Step 7: Commit**

```bash
cd ~/projects/raidr_extension
git add -A
git commit -m "feat: content-addressed IndexedDB store for the offscreen buffer"
```

---

### Task 8: Bundle assembly and zip export

**Files:**
- Create: `~/projects/raidr_extension/src/offscreen/exporter.ts`
- Modify: `~/projects/raidr_extension/src/offscreen/index.ts`
- Modify: `~/projects/raidr_extension/src/background/index.ts`
- Test: `~/projects/raidr_extension/tests/offscreen/exporter.test.ts`

**Interfaces:**
- Consumes: `contentPath`, `extensionForMime`, `toJsonl`, `createManifest` from `@sudobility/raidr_processor`; `ContentStore` from Task 7
- Produces:
  - `buildBundleFiles(input: BundleInput): Promise<Record<string, Uint8Array>>`
  - `zipBundle(files: Record<string, Uint8Array>): Promise<Uint8Array>`
  - `bundleFilename(origin: string, startedAt: string): string`

`buildBundleFiles` is pure over its inputs, which is what makes the bundle format testable without a browser.

- [ ] **Step 1: Write the failing test**

```ts
// tests/offscreen/exporter.test.ts
import { expect, test } from 'bun:test';
import 'fake-indexeddb/auto';
import { unzipSync, strFromU8 } from 'fflate';
import { IdbContentStore } from '../../src/offscreen/store';
import {
  buildBundleFiles,
  zipBundle,
  bundleFilename,
} from '../../src/offscreen/exporter';

const encoder = new TextEncoder();

async function fixtureInput() {
  const store = new IdbContentStore(`raidr-export-${Math.random()}`, indexedDB);
  const htmlHash = await store.put(encoder.encode('<html></html>'));
  return {
    store,
    input: {
      store,
      manifest: {
        formatVersion: 1 as const,
        sessionId: 's1',
        origin: 'https://example.com',
        startedAt: '2026-08-24T10:00:00.000Z',
        endedAt: '2026-08-24T10:05:00.000Z',
        counts: { requests: 1, frames: 0, bodies: 1, gaps: 1 },
        stack: null,
      },
      requests: [
        {
          id: 'r1',
          ts: 1756029600000,
          method: 'GET',
          url: 'https://example.com/',
          resourceType: 'Document',
          requestHeaders: {},
          requestBodyHash: null,
          status: 200,
          responseHeaders: {},
          responseBodyHash: htmlHash,
          mimeType: 'text/html',
          fromCache: false,
          navigationId: 'nav1',
        },
      ],
      frames: [],
      gaps: [
        {
          requestId: 'r2',
          url: 'https://cdn.example.com/chunk-47.js',
          reason: 'body-evicted' as const,
          ts: 1756029601000,
          detail: 'No resource with given identifier found',
        },
      ],
      redaction: [
        { placeholder: '<JWT:a1b2>', kind: 'jwt' as const, occurrences: 4 },
      ],
      runtime: {
        framework: { framework: 'react' },
        routes: [],
        stores: [],
        chunks: { known: [], loaded: [] },
        coverage: {},
      },
      htmlHash,
    },
  };
}

test('lays out every required bundle path', async () => {
  const { input } = await fixtureInput();
  const files = await buildBundleFiles(input);
  const paths = Object.keys(files).sort();

  expect(paths).toContain('raidr.json');
  expect(paths).toContain('network/requests.jsonl');
  expect(paths).toContain('network/websockets.jsonl');
  expect(paths).toContain('gaps.json');
  expect(paths).toContain('redaction.json');
  expect(paths).toContain('runtime/framework.json');
  expect(paths).toContain('runtime/routes.json');
  expect(paths).toContain('runtime/stores.json');
  expect(paths).toContain('runtime/chunks.json');
  expect(paths).toContain('runtime/coverage.json');
  expect(paths).toContain(`content/${input.htmlHash}.html`);
});

test('writes referenced bodies with the extension implied by mime type', async () => {
  const { input } = await fixtureInput();
  const files = await buildBundleFiles(input);
  const body = files[`content/${input.htmlHash}.html`];
  expect(strFromU8(body!)).toBe('<html></html>');
});

test('records gaps verbatim so reconstruction can see what is missing', async () => {
  const { input } = await fixtureInput();
  const files = await buildBundleFiles(input);
  const gaps = JSON.parse(strFromU8(files['gaps.json']!));
  expect(gaps).toHaveLength(1);
  expect(gaps[0].reason).toBe('body-evicted');
});

test('never writes the pseudonym salt into redaction.json', async () => {
  const { input } = await fixtureInput();
  const files = await buildBundleFiles(input);
  const text = strFromU8(files['redaction.json']!);
  expect(text).toContain('<JWT:a1b2>');
  expect(text.toLowerCase()).not.toContain('salt');
});

test('zips into an archive that unzips back to the same files', async () => {
  const { input } = await fixtureInput();
  const files = await buildBundleFiles(input);
  const zipped = await zipBundle(files);
  const unzipped = unzipSync(zipped);
  expect(strFromU8(unzipped['raidr.json']!)).toBe(strFromU8(files['raidr.json']!));
});

test('filename encodes host and start time', () => {
  expect(bundleFilename('https://app.example.com', '2026-08-24T10:05:00.000Z')).toBe(
    'raidr-app.example.com-20260824-1005.zip'
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/projects/raidr_extension && bun test tests/offscreen/exporter.test.ts`
Expected: FAIL — cannot resolve `../../src/offscreen/exporter`

- [ ] **Step 3: Write src/offscreen/exporter.ts**

```ts
import { zip } from 'fflate';
import {
  contentPath,
  extensionForMime,
  toJsonl,
  type CapturedFrame,
  type CapturedRequest,
  type Gap,
  type RedactionEntry,
  type RaidrManifest,
} from '@sudobility/raidr_processor';
import type { ContentStore } from './store';

export interface RuntimeArtifacts {
  framework: unknown;
  routes: unknown;
  stores: unknown;
  chunks: unknown;
  coverage: unknown;
}

export interface BundleInput {
  store: ContentStore;
  manifest: RaidrManifest;
  requests: CapturedRequest[];
  frames: CapturedFrame[];
  gaps: Gap[];
  redaction: RedactionEntry[];
  runtime: RuntimeArtifacts;
}

const encoder = new TextEncoder();

function json(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(value, null, 2));
}

export async function buildBundleFiles(
  input: BundleInput
): Promise<Record<string, Uint8Array>> {
  const files: Record<string, Uint8Array> = {
    'raidr.json': json(input.manifest),
    'network/requests.jsonl': encoder.encode(toJsonl(input.requests)),
    'network/websockets.jsonl': encoder.encode(toJsonl(input.frames)),
    'gaps.json': json(input.gaps),
    'redaction.json': json(input.redaction),
    'runtime/framework.json': json(input.runtime.framework),
    'runtime/routes.json': json(input.runtime.routes),
    'runtime/stores.json': json(input.runtime.stores),
    'runtime/chunks.json': json(input.runtime.chunks),
    'runtime/coverage.json': json(input.runtime.coverage),
  };

  // Extension is derived from the mime type of the request that produced the
  // body. A hash referenced by two requests with different mime types is
  // written once per extension; the bytes are identical either way.
  for (const request of input.requests) {
    const ext = extensionForMime(request.mimeType);
    for (const hash of [request.responseBodyHash, request.requestBodyHash]) {
      if (!hash) continue;
      const path = contentPath(hash, hash === request.requestBodyHash ? 'json' : ext);
      if (files[path]) continue;
      const bytes = await input.store.get(hash);
      if (bytes) files[path] = bytes;
    }
  }

  for (const frame of input.frames) {
    const path = contentPath(frame.payloadHash, 'txt');
    if (files[path]) continue;
    const bytes = await input.store.get(frame.payloadHash);
    if (bytes) files[path] = bytes;
  }

  return files;
}

export function zipBundle(
  files: Record<string, Uint8Array>
): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    zip(files, { level: 6 }, (error, data) => {
      if (error) reject(error);
      else resolve(data);
    });
  });
}

export function bundleFilename(origin: string, startedAt: string): string {
  const host = new URL(origin).host;
  const date = startedAt.slice(0, 10).replace(/-/g, '');
  const time = startedAt.slice(11, 16).replace(':', '');
  return `raidr-${host}-${date}-${time}.zip`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ~/projects/raidr_extension && bun test tests/offscreen/exporter.test.ts`
Expected: PASS, 6 tests

- [ ] **Step 5: Wire export through the offscreen document and service worker**

This is the minimal version that proves export end-to-end; Task 17 replaces it
with the full session lifecycle. Replace `src/offscreen/index.ts`:

```ts
import { isRaidrMessage } from '@/shared/messages';
import { IdbContentStore } from './store';
import { buildBundleFiles, zipBundle, bundleFilename } from './exporter';
import type { BundleInput } from './exporter';

const store = new IdbContentStore('raidr-capture', indexedDB);

// Session state lives here, not in the service worker: MV3 terminates an idle
// worker after ~30s, which would discard the buffer mid-capture.
const session = {
  manifest: null as BundleInput['manifest'] | null,
  requests: [] as BundleInput['requests'],
  frames: [] as BundleInput['frames'],
  gaps: [] as BundleInput['gaps'],
  redaction: [] as BundleInput['redaction'],
  runtime: {
    framework: null,
    routes: [],
    stores: [],
    chunks: { known: [], loaded: [] },
    coverage: {},
  } as BundleInput['runtime'],
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!isRaidrMessage(message)) return;

  if (message.kind === 'export/start') {
    void (async () => {
      if (!session.manifest) {
        sendResponse({ ok: false, error: 'no active session' });
        return;
      }
      const files = await buildBundleFiles({ store, ...session, manifest: session.manifest });
      const zipped = await zipBundle(files);
      const blobUrl = URL.createObjectURL(
        new Blob([zipped], { type: 'application/zip' })
      );
      sendResponse({
        ok: true,
        blobUrl,
        filename: bundleFilename(
          session.manifest.origin,
          session.manifest.startedAt
        ),
      });
    })();
    return true; // keep the message channel open for the async response
  }
});

export { session, store };
```

Add offscreen lifecycle and download handling to `src/background/index.ts`:

```ts
import { isRaidrMessage } from '@/shared/messages';

const OFFSCREEN_PATH = 'src/offscreen/index.html';

async function ensureOffscreen(): Promise<void> {
  const existing = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
  });
  if (existing.length > 0) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: [chrome.offscreen.Reason.BLOBS],
    justification:
      'Holds the capture buffer and builds the export archive; a service worker cannot, because it is terminated when idle.',
  });
}

chrome.runtime.onMessage.addListener((message) => {
  if (!isRaidrMessage(message)) return;

  if (message.kind === 'export/ready') {
    void chrome.downloads.download({
      url: message.blobUrl,
      filename: message.filename,
      saveAs: true,
    });
  }
});

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error: unknown) => console.error('[raidr] side panel', error));

void ensureOffscreen();
```

- [ ] **Step 6: Verify the full suite and build**

Run: `cd ~/projects/raidr_extension && bun test && bun run typecheck && bun run build`
Expected: PASS, 28 tests total; typecheck clean; build succeeds

- [ ] **Step 7: Commit**

```bash
cd ~/projects/raidr_extension
git add -A
git commit -m "feat: bundle assembly, zip export, and offscreen document lifecycle"
```

---
# Milestone 3 — Redaction

All redaction logic lives in `raidr_processor` as pure functions. The extension imports
it and calls it before anything reaches IndexedDB.

### Task 9: Stable pseudonym generator

**Files:**
- Create: `~/projects/raidr_processor/src/redaction/pseudonym.ts`
- Modify: `~/projects/raidr_processor/src/index.ts`
- Test: `~/projects/raidr_processor/tests/redaction/pseudonym.test.ts`

**Interfaces:**
- Consumes: `RedactionKind`, `RedactionEntry` from Task 2
- Produces:
  - `type Pseudonymizer = (kind: RedactionKind, value: string) => string`
  - `createPseudonymizer(salt: string): { pseudonym: Pseudonymizer; entries(): RedactionEntry[] }`

- [ ] **Step 1: Write the failing test**

```ts
// tests/redaction/pseudonym.test.ts
import { expect, test } from 'bun:test';
import { createPseudonymizer } from '../../src/redaction/pseudonym';

test('the same value always yields the same placeholder', () => {
  const { pseudonym } = createPseudonymizer('salt-1');
  const a = pseudonym('jwt', 'eyJhbGciOi.payload.sig');
  const b = pseudonym('jwt', 'eyJhbGciOi.payload.sig');
  expect(a).toBe(b);
});

test('different values yield different placeholders', () => {
  const { pseudonym } = createPseudonymizer('salt-1');
  expect(pseudonym('jwt', 'token-a')).not.toBe(pseudonym('jwt', 'token-b'));
});

test('placeholder format is <KIND:hash>', () => {
  const { pseudonym } = createPseudonymizer('salt-1');
  expect(pseudonym('jwt', 'token-a')).toMatch(/^<JWT:[0-9a-f]{4}>$/);
  expect(pseudonym('api-key', 'k')).toMatch(/^<API_KEY:[0-9a-f]{4}>$/);
  expect(pseudonym('high-entropy', 'x')).toMatch(/^<SECRET:[0-9a-f]{4}>$/);
});

test('a different salt yields a different placeholder for the same value', () => {
  const one = createPseudonymizer('salt-1');
  const two = createPseudonymizer('salt-2');
  expect(one.pseudonym('jwt', 'token-a')).not.toBe(two.pseudonym('jwt', 'token-a'));
});

test('emails become sequential example.com addresses, stably', () => {
  const { pseudonym } = createPseudonymizer('salt-1');
  expect(pseudonym('email', 'jane@corp.com')).toBe('user1@example.com');
  expect(pseudonym('email', 'bob@corp.com')).toBe('user2@example.com');
  expect(pseudonym('email', 'jane@corp.com')).toBe('user1@example.com');
});

test('phones become sequential placeholder numbers, stably', () => {
  const { pseudonym } = createPseudonymizer('salt-1');
  expect(pseudonym('phone', '+14155550001')).toBe('+15550000001');
  expect(pseudonym('phone', '+14155550002')).toBe('+15550000002');
  expect(pseudonym('phone', '+14155550001')).toBe('+15550000001');
});

test('entries report each placeholder with its kind and occurrence count', () => {
  const { pseudonym, entries } = createPseudonymizer('salt-1');
  pseudonym('jwt', 'token-a');
  pseudonym('jwt', 'token-a');
  pseudonym('jwt', 'token-b');

  const report = entries();
  expect(report).toHaveLength(2);
  const first = report.find((e) => e.occurrences === 2);
  expect(first!.kind).toBe('jwt');
});

test('entries never contain the original values', () => {
  const { pseudonym, entries } = createPseudonymizer('salt-1');
  pseudonym('jwt', 'super-secret-token');
  expect(JSON.stringify(entries())).not.toContain('super-secret-token');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/projects/raidr_processor && bun test tests/redaction/pseudonym.test.ts`
Expected: FAIL — cannot resolve `../../src/redaction/pseudonym`

- [ ] **Step 3: Write src/redaction/pseudonym.ts**

```ts
import type { RedactionEntry, RedactionKind } from '../bundle/types';

export type Pseudonymizer = (kind: RedactionKind, value: string) => string;

const LABELS: Record<RedactionKind, string> = {
  jwt: 'JWT',
  bearer: 'BEARER',
  cookie: 'COOKIE',
  'api-key': 'API_KEY',
  password: 'PASSWORD',
  email: 'EMAIL',
  phone: 'PHONE',
  'high-entropy': 'SECRET',
};

/**
 * FNV-1a, 32-bit. Synchronous by design: redaction runs inline on every
 * captured body, and an async digest per field would serialize the capture
 * pipeline behind the event loop.
 */
function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export function createPseudonymizer(salt: string): {
  pseudonym: Pseudonymizer;
  entries(): RedactionEntry[];
} {
  const assigned = new Map<string, string>();
  const counts = new Map<string, { kind: RedactionKind; occurrences: number }>();
  let emailCounter = 0;
  let phoneCounter = 0;

  const pseudonym: Pseudonymizer = (kind, value) => {
    const key = `${kind}:${value}`;
    let placeholder = assigned.get(key);

    if (placeholder === undefined) {
      if (kind === 'email') {
        emailCounter += 1;
        placeholder = `user${emailCounter}@example.com`;
      } else if (kind === 'phone') {
        phoneCounter += 1;
        placeholder = `+1555${String(phoneCounter).padStart(7, '0')}`;
      } else {
        const digest = fnv1a(`${salt}:${value}`)
          .toString(16)
          .padStart(8, '0')
          .slice(0, 4);
        placeholder = `<${LABELS[kind]}:${digest}>`;
      }
      assigned.set(key, placeholder);
      counts.set(placeholder, { kind, occurrences: 0 });
    }

    const entry = counts.get(placeholder);
    if (entry) entry.occurrences += 1;
    return placeholder;
  };

  return {
    pseudonym,
    entries: () =>
      Array.from(counts.entries()).map(([placeholder, meta]) => ({
        placeholder,
        kind: meta.kind,
        occurrences: meta.occurrences,
      })),
  };
}
```

- [ ] **Step 4: Export from src/index.ts**

```ts
export { createPseudonymizer } from './redaction/pseudonym';
export type { Pseudonymizer } from './redaction/pseudonym';
```

- [ ] **Step 5: Run tests**

Run: `cd ~/projects/raidr_processor && bun test && bun run typecheck`
Expected: PASS, 21 tests total; typecheck clean

- [ ] **Step 6: Commit**

```bash
cd ~/projects/raidr_processor
git add -A
git commit -m "feat: stable pseudonym generator preserving referential integrity"
```

---

### Task 10: Detection patterns and header redaction

**Files:**
- Create: `~/projects/raidr_processor/src/redaction/patterns.ts`
- Create: `~/projects/raidr_processor/src/redaction/headers.ts`
- Modify: `~/projects/raidr_processor/src/index.ts`
- Test: `~/projects/raidr_processor/tests/redaction/headers.test.ts`

**Interfaces:**
- Consumes: `Pseudonymizer` from Task 9
- Produces:
  - `isSensitiveKey(key: string): RedactionKind | null`
  - `classifyValue(value: string): RedactionKind | null`
  - `redactHeaders(headers: Record<string,string>, pseudonym: Pseudonymizer): Record<string,string>`

- [ ] **Step 1: Write the failing test**

```ts
// tests/redaction/headers.test.ts
import { expect, test } from 'bun:test';
import { createPseudonymizer } from '../../src/redaction/pseudonym';
import { redactHeaders } from '../../src/redaction/headers';
import { isSensitiveKey, classifyValue } from '../../src/redaction/patterns';

test('recognises sensitive key names', () => {
  expect(isSensitiveKey('password')).toBe('password');
  expect(isSensitiveKey('access_token')).toBe('jwt');
  expect(isSensitiveKey('apiKey')).toBe('api-key');
  expect(isSensitiveKey('api_key')).toBe('api-key');
  expect(isSensitiveKey('X-Session-Id')).toBe('api-key');
});

test('leaves ordinary key names alone', () => {
  expect(isSensitiveKey('username')).toBeNull();
  expect(isSensitiveKey('id')).toBeNull();
  expect(isSensitiveKey('createdAt')).toBeNull();
});

test('classifies values by shape', () => {
  expect(classifyValue('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc')).toBe('jwt');
  expect(classifyValue('Bearer abc123def456')).toBe('bearer');
  expect(classifyValue('jane@corp.com')).toBe('email');
  expect(classifyValue('a'.repeat(40))).toBe('high-entropy');
});

test('preserves UUIDs — they are structural, not secret', () => {
  expect(classifyValue('550e8400-e29b-41d4-a716-446655440000')).toBeNull();
});

test('leaves short ordinary strings alone', () => {
  expect(classifyValue('active')).toBeNull();
  expect(classifyValue('1138')).toBeNull();
});

test('redacts denylisted headers but keeps the header itself', () => {
  const { pseudonym } = createPseudonymizer('s');
  const out = redactHeaders(
    {
      authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc',
      cookie: 'session=abc123',
      'content-type': 'application/json',
    },
    pseudonym
  );

  expect(out['content-type']).toBe('application/json');
  expect(out.authorization).toMatch(/^<(JWT|BEARER):[0-9a-f]{4}>$/);
  expect(out.cookie).toMatch(/^<COOKIE:[0-9a-f]{4}>$/);
});

test('the same token in two requests keeps the same placeholder', () => {
  const { pseudonym } = createPseudonymizer('s');
  const token = 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc';
  const first = redactHeaders({ authorization: token }, pseudonym);
  const second = redactHeaders({ authorization: token }, pseudonym);
  expect(first.authorization).toBe(second.authorization);
});

test('matches header names case-insensitively', () => {
  const { pseudonym } = createPseudonymizer('s');
  const out = redactHeaders({ Authorization: 'Bearer abcdef123456' }, pseudonym);
  expect(out.Authorization).toMatch(/^<BEARER:/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/projects/raidr_processor && bun test tests/redaction/headers.test.ts`
Expected: FAIL — cannot resolve `../../src/redaction/patterns`

- [ ] **Step 3: Write src/redaction/patterns.ts**

```ts
import type { RedactionKind } from '../bundle/types';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const JWT_RE = /^ey[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/;
const BEARER_RE = /^Bearer\s+\S{8,}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const HIGH_ENTROPY_RE = /^[A-Za-z0-9+/_=-]{40,}$/;

const KEY_KINDS: Array<[RegExp, RedactionKind]> = [
  [/^(password|passwd|pwd)$/i, 'password'],
  [/^(access_?token|refresh_?token|id_?token|jwt)$/i, 'jwt'],
  [/^(api_?key|apikey|x-api-key|client_?secret|secret)$/i, 'api-key'],
  [/^(cookie|set-cookie)$/i, 'cookie'],
  [/^(authorization|proxy-authorization)$/i, 'bearer'],
  [/(^|[-_])session([-_]|$)/i, 'api-key'],
  [/^(ssn|social_?security)$/i, 'password'],
  [/^(credit_?card|card_?number|cvv|cvc)$/i, 'password'],
  [/^(email|email_?address)$/i, 'email'],
  [/^(phone|phone_?number|mobile)$/i, 'phone'],
];

export function isSensitiveKey(key: string): RedactionKind | null {
  for (const [pattern, kind] of KEY_KINDS) {
    if (pattern.test(key)) return kind;
  }
  return null;
}

export function classifyValue(value: string): RedactionKind | null {
  // UUIDs first: they look high-entropy but carry the relational shape of the
  // data. Redacting them would break foreign-key correspondence downstream.
  if (UUID_RE.test(value)) return null;
  if (JWT_RE.test(value)) return 'jwt';
  if (BEARER_RE.test(value)) return 'bearer';
  if (EMAIL_RE.test(value)) return 'email';
  if (HIGH_ENTROPY_RE.test(value)) return 'high-entropy';
  return null;
}
```

- [ ] **Step 4: Write src/redaction/headers.ts**

```ts
import type { Pseudonymizer } from './pseudonym';
import { classifyValue, isSensitiveKey } from './patterns';

export function redactHeaders(
  headers: Record<string, string>,
  pseudonym: Pseudonymizer
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const byKey = isSensitiveKey(key);
    if (byKey) {
      // Prefer the value's own shape when it is more specific than the header
      // name — an Authorization header holding a JWT is tagged as a JWT.
      const byValue = classifyValue(value);
      out[key] = pseudonym(byValue ?? byKey, value);
      continue;
    }
    const byValue = classifyValue(value);
    out[key] = byValue ? pseudonym(byValue, value) : value;
  }
  return out;
}
```

- [ ] **Step 5: Export from src/index.ts**

```ts
export { isSensitiveKey, classifyValue } from './redaction/patterns';
export { redactHeaders } from './redaction/headers';
```

- [ ] **Step 6: Run tests**

Run: `cd ~/projects/raidr_processor && bun test && bun run typecheck`
Expected: PASS, 29 tests total; typecheck clean

- [ ] **Step 7: Commit**

```bash
cd ~/projects/raidr_processor
git add -A
git commit -m "feat: sensitive value detection and header redaction"
```

---

### Task 11: JSON body redaction and the redaction entry point

**Files:**
- Create: `~/projects/raidr_processor/src/redaction/json.ts`
- Create: `~/projects/raidr_processor/src/redaction/index.ts`
- Modify: `~/projects/raidr_processor/src/index.ts`
- Test: `~/projects/raidr_processor/tests/redaction/json.test.ts`
- Test: `~/projects/raidr_processor/tests/redaction/redactRequest.test.ts`

**Interfaces:**
- Consumes: `Pseudonymizer`, `isSensitiveKey`, `classifyValue`
- Produces:
  - `redactJsonValue(value: unknown, pseudonym: Pseudonymizer): unknown`
  - `redactJsonText(text: string, pseudonym: Pseudonymizer): string`
  - `redactHtmlHydration(html: string, pseudonym: Pseudonymizer): string`
  - `redactRequest(input: RedactableRequest, pseudonym: Pseudonymizer): RedactedRequest`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/redaction/json.test.ts
import { expect, test } from 'bun:test';
import { createPseudonymizer } from '../../src/redaction/pseudonym';
import {
  redactJsonValue,
  redactJsonText,
  redactHtmlHydration,
} from '../../src/redaction/json';

test('redacts by key name at any depth', () => {
  const { pseudonym } = createPseudonymizer('s');
  const out = redactJsonValue(
    { user: { name: 'Jane', password: 'hunter2' } },
    pseudonym
  ) as { user: { name: string; password: string } };

  expect(out.user.name).toBe('Jane');
  expect(out.user.password).toMatch(/^<PASSWORD:/);
});

test('redacts by value shape even under an innocent key', () => {
  const { pseudonym } = createPseudonymizer('s');
  const out = redactJsonValue(
    { data: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc' },
    pseudonym
  ) as { data: string };
  expect(out.data).toMatch(/^<JWT:/);
});

test('walks arrays', () => {
  const { pseudonym } = createPseudonymizer('s');
  const out = redactJsonValue(
    [{ email: 'a@b.com' }, { email: 'c@d.com' }],
    pseudonym
  ) as Array<{ email: string }>;
  expect(out[0]!.email).toBe('user1@example.com');
  expect(out[1]!.email).toBe('user2@example.com');
});

test('preserves UUIDs, numbers, booleans, and nulls', () => {
  const { pseudonym } = createPseudonymizer('s');
  const input = {
    id: '550e8400-e29b-41d4-a716-446655440000',
    count: 42,
    active: true,
    deletedAt: null,
  };
  expect(redactJsonValue(input, pseudonym)).toEqual(input);
});

test('preserves object shape exactly — no keys added or dropped', () => {
  const { pseudonym } = createPseudonymizer('s');
  const input = { a: 'x', token: 'eyJa.b.c', nested: { b: 1 } };
  const out = redactJsonValue(input, pseudonym) as Record<string, unknown>;
  expect(Object.keys(out).sort()).toEqual(['a', 'nested', 'token']);
});

test('redactJsonText round-trips through JSON', () => {
  const { pseudonym } = createPseudonymizer('s');
  const out = redactJsonText('{"password":"hunter2"}', pseudonym);
  expect(JSON.parse(out).password).toMatch(/^<PASSWORD:/);
});

test('redactJsonText returns unparseable input unchanged', () => {
  const { pseudonym } = createPseudonymizer('s');
  expect(redactJsonText('not json at all', pseudonym)).toBe('not json at all');
});

test('redacts inline hydration state in HTML', () => {
  const { pseudonym } = createPseudonymizer('s');
  const html =
    '<html><body><script>window.__INITIAL_STATE__ = {"user":{"email":"jane@corp.com"}};</script></body></html>';
  const out = redactHtmlHydration(html, pseudonym);

  expect(out).toContain('user1@example.com');
  expect(out).not.toContain('jane@corp.com');
  expect(out).toContain('window.__INITIAL_STATE__ =');
  expect(out.startsWith('<html><body><script>')).toBe(true);
});

test('handles nested braces in hydration state', () => {
  const { pseudonym } = createPseudonymizer('s');
  const html =
    '<script>window.__INITIAL_STATE__ = {"a":{"b":{"password":"hunter2"}},"c":1};</script>';
  const out = redactHtmlHydration(html, pseudonym);
  expect(out).toContain('<PASSWORD:');
  expect(out).toContain('"c":1');
});

test('leaves HTML without hydration state untouched', () => {
  const { pseudonym } = createPseudonymizer('s');
  const html = '<html><body>hello</body></html>';
  expect(redactHtmlHydration(html, pseudonym)).toBe(html);
});
```

```ts
// tests/redaction/redactRequest.test.ts
import { expect, test } from 'bun:test';
import { createPseudonymizer } from '../../src/redaction/pseudonym';
import { redactRequest } from '../../src/redaction/index';

test('never mutates JavaScript bodies', () => {
  const { pseudonym } = createPseudonymizer('s');
  const source = 'const API_KEY="abcdefghijklmnopqrstuvwxyz0123456789abcd";';
  const out = redactRequest(
    {
      requestHeaders: {},
      responseHeaders: {},
      mimeType: 'application/javascript',
      requestBody: null,
      responseBody: source,
    },
    pseudonym
  );
  expect(out.responseBody).toBe(source);
});

test('never mutates CSS bodies', () => {
  const { pseudonym } = createPseudonymizer('s');
  const css = '.a{content:"abcdefghijklmnopqrstuvwxyz0123456789abcd"}';
  const out = redactRequest(
    {
      requestHeaders: {},
      responseHeaders: {},
      mimeType: 'text/css',
      requestBody: null,
      responseBody: css,
    },
    pseudonym
  );
  expect(out.responseBody).toBe(css);
});

test('redacts JSON response bodies', () => {
  const { pseudonym } = createPseudonymizer('s');
  const out = redactRequest(
    {
      requestHeaders: {},
      responseHeaders: {},
      mimeType: 'application/json',
      requestBody: null,
      responseBody: '{"access_token":"eyJa.b.c"}',
    },
    pseudonym
  );
  expect(JSON.parse(out.responseBody!).access_token).toMatch(/^<JWT:/);
});

test('redacts request bodies regardless of response mime type', () => {
  const { pseudonym } = createPseudonymizer('s');
  const out = redactRequest(
    {
      requestHeaders: {},
      responseHeaders: {},
      mimeType: 'text/html',
      requestBody: '{"password":"hunter2"}',
      responseBody: null,
    },
    pseudonym
  );
  expect(JSON.parse(out.requestBody!).password).toMatch(/^<PASSWORD:/);
});

test('redacts hydration state inside HTML responses', () => {
  const { pseudonym } = createPseudonymizer('s');
  const out = redactRequest(
    {
      requestHeaders: {},
      responseHeaders: {},
      mimeType: 'text/html',
      requestBody: null,
      responseBody:
        '<script>window.__INITIAL_STATE__ = {"email":"jane@corp.com"};</script>',
    },
    pseudonym
  );
  expect(out.responseBody).toContain('user1@example.com');
});

test('the login response token matches the token in later request headers', () => {
  const { pseudonym } = createPseudonymizer('s');
  const token = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc';

  const login = redactRequest(
    {
      requestHeaders: {},
      responseHeaders: {},
      mimeType: 'application/json',
      requestBody: null,
      responseBody: JSON.stringify({ access_token: token }),
    },
    pseudonym
  );
  const later = redactRequest(
    {
      requestHeaders: { authorization: token },
      responseHeaders: {},
      mimeType: 'application/json',
      requestBody: null,
      responseBody: '{}',
    },
    pseudonym
  );

  expect(JSON.parse(login.responseBody!).access_token).toBe(
    later.requestHeaders.authorization
  );
});
```

The last test is the point of the whole redaction design: it proves the auth flow stays reconstructable.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ~/projects/raidr_processor && bun test tests/redaction/`
Expected: FAIL — cannot resolve `../../src/redaction/json`

- [ ] **Step 3: Write src/redaction/json.ts**

```ts
import type { Pseudonymizer } from './pseudonym';
import { classifyValue, isSensitiveKey } from './patterns';

export function redactJsonValue(
  value: unknown,
  pseudonym: Pseudonymizer,
  keyHint: string | null = null
): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactJsonValue(item, pseudonym, keyHint));
  }

  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      out[key] = redactJsonValue(child, pseudonym, key);
    }
    return out;
  }

  if (typeof value === 'string') {
    const byValue = classifyValue(value);
    const byKey = keyHint ? isSensitiveKey(keyHint) : null;
    // Value shape wins when both match: it is the more specific signal.
    const kind = byValue ?? byKey;
    return kind ? pseudonym(kind, value) : value;
  }

  return value;
}

export function redactJsonText(
  text: string,
  pseudonym: Pseudonymizer
): string {
  try {
    const parsed: unknown = JSON.parse(text);
    return JSON.stringify(redactJsonValue(parsed, pseudonym));
  } catch {
    // Not JSON. Returning it unchanged is correct: this function's contract is
    // JSON redaction, and the caller decides what non-JSON bodies deserve.
    return text;
  }
}

const HYDRATION_KEYS = [
  '__INITIAL_STATE__',
  '__PRELOADED_STATE__',
  '__NUXT__',
  '__NEXT_DATA__',
];

/** Extracts the balanced-brace object starting at `start`, or null. */
function readObjectLiteral(text: string, start: number): string | null {
  if (text[start] !== '{') return null;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const char = text[i]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

export function redactHtmlHydration(
  html: string,
  pseudonym: Pseudonymizer
): string {
  let out = html;

  for (const key of HYDRATION_KEYS) {
    let searchFrom = 0;
    for (;;) {
      const keyIndex = out.indexOf(key, searchFrom);
      if (keyIndex < 0) break;

      const braceIndex = out.indexOf('{', keyIndex);
      if (braceIndex < 0) break;

      const literal = readObjectLiteral(out, braceIndex);
      if (!literal) {
        searchFrom = keyIndex + key.length;
        continue;
      }

      const redacted = redactJsonText(literal, pseudonym);
      out = out.slice(0, braceIndex) + redacted + out.slice(braceIndex + literal.length);
      searchFrom = braceIndex + redacted.length;
    }
  }

  return out;
}
```

- [ ] **Step 4: Write src/redaction/index.ts**

```ts
import type { Pseudonymizer } from './pseudonym';
import { redactHeaders } from './headers';
import { redactHtmlHydration, redactJsonText } from './json';

export interface RedactableRequest {
  requestHeaders: Record<string, string>;
  responseHeaders: Record<string, string>;
  mimeType: string | null;
  requestBody: string | null;
  responseBody: string | null;
}

export interface RedactedRequest {
  requestHeaders: Record<string, string>;
  responseHeaders: Record<string, string>;
  requestBody: string | null;
  responseBody: string | null;
}

/**
 * JavaScript and CSS are public code. Mutating them would corrupt parsing and
 * invalidate source-map offsets, destroying the material reconstruction needs.
 */
function isImmutableAsset(mimeType: string | null): boolean {
  if (!mimeType) return false;
  const base = mimeType.split(';')[0]?.trim().toLowerCase() ?? '';
  return (
    base.includes('javascript') ||
    base === 'text/css' ||
    base.startsWith('image/') ||
    base.startsWith('font/')
  );
}

function isHtml(mimeType: string | null): boolean {
  return (mimeType ?? '').toLowerCase().includes('html');
}

export function redactRequest(
  input: RedactableRequest,
  pseudonym: Pseudonymizer
): RedactedRequest {
  let responseBody = input.responseBody;

  if (responseBody !== null) {
    if (isImmutableAsset(input.mimeType)) {
      // left exactly as served
    } else if (isHtml(input.mimeType)) {
      responseBody = redactHtmlHydration(responseBody, pseudonym);
    } else {
      responseBody = redactJsonText(responseBody, pseudonym);
    }
  }

  return {
    requestHeaders: redactHeaders(input.requestHeaders, pseudonym),
    responseHeaders: redactHeaders(input.responseHeaders, pseudonym),
    requestBody:
      input.requestBody === null
        ? null
        : redactJsonText(input.requestBody, pseudonym),
    responseBody,
  };
}
```

- [ ] **Step 5: Export from src/index.ts**

```ts
export {
  redactJsonValue,
  redactJsonText,
  redactHtmlHydration,
} from './redaction/json';
export { redactRequest } from './redaction/index';
export type { RedactableRequest, RedactedRequest } from './redaction/index';
```

- [ ] **Step 6: Run tests**

Run: `cd ~/projects/raidr_processor && bun test && bun run typecheck`
Expected: PASS, 45 tests total; typecheck clean

- [ ] **Step 7: Commit**

```bash
cd ~/projects/raidr_processor
git add -A
git commit -m "feat: JSON, HTML hydration, and whole-request redaction"
```

---

### Task 12: Wire redaction into capture and add the review gate

**Files:**
- Create: `~/projects/raidr_extension/src/offscreen/capturePipeline.ts`
- Create: `~/projects/raidr_extension/src/sidepanel/components/RedactionReport.tsx`
- Modify: `~/projects/raidr_extension/src/offscreen/index.ts`
- Modify: `~/projects/raidr_extension/src/sidepanel/SidePanel.tsx`
- Test: `~/projects/raidr_extension/tests/offscreen/capturePipeline.test.ts`

**Interfaces:**
- Consumes: `AssembledRequest` (Task 6), `ContentStore` (Task 7), `redactRequest`/`createPseudonymizer` (Tasks 9–11)
- Produces:
  - `class CapturePipeline` with:
    - constructor `(store: ContentStore, salt: string)`
    - `ingest(assembled: AssembledRequest, responseBody: string | null): Promise<CapturedRequest>`
    - `redactionEntries(): RedactionEntry[]`
    - `rows(): CapturedRequest[]`

- [ ] **Step 1: Write the failing test**

```ts
// tests/offscreen/capturePipeline.test.ts
import { expect, test } from 'bun:test';
import 'fake-indexeddb/auto';
import { IdbContentStore } from '../../src/offscreen/store';
import { CapturePipeline } from '../../src/offscreen/capturePipeline';
import type { AssembledRequest } from '../../src/background/requestAssembler';

function pipeline() {
  return new CapturePipeline(
    new IdbContentStore(`raidr-pipe-${Math.random()}`, indexedDB),
    'test-salt'
  );
}

function assembled(overrides: Partial<AssembledRequest> = {}): AssembledRequest {
  return {
    id: 'r1',
    ts: 1756029600000,
    method: 'GET',
    url: 'https://example.com/api/me',
    resourceType: 'XHR',
    requestHeaders: {},
    requestBody: null,
    status: 200,
    responseHeaders: {},
    mimeType: 'application/json',
    fromCache: false,
    navigationId: 'nav1',
    ...overrides,
  };
}

test('stores the redacted body, never the raw one', async () => {
  const pipe = pipeline();
  const row = await pipe.ingest(assembled(), '{"access_token":"eyJa.b.c"}');

  const stored = await pipe.store.get(row.responseBodyHash!);
  const text = new TextDecoder().decode(stored!);
  expect(text).not.toContain('eyJa.b.c');
  expect(text).toContain('<JWT:');
});

test('redacts request headers', async () => {
  const pipe = pipeline();
  const row = await pipe.ingest(
    assembled({ requestHeaders: { authorization: 'Bearer abcdef123456' } }),
    '{}'
  );
  expect(row.requestHeaders.authorization).toMatch(/^<BEARER:/);
});

test('hashes identical redacted bodies to one stored blob', async () => {
  const pipe = pipeline();
  await pipe.ingest(assembled({ id: 'r1' }), '{"a":1}');
  await pipe.ingest(assembled({ id: 'r2' }), '{"a":1}');
  expect(await pipe.store.count()).toBe(1);
});

test('a null body yields a null hash rather than an empty blob', async () => {
  const pipe = pipeline();
  const row = await pipe.ingest(assembled(), null);
  expect(row.responseBodyHash).toBeNull();
  expect(await pipe.store.count()).toBe(0);
});

test('accumulates a redaction report across requests', async () => {
  const pipe = pipeline();
  await pipe.ingest(assembled({ id: 'r1' }), '{"access_token":"eyJa.b.c"}');
  await pipe.ingest(assembled({ id: 'r2' }), '{"access_token":"eyJa.b.c"}');

  const entries = pipe.redactionEntries();
  expect(entries).toHaveLength(1);
  expect(entries[0]!.kind).toBe('jwt');
  expect(entries[0]!.occurrences).toBe(2);
});

test('rows accumulate in capture order', async () => {
  const pipe = pipeline();
  await pipe.ingest(assembled({ id: 'r1' }), '{}');
  await pipe.ingest(assembled({ id: 'r2' }), '{}');
  expect(pipe.rows().map((r) => r.id)).toEqual(['r1', 'r2']);
});

test('JavaScript bodies reach the store byte-identical', async () => {
  const pipe = pipeline();
  const source = 'const t="abcdefghijklmnopqrstuvwxyz0123456789abcd";';
  const row = await pipe.ingest(
    assembled({ mimeType: 'application/javascript' }),
    source
  );
  const stored = await pipe.store.get(row.responseBodyHash!);
  expect(new TextDecoder().decode(stored!)).toBe(source);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/projects/raidr_extension && bun test tests/offscreen/capturePipeline.test.ts`
Expected: FAIL — cannot resolve `../../src/offscreen/capturePipeline`

- [ ] **Step 3: Write src/offscreen/capturePipeline.ts**

```ts
import {
  createPseudonymizer,
  redactRequest,
  type CapturedRequest,
  type RedactionEntry,
} from '@sudobility/raidr_processor';
import type { AssembledRequest } from '@/background/requestAssembler';
import type { ContentStore } from './store';

const encoder = new TextEncoder();

export class CapturePipeline {
  private readonly pseudonymizer: ReturnType<typeof createPseudonymizer>;
  private readonly captured: CapturedRequest[] = [];

  constructor(
    readonly store: ContentStore,
    salt: string
  ) {
    this.pseudonymizer = createPseudonymizer(salt);
  }

  async ingest(
    assembled: AssembledRequest,
    responseBody: string | null
  ): Promise<CapturedRequest> {
    const redacted = redactRequest(
      {
        requestHeaders: assembled.requestHeaders,
        responseHeaders: assembled.responseHeaders,
        mimeType: assembled.mimeType,
        requestBody: assembled.requestBody,
        responseBody,
      },
      this.pseudonymizer.pseudonym
    );

    const requestBodyHash =
      redacted.requestBody === null
        ? null
        : await this.store.put(encoder.encode(redacted.requestBody));
    const responseBodyHash =
      redacted.responseBody === null
        ? null
        : await this.store.put(encoder.encode(redacted.responseBody));

    const row: CapturedRequest = {
      id: assembled.id,
      ts: assembled.ts,
      method: assembled.method,
      url: assembled.url,
      resourceType: assembled.resourceType,
      requestHeaders: redacted.requestHeaders,
      requestBodyHash,
      status: assembled.status,
      responseHeaders: redacted.responseHeaders,
      responseBodyHash,
      mimeType: assembled.mimeType,
      fromCache: assembled.fromCache,
      navigationId: assembled.navigationId,
    };

    this.captured.push(row);
    return row;
  }

  redactionEntries(): RedactionEntry[] {
    return this.pseudonymizer.entries();
  }

  rows(): CapturedRequest[] {
    return this.captured;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ~/projects/raidr_extension && bun test tests/offscreen/capturePipeline.test.ts`
Expected: PASS, 7 tests

- [ ] **Step 5: Build the redaction review gate**

`src/sidepanel/components/RedactionReport.tsx`:

```tsx
import type { RedactionEntry } from '@sudobility/raidr_processor';

interface Props {
  entries: RedactionEntry[];
  acknowledged: boolean;
  onAcknowledge: () => void;
}

export function RedactionReport({ entries, acknowledged, onAcknowledge }: Props) {
  const byKind = new Map<string, number>();
  for (const entry of entries) {
    byKind.set(entry.kind, (byKind.get(entry.kind) ?? 0) + entry.occurrences);
  }

  return (
    <section className="border-t pt-3 mt-3">
      <h2 className="font-medium mb-2">Redaction report</h2>

      {entries.length === 0 ? (
        <p className="text-xs opacity-70">Nothing redacted yet.</p>
      ) : (
        <ul className="text-xs space-y-1">
          {Array.from(byKind.entries()).map(([kind, count]) => (
            <li key={kind} className="flex justify-between">
              <span>{kind}</span>
              <span className="tabular-nums opacity-70">{count}</span>
            </li>
          ))}
        </ul>
      )}

      <details className="mt-2 text-xs">
        <summary className="cursor-pointer opacity-70">
          Sample placeholders
        </summary>
        <ul className="mt-1 space-y-0.5 font-mono">
          {entries.slice(0, 10).map((entry) => (
            <li key={entry.placeholder}>{entry.placeholder}</li>
          ))}
        </ul>
      </details>

      <label className="flex items-center gap-2 mt-3 text-xs">
        <input
          type="checkbox"
          checked={acknowledged}
          onChange={onAcknowledge}
        />
        I have reviewed what will leave the browser
      </label>
    </section>
  );
}
```

- [ ] **Step 6: Gate export behind the review in SidePanel.tsx**

```tsx
import { useState } from 'react';
import type { RedactionEntry } from '@sudobility/raidr_processor';
import { RedactionReport } from './components/RedactionReport';

export function SidePanel() {
  const [entries] = useState<RedactionEntry[]>([]);
  const [acknowledged, setAcknowledged] = useState(false);

  return (
    <main className="p-4 text-sm">
      <h1 className="font-semibold">raidr</h1>

      <RedactionReport
        entries={entries}
        acknowledged={acknowledged}
        onAcknowledge={() => setAcknowledged((prev) => !prev)}
      />

      <button
        type="button"
        disabled={!acknowledged}
        onClick={() => chrome.runtime.sendMessage({ kind: 'export/start' })}
        className="mt-3 w-full rounded bg-black px-3 py-2 text-white disabled:opacity-40"
      >
        Export bundle
      </button>
    </main>
  );
}
```

- [ ] **Step 7: Verify the suite and build**

Run: `cd ~/projects/raidr_extension && bun test && bun run typecheck && bun run build`
Expected: PASS, 35 tests total; typecheck clean; build succeeds

- [ ] **Step 8: Commit**

```bash
cd ~/projects/raidr_extension
git add -A
git commit -m "feat: redaction pipeline and pre-export review gate"
```

---
# Milestone 4 — Introspection and the coverage meter

### Task 13: Endpoint path templates

**Files:**
- Create: `~/projects/raidr_processor/src/coverage/pathTemplate.ts`
- Modify: `~/projects/raidr_processor/src/index.ts`
- Test: `~/projects/raidr_processor/tests/coverage/pathTemplate.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `toPathTemplate(pathname: string): string`
  - `endpointKey(method: string, url: string): string`

- [ ] **Step 1: Write the failing test**

```ts
// tests/coverage/pathTemplate.test.ts
import { expect, test } from 'bun:test';
import { toPathTemplate, endpointKey } from '../../src/coverage/pathTemplate';

test('replaces numeric ids', () => {
  expect(toPathTemplate('/api/users/1138')).toBe('/api/users/{id}');
});

test('replaces uuids with a distinct marker', () => {
  expect(toPathTemplate('/api/users/550e8400-e29b-41d4-a716-446655440000')).toBe(
    '/api/users/{uuid}'
  );
});

test('replaces long hex and base64-ish segments', () => {
  expect(toPathTemplate('/files/a3f5c9e1b2d4a6f8c0e2b4d6a8f0c2e4')).toBe(
    '/files/{hash}'
  );
});

test('keeps ordinary words', () => {
  expect(toPathTemplate('/api/users/me')).toBe('/api/users/me');
  expect(toPathTemplate('/api/users/current-user')).toBe('/api/users/current-user');
});

test('keeps version segments that merely contain digits', () => {
  expect(toPathTemplate('/api/v2/orders/9/items')).toBe('/api/v2/orders/{id}/items');
});

test('handles root and trailing slashes', () => {
  expect(toPathTemplate('/')).toBe('/');
  expect(toPathTemplate('/api/users/')).toBe('/api/users/');
});

test('endpointKey combines method and templated path from a full URL', () => {
  expect(endpointKey('GET', 'https://example.com/api/users/1138?page=2')).toBe(
    'GET /api/users/{id}'
  );
});

test('endpointKey ignores query strings so pagination does not fragment counts', () => {
  expect(endpointKey('GET', 'https://example.com/api/users?page=1')).toBe(
    endpointKey('GET', 'https://example.com/api/users?page=99')
  );
});

test('endpointKey tolerates a malformed URL by returning it verbatim', () => {
  expect(endpointKey('GET', 'not a url')).toBe('GET not a url');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/projects/raidr_processor && bun test tests/coverage/pathTemplate.test.ts`
Expected: FAIL — cannot resolve `../../src/coverage/pathTemplate`

- [ ] **Step 3: Write src/coverage/pathTemplate.ts**

```ts
const NUMERIC_RE = /^\d+$/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH_RE = /^[0-9a-f]{16,}$/i;
const OPAQUE_RE = /^[A-Za-z0-9_-]{24,}$/;

function templateSegment(segment: string): string {
  if (segment === '') return segment;
  if (NUMERIC_RE.test(segment)) return '{id}';
  if (UUID_RE.test(segment)) return '{uuid}';
  if (HASH_RE.test(segment)) return '{hash}';
  if (OPAQUE_RE.test(segment)) return '{token}';
  return segment;
}

export function toPathTemplate(pathname: string): string {
  return pathname.split('/').map(templateSegment).join('/');
}

export function endpointKey(method: string, url: string): string {
  try {
    return `${method} ${toPathTemplate(new URL(url).pathname)}`;
  } catch {
    return `${method} ${url}`;
  }
}
```

- [ ] **Step 4: Export from src/index.ts**

```ts
export { toPathTemplate, endpointKey } from './coverage/pathTemplate';
```

- [ ] **Step 5: Run tests**

Run: `cd ~/projects/raidr_processor && bun test && bun run typecheck`
Expected: PASS, 9 new tests; typecheck clean

- [ ] **Step 6: Commit**

```bash
cd ~/projects/raidr_processor
git add -A
git commit -m "feat: endpoint path templating"
```

---

### Task 14: Coverage computation

**Files:**
- Create: `~/projects/raidr_processor/src/coverage/coverage.ts`
- Modify: `~/projects/raidr_processor/src/index.ts`
- Test: `~/projects/raidr_processor/tests/coverage/coverage.test.ts`

**Interfaces:**
- Consumes: `endpointKey` from Task 13
- Produces:
  - types `ChunkManifest`, `RouteRecord`, `CoverageInput`, `CoverageReport`
  - `computeCoverage(input: CoverageInput): CoverageReport`

- [ ] **Step 1: Write the failing test**

```ts
// tests/coverage/coverage.test.ts
import { expect, test } from 'bun:test';
import { computeCoverage } from '../../src/coverage/coverage';

const base = {
  chunks: { known: [] as string[], loaded: [] as string[] },
  routes: [] as Array<{ path: string; visited: boolean }>,
  requests: [] as Array<{ method: string; url: string; status: number | null }>,
};

test('reports chunk coverage and names what is missing', () => {
  const report = computeCoverage({
    ...base,
    chunks: { known: ['a.js', 'b.js', 'c.js', 'd.js'], loaded: ['a.js', 'b.js'] },
  });

  expect(report.chunks.known).toBe(4);
  expect(report.chunks.loaded).toBe(2);
  expect(report.chunks.pct).toBe(50);
  expect(report.chunks.missing).toEqual(['c.js', 'd.js']);
});

test('ignores loaded chunks absent from the manifest', () => {
  const report = computeCoverage({
    ...base,
    chunks: { known: ['a.js'], loaded: ['a.js', 'runtime.js'] },
  });
  expect(report.chunks.loaded).toBe(1);
  expect(report.chunks.pct).toBe(100);
});

test('reports route coverage and lists unvisited paths', () => {
  const report = computeCoverage({
    ...base,
    routes: [
      { path: '/', visited: true },
      { path: '/settings', visited: false },
      { path: '/admin', visited: false },
    ],
  });

  expect(report.routes.total).toBe(3);
  expect(report.routes.visited).toBe(1);
  expect(report.routes.pct).toBe(33);
  expect(report.routes.unvisited).toEqual(['/settings', '/admin']);
});

test('clusters requests into endpoints with call counts', () => {
  const report = computeCoverage({
    ...base,
    requests: [
      { method: 'GET', url: 'https://x.com/api/users/1', status: 200 },
      { method: 'GET', url: 'https://x.com/api/users/2', status: 200 },
      { method: 'POST', url: 'https://x.com/api/users', status: 201 },
    ],
  });

  expect(report.endpoints).toHaveLength(2);
  const byId = report.endpoints.find((e) => e.key === 'GET /api/users/{id}');
  expect(byId!.calls).toBe(2);
});

test('tracks distinct status codes per endpoint', () => {
  const report = computeCoverage({
    ...base,
    requests: [
      { method: 'GET', url: 'https://x.com/api/me', status: 200 },
      { method: 'GET', url: 'https://x.com/api/me', status: 401 },
    ],
  });
  expect(report.endpoints[0]!.statuses.sort()).toEqual([200, 401]);
});

test('endpoints are ordered by call count, descending', () => {
  const report = computeCoverage({
    ...base,
    requests: [
      { method: 'GET', url: 'https://x.com/api/a', status: 200 },
      { method: 'GET', url: 'https://x.com/api/b', status: 200 },
      { method: 'GET', url: 'https://x.com/api/b', status: 200 },
    ],
  });
  expect(report.endpoints[0]!.key).toBe('GET /api/b');
});

test('empty input yields 100 percent rather than a division by zero', () => {
  const report = computeCoverage(base);
  expect(report.chunks.pct).toBe(100);
  expect(report.routes.pct).toBe(100);
  expect(report.endpoints).toEqual([]);
});

test('complete is true only when chunks and routes are both fully covered', () => {
  expect(
    computeCoverage({
      ...base,
      chunks: { known: ['a.js'], loaded: ['a.js'] },
      routes: [{ path: '/', visited: true }],
    }).complete
  ).toBe(true);

  expect(
    computeCoverage({
      ...base,
      chunks: { known: ['a.js', 'b.js'], loaded: ['a.js'] },
      routes: [{ path: '/', visited: true }],
    }).complete
  ).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/projects/raidr_processor && bun test tests/coverage/coverage.test.ts`
Expected: FAIL — cannot resolve `../../src/coverage/coverage`

- [ ] **Step 3: Write src/coverage/coverage.ts**

```ts
import { endpointKey } from './pathTemplate';

export interface ChunkManifest {
  known: string[];
  loaded: string[];
}

export interface RouteRecord {
  path: string;
  visited: boolean;
}

export interface CoverageInput {
  chunks: ChunkManifest;
  routes: RouteRecord[];
  requests: Array<{ method: string; url: string; status: number | null }>;
}

export interface EndpointCoverage {
  key: string;
  calls: number;
  statuses: number[];
}

export interface CoverageReport {
  chunks: { known: number; loaded: number; pct: number; missing: string[] };
  routes: { total: number; visited: number; pct: number; unvisited: string[] };
  endpoints: EndpointCoverage[];
  complete: boolean;
}

/** An empty denominator means nothing is outstanding, so coverage is complete. */
function percent(part: number, total: number): number {
  return total === 0 ? 100 : Math.round((part / total) * 100);
}

export function computeCoverage(input: CoverageInput): CoverageReport {
  const loadedSet = new Set(input.chunks.loaded);
  const missing = input.chunks.known.filter((chunk) => !loadedSet.has(chunk));
  const loadedKnown = input.chunks.known.length - missing.length;

  const unvisited = input.routes
    .filter((route) => !route.visited)
    .map((route) => route.path);
  const visited = input.routes.length - unvisited.length;

  const endpoints = new Map<string, { calls: number; statuses: Set<number> }>();
  for (const request of input.requests) {
    const key = endpointKey(request.method, request.url);
    let entry = endpoints.get(key);
    if (!entry) {
      entry = { calls: 0, statuses: new Set<number>() };
      endpoints.set(key, entry);
    }
    entry.calls += 1;
    if (request.status !== null) entry.statuses.add(request.status);
  }

  return {
    chunks: {
      known: input.chunks.known.length,
      loaded: loadedKnown,
      pct: percent(loadedKnown, input.chunks.known.length),
      missing,
    },
    routes: {
      total: input.routes.length,
      visited,
      pct: percent(visited, input.routes.length),
      unvisited,
    },
    endpoints: Array.from(endpoints.entries())
      .map(([key, value]) => ({
        key,
        calls: value.calls,
        statuses: Array.from(value.statuses),
      }))
      .sort((a, b) => b.calls - a.calls),
    complete: missing.length === 0 && unvisited.length === 0,
  };
}
```

- [ ] **Step 4: Export from src/index.ts**

```ts
export { computeCoverage } from './coverage/coverage';
export type {
  ChunkManifest,
  RouteRecord,
  CoverageInput,
  CoverageReport,
  EndpointCoverage,
} from './coverage/coverage';
```

- [ ] **Step 5: Run tests and build the library**

Run: `cd ~/projects/raidr_processor && bun test && bun run typecheck && bun run build`
Expected: PASS, 8 new tests; typecheck clean; `dist/` emitted

- [ ] **Step 6: Commit**

```bash
cd ~/projects/raidr_processor
git add -A
git commit -m "feat: chunk, route, and endpoint coverage computation"
```

---

### Task 15: Page introspection probes

**Files:**
- Create: `~/projects/raidr_extension/src/introspect/probes.ts`
- Test: `~/projects/raidr_extension/tests/introspect/probes.test.ts`

**Interfaces:**
- Consumes: `StackFingerprint` from `@sudobility/raidr_processor` (type-only)
- Produces:
  - `detectFramework(): StackFingerprint`
  - `readRoutes(): string[]`
  - `readChunkManifest(): string[]`
  - `PROBE_SOURCES: { framework: string; routes: string; chunks: string }`

**Critical constraint:** each probe function is serialized with `.toString()` and
evaluated inside the page via `Runtime.evaluate`. It therefore must be entirely
self-contained — no imports, no module-scope constants, no closure references.
Type-only imports are fine because TypeScript erases them. The tests enforce
this by executing each probe source through `new Function`, which has no access
to module scope.

- [ ] **Step 1: Write the failing test**

```ts
// tests/introspect/probes.test.ts
import { expect, test, afterEach } from 'bun:test';
import { PROBE_SOURCES } from '../../src/introspect/probes';

const g = globalThis as Record<string, unknown>;

afterEach(() => {
  delete g.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  delete g.__VUE_DEVTOOLS_GLOBAL_HOOK__;
  delete g.__webpack_require__;
  delete g.__vite__mapDeps;
});

function run<T>(source: string): T {
  return new Function(`return (${source});`)() as T;
}

test('probe sources are self-contained and evaluate without module scope', () => {
  for (const source of Object.values(PROBE_SOURCES)) {
    expect(() => run(source)).not.toThrow();
  }
});

test('detects React and its version', () => {
  g.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    renderers: new Map([[1, { version: '18.3.1' }]]),
  };
  const result = run<{ framework: string; frameworkVersion: string | null }>(
    PROBE_SOURCES.framework
  );
  expect(result.framework).toBe('react');
  expect(result.frameworkVersion).toBe('18.3.1');
});

test('detects Vue and its version', () => {
  g.__VUE_DEVTOOLS_GLOBAL_HOOK__ = { Vue: { version: '3.4.21' } };
  const result = run<{ framework: string; frameworkVersion: string | null }>(
    PROBE_SOURCES.framework
  );
  expect(result.framework).toBe('vue');
  expect(result.frameworkVersion).toBe('3.4.21');
});

test('reports unknown when no framework is present', () => {
  const result = run<{ framework: string }>(PROBE_SOURCES.framework);
  expect(result.framework).toBe('unknown');
});

test('detects the webpack bundler', () => {
  g.__webpack_require__ = () => undefined;
  expect(run<{ bundler: string }>(PROBE_SOURCES.framework).bundler).toBe('webpack');
});

test('detects the vite bundler', () => {
  g.__vite__mapDeps = () => [];
  expect(run<{ bundler: string }>(PROBE_SOURCES.framework).bundler).toBe('vite');
});

test('reads the webpack chunk manifest from the url helper', () => {
  const u = (id: string) => `static/js/${id}.chunk.js`;
  // webpack embeds the id→name map inside the source of `u`.
  u.toString = () =>
    'function u(e){return"static/js/"+({12:"about",47:"admin"}[e])+".chunk.js"}';
  const webpackRequire = (() => undefined) as unknown as Record<string, unknown>;
  webpackRequire.u = u;
  g.__webpack_require__ = webpackRequire;

  const chunks = run<string[]>(PROBE_SOURCES.chunks);
  expect(chunks).toEqual([
    'static/js/12.chunk.js',
    'static/js/47.chunk.js',
  ]);
});

test('reads the vite chunk manifest from viteFileDeps', () => {
  const mapDeps = (() => []) as unknown as Record<string, unknown>;
  mapDeps.viteFileDeps = ['assets/About-a1b2.js', 'assets/Admin-c3d4.js'];
  g.__vite__mapDeps = mapDeps;

  expect(run<string[]>(PROBE_SOURCES.chunks)).toEqual([
    'assets/About-a1b2.js',
    'assets/Admin-c3d4.js',
  ]);
});

test('returns an empty chunk list when no bundler is detected', () => {
  expect(run<string[]>(PROBE_SOURCES.chunks)).toEqual([]);
});

test('reads Vue Router paths', () => {
  g.__VUE_DEVTOOLS_GLOBAL_HOOK__ = {
    apps: [
      {
        app: {
          config: {
            globalProperties: {
              $router: {
                getRoutes: () => [{ path: '/' }, { path: '/settings' }],
              },
            },
          },
        },
      },
    ],
  };
  expect(run<string[]>(PROBE_SOURCES.routes)).toEqual(['/', '/settings']);
});

test('returns an empty route list when no router is reachable', () => {
  expect(run<string[]>(PROBE_SOURCES.routes)).toEqual([]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/projects/raidr_extension && bun test tests/introspect/probes.test.ts`
Expected: FAIL — cannot resolve `../../src/introspect/probes`

- [ ] **Step 3: Write src/introspect/probes.ts**

```ts
import type { StackFingerprint } from '@sudobility/raidr_processor';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Every function below is serialized with `.toString()` and evaluated inside
 * the page. They must reference nothing outside their own body.
 */

export function detectFramework(): StackFingerprint {
  const g = globalThis as any;

  let framework: 'react' | 'vue' | 'unknown' = 'unknown';
  let frameworkVersion: string | null = null;

  const reactHook = g.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  const vueHook = g.__VUE_DEVTOOLS_GLOBAL_HOOK__;

  if (reactHook && reactHook.renderers && reactHook.renderers.size > 0) {
    framework = 'react';
    const renderers = Array.from(reactHook.renderers.values()) as any[];
    frameworkVersion = renderers[0]?.version ?? null;
  } else if (vueHook) {
    framework = 'vue';
    frameworkVersion = vueHook.Vue?.version ?? null;
  }

  let bundler: 'webpack' | 'vite' | 'unknown' = 'unknown';
  if (typeof g.__webpack_require__ !== 'undefined') bundler = 'webpack';
  else if (typeof g.__vite__mapDeps !== 'undefined') bundler = 'vite';

  const stateLibraries: string[] = [];
  if (g.__REDUX_DEVTOOLS_EXTENSION__ || g.__REDUX_DEVTOOLS_EXTENSION_COMPOSE__) {
    stateLibraries.push('redux');
  }
  if (vueHook && vueHook.Pinia) stateLibraries.push('pinia');

  return {
    framework,
    frameworkVersion,
    router: null,
    routerVersion: null,
    stateLibraries,
    bundler,
  };
}

export function readRoutes(): string[] {
  const g = globalThis as any;
  const paths: string[] = [];

  const vueHook = g.__VUE_DEVTOOLS_GLOBAL_HOOK__;
  const vueApp = vueHook?.apps?.[0]?.app;
  const vueRouter = vueApp?.config?.globalProperties?.$router;
  if (vueRouter && typeof vueRouter.getRoutes === 'function') {
    for (const route of vueRouter.getRoutes()) {
      if (route && typeof route.path === 'string') paths.push(route.path);
    }
    return paths;
  }

  // React Router's data router registers itself for its own devtools.
  const reactRouter = g.__reactRouterDataRouter ?? g.__staticRouterHydrationData;
  const routes = reactRouter?.routes;
  if (Array.isArray(routes)) {
    const walk = (nodes: any[], prefix: string): void => {
      for (const node of nodes) {
        const segment = typeof node.path === 'string' ? node.path : '';
        const full = segment.startsWith('/')
          ? segment
          : `${prefix}/${segment}`.replace(/\/+/g, '/');
        if (segment) paths.push(full);
        if (Array.isArray(node.children)) walk(node.children, full);
      }
    };
    walk(routes, '');
  }

  return paths;
}

export function readChunkManifest(): string[] {
  const g = globalThis as any;

  const viteMapDeps = g.__vite__mapDeps;
  if (viteMapDeps && Array.isArray(viteMapDeps.viteFileDeps)) {
    return viteMapDeps.viteFileDeps.slice();
  }

  const webpackRequire = g.__webpack_require__;
  const urlHelper = webpackRequire?.u;
  if (typeof urlHelper === 'function') {
    // webpack inlines the chunk id→name map into the body of `u`. Recovering
    // the ids from its source is the only way to enumerate chunks that have
    // not loaded yet.
    const source = String(urlHelper);
    const literal = source.match(/\{[^{}]*\}/);
    if (literal) {
      const ids = literal[0].match(/(^|[{,])\s*("?)([\w.-]+)\2\s*:/g) ?? [];
      const chunks: string[] = [];
      for (const raw of ids) {
        const id = raw.replace(/[{,:\s"]/g, '');
        if (!id) continue;
        try {
          chunks.push(String(urlHelper(id)));
        } catch {
          // A chunk id the helper cannot resolve is not a chunk we can fetch.
        }
      }
      return chunks;
    }
  }

  return [];
}

export const PROBE_SOURCES = {
  framework: `(${detectFramework.toString()})()`,
  routes: `(${readRoutes.toString()})()`,
  chunks: `(${readChunkManifest.toString()})()`,
};
```

- [ ] **Step 4: Run tests**

Run: `cd ~/projects/raidr_extension && bun test tests/introspect/probes.test.ts`
Expected: PASS, 11 tests

- [ ] **Step 5: Commit**

```bash
cd ~/projects/raidr_extension
git add -A
git commit -m "feat: self-contained page introspection probes"
```

---

### Task 16: Session wiring and the coverage meter

**Files:**
- Create: `~/projects/raidr_extension/src/background/cdpSession.ts`
- Create: `~/projects/raidr_extension/src/sidepanel/components/CoverageMeter.tsx`
- Modify: `~/projects/raidr_extension/src/background/index.ts`
- Modify: `~/projects/raidr_extension/src/sidepanel/SidePanel.tsx`
- Modify: `~/projects/raidr_extension/src/shared/messages.ts`
- Test: `~/projects/raidr_extension/tests/background/cdpSession.test.ts`

**Interfaces:**
- Consumes: `ChromeAdapter` (Task 5), `RequestAssembler` (Task 6), `PROBE_SOURCES` (Task 15), `computeCoverage` (Task 14)
- Produces:
  - `class CdpSession` with:
    - constructor `(adapter: ChromeAdapter, sink: CaptureSink)`
    - `start(tabId: number): Promise<void>`
    - `stop(): Promise<void>`
  - `interface CaptureSink` with `onRequest`, `onGap`, `onRuntime`

- [ ] **Step 1: Write the failing test**

```ts
// tests/background/cdpSession.test.ts
import { expect, test } from 'bun:test';
import { FakeChromeAdapter } from '../support/FakeChromeAdapter';
import { CdpSession, type CaptureSink } from '../../src/background/cdpSession';
import type { Gap } from '@sudobility/raidr_processor';

function collectingSink() {
  const requests: Array<{ url: string; body: string | null }> = [];
  const gaps: Gap[] = [];
  const sink: CaptureSink = {
    onRequest: async (assembled, body) => {
      requests.push({ url: assembled.url, body });
    },
    onGap: async (gap) => {
      gaps.push(gap);
    },
    onRuntime: async () => {},
  };
  return { sink, requests, gaps };
}

test('enables the CDP domains capture depends on', async () => {
  const fake = new FakeChromeAdapter();
  const { sink } = collectingSink();
  await new CdpSession(fake, sink).start(1);

  const methods = fake.commands.map((c) => c.method);
  expect(methods).toContain('Network.enable');
  expect(methods).toContain('Page.enable');
  expect(methods).toContain('Debugger.enable');
  expect(methods).toContain('Runtime.enable');
});

test('raises the network buffer so large bundles are not evicted', async () => {
  const fake = new FakeChromeAdapter();
  const { sink } = collectingSink();
  await new CdpSession(fake, sink).start(1);

  const enable = fake.commands.find((c) => c.method === 'Network.enable');
  expect(Number(enable!.params.maxResourceBufferSize)).toBeGreaterThanOrEqual(
    100 * 1024 * 1024
  );
  expect(Number(enable!.params.maxTotalBufferSize)).toBeGreaterThanOrEqual(
    500 * 1024 * 1024
  );
});

test('fetches the response body only once loading has finished', async () => {
  const fake = new FakeChromeAdapter();
  fake.respondWith('Network.getResponseBody', () => ({
    body: '{"ok":true}',
    base64Encoded: false,
  }));
  const { sink, requests } = collectingSink();
  const session = new CdpSession(fake, sink);
  await session.start(1);

  fake.emit(1, 'Network.requestWillBeSent', {
    requestId: 'r1',
    wallTime: 1756029600,
    request: { url: 'https://x.com/api/me', method: 'GET', headers: {} },
    type: 'XHR',
  });
  expect(
    fake.commands.some((c) => c.method === 'Network.getResponseBody')
  ).toBe(false);

  fake.emit(1, 'Network.responseReceived', {
    requestId: 'r1',
    response: { status: 200, headers: {}, mimeType: 'application/json' },
  });
  fake.emit(1, 'Network.loadingFinished', { requestId: 'r1' });
  await Bun.sleep(0);

  expect(requests).toHaveLength(1);
  expect(requests[0]!.body).toBe('{"ok":true}');
});

test('decodes base64 response bodies', async () => {
  const fake = new FakeChromeAdapter();
  fake.respondWith('Network.getResponseBody', () => ({
    body: btoa('binary-ish'),
    base64Encoded: true,
  }));
  const { sink, requests } = collectingSink();
  await new CdpSession(fake, sink).start(1);

  fake.emit(1, 'Network.requestWillBeSent', {
    requestId: 'r1',
    wallTime: 1756029600,
    request: { url: 'https://x.com/a.png', method: 'GET', headers: {} },
    type: 'Image',
  });
  fake.emit(1, 'Network.responseReceived', {
    requestId: 'r1',
    response: { status: 200, headers: {}, mimeType: 'image/png' },
  });
  fake.emit(1, 'Network.loadingFinished', { requestId: 'r1' });
  await Bun.sleep(0);

  expect(requests[0]!.body).toBe('binary-ish');
});

test('an evicted body becomes a gap rather than a dropped request', async () => {
  const fake = new FakeChromeAdapter();
  fake.respondWith('Network.getResponseBody', () => {
    throw new Error('No resource with given identifier found');
  });
  const { sink, gaps, requests } = collectingSink();
  await new CdpSession(fake, sink).start(1);

  fake.emit(1, 'Network.requestWillBeSent', {
    requestId: 'r1',
    wallTime: 1756029600,
    request: { url: 'https://x.com/chunk-47.js', method: 'GET', headers: {} },
    type: 'Script',
  });
  fake.emit(1, 'Network.responseReceived', {
    requestId: 'r1',
    response: { status: 200, headers: {}, mimeType: 'application/javascript' },
  });
  fake.emit(1, 'Network.loadingFinished', { requestId: 'r1' });
  await Bun.sleep(0);

  expect(gaps).toHaveLength(1);
  expect(gaps[0]!.reason).toBe('body-evicted');
  expect(gaps[0]!.url).toBe('https://x.com/chunk-47.js');
  // The request itself is still recorded — only its body is missing.
  expect(requests).toHaveLength(1);
  expect(requests[0]!.body).toBeNull();
});

test('a failed load is recorded as a gap', async () => {
  const fake = new FakeChromeAdapter();
  const { sink, gaps } = collectingSink();
  await new CdpSession(fake, sink).start(1);

  fake.emit(1, 'Network.requestWillBeSent', {
    requestId: 'r1',
    wallTime: 1756029600,
    request: { url: 'https://x.com/blocked.js', method: 'GET', headers: {} },
    type: 'Script',
  });
  fake.emit(1, 'Network.loadingFailed', {
    requestId: 'r1',
    errorText: 'net::ERR_BLOCKED_BY_CLIENT',
    canceled: false,
  });
  await Bun.sleep(0);

  expect(gaps[0]!.detail).toBe('net::ERR_BLOCKED_BY_CLIENT');
});

test('runs the introspection probes after a navigation completes', async () => {
  const fake = new FakeChromeAdapter();
  fake.respondWith('Runtime.evaluate', () => ({
    result: { value: [] },
  }));
  const { sink } = collectingSink();
  await new CdpSession(fake, sink).start(1);

  fake.emit(1, 'Page.loadEventFired', {});
  await Bun.sleep(0);

  const evaluations = fake.commands.filter((c) => c.method === 'Runtime.evaluate');
  expect(evaluations.length).toBeGreaterThanOrEqual(3);
  expect(evaluations.every((c) => c.params.returnByValue === true)).toBe(true);
});

test('detaching stops the debugger cleanly', async () => {
  const fake = new FakeChromeAdapter();
  const { sink } = collectingSink();
  const session = new CdpSession(fake, sink);
  await session.start(1);
  expect(fake.attached).toContain(1);

  await session.stop();
  expect(fake.attached).not.toContain(1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/projects/raidr_extension && bun test tests/background/cdpSession.test.ts`
Expected: FAIL — cannot resolve `../../src/background/cdpSession`

- [ ] **Step 3: Write src/background/cdpSession.ts**

```ts
import type { Gap, StackFingerprint } from '@sudobility/raidr_processor';
import type { ChromeAdapter } from '@/adapters/ChromeAdapter';
import { RequestAssembler, type AssembledRequest } from './requestAssembler';
import { PROBE_SOURCES } from '@/introspect/probes';

const MAX_RESOURCE_BUFFER = 100 * 1024 * 1024;
const MAX_TOTAL_BUFFER = 500 * 1024 * 1024;

export interface RuntimeSnapshot {
  framework: StackFingerprint | null;
  routes: string[];
  chunks: string[];
}

export interface CaptureSink {
  onRequest(
    assembled: AssembledRequest,
    responseBody: string | null
  ): Promise<void>;
  onGap(gap: Gap): Promise<void>;
  onRuntime(snapshot: RuntimeSnapshot): Promise<void>;
}

function decodeBody(result: unknown): string | null {
  if (typeof result !== 'object' || result === null) return null;
  const { body, base64Encoded } = result as {
    body?: unknown;
    base64Encoded?: unknown;
  };
  if (typeof body !== 'string') return null;
  return base64Encoded === true ? atob(body) : body;
}

export class CdpSession {
  private assembler = new RequestAssembler();
  private tabId: number | null = null;
  private navigationCounter = 0;

  constructor(
    private readonly adapter: ChromeAdapter,
    private readonly sink: CaptureSink
  ) {}

  async start(tabId: number): Promise<void> {
    this.tabId = tabId;
    await this.adapter.attach(tabId);

    this.adapter.onEvent((eventTabId, method, params) => {
      if (eventTabId !== this.tabId) return;
      void this.handle(method, params);
    });

    await this.adapter.sendCommand(tabId, 'Network.enable', {
      maxResourceBufferSize: MAX_RESOURCE_BUFFER,
      maxTotalBufferSize: MAX_TOTAL_BUFFER,
    });
    await this.adapter.sendCommand(tabId, 'Page.enable');
    await this.adapter.sendCommand(tabId, 'Debugger.enable');
    await this.adapter.sendCommand(tabId, 'Runtime.enable');
  }

  async stop(): Promise<void> {
    if (this.tabId === null) return;
    await this.adapter.detach(this.tabId);
    this.tabId = null;
  }

  private async handle(
    method: string,
    params: Record<string, unknown>
  ): Promise<void> {
    switch (method) {
      case 'Network.requestWillBeSent':
        this.assembler.onRequestWillBeSent(params);
        return;

      case 'Network.responseReceived':
        this.assembler.onResponseReceived(params);
        return;

      case 'Network.loadingFinished':
        await this.finish(String(params.requestId ?? ''));
        return;

      case 'Network.loadingFailed': {
        const gap = this.assembler.onLoadingFailed(
          String(params.requestId ?? ''),
          String(params.errorText ?? 'unknown'),
          params.canceled === true
        );
        if (gap) await this.sink.onGap(gap);
        return;
      }

      case 'Page.loadEventFired':
      case 'Page.navigatedWithinDocument':
        this.navigationCounter += 1;
        this.assembler.setNavigationId(`nav${this.navigationCounter}`);
        await this.introspect();
        return;

      default:
        return;
    }
  }

  private async finish(requestId: string): Promise<void> {
    const assembled = this.assembler.onLoadingFinished(requestId);
    if (!assembled || this.tabId === null) return;

    let body: string | null = null;
    try {
      const result = await this.adapter.sendCommand(
        this.tabId,
        'Network.getResponseBody',
        { requestId }
      );
      body = decodeBody(result);
    } catch (error) {
      // The body was evicted from Chrome's buffer before we asked for it. The
      // request is still recorded; the missing body becomes an explicit gap so
      // reconstruction never silently invents it.
      await this.sink.onGap({
        requestId,
        url: assembled.url,
        reason: 'body-evicted',
        ts: assembled.ts,
        detail: error instanceof Error ? error.message : String(error),
      });
    }

    await this.sink.onRequest(assembled, body);
  }

  private async introspect(): Promise<void> {
    if (this.tabId === null) return;

    const evaluate = async <T>(expression: string, fallback: T): Promise<T> => {
      try {
        const result = (await this.adapter.sendCommand(
          this.tabId!,
          'Runtime.evaluate',
          { expression, returnByValue: true }
        )) as { result?: { value?: T } } | undefined;
        return result?.result?.value ?? fallback;
      } catch {
        return fallback;
      }
    };

    const [framework, routes, chunks] = await Promise.all([
      evaluate<StackFingerprint | null>(PROBE_SOURCES.framework, null),
      evaluate<string[]>(PROBE_SOURCES.routes, []),
      evaluate<string[]>(PROBE_SOURCES.chunks, []),
    ]);

    await this.sink.onRuntime({ framework, routes, chunks });
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ~/projects/raidr_extension && bun test tests/background/cdpSession.test.ts`
Expected: PASS, 8 tests

- [ ] **Step 5: Build the coverage meter component**

`src/sidepanel/components/CoverageMeter.tsx`:

```tsx
import type { CoverageReport } from '@sudobility/raidr_processor';

interface Props {
  report: CoverageReport;
}

function Track({
  label,
  pct,
  detail,
}: {
  label: string;
  pct: number;
  detail: string;
}) {
  return (
    <div className="mb-3">
      <div className="flex justify-between text-xs mb-1">
        <span>{label}</span>
        <span className="tabular-nums opacity-70">{detail}</span>
      </div>
      <div className="h-1.5 rounded bg-neutral-200">
        <div
          className="h-1.5 rounded bg-black transition-all"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

export function CoverageMeter({ report }: Props) {
  return (
    <section>
      <Track
        label="Chunks"
        pct={report.chunks.pct}
        detail={`${report.chunks.loaded} / ${report.chunks.known}`}
      />
      <Track
        label="Routes"
        pct={report.routes.pct}
        detail={`${report.routes.visited} / ${report.routes.total}`}
      />

      {report.chunks.missing.length > 0 && (
        <details className="text-xs mb-2">
          <summary className="cursor-pointer opacity-70">
            {report.chunks.missing.length} chunks not loaded
          </summary>
          <ul className="mt-1 font-mono space-y-0.5">
            {report.chunks.missing.map((chunk) => (
              <li key={chunk} className="truncate">{chunk}</li>
            ))}
          </ul>
        </details>
      )}

      {report.routes.unvisited.length > 0 && (
        <details className="text-xs mb-2">
          <summary className="cursor-pointer opacity-70">
            {report.routes.unvisited.length} routes not visited
          </summary>
          <ul className="mt-1 font-mono space-y-0.5">
            {report.routes.unvisited.map((route) => (
              <li key={route} className="truncate">{route}</li>
            ))}
          </ul>
        </details>
      )}

      <details className="text-xs">
        <summary className="cursor-pointer opacity-70">
          {report.endpoints.length} endpoints observed
        </summary>
        <ul className="mt-1 space-y-0.5">
          {report.endpoints.map((endpoint) => (
            <li key={endpoint.key} className="flex justify-between gap-2">
              <span className="font-mono truncate">{endpoint.key}</span>
              <span className="tabular-nums opacity-70">{endpoint.calls}</span>
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}
```

- [ ] **Step 6: Add the coverage message and wire the panel**

Add to the `RaidrMessage` union and `KINDS` set in `src/shared/messages.ts`:

```ts
  | { kind: 'session/coverage'; report: import('@sudobility/raidr_processor').CoverageReport }
```

and add `'session/coverage'` to the `KINDS` set.

Replace `src/sidepanel/SidePanel.tsx`:

```tsx
import { useEffect, useState } from 'react';
import type { CoverageReport, RedactionEntry } from '@sudobility/raidr_processor';
import { isRaidrMessage } from '@/shared/messages';
import { CoverageMeter } from './components/CoverageMeter';
import { RedactionReport } from './components/RedactionReport';

const EMPTY_REPORT: CoverageReport = {
  chunks: { known: 0, loaded: 0, pct: 100, missing: [] },
  routes: { total: 0, visited: 0, pct: 100, unvisited: [] },
  endpoints: [],
  complete: true,
};

export function SidePanel() {
  const [capturing, setCapturing] = useState(false);
  const [report, setReport] = useState<CoverageReport>(EMPTY_REPORT);
  const [entries, setEntries] = useState<RedactionEntry[]>([]);
  const [acknowledged, setAcknowledged] = useState(false);

  useEffect(() => {
    const listener = (message: unknown) => {
      if (!isRaidrMessage(message)) return;
      if (message.kind === 'session/coverage') setReport(message.report);
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, []);

  const toggle = async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;

    if (capturing) {
      await chrome.runtime.sendMessage({ kind: 'session/stop' });
    } else {
      await chrome.runtime.sendMessage({ kind: 'session/start', tabId: tab.id });
    }
    setCapturing((prev) => !prev);
  };

  return (
    <main className="p-4 text-sm">
      <div className="flex items-center justify-between mb-4">
        <h1 className="font-semibold">raidr</h1>
        <button
          type="button"
          onClick={() => void toggle()}
          className="rounded border px-3 py-1 text-xs"
        >
          {capturing ? 'Stop' : 'Start capture'}
        </button>
      </div>

      <CoverageMeter report={report} />

      <RedactionReport
        entries={entries}
        acknowledged={acknowledged}
        onAcknowledge={() => setAcknowledged((prev) => !prev)}
      />

      <button
        type="button"
        disabled={!acknowledged}
        onClick={() => void chrome.runtime.sendMessage({ kind: 'export/start' })}
        className="mt-3 w-full rounded bg-black px-3 py-2 text-white disabled:opacity-40"
      >
        Export bundle
      </button>
    </main>
  );
}
```

Note: `entries` stays empty until Task 17, which adds the `session/redaction`
message and the offscreen broadcast that fills it. That is deliberate — this
task ends with a panel that renders both components correctly against live
coverage data, and Task 17 closes the redaction half of the loop.

- [ ] **Step 7: Wire the session into the service worker**

In `src/background/index.ts`, add above the existing message listener:

```ts
import { LiveChromeAdapter } from '@/adapters/ChromeAdapter';
import { CdpSession } from './cdpSession';

let session: CdpSession | null = null;

async function startSession(tabId: number): Promise<void> {
  await ensureOffscreen();
  session = new CdpSession(new LiveChromeAdapter(), {
    onRequest: async (assembled, body) => {
      await chrome.runtime.sendMessage({
        kind: 'capture/request',
        row: { assembled, body },
      });
    },
    onGap: async (gap) => {
      await chrome.runtime.sendMessage({ kind: 'capture/gap', gap });
    },
    onRuntime: async (snapshot) => {
      await chrome.runtime.sendMessage({
        kind: 'capture/runtime',
        snapshot,
      });
    },
  });
  await session.start(tabId);
}
```

and extend the message listener:

```ts
  if (message.kind === 'session/start') void startSession(message.tabId);
  if (message.kind === 'session/stop') void session?.stop();
```

Add `'capture/runtime'` to the `RaidrMessage` union and `KINDS` set.

- [ ] **Step 8: Verify the whole suite and build**

Run:
```bash
cd ~/projects/raidr_processor && bun test && bun run build
cd ~/projects/raidr_extension && bun test && bun run typecheck && bun run build
```
Expected: all tests PASS; typecheck clean; build succeeds

- [ ] **Step 9: End-to-end manual verification**

1. Reload the unpacked extension at `chrome://extensions`.
2. Open any React or Vue app in a tab and open the raidr side panel.
3. Click **Start capture**. Confirm Chrome shows the "being debugged" banner.
4. Navigate through several routes in the app.
5. Confirm the coverage meter advances — chunk and route counts rise, endpoints appear.
6. Tick the redaction acknowledgement and click **Export bundle**.
7. Unzip the download and verify:
   - `raidr.json` has `formatVersion: 1` and a non-null `stack.framework`
   - `network/requests.jsonl` has one line per request
   - `content/` holds the JS bundles, byte-identical to what the site served
   - `redaction.json` lists placeholders and contains no real tokens
   - `gaps.json` exists (possibly empty)

```bash
cd ~/Downloads && unzip -o raidr-*.zip -d raidr-check && jq . raidr-check/raidr.json
grep -c '' raidr-check/network/requests.jsonl
```

- [ ] **Step 10: Commit**

```bash
cd ~/projects/raidr_extension
git add -A
git commit -m "feat: CDP session wiring and live coverage meter"
```

---

### Task 17: Offscreen session lifecycle

Tasks 8, 12, and 16 each built one edge of the capture loop. This task closes
it: the offscreen document creates the manifest, ingests capture messages
through `CapturePipeline`, recomputes coverage, and broadcasts state to the
panel. Without it the panel's meter never moves and `session.manifest` stays
null, so export refuses.

**Files:**
- Create: `~/projects/raidr_extension/src/offscreen/sessionState.ts`
- Modify: `~/projects/raidr_extension/src/offscreen/index.ts`
- Modify: `~/projects/raidr_extension/src/shared/messages.ts`
- Test: `~/projects/raidr_extension/tests/offscreen/sessionState.test.ts`

**Interfaces:**
- Consumes: `CapturePipeline` (Task 12), `computeCoverage` (Task 14), `createManifest` (Task 3), `RuntimeSnapshot` (Task 16)
- Produces:
  - `class SessionState` with:
    - constructor `(store: ContentStore, salt: string)`
    - `begin(origin: string, startedAt: string, sessionId: string): void`
    - `ingestRequest(assembled: AssembledRequest, body: string | null): Promise<void>`
    - `ingestGap(gap: Gap): void`
    - `ingestRuntime(snapshot: RuntimeSnapshot): void`
    - `coverage(): CoverageReport`
    - `redaction(): RedactionEntry[]`
    - `manifest(): RaidrManifest | null`
    - `bundleInput(): BundleInput`

- [ ] **Step 1: Write the failing test**

```ts
// tests/offscreen/sessionState.test.ts
import { expect, test } from 'bun:test';
import 'fake-indexeddb/auto';
import { IdbContentStore } from '../../src/offscreen/store';
import { SessionState } from '../../src/offscreen/sessionState';
import type { AssembledRequest } from '../../src/background/requestAssembler';

function session() {
  const state = new SessionState(
    new IdbContentStore(`raidr-session-${Math.random()}`, indexedDB),
    'salt'
  );
  state.begin('https://example.com', '2026-08-24T10:00:00.000Z', 's1');
  return state;
}

function assembled(url: string, id = 'r1'): AssembledRequest {
  return {
    id,
    ts: 1756029600000,
    method: 'GET',
    url,
    resourceType: 'XHR',
    requestHeaders: {},
    requestBody: null,
    status: 200,
    responseHeaders: {},
    mimeType: 'application/json',
    fromCache: false,
    navigationId: 'nav1',
  };
}

test('begin creates a manifest', () => {
  const state = session();
  expect(state.manifest()!.origin).toBe('https://example.com');
  expect(state.manifest()!.formatVersion).toBe(1);
});

test('manifest is null before begin', () => {
  const state = new SessionState(
    new IdbContentStore(`raidr-none-${Math.random()}`, indexedDB),
    'salt'
  );
  expect(state.manifest()).toBeNull();
});

test('ingested requests appear in endpoint coverage', async () => {
  const state = session();
  await state.ingestRequest(assembled('https://example.com/api/users/1'), '{}');
  await state.ingestRequest(assembled('https://example.com/api/users/2', 'r2'), '{}');

  const report = state.coverage();
  expect(report.endpoints).toHaveLength(1);
  expect(report.endpoints[0]!.key).toBe('GET /api/users/{id}');
  expect(report.endpoints[0]!.calls).toBe(2);
});

test('runtime snapshots feed chunk and route coverage', async () => {
  const state = session();
  state.ingestRuntime({
    framework: {
      framework: 'react',
      frameworkVersion: '18.3.1',
      router: null,
      routerVersion: null,
      stateLibraries: [],
      bundler: 'vite',
    },
    routes: ['/', '/settings'],
    chunks: ['a.js', 'b.js'],
  });

  const report = state.coverage();
  expect(report.chunks.known).toBe(2);
  expect(report.routes.total).toBe(2);
  expect(state.manifest()!.stack!.framework).toBe('react');
});

test('a chunk becomes loaded once a request for it is captured', async () => {
  const state = session();
  state.ingestRuntime({
    framework: null,
    routes: [],
    chunks: ['assets/About-a1b2.js', 'assets/Admin-c3d4.js'],
  });
  await state.ingestRequest(
    assembled('https://example.com/assets/About-a1b2.js'),
    'code'
  );

  const report = state.coverage();
  expect(report.chunks.loaded).toBe(1);
  expect(report.chunks.missing).toEqual(['assets/Admin-c3d4.js']);
});

test('a route becomes visited once a navigation reports it', async () => {
  const state = session();
  state.ingestRuntime({ framework: null, routes: ['/', '/settings'], chunks: [] });
  await state.ingestRequest(assembled('https://example.com/settings'), '{}');
  state.markVisited('/settings');

  const report = state.coverage();
  expect(report.routes.visited).toBe(1);
  expect(report.routes.unvisited).toEqual(['/']);
});

test('gaps accumulate and are counted in the manifest', async () => {
  const state = session();
  state.ingestGap({
    requestId: 'r9',
    url: 'https://example.com/chunk-47.js',
    reason: 'body-evicted',
    ts: 1756029601000,
    detail: 'evicted',
  });
  expect(state.bundleInput().gaps).toHaveLength(1);
  expect(state.manifest()!.counts.gaps).toBe(1);
});

test('manifest counts track captured requests and bodies', async () => {
  const state = session();
  await state.ingestRequest(assembled('https://example.com/api/a'), '{"a":1}');
  await state.ingestRequest(assembled('https://example.com/api/b', 'r2'), '{"b":2}');

  expect(state.manifest()!.counts.requests).toBe(2);
  expect(state.manifest()!.counts.bodies).toBe(2);
});

test('redaction entries surface through the session', async () => {
  const state = session();
  await state.ingestRequest(
    assembled('https://example.com/api/login'),
    '{"access_token":"eyJa.b.c"}'
  );
  expect(state.redaction()[0]!.kind).toBe('jwt');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/projects/raidr_extension && bun test tests/offscreen/sessionState.test.ts`
Expected: FAIL — cannot resolve `../../src/offscreen/sessionState`

- [ ] **Step 3: Write src/offscreen/sessionState.ts**

```ts
import {
  computeCoverage,
  createManifest,
  type CapturedFrame,
  type CapturedRequest,
  type CoverageReport,
  type Gap,
  type RedactionEntry,
  type StackFingerprint,
  type RaidrManifest,
} from '@sudobility/raidr_processor';
import type { AssembledRequest } from '@/background/requestAssembler';
import type { RuntimeSnapshot } from '@/background/cdpSession';
import { CapturePipeline } from './capturePipeline';
import type { ContentStore } from './store';
import type { BundleInput } from './exporter';

export class SessionState {
  private pipeline: CapturePipeline;
  private currentManifest: RaidrManifest | null = null;
  private gaps: Gap[] = [];
  private frames: CapturedFrame[] = [];
  private knownChunks = new Set<string>();
  private knownRoutes = new Set<string>();
  private visitedRoutes = new Set<string>();
  private framework: StackFingerprint | null = null;

  constructor(
    private readonly store: ContentStore,
    salt: string
  ) {
    this.pipeline = new CapturePipeline(store, salt);
  }

  begin(origin: string, startedAt: string, sessionId: string): void {
    this.currentManifest = createManifest({ sessionId, origin, startedAt });
  }

  async ingestRequest(
    assembled: AssembledRequest,
    body: string | null
  ): Promise<void> {
    await this.pipeline.ingest(assembled, body);
    this.refreshCounts();
  }

  ingestGap(gap: Gap): void {
    this.gaps.push(gap);
    this.refreshCounts();
  }

  ingestRuntime(snapshot: RuntimeSnapshot): void {
    for (const chunk of snapshot.chunks) this.knownChunks.add(chunk);
    for (const route of snapshot.routes) this.knownRoutes.add(route);
    if (snapshot.framework) {
      this.framework = snapshot.framework;
      if (this.currentManifest) this.currentManifest.stack = snapshot.framework;
    }
  }

  markVisited(path: string): void {
    this.visitedRoutes.add(path);
  }

  /**
   * A known chunk counts as loaded when some captured request URL ends with
   * its manifest path. Manifest entries are build-relative (`assets/x.js`)
   * while requests are absolute, so suffix matching is the join.
   */
  private loadedChunks(): string[] {
    const urls = this.pipeline.rows().map((row) => row.url);
    return Array.from(this.knownChunks).filter((chunk) =>
      urls.some((url) => url.endsWith(chunk))
    );
  }

  private refreshCounts(): void {
    if (!this.currentManifest) return;
    const rows = this.pipeline.rows();
    const bodies = new Set<string>();
    for (const row of rows) {
      if (row.responseBodyHash) bodies.add(row.responseBodyHash);
      if (row.requestBodyHash) bodies.add(row.requestBodyHash);
    }
    this.currentManifest.counts = {
      requests: rows.length,
      frames: this.frames.length,
      bodies: bodies.size,
      gaps: this.gaps.length,
    };
  }

  coverage(): CoverageReport {
    return computeCoverage({
      chunks: {
        known: Array.from(this.knownChunks),
        loaded: this.loadedChunks(),
      },
      routes: Array.from(this.knownRoutes).map((path) => ({
        path,
        visited: this.visitedRoutes.has(path),
      })),
      requests: this.pipeline.rows().map((row) => ({
        method: row.method,
        url: row.url,
        status: row.status,
      })),
    });
  }

  redaction(): RedactionEntry[] {
    return this.pipeline.redactionEntries();
  }

  manifest(): RaidrManifest | null {
    return this.currentManifest;
  }

  rows(): CapturedRequest[] {
    return this.pipeline.rows();
  }

  bundleInput(): BundleInput {
    if (!this.currentManifest) throw new Error('session not started');
    return {
      store: this.store,
      manifest: this.currentManifest,
      requests: this.pipeline.rows(),
      frames: this.frames,
      gaps: this.gaps,
      redaction: this.redaction(),
      runtime: {
        framework: this.framework,
        routes: Array.from(this.knownRoutes),
        stores: this.framework?.stateLibraries ?? [],
        chunks: {
          known: Array.from(this.knownChunks),
          loaded: this.loadedChunks(),
        },
        coverage: this.coverage(),
      },
    };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ~/projects/raidr_extension && bun test tests/offscreen/sessionState.test.ts`
Expected: PASS, 9 tests

- [ ] **Step 5: Add the remaining message kinds**

In `src/shared/messages.ts`, add to the union and to `KINDS`:

```ts
  | { kind: 'session/redaction'; entries: import('@sudobility/raidr_processor').RedactionEntry[] }
  | { kind: 'capture/runtime'; snapshot: import('@/background/cdpSession').RuntimeSnapshot }
```

Add `'session/redaction'` and `'capture/runtime'` to the `KINDS` set.

- [ ] **Step 6: Replace src/offscreen/index.ts with the wired version**

```ts
import { isRaidrMessage } from '@/shared/messages';
import { IdbContentStore } from './store';
import { SessionState } from './sessionState';
import { buildBundleFiles, zipBundle, bundleFilename } from './exporter';

const store = new IdbContentStore('raidr-capture', indexedDB);

// The salt is generated per session and deliberately never persisted or
// exported: it is what keeps short pseudonym hashes from being brute-forced
// back to the original credentials.
const salt = crypto.randomUUID();
const state = new SessionState(store, salt);

function broadcast(): void {
  void chrome.runtime.sendMessage({
    kind: 'session/coverage',
    report: state.coverage(),
  });
  void chrome.runtime.sendMessage({
    kind: 'session/redaction',
    entries: state.redaction(),
  });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!isRaidrMessage(message)) return;

  switch (message.kind) {
    case 'session/start':
      state.begin(
        'https://unknown.invalid',
        new Date().toISOString(),
        crypto.randomUUID()
      );
      broadcast();
      return;

    case 'capture/request': {
      const { assembled, body } = message.row as {
        assembled: Parameters<SessionState['ingestRequest']>[0];
        body: string | null;
      };
      void state.ingestRequest(assembled, body).then(broadcast);
      return;
    }

    case 'capture/gap':
      state.ingestGap(message.gap);
      broadcast();
      return;

    case 'capture/runtime':
      state.ingestRuntime(message.snapshot);
      broadcast();
      return;

    case 'export/start':
      void (async () => {
        const manifest = state.manifest();
        if (!manifest) {
          sendResponse({ ok: false, error: 'no active session' });
          return;
        }
        manifest.endedAt = new Date().toISOString();
        const files = await buildBundleFiles(state.bundleInput());
        const zipped = await zipBundle(files);
        const blobUrl = URL.createObjectURL(
          new Blob([zipped], { type: 'application/zip' })
        );
        void chrome.runtime.sendMessage({
          kind: 'export/ready',
          blobUrl,
          filename: bundleFilename(manifest.origin, manifest.startedAt),
        });
        sendResponse({ ok: true });
      })();
      return true; // keep the message channel open for the async response

    default:
      return;
  }
});
```

- [ ] **Step 7: Pass the real origin on session start**

In `src/background/index.ts`, resolve the tab's origin before starting so the
manifest and export filename are correct. Replace the `session/start` branch:

```ts
  if (message.kind === 'session/start') {
    void (async () => {
      const tab = await chrome.tabs.get(message.tabId);
      const origin = tab.url ? new URL(tab.url).origin : 'https://unknown.invalid';
      await ensureOffscreen();
      await chrome.runtime.sendMessage({ kind: 'session/begin', origin });
      await startSession(message.tabId);
    })();
  }
```

Add `{ kind: 'session/begin'; origin: string }` to the `RaidrMessage` union and
`'session/begin'` to `KINDS`, and in the offscreen listener replace the
`session/start` case with:

```ts
    case 'session/begin':
      state.begin(message.origin, new Date().toISOString(), crypto.randomUUID());
      broadcast();
      return;
```

- [ ] **Step 8: Subscribe the panel to redaction updates**

In `src/sidepanel/SidePanel.tsx`, extend the message listener added in Task 16:

```ts
      if (message.kind === 'session/redaction') setEntries(message.entries);
```

- [ ] **Step 9: Verify the suite and build**

Run: `cd ~/projects/raidr_extension && bun test && bun run typecheck && bun run build`
Expected: all tests PASS; typecheck clean; build succeeds

- [ ] **Step 10: Commit**

```bash
cd ~/projects/raidr_extension
git add -A
git commit -m "feat: offscreen session lifecycle wiring coverage and redaction to the panel"
```

---

### Task 18: Source-map discovery

The spec calls source maps the single biggest quality fork in reconstruction:
a map with `sourcesContent` turns inference into recovery. Discovery must
happen during capture, because a stripped `sourceMappingURL` comment is still
visible to CDP's `Debugger.scriptParsed`, and because the map has to be fetched
from the live origin with the session's own credentials.

**Files:**
- Create: `~/projects/raidr_extension/src/background/sourceMaps.ts`
- Modify: `~/projects/raidr_extension/src/background/cdpSession.ts`
- Test: `~/projects/raidr_extension/tests/background/sourceMaps.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `candidateMapUrls(scriptUrl: string, declaredMapUrl: string | null): string[]`
  - `isUsefulSourceMap(text: string): boolean`

- [ ] **Step 1: Write the failing test**

```ts
// tests/background/sourceMaps.test.ts
import { expect, test } from 'bun:test';
import {
  candidateMapUrls,
  isUsefulSourceMap,
} from '../../src/background/sourceMaps';

test('prefers the declared sourceMappingURL, resolved against the script', () => {
  expect(
    candidateMapUrls('https://x.com/assets/app-a1b2.js', 'app-a1b2.js.map')[0]
  ).toBe('https://x.com/assets/app-a1b2.js.map');
});

test('accepts an absolute declared map url', () => {
  expect(
    candidateMapUrls('https://x.com/a.js', 'https://cdn.x.com/a.js.map')[0]
  ).toBe('https://cdn.x.com/a.js.map');
});

test('speculates <script>.map when no url is declared', () => {
  expect(candidateMapUrls('https://x.com/assets/app-a1b2.js', null)).toEqual([
    'https://x.com/assets/app-a1b2.js.map',
  ]);
});

test('speculation is still attempted alongside a declared url', () => {
  const candidates = candidateMapUrls('https://x.com/a.js', 'wrong.map');
  expect(candidates).toContain('https://x.com/a.js.map');
});

test('ignores inline data-uri maps — the bytes are already captured', () => {
  expect(
    candidateMapUrls('https://x.com/a.js', 'data:application/json;base64,e30=')
  ).toEqual(['https://x.com/a.js.map']);
});

test('ignores non-http script urls', () => {
  expect(candidateMapUrls('chrome-extension://abc/a.js', null)).toEqual([]);
  expect(candidateMapUrls('', null)).toEqual([]);
});

test('a map with sourcesContent is useful', () => {
  const map = JSON.stringify({
    version: 3,
    sources: ['src/App.tsx'],
    sourcesContent: ['export const App = () => null;'],
    mappings: 'AAAA',
  });
  expect(isUsefulSourceMap(map)).toBe(true);
});

test('a map without sourcesContent is not useful', () => {
  const map = JSON.stringify({
    version: 3,
    sources: ['src/App.tsx'],
    mappings: 'AAAA',
  });
  expect(isUsefulSourceMap(map)).toBe(false);
});

test('a map whose sourcesContent is all null is not useful', () => {
  const map = JSON.stringify({
    version: 3,
    sources: ['a.ts'],
    sourcesContent: [null],
    mappings: 'AAAA',
  });
  expect(isUsefulSourceMap(map)).toBe(false);
});

test('non-JSON is not a useful source map', () => {
  expect(isUsefulSourceMap('<!doctype html><html>404</html>')).toBe(false);
});
```

The 404-HTML case matters: servers commonly answer a speculative `.map` request
with a 200 HTML error page, and storing that as a source map would poison
reconstruction.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/projects/raidr_extension && bun test tests/background/sourceMaps.test.ts`
Expected: FAIL — cannot resolve `../../src/background/sourceMaps`

- [ ] **Step 3: Write src/background/sourceMaps.ts**

```ts
export function candidateMapUrls(
  scriptUrl: string,
  declaredMapUrl: string | null
): string[] {
  if (!scriptUrl.startsWith('http')) return [];

  const candidates: string[] = [];

  if (declaredMapUrl && !declaredMapUrl.startsWith('data:')) {
    try {
      candidates.push(new URL(declaredMapUrl, scriptUrl).toString());
    } catch {
      // A malformed declaration is no reason to skip speculation.
    }
  }

  // Even with a declared URL, try the conventional sibling: build tools
  // frequently strip the comment while leaving the file in place.
  const speculative = `${scriptUrl.split('?')[0]}.map`;
  if (!candidates.includes(speculative)) candidates.push(speculative);

  return candidates;
}

export function isUsefulSourceMap(text: string): boolean {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null) return false;
    const { sourcesContent } = parsed as { sourcesContent?: unknown };
    if (!Array.isArray(sourcesContent)) return false;
    return sourcesContent.some(
      (entry) => typeof entry === 'string' && entry.length > 0
    );
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Handle `Debugger.scriptParsed` in the session**

Extend `CaptureSink` in `src/background/cdpSession.ts`:

```ts
  onSourceMap(scriptUrl: string, mapUrl: string, text: string): Promise<void>;
```

Add the case to `handle`:

```ts
      case 'Debugger.scriptParsed':
        await this.discoverSourceMap(
          String(params.url ?? ''),
          typeof params.sourceMapURL === 'string' ? params.sourceMapURL : null
        );
        return;
```

And the method:

```ts
  private async discoverSourceMap(
    scriptUrl: string,
    declaredMapUrl: string | null
  ): Promise<void> {
    for (const mapUrl of candidateMapUrls(scriptUrl, declaredMapUrl)) {
      if (this.attemptedMaps.has(mapUrl)) continue;
      this.attemptedMaps.add(mapUrl);
      try {
        const response = await fetch(mapUrl, { credentials: 'include' });
        if (!response.ok) continue;
        const text = await response.text();
        if (!isUsefulSourceMap(text)) continue;
        await this.sink.onSourceMap(scriptUrl, mapUrl, text);
        return;
      } catch {
        // A missing or blocked map is the common case, not an error worth
        // recording as a gap: the bundle is still complete without it.
      }
    }
  }
```

Add `private attemptedMaps = new Set<string>();` as a field and import
`candidateMapUrls` and `isUsefulSourceMap` at the top.

- [ ] **Step 5: Store discovered maps**

In `src/offscreen/sessionState.ts`, add:

```ts
  private sourceMaps = new Map<string, string>();

  async ingestSourceMap(scriptUrl: string, text: string): Promise<void> {
    const hash = await this.store.put(new TextEncoder().encode(text));
    this.sourceMaps.set(scriptUrl, hash);
  }

  sourceMapHashes(): Record<string, string> {
    return Object.fromEntries(this.sourceMaps);
  }
```

In `src/offscreen/exporter.ts`, add `sourceMaps: Record<string, string>` to
`BundleInput` and write each one:

```ts
  for (const hash of Object.values(input.sourceMaps)) {
    const path = sourcemapPath(hash);
    if (files[path]) continue;
    const bytes = await input.store.get(hash);
    if (bytes) files[path] = bytes;
  }
  files['sourcemaps/index.json'] = json(input.sourceMaps);
```

Import `sourcemapPath` from `@sudobility/raidr_processor`, and return
`sourceMaps: this.sourceMapHashes()` from `SessionState.bundleInput()`.

Add a `capture/sourcemap` message kind carrying `{ scriptUrl, text }`, routed
from the service worker's `onSourceMap` sink into `state.ingestSourceMap`,
following the same pattern as `capture/gap`.

- [ ] **Step 6: Verify the suite and build**

Run: `cd ~/projects/raidr_extension && bun test && bun run typecheck && bun run build`
Expected: all tests PASS, 10 new tests; typecheck clean; build succeeds

- [ ] **Step 7: Verify against a real app with published maps**

Capture any Vite dev build or a production app that ships maps, export the
bundle, then check:

```bash
cd ~/Downloads && unzip -o raidr-*.zip -d raidr-check
jq 'keys | length' raidr-check/sourcemaps/index.json
jq '.sourcesContent | length' raidr-check/sourcemaps/*.map | head -3
```

Expected: a non-zero map count, and `sourcesContent` arrays holding real source.

- [ ] **Step 8: Commit**

```bash
cd ~/projects/raidr_extension
git add -A
git commit -m "feat: source-map discovery and bundle storage"
```

---

## Definition of done

- `bun test` green in both repos.
- `bun run typecheck` clean in both repos.
- `bun run build` produces a loadable unpacked extension.
- A real capture session against a React app and a Vue app each export a bundle passing the Task 16 Step 9 checks.
- Source maps are discovered and stored when the target ships them (Task 18 Step 7).
- No raw credential appears anywhere in an exported bundle.

## Deferred to the milestone 5–8 plan

- Source-map unpacking and recovery-ratio branching
- Bundle module splitting and beautification
- JSON Schema inference and the API model
- Deterministic codegen and the Hono replay server
- The `raidr_cli` binary and the `reconstruct` skill it drives (a separate repo — see the spec's Repositories section for why the CLI cannot live in `raidr_processor`)
- Round-trip end-to-end test
- WebSocket frame capture is typed in the bundle format and written to `network/websockets.jsonl`, but the CDP handlers for `Network.webSocketFrameSent`/`webSocketFrameReceived` are not wired in these four milestones.
