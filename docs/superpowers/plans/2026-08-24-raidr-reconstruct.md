# raidr Reconstruction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn an raidr capture bundle into a working reconstruction of the captured web app — via a `raidr_cli` binary that performs every deterministic stage, and a Claude Code `reconstruct` skill that drives it and supplies the judgment the binary cannot.

**Architecture:** Pure transformations (schema inference, source-map parsing, route modelling, codegen templates) live in `raidr_processor` and are tested headlessly. All filesystem work — unzip, read, emit, spawn — lives in `raidr_cli`. The skill is markdown that shells out to the CLI and then does per-route implementation work against the CLI's intermediate artifacts.

**Tech Stack:** Bun, TypeScript 5.7+, `fflate` (unzip), `prettier` (beautify + format emitted code), `hono` (replay server), Playwright (fixture generation only).

**Spec:** `docs/superpowers/specs/2026-08-24-raidr-design.md` (in `raidr_processor`), stages 1–9 of the Reconstruction section.

**Predecessor:** `docs/superpowers/plans/2026-08-24-raidr-capture.md` — milestones 1–4, shipped.

**Scope:** Milestones 5–8. Covers stages 1–9 in full.

## Global Constraints

- Package manager is **Bun**. Never npm, yarn, or pnpm.
- `raidr_processor` (`@sudobility/raidr_processor`, BUSL-1.1) performs **no I/O**: no `fs`, no `chrome.*`, no `DOM` in its tsconfig `lib`. Enforced mechanically — a stray `window` or `readFile` fails typecheck.
- `raidr_cli` (`@sudobility/raidr_cli`, BUSL-1.1) owns every filesystem and process operation.
- `raidr_extension` is `private: true`.
- Bundle `formatVersion` is `1`. `validateManifest` must reject anything else before analysis begins.
- **Gaps propagate as gaps.** No stage may invent, guess, or silently drop data missing from the bundle. Every generated file that stands on missing capture carries an `RAIDR-GAP` marker naming what was absent.
- Generated projects must pass `bun install && bun run typecheck && bun run build`. A reconstruction that does not build is not a reconstruction.
- Fixture bundles are produced by the **same** `buildBundleFiles` the extension uses. Fixtures that drift from real output are worse than no fixtures.

---

## File Structure

### `raidr_processor` (additions)

| File | Responsibility |
|---|---|
| `src/bundle/assemble.ts` | `buildBundleFiles` / `zipBundle` / `bundleFilename`, moved here from the extension so both producers share one implementation. |
| `src/bundle/store.ts` | `ContentStore` interface + `MemoryContentStore`. |
| `src/analysis/sourceMap.ts` | Source-map parsing, `sourcesContent` recovery, recovery ratio. |
| `src/analysis/schema.ts` | JSON Schema inference by unifying N observed samples. |
| `src/analysis/apiModel.ts` | Endpoint clustering → per-status schemas. |
| `src/analysis/routeModel.ts` | Router table joined to the request timeline. |
| `src/analysis/stack.ts` | Stack decision from the runtime fingerprint. |
| `src/codegen/types.ts` | JSON Schema → TypeScript source. |
| `src/codegen/client.ts` | API model → typed client source. |
| `src/codegen/replay.ts` | API model → Hono replay server source. |
| `src/codegen/project.ts` | package.json / vite config / router source. |

### `raidr_cli`

| File | Responsibility |
|---|---|
| `src/cli.ts` | Argument parsing, command dispatch. |
| `src/commands/reconstruct.ts` | Stage orchestration, artifact writing. |
| `src/bundle/load.ts` | Unzip and read a bundle from disk into memory. |
| `src/stages/*.ts` | One file per stage; each reads prior artifacts, writes its own. |
| `src/emit.ts` | Write generated files, run Prettier, report what was written. |
| `fixtures/apps/react-sample/` | Real Vite + React + react-router app with lazy routes. |
| `fixtures/apps/vue-sample/` | Real Vite + Vue + vue-router app with lazy routes. |
| `fixtures/api/server.ts` | Hono API the sample apps call. |
| `scripts/captureFixture.ts` | Playwright CDP harness producing real bundles. |
| `fixtures/bundles/*.zip` | Committed real captures. |
| `skills/reconstruct/SKILL.md` | The Claude Code skill. |
| `skills/reconstruct/INSTALL.md` | Installation instructions. |

---

# Milestone 5 — Real fixtures

### Task 19: Move bundle assembly into `raidr_processor`

Fixtures are worthless if they are not shaped exactly like the extension's
output. Sharing one implementation is the only way to guarantee that.

**Files:**
- Create: `~/projects/raidr_processor/src/bundle/store.ts`
- Create: `~/projects/raidr_processor/src/bundle/assemble.ts`
- Modify: `~/projects/raidr_processor/src/index.ts`
- Delete: `~/projects/raidr_extension/src/offscreen/exporter.ts`
- Modify: `~/projects/raidr_extension/src/offscreen/index.ts`, `src/offscreen/sessionState.ts`, `src/offscreen/store.ts`
- Move: `~/projects/raidr_extension/tests/offscreen/exporter.test.ts` → `~/projects/raidr_processor/tests/bundle/assemble.test.ts`

**Interfaces:**
- Produces (from `@sudobility/raidr_processor`):
  - `interface ContentStore { put(bytes: Uint8Array): Promise<string>; get(hash: string): Promise<Uint8Array | null>; has(hash: string): Promise<boolean>; count(): Promise<number>; totalBytes(): Promise<number> }`
  - `class MemoryContentStore implements ContentStore` — constructor `(hash: (bytes: Uint8Array) => Promise<string>)`
  - `buildBundleFiles(input: BundleInput): Promise<Record<string, Uint8Array>>`
  - `zipBundle(files: Record<string, Uint8Array>): Promise<Uint8Array>`
  - `bundleFilename(origin: string, startedAt: string): string`
  - `interface BundleInput`, `interface RuntimeArtifacts`

`MemoryContentStore` takes the hash function by injection because `raidr_processor`
may not assume `crypto.subtle` exists; the extension and the CLI each pass
their own.

- [ ] **Step 1: Write the failing test**

Move the existing `tests/offscreen/exporter.test.ts` to
`~/projects/raidr_processor/tests/bundle/assemble.test.ts`, replacing the
`IdbContentStore` + `fake-indexeddb` setup with `MemoryContentStore`:

```ts
import { expect, test } from 'bun:test';
import { unzipSync, strFromU8 } from 'fflate';
import {
  MemoryContentStore,
  buildBundleFiles,
  zipBundle,
  bundleFilename,
} from '../../src/index';

const encoder = new TextEncoder();

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

test('memory store round-trips and deduplicates', async () => {
  const store = new MemoryContentStore(sha256Hex);
  const a = await store.put(encoder.encode('same'));
  const b = await store.put(encoder.encode('same'));
  expect(a).toBe(b);
  expect(await store.count()).toBe(1);
  expect(strFromU8((await store.get(a))!)).toBe('same');
});
```

Then append every assertion from the original exporter test verbatim — the
bundle layout test, the mime-extension test, the gaps test, the salt test, the
zip round-trip, the filename test, and both source-map tests.

- [ ] **Step 2: Run to verify it fails**

Run: `cd ~/projects/raidr_processor && bun test tests/bundle/assemble.test.ts`
Expected: FAIL — `MemoryContentStore` is not exported

- [ ] **Step 3: Write `src/bundle/store.ts`**

```ts
export interface ContentStore {
  put(bytes: Uint8Array): Promise<string>;
  get(hash: string): Promise<Uint8Array | null>;
  has(hash: string): Promise<boolean>;
  count(): Promise<number>;
  totalBytes(): Promise<number>;
}

export type HashFn = (bytes: Uint8Array) => Promise<string>;

/**
 * In-memory content store. The hash function is injected because raidr_processor
 * cannot assume a platform crypto API exists.
 */
export class MemoryContentStore implements ContentStore {
  private rows = new Map<string, Uint8Array>();

  constructor(private readonly hash: HashFn) {}

  async put(bytes: Uint8Array): Promise<string> {
    const key = await this.hash(bytes);
    if (!this.rows.has(key)) this.rows.set(key, bytes);
    return key;
  }

  async get(hash: string): Promise<Uint8Array | null> {
    return this.rows.get(hash) ?? null;
  }

  async has(hash: string): Promise<boolean> {
    return this.rows.has(hash);
  }

  async count(): Promise<number> {
    return this.rows.size;
  }

  async totalBytes(): Promise<number> {
    let total = 0;
    for (const bytes of this.rows.values()) total += bytes.byteLength;
    return total;
  }
}
```

- [ ] **Step 4: Move the assembler**

Copy `raidr_extension/src/offscreen/exporter.ts` to
`raidr_processor/src/bundle/assemble.ts` unchanged except its imports: it now imports
`contentPath`, `extensionForMime`, `sourcemapPath`, `toJsonl` from sibling
modules (`../bundle/paths`, `../bundle/manifest`) and `ContentStore` from
`./store` instead of `@sudobility/raidr_processor` and `./store`.

- [ ] **Step 5: Export from `src/index.ts`**

```ts
export { MemoryContentStore } from './bundle/store';
export type { ContentStore, HashFn } from './bundle/store';
export {
  buildBundleFiles,
  zipBundle,
  bundleFilename,
} from './bundle/assemble';
export type { BundleInput, RuntimeArtifacts } from './bundle/assemble';
```

- [ ] **Step 6: Point the extension at the library**

Delete `raidr_extension/src/offscreen/exporter.ts` and
`tests/offscreen/exporter.test.ts`. In `src/offscreen/store.ts`, delete the
local `ContentStore` interface and re-export the library's:

```ts
import type { ContentStore } from '@sudobility/raidr_processor';
export type { ContentStore };
```

`IdbContentStore` stays — it is the browser implementation. In
`src/offscreen/index.ts` and `src/offscreen/sessionState.ts`, change the
`./exporter` imports to `@sudobility/raidr_processor`.

- [ ] **Step 7: Verify both repos**

```bash
cd ~/projects/raidr_processor && bun test && bun run typecheck && bun run build
cd ~/projects/raidr_extension && bun test && bun run typecheck && bun run build
```
Expected: lib gains the assembler tests; extension loses them and keeps the rest green. No behaviour change.

- [ ] **Step 8: Commit both repos**

```bash
cd ~/projects/raidr_processor && git add -A && git commit -m "refactor: move bundle assembly into the library for producer sharing"
cd ~/projects/raidr_extension && git add -A && git commit -m "refactor: consume bundle assembly from raidr_processor"
```

---

### Task 20: Sample apps and fixture API

Real minified output with real lazy chunks and real source maps. Nothing here
is a mock — these are ordinary Vite apps that get built and served.

**Files:**
- Create: `~/projects/raidr_cli/fixtures/api/server.ts`
- Create: `~/projects/raidr_cli/fixtures/apps/react-sample/` (Vite + React + react-router)
- Create: `~/projects/raidr_cli/fixtures/apps/vue-sample/` (Vite + Vue + vue-router)
- Create: `~/projects/raidr_cli/package.json`, `tsconfig.json`
- Test: `~/projects/raidr_cli/tests/fixtures/apps.test.ts`

**Interfaces:**
- Produces: two buildable apps and one API server; `startFixtureApi(port: number)` exported from `fixtures/api/server.ts`

The apps must exercise everything the analysis stages need:
- **3+ routes**, at least 2 of them lazy (`React.lazy` / dynamic `import()`), so the chunk manifest has entries that only load on navigation
- **Source maps on** (`build.sourcemap: true`) — this is the recovery path
- **An endpoint returning two different shapes** by status (200 vs 401), so schema unification has a real union to model
- **A list endpoint and a detail endpoint** (`/api/users`, `/api/users/:id`), so path templating has something to cluster
- **A login endpoint** returning a token that later requests send, so redaction's referential integrity is exercised end to end

- [ ] **Step 1: Write the failing test**

```ts
// tests/fixtures/apps.test.ts
import { expect, test } from 'bun:test';
import { startFixtureApi } from '../../fixtures/api/server';

test('fixture api serves a user list', async () => {
  const server = startFixtureApi(0);
  try {
    const res = await fetch(`http://localhost:${server.port}/api/users`);
    expect(res.status).toBe(200);
    // Bun types res.json() as unknown under strict mode; annotate or typecheck fails.
    const body = (await res.json()) as { users: Array<{ id: number }> };
    expect(Array.isArray(body.users)).toBe(true);
    expect(body.users[0]!.id).toBeDefined();
  } finally {
    server.stop();
  }
});

test('detail endpoint returns a single user', async () => {
  const server = startFixtureApi(0);
  try {
    const res = await fetch(`http://localhost:${server.port}/api/users/1`);
    const body = await res.json();
    expect(body.id).toBe(1);
    expect(body.email).toContain('@');
  } finally {
    server.stop();
  }
});

test('the same endpoint returns different shapes by status', async () => {
  const server = startFixtureApi(0);
  try {
    const anon = await fetch(`http://localhost:${server.port}/api/me`);
    expect(anon.status).toBe(401);
    expect((await anon.json()).error).toBeDefined();

    const authed = await fetch(`http://localhost:${server.port}/api/me`, {
      headers: { authorization: 'Bearer test-token' },
    });
    expect(authed.status).toBe(200);
    expect((await authed.json()).email).toBeDefined();
  } finally {
    server.stop();
  }
});

test('login returns a token that /api/me accepts', async () => {
  const server = startFixtureApi(0);
  try {
    const login = await fetch(`http://localhost:${server.port}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'ada@example.com', password: 'hunter2' }),
    });
    const { access_token } = await login.json();
    expect(access_token.startsWith('ey')).toBe(true);

    const me = await fetch(`http://localhost:${server.port}/api/me`, {
      headers: { authorization: `Bearer ${access_token}` },
    });
    expect(me.status).toBe(200);
  } finally {
    server.stop();
  }
});

test('optional fields are genuinely absent on some records', async () => {
  const server = startFixtureApi(0);
  try {
    const { users } = await fetch(
      `http://localhost:${server.port}/api/users`
    ).then((r) => r.json());
    expect(users.some((u: Record<string, unknown>) => u.nickname === undefined)).toBe(true);
    expect(users.some((u: Record<string, unknown>) => u.nickname !== undefined)).toBe(true);
  } finally {
    server.stop();
  }
});
```

The last test matters: schema inference can only learn optionality if some
records actually omit the field.

- [ ] **Step 2: Run to verify it fails**

Run: `cd ~/projects/raidr_cli && bun test`
Expected: FAIL — cannot resolve `../../fixtures/api/server`

- [ ] **Step 3: Create `raidr_cli/package.json`**

```json
{
  "name": "@sudobility/raidr_cli",
  "version": "0.0.1",
  "description": "Reconstruct a web app from an raidr capture bundle",
  "license": "BUSL-1.1",
  "type": "module",
  "bin": { "raidr": "./src/cli.ts" },
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "bun test",
    "fixtures:build": "bun run scripts/buildFixtureApps.ts",
    "fixtures:capture": "bun run scripts/captureFixture.ts"
  },
  "dependencies": {
    "@sudobility/raidr_processor": "file:../raidr_processor",
    "fflate": "^0.8.2",
    "hono": "^4.6.0",
    "prettier": "^3.6.2"
  },
  "devDependencies": {
    "@types/bun": "^1.3.14",
    "playwright": "^1.60.0",
    "typescript": "^5.7.3"
  }
}
```

`bin` points at the TypeScript source: Bun executes it directly, so there is no
build step to keep in sync.

- [ ] **Step 4: Create `raidr_cli/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noEmit": true,
    "skipLibCheck": true,
    "verbatimModuleSyntax": true,
    "types": ["bun"],
    "baseUrl": ".",
    "paths": { "@/*": ["src/*"] }
  },
  "include": ["src", "tests", "scripts", "fixtures/api"]
}
```

`fixtures/apps` is deliberately excluded — those are independent projects with
their own tsconfigs and JSX settings.

- [ ] **Step 5: Write `fixtures/api/server.ts`**

```ts
import { Hono } from 'hono';
import { cors } from 'hono/cors';

interface User {
  id: number;
  email: string;
  name: string;
  role: 'admin' | 'member';
  nickname?: string;
  createdAt: string;
}

const USERS: User[] = [
  {
    id: 1,
    email: 'ada@example.com',
    name: 'Ada Lovelace',
    role: 'admin',
    nickname: 'ada',
    createdAt: '2026-01-04T09:00:00.000Z',
  },
  {
    id: 2,
    email: 'alan@example.com',
    name: 'Alan Turing',
    role: 'member',
    createdAt: '2026-02-11T09:00:00.000Z',
  },
  {
    id: 3,
    email: 'grace@example.com',
    name: 'Grace Hopper',
    role: 'member',
    nickname: 'amazing grace',
    createdAt: '2026-03-27T09:00:00.000Z',
  },
];

// A structurally valid JWT whose payload is inert. Present so the capture
// exercises redaction's referential integrity: the token returned by /api/login
// is the one later requests carry in Authorization.
const TOKEN =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIiwibmFtZSI6IkFkYSJ9.c2lnbmF0dXJlLXBsYWNlaG9sZGVy';

export function startFixtureApi(port: number) {
  const app = new Hono();
  app.use('/*', cors());

  app.get('/api/users', (c) => c.json({ users: USERS, total: USERS.length }));

  app.get('/api/users/:id', (c) => {
    const user = USERS.find((u) => u.id === Number(c.req.param('id')));
    return user ? c.json(user) : c.json({ error: 'not_found' }, 404);
  });

  app.post('/api/login', async (c) => {
    const body = await c.req.json<{ email?: string }>();
    return c.json({
      access_token: TOKEN,
      expires_in: 3600,
      user: USERS.find((u) => u.email === body.email) ?? USERS[0],
    });
  });

  // Two shapes for one endpoint, so schema unification has a real union.
  app.get('/api/me', (c) => {
    const auth = c.req.header('authorization');
    if (!auth) return c.json({ error: 'unauthorized', code: 401 }, 401);
    return c.json(USERS[0]!);
  });

  app.get('/api/stats', (c) =>
    c.json({
      users: USERS.length,
      activeToday: 2,
      storageBytes: 1048576,
      lastSync: null,
    })
  );

  const server = Bun.serve({ port, fetch: app.fetch });
  return { port: server.port, stop: () => server.stop(true) };
}

if (import.meta.main) {
  const { port } = startFixtureApi(8123);
  console.log(`fixture api on http://localhost:${port}`);
}
```

- [ ] **Step 6: Create the React sample app**

`fixtures/apps/react-sample/` — a normal Vite project. `package.json` deps:
`react`, `react-dom`, `react-router-dom`; dev deps `vite`, `@vitejs/plugin-react`,
`typescript`. `vite.config.ts` must set `build: { sourcemap: true }`.

`src/main.tsx` mounts a `createBrowserRouter` with four routes, two lazy:

```tsx
import { lazy, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider, Link } from 'react-router-dom';
import { Home } from './pages/Home';

const Users = lazy(() => import('./pages/Users'));
const UserDetail = lazy(() => import('./pages/UserDetail'));
const Stats = lazy(() => import('./pages/Stats'));

const wrap = (node: React.ReactNode) => (
  <Suspense fallback={<p>loading</p>}>{node}</Suspense>
);

const router = createBrowserRouter([
  { path: '/', element: <Home /> },
  { path: '/users', element: wrap(<Users />) },
  { path: '/users/:id', element: wrap(<UserDetail />) },
  { path: '/stats', element: wrap(<Stats />) },
]);

// Exposed so the capture probe can read the real route table.
(globalThis as unknown as Record<string, unknown>).__reactRouterDataRouter = router;

createRoot(document.getElementById('root')!).render(
  <RouterProvider router={router} />
);
```

Each page fetches from the API on mount: `Home` calls `/api/login` then
`/api/me`; `Users` calls `/api/users`; `UserDetail` calls `/api/users/:id`;
`Stats` calls `/api/stats`. `Home` stores the token and every later call sends
`Authorization: Bearer <token>`.

The `__reactRouterDataRouter` assignment is not decoration — it is what the
`readRoutes` probe from Task 15 reads. Without it the React route track is
empty, and this fixture would not exercise it.

- [ ] **Step 7: Create the Vue sample app**

`fixtures/apps/vue-sample/` — Vite + Vue 3 + `vue-router`, same four routes,
two lazy via `() => import('./pages/Users.vue')`, same API calls, same
`build.sourcemap: true`. Vue Router is discoverable through the devtools hook
without extra wiring, so no global assignment is needed.

- [ ] **Step 8: Create `scripts/buildFixtureApps.ts`**

```ts
import { $ } from 'bun';

const APPS = ['react-sample', 'vue-sample'];

for (const app of APPS) {
  const dir = `${import.meta.dir}/../fixtures/apps/${app}`;
  console.log(`building ${app}`);
  await $`bun install`.cwd(dir);
  await $`bun run build`.cwd(dir);
}
```

- [ ] **Step 9: Install, build, and verify**

```bash
cd ~/projects/raidr_cli && bun install && bun test && bun run fixtures:build
ls fixtures/apps/react-sample/dist/assets/*.map | head
```
Expected: 5 API tests PASS; both apps build; `.map` files present in both `dist/assets`

- [ ] **Step 10: Commit**

```bash
cd ~/projects/raidr_cli
git add -A && git commit -m "feat: fixture API and real React/Vue sample apps"
```

---

### Task 21: Playwright CDP capture harness

**Files:**
- Create: `~/projects/raidr_cli/scripts/captureFixture.ts`
- Create: `~/projects/raidr_cli/src/capture/harness.ts`
- Test: `~/projects/raidr_cli/tests/capture/harness.test.ts`
- Produces: `~/projects/raidr_cli/fixtures/bundles/react-sample.zip`, `vue-sample.zip`

**Interfaces:**
- Consumes: `buildBundleFiles`, `zipBundle`, `MemoryContentStore`, `createPseudonymizer`, `redactRequest`, `createManifest` from `@sudobility/raidr_processor`
- Produces:
  - `captureApp(options: CaptureOptions): Promise<Uint8Array>` — returns the zipped bundle
  - `interface CaptureOptions { url: string; routes: string[]; outName: string }`

The harness mirrors the extension's pipeline exactly — same CDP domains, same
`loadingFinished` body fetch, same redaction, same assembler semantics, same
`buildBundleFiles`. It differs only in *who* owns the CDP connection.

- [ ] **Step 1: Write the failing test**

```ts
// tests/capture/harness.test.ts
import { expect, test } from 'bun:test';
import { unzipSync, strFromU8 } from 'fflate';
import { validateManifest, parseJsonl, type CapturedRequest } from '@sudobility/raidr_processor';
import { captureApp } from '../../src/capture/harness';
import { startFixtureApi } from '../../fixtures/api/server';

// Real browser work; generous but bounded.
const TIMEOUT = 120_000;

test(
  'captures the react sample into a valid bundle',
  async () => {
    const api = startFixtureApi(8123);
    try {
      const zipped = await captureApp({
        appDir: `${import.meta.dir}/../../fixtures/apps/react-sample/dist`,
        routes: ['/', '/users', '/users/1', '/stats'],
        outName: 'react-sample',
      });

      const files = unzipSync(zipped);
      const manifest = JSON.parse(strFromU8(files['raidr.json']!));
      expect(validateManifest(manifest).ok).toBe(true);
      expect(manifest.stack.framework).toBe('react');
      expect(manifest.stack.bundler).toBe('vite');

      const requests = parseJsonl<CapturedRequest>(
        strFromU8(files['network/requests.jsonl']!)
      );
      expect(requests.length).toBeGreaterThan(5);

      // The API was actually exercised.
      expect(requests.some((r) => r.url.includes('/api/users'))).toBe(true);

      // Real JS bodies landed in the content store.
      expect(
        Object.keys(files).some((p) => p.startsWith('content/') && p.endsWith('.js'))
      ).toBe(true);

      // Source maps were discovered — the recovery path has material.
      const mapIndex = JSON.parse(strFromU8(files['sourcemaps/index.json']!));
      expect(Object.keys(mapIndex).length).toBeGreaterThan(0);

      // Redaction ran: the login token never appears in the clear.
      const all = Object.values(files).map(strFromU8).join('');
      expect(all).not.toContain('c2lnbmF0dXJlLXBsYWNlaG9sZGVy');
    } finally {
      api.stop();
    }
  },
  TIMEOUT
);

test(
  'captures the vue sample and detects vue',
  async () => {
    const api = startFixtureApi(8123);
    try {
      const zipped = await captureApp({
        appDir: `${import.meta.dir}/../../fixtures/apps/vue-sample/dist`,
        routes: ['/', '/users', '/users/1', '/stats'],
        outName: 'vue-sample',
      });
      const files = unzipSync(zipped);
      const manifest = JSON.parse(strFromU8(files['raidr.json']!));
      expect(manifest.stack.framework).toBe('vue');
    } finally {
      api.stop();
    }
  },
  TIMEOUT
);
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd ~/projects/raidr_cli && bun test tests/capture/harness.test.ts`
Expected: FAIL — cannot resolve `../../src/capture/harness`

- [ ] **Step 3: Write `src/capture/harness.ts`**

```ts
import { chromium } from 'playwright';
import {
  MemoryContentStore,
  buildBundleFiles,
  bundleFilename,
  createManifest,
  createPseudonymizer,
  redactRequest,
  zipBundle,
  type CapturedRequest,
  type Gap,
  type StackFingerprint,
} from '@sudobility/raidr_processor';

export interface CaptureOptions {
  /** Built app directory to serve statically. */
  appDir: string;
  /** SPA paths to visit, in order. */
  routes: string[];
  outName: string;
}

const encoder = new TextEncoder();

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function captureApp(options: CaptureOptions): Promise<Uint8Array> {
  // Serve the built app with SPA fallback so deep links resolve.
  const appServer = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const file = Bun.file(`${options.appDir}${url.pathname}`);
      if (await file.exists()) return new Response(file);
      return new Response(Bun.file(`${options.appDir}/index.html`), {
        headers: { 'content-type': 'text/html' },
      });
    },
  });
  const origin = `http://localhost:${appServer.port}`;

  const browser = await chromium.launch();
  const page = await browser.newPage();
  const cdp = await page.context().newCDPSession(page);

  const store = new MemoryContentStore(sha256Hex);
  const { pseudonym, entries } = createPseudonymizer(crypto.randomUUID());
  const manifest = createManifest({
    sessionId: options.outName,
    origin,
    startedAt: new Date().toISOString(),
  });

  const rows: CapturedRequest[] = [];
  const gaps: Gap[] = [];
  const sourceMaps: Record<string, string> = {};
  const pending = new Map<string, Record<string, unknown>>();

  cdp.on('Network.requestWillBeSent', (p) => pending.set(p.requestId, p as never));
  cdp.on('Network.responseReceived', (p) => {
    const entry = pending.get(p.requestId);
    if (entry) entry.response = p.response;
  });

  const finished: Array<Promise<void>> = [];

  cdp.on('Network.loadingFinished', (p) => {
    const entry = pending.get(p.requestId);
    if (!entry) return;
    pending.delete(p.requestId);

    finished.push(
      (async () => {
        const request = entry.request as Record<string, unknown>;
        const response = (entry.response ?? {}) as Record<string, unknown>;
        const url = String(request.url ?? '');
        const mimeType =
          typeof response.mimeType === 'string' ? response.mimeType : null;

        let body: string | null = null;
        try {
          const result = await cdp.send('Network.getResponseBody', {
            requestId: p.requestId,
          });
          body = result.base64Encoded
            ? Buffer.from(result.body, 'base64').toString('binary')
            : result.body;
        } catch (error) {
          gaps.push({
            requestId: p.requestId,
            url,
            reason: 'body-evicted',
            ts: Math.round(Number(entry.wallTime ?? 0) * 1000),
            detail: error instanceof Error ? error.message : String(error),
          });
        }

        const redacted = redactRequest(
          {
            requestHeaders: (request.headers ?? {}) as Record<string, string>,
            responseHeaders: (response.headers ?? {}) as Record<string, string>,
            mimeType,
            requestBody:
              typeof request.postData === 'string' ? request.postData : null,
            responseBody: body,
          },
          pseudonym
        );

        rows.push({
          id: p.requestId,
          ts: Math.round(Number(entry.wallTime ?? 0) * 1000),
          method: String(request.method ?? 'GET'),
          url,
          resourceType: String(entry.type ?? 'Other'),
          requestHeaders: redacted.requestHeaders,
          requestBodyHash:
            redacted.requestBody === null
              ? null
              : await store.put(encoder.encode(redacted.requestBody)),
          status: Number(response.status ?? 0),
          responseHeaders: redacted.responseHeaders,
          responseBodyHash:
            redacted.responseBody === null
              ? null
              : await store.put(encoder.encode(redacted.responseBody)),
          mimeType,
          fromCache: response.fromDiskCache === true,
          navigationId: null,
        });
      })()
    );
  });

  await cdp.send('Network.enable', {
    maxResourceBufferSize: 100 * 1024 * 1024,
    maxTotalBufferSize: 500 * 1024 * 1024,
  });
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  let framework: StackFingerprint | null = null;
  const knownChunks = new Set<string>();
  const knownRoutes = new Set<string>();

  const { PROBE_SOURCES } = await import('../introspect/probes');

  for (const route of options.routes) {
    await page.goto(`${origin}${route}`, { waitUntil: 'networkidle' });
    framework = (await page.evaluate(PROBE_SOURCES.framework)) as StackFingerprint;
    for (const r of (await page.evaluate(PROBE_SOURCES.routes)) as string[]) {
      knownRoutes.add(r);
    }
    for (const c of (await page.evaluate(PROBE_SOURCES.chunks)) as string[]) {
      knownChunks.add(c);
    }
  }

  // Fetch source maps with the page's own credentials.
  for (const row of rows) {
    if (!row.mimeType?.includes('javascript')) continue;
    const mapUrl = `${row.url.split('?')[0]}.map`;
    try {
      const text = await page.evaluate(
        async (u) => (await fetch(u)).text(),
        mapUrl
      );
      const parsed = JSON.parse(text) as { sourcesContent?: unknown };
      if (
        Array.isArray(parsed.sourcesContent) &&
        parsed.sourcesContent.some((s) => typeof s === 'string' && s.length > 0)
      ) {
        sourceMaps[row.url] = await store.put(encoder.encode(text));
      }
    } catch {
      // No map for this chunk; not a gap — the bundle is complete without it.
    }
  }

  await Promise.all(finished);
  await browser.close();
  appServer.stop(true);

  manifest.endedAt = new Date().toISOString();
  manifest.stack = framework;
  manifest.counts = {
    requests: rows.length,
    frames: 0,
    bodies: await store.count(),
    gaps: gaps.length,
  };

  const files = await buildBundleFiles({
    store,
    manifest,
    requests: rows,
    frames: [],
    gaps,
    redaction: entries(),
    sourceMaps,
    runtime: {
      framework,
      routes: Array.from(knownRoutes),
      stores: framework?.stateLibraries ?? [],
      chunks: {
        known: Array.from(knownChunks),
        loaded: Array.from(knownChunks).filter((c) =>
          rows.some((r) => r.url.endsWith(c))
        ),
      },
      coverage: {},
    },
  });

  return zipBundle(files);
}

export { bundleFilename };
```

- [ ] **Step 4: Share the probes**

`harness.ts` imports `../introspect/probes`. Copy
`raidr_extension/src/introspect/probes.ts` to `raidr_cli/src/introspect/probes.ts`
**unchanged**, and add a test asserting the two files are byte-identical:

```ts
// tests/introspect/probesParity.test.ts
import { expect, test } from 'bun:test';

test('cli probes are identical to the extension probes', async () => {
  const cli = await Bun.file(`${import.meta.dir}/../../src/introspect/probes.ts`).text();
  const ext = await Bun.file(
    `${import.meta.dir}/../../../raidr_extension/src/introspect/probes.ts`
  ).text();
  expect(cli).toBe(ext);
});
```

Duplication with a parity test beats a shared package here: the probes must run
in the page, so they cannot import anything, and a cross-repo dependency for one
file would be heavier than a test that fails loudly on drift.

- [ ] **Step 5: Write `scripts/captureFixture.ts`**

```ts
import { captureApp } from '../src/capture/harness';
import { startFixtureApi } from '../fixtures/api/server';

const APPS = [
  { name: 'react-sample', routes: ['/', '/users', '/users/1', '/stats'] },
  { name: 'vue-sample', routes: ['/', '/users', '/users/1', '/stats'] },
];

const api = startFixtureApi(8123);
try {
  for (const app of APPS) {
    console.log(`capturing ${app.name}`);
    const zipped = await captureApp({
      appDir: `${import.meta.dir}/../fixtures/apps/${app.name}/dist`,
      routes: app.routes,
      outName: app.name,
    });
    await Bun.write(
      `${import.meta.dir}/../fixtures/bundles/${app.name}.zip`,
      zipped
    );
    console.log(`  wrote ${zipped.byteLength} bytes`);
  }
} finally {
  api.stop();
}
```

- [ ] **Step 6: Generate and commit the real bundles**

```bash
cd ~/projects/raidr_cli
bunx playwright install chromium
mkdir -p fixtures/bundles
bun run fixtures:capture
bun test
unzip -l fixtures/bundles/react-sample.zip | head -20
```
Expected: both bundles written; harness tests PASS; the listing shows `raidr.json`, `network/requests.jsonl`, `content/*.js`, `sourcemaps/`

- [ ] **Step 7: Commit**

```bash
cd ~/projects/raidr_cli
git add -A && git commit -m "feat: Playwright CDP fixture harness and real captured bundles"
```

---
# Milestone 6 — Analysis (stages 1–5)

### Task 22: `raidr_cli` scaffold and bundle loader

**Files:**
- Create: `~/projects/raidr_cli/src/bundle/load.ts`
- Create: `~/projects/raidr_cli/src/cli.ts`
- Test: `~/projects/raidr_cli/tests/bundle/load.test.ts`

**Interfaces:**
- Produces:
  - `loadBundle(path: string): Promise<LoadedBundle>` — accepts a `.zip` or an unpacked directory
  - `interface LoadedBundle { manifest: RaidrManifest; requests: CapturedRequest[]; frames: CapturedFrame[]; gaps: Gap[]; redaction: RedactionEntry[]; sourceMaps: Record<string,string>; runtime: RuntimeArtifacts; content: Map<string, Uint8Array>; text(hash: string): string | null; json(hash: string): unknown }`

Stage 1. Reads `gaps.json` first so every later stage knows what is missing.

- [ ] **Step 1: Write the failing test**

```ts
// tests/bundle/load.test.ts
import { expect, test } from 'bun:test';
import { loadBundle } from '../../src/bundle/load';

const REACT = `${import.meta.dir}/../../fixtures/bundles/react-sample.zip`;

test('loads a real captured bundle from a zip', async () => {
  const bundle = await loadBundle(REACT);
  expect(bundle.manifest.formatVersion).toBe(1);
  expect(bundle.manifest.stack?.framework).toBe('react');
  expect(bundle.requests.length).toBeGreaterThan(5);
});

test('resolves body hashes to text', async () => {
  const bundle = await loadBundle(REACT);
  const apiCall = bundle.requests.find((r) => r.url.includes('/api/users'));
  expect(apiCall).toBeDefined();
  const body = bundle.json(apiCall!.responseBodyHash!);
  expect(body).toBeDefined();
});

test('returns null for an unknown hash rather than throwing', async () => {
  const bundle = await loadBundle(REACT);
  expect(bundle.text('nonexistent')).toBeNull();
});

test('rejects a bundle whose formatVersion is unsupported', async () => {
  await expect(loadBundle(`${import.meta.dir}/fixtures/badversion`)).rejects.toThrow(
    /formatVersion/
  );
});

test('exposes gaps so later stages can see what is missing', async () => {
  const bundle = await loadBundle(REACT);
  expect(Array.isArray(bundle.gaps)).toBe(true);
});
```

Also create `tests/bundle/fixtures/badversion/raidr.json` containing
`{"formatVersion": 99, "sessionId": "x", "origin": "https://x", "startedAt": "", "counts": {}}`.

- [ ] **Step 2: Run to verify it fails**

Run: `cd ~/projects/raidr_cli && bun test tests/bundle/load.test.ts`
Expected: FAIL — cannot resolve `../../src/bundle/load`

- [ ] **Step 3: Write `src/bundle/load.ts`**

```ts
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { unzipSync } from 'fflate';
import {
  parseJsonl,
  validateManifest,
  type CapturedFrame,
  type CapturedRequest,
  type Gap,
  type RedactionEntry,
  type RuntimeArtifacts,
  type RaidrManifest,
} from '@sudobility/raidr_processor';

export interface LoadedBundle {
  manifest: RaidrManifest;
  requests: CapturedRequest[];
  frames: CapturedFrame[];
  gaps: Gap[];
  redaction: RedactionEntry[];
  sourceMaps: Record<string, string>;
  runtime: RuntimeArtifacts;
  content: Map<string, Uint8Array>;
  text(hash: string): string | null;
  json(hash: string): unknown;
}

const decoder = new TextDecoder();

async function readTree(dir: string, prefix = ''): Promise<Map<string, Uint8Array>> {
  const files = new Map<string, Uint8Array>();
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      for (const [k, v] of await readTree(abs, rel)) files.set(k, v);
    } else {
      files.set(rel, new Uint8Array(await readFile(abs)));
    }
  }
  return files;
}

export async function loadBundle(path: string): Promise<LoadedBundle> {
  const info = await stat(path);
  const files = info.isDirectory()
    ? await readTree(path)
    : new Map(
        Object.entries(unzipSync(new Uint8Array(await readFile(path)))).map(
          ([k, v]) => [k, v] as const
        )
      );

  const readText = (name: string): string | null => {
    const bytes = files.get(name);
    return bytes ? decoder.decode(bytes) : null;
  };
  const readJson = <T>(name: string, fallback: T): T => {
    const text = readText(name);
    return text === null ? fallback : (JSON.parse(text) as T);
  };

  const manifestText = readText('raidr.json');
  if (manifestText === null) throw new Error(`${path}: raidr.json not found`);

  const validation = validateManifest(JSON.parse(manifestText));
  if (!validation.ok) {
    throw new Error(`${path}: invalid bundle — ${validation.errors.join('; ')}`);
  }

  // Gaps first: everything downstream must know what is missing before it
  // starts reasoning about what is present.
  const gaps = readJson<Gap[]>('gaps.json', []);

  const content = new Map<string, Uint8Array>();
  for (const [name, bytes] of files) {
    if (!name.startsWith('content/')) continue;
    const hash = name.slice('content/'.length).split('.')[0];
    if (hash) content.set(hash, bytes);
  }
  for (const [name, bytes] of files) {
    if (!name.startsWith('sourcemaps/') || !name.endsWith('.map')) continue;
    const hash = name.slice('sourcemaps/'.length, -'.map'.length);
    content.set(hash, bytes);
  }

  const text = (hash: string): string | null => {
    const bytes = content.get(hash);
    return bytes ? decoder.decode(bytes) : null;
  };

  return {
    manifest: validation.manifest,
    requests: parseJsonl<CapturedRequest>(readText('network/requests.jsonl') ?? ''),
    frames: parseJsonl<CapturedFrame>(readText('network/websockets.jsonl') ?? ''),
    gaps,
    redaction: readJson<RedactionEntry[]>('redaction.json', []),
    sourceMaps: readJson<Record<string, string>>('sourcemaps/index.json', {}),
    runtime: {
      framework: readJson('runtime/framework.json', null),
      routes: readJson('runtime/routes.json', []),
      stores: readJson('runtime/stores.json', []),
      chunks: readJson('runtime/chunks.json', { known: [], loaded: [] }),
      coverage: readJson('runtime/coverage.json', {}),
    },
    content,
    text,
    json(hash: string): unknown {
      const raw = text(hash);
      if (raw === null) return undefined;
      try {
        return JSON.parse(raw);
      } catch {
        return undefined;
      }
    },
  };
}
```

- [ ] **Step 4: Write a minimal `src/cli.ts`**

```ts
#!/usr/bin/env bun
const [command] = process.argv.slice(2);

if (command !== 'reconstruct') {
  console.error('usage: raidr reconstruct <bundle.zip|dir> --out <dir>');
  process.exit(1);
}

const { runReconstruct } = await import('./commands/reconstruct');
await runReconstruct(process.argv.slice(3));
```

**Correction:** do not create `cli.ts` in this task. Its dynamic import of
`./commands/reconstruct` does not typecheck until Task 32 creates that module,
which would break the verification gate on every task in between. Create
`cli.ts` in Task 32 alongside the command it dispatches to.

- [ ] **Step 5: Verify and commit**

```bash
cd ~/projects/raidr_cli && bun test tests/bundle/load.test.ts && bun run typecheck
git add -A && git commit -m "feat: bundle loader reading zips and directories"
```

---

### Task 23: Source-map recovery

**Files:**
- Create: `~/projects/raidr_processor/src/analysis/sourceMap.ts`
- Modify: `~/projects/raidr_processor/src/index.ts`
- Test: `~/projects/raidr_processor/tests/analysis/sourceMap.test.ts`

**Interfaces:**
- Produces:
  - `parseSourceMap(text: string): SourceMap | null`
  - `recoverSources(map: SourceMap): RecoveredFile[]` — `{ path: string; content: string }`
  - `recoveryRatio(input: { mappedBytes: number; totalBytes: number }): number`
  - `normalizeSourcePath(source: string): string`

Stage 2, and the decision point of the whole pipeline: above 80 percent
recovery the reconstruction emits real original files instead of inferring.

- [ ] **Step 1: Write the failing test**

```ts
// tests/analysis/sourceMap.test.ts
import { expect, test } from 'bun:test';
import {
  parseSourceMap,
  recoverSources,
  recoveryRatio,
  normalizeSourcePath,
} from '../../src/analysis/sourceMap';

const MAP = JSON.stringify({
  version: 3,
  file: 'app.js',
  sources: ['../../src/App.tsx', 'webpack://app/./src/main.tsx', 'src/util.ts'],
  sourcesContent: [
    'export const App = () => null;',
    'import "./App";',
    null,
  ],
  mappings: 'AAAA',
});

test('parses a valid source map', () => {
  const map = parseSourceMap(MAP);
  expect(map).not.toBeNull();
  expect(map!.sources).toHaveLength(3);
});

test('returns null for non-JSON and for the wrong version', () => {
  expect(parseSourceMap('<!doctype html>')).toBeNull();
  expect(parseSourceMap(JSON.stringify({ version: 2, sources: [] }))).toBeNull();
});

test('recovers only sources that carry content', () => {
  const files = recoverSources(parseSourceMap(MAP)!);
  expect(files).toHaveLength(2);
  expect(files[0]!.content).toContain('export const App');
});

test('normalizes bundler-specific source paths', () => {
  expect(normalizeSourcePath('../../src/App.tsx')).toBe('src/App.tsx');
  expect(normalizeSourcePath('webpack://app/./src/main.tsx')).toBe('src/main.tsx');
  expect(normalizeSourcePath('/src/util.ts')).toBe('src/util.ts');
  expect(normalizeSourcePath('src/util.ts')).toBe('src/util.ts');
});

test('strips node_modules sources — they are dependencies, not app code', () => {
  const map = parseSourceMap(
    JSON.stringify({
      version: 3,
      sources: ['../node_modules/react/index.js', '../src/App.tsx'],
      sourcesContent: ['module.exports = {};', 'export const App = 1;'],
      mappings: 'AAAA',
    })
  )!;
  const files = recoverSources(map);
  expect(files).toHaveLength(1);
  expect(files[0]!.path).toBe('src/App.tsx');
});

test('recovery ratio drives the recovery-mode decision', () => {
  expect(recoveryRatio({ mappedBytes: 900, totalBytes: 1000 })).toBe(90);
  expect(recoveryRatio({ mappedBytes: 0, totalBytes: 1000 })).toBe(0);
  expect(recoveryRatio({ mappedBytes: 0, totalBytes: 0 })).toBe(0);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd ~/projects/raidr_processor && bun test tests/analysis/sourceMap.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write `src/analysis/sourceMap.ts`**

```ts
export interface SourceMap {
  version: 3;
  file?: string;
  sources: string[];
  sourcesContent?: Array<string | null>;
  mappings: string;
}

export interface RecoveredFile {
  path: string;
  content: string;
}

export function parseSourceMap(text: string): SourceMap | null {
  try {
    const parsed = JSON.parse(text) as Partial<SourceMap>;
    if (parsed.version !== 3 || !Array.isArray(parsed.sources)) return null;
    return parsed as SourceMap;
  } catch {
    return null;
  }
}

/**
 * Bundlers write source paths in several dialects: relative walk-ups, a
 * `webpack://` protocol, absolute roots. Reduce them all to a repo-relative
 * path so recovered files can be written to a tree.
 */
export function normalizeSourcePath(source: string): string {
  let path = source;

  const protocol = path.indexOf('://');
  if (protocol >= 0) {
    path = path.slice(protocol + 3);
    // webpack://<project-name>/./src/... — drop the project segment.
    const firstSlash = path.indexOf('/');
    if (firstSlash >= 0) path = path.slice(firstSlash + 1);
  }

  path = path.replace(/^(\.\.\/)+/, '').replace(/^\.\//, '').replace(/^\/+/, '');
  return path;
}

export function recoverSources(map: SourceMap): RecoveredFile[] {
  const contents = map.sourcesContent ?? [];
  const files: RecoveredFile[] = [];

  map.sources.forEach((source, index) => {
    const content = contents[index];
    if (typeof content !== 'string' || content.length === 0) return;
    // Dependencies are not the app; recovering them would bury the real code.
    if (source.includes('node_modules')) return;
    files.push({ path: normalizeSourcePath(source), content });
  });

  return files;
}

export function recoveryRatio(input: {
  mappedBytes: number;
  totalBytes: number;
}): number {
  if (input.totalBytes === 0) return 0;
  return Math.round((input.mappedBytes / input.totalBytes) * 100);
}
```

- [ ] **Step 4: Export, verify, commit**

Add exports to `src/index.ts`, then:

```bash
cd ~/projects/raidr_processor && bun test && bun run typecheck && bun run build
git add -A && git commit -m "feat: source-map parsing and original-source recovery"
```

---

### Task 24: Chunk beautification

**Files:**
- Create: `~/projects/raidr_cli/src/stages/unpack.ts`
- Test: `~/projects/raidr_cli/tests/stages/unpack.test.ts`

**Interfaces:**
- Produces:
  - `beautify(source: string): Promise<string>`
  - `splitWebpackModules(source: string): Array<{ id: string; source: string }>`
  - `unpackChunks(bundle: LoadedBundle): Promise<UnpackedChunk[]>`

Stage 3 — the fallback path, used only where source maps are absent.

**Known limitation, stated up front:** webpack chunks carry an explicit module
registry that can be split by id. Vite/Rollup chunks are flat ES modules with
no such structure; splitting them would need a full AST pass. For those we
beautify and stop, and record `splittable: false` so the skill knows it is
reading a whole chunk rather than a module. Pretending otherwise would produce
confident nonsense.

- [ ] **Step 1: Write the failing test**

```ts
// tests/stages/unpack.test.ts
import { expect, test } from 'bun:test';
import { beautify, splitWebpackModules } from '../../src/stages/unpack';

test('beautifies minified javascript', async () => {
  const out = await beautify('const a=1;function b(){return a+1}');
  expect(out).toContain('function b()');
  expect(out.split('\n').length).toBeGreaterThan(1);
});

test('returns the original source when it cannot be parsed', async () => {
  const broken = 'const = = =';
  expect(await beautify(broken)).toBe(broken);
});

test('splits a webpack module registry by id', () => {
  const chunk =
    '(self.webpackChunk=self.webpackChunk||[]).push([[47],{' +
    '312:(e,t,n)=>{n.d(t,{A:()=>r});const r=1},' +
    '918:(e,t,n)=>{t.A=2}' +
    '}]);';
  const modules = splitWebpackModules(chunk);
  expect(modules.map((m) => m.id)).toEqual(['312', '918']);
  expect(modules[0]!.source).toContain('n.d(t,');
});

test('returns no modules for a flat rollup chunk', () => {
  expect(splitWebpackModules('import{a}from"./x.js";export const b=a+1;')).toEqual([]);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd ~/projects/raidr_cli && bun test tests/stages/unpack.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write `src/stages/unpack.ts`**

```ts
import prettier from 'prettier';
import type { LoadedBundle } from '../bundle/load';

export interface UnpackedChunk {
  url: string;
  hash: string;
  source: string;
  splittable: boolean;
  modules: Array<{ id: string; source: string }>;
}

export async function beautify(source: string): Promise<string> {
  try {
    return await prettier.format(source, {
      parser: 'babel',
      semi: true,
      singleQuote: true,
    });
  } catch {
    // Minified output is sometimes not parseable as standalone script text.
    // Returning it unchanged keeps the bytes available to the reader.
    return source;
  }
}

/**
 * webpack emits `{ <id>: (module, exports, require) => { ... } }`. Scanning for
 * `<id>:` at brace depth 1 recovers module boundaries without an AST.
 */
export function splitWebpackModules(
  source: string
): Array<{ id: string; source: string }> {
  const start = source.search(/\{\s*\d+\s*:\s*(\(|function)/);
  if (start < 0) return [];

  const modules: Array<{ id: string; source: string }> = [];
  let depth = 0;
  let currentId: string | null = null;
  let bodyStart = 0;
  let inString: string | null = null;
  let escaped = false;

  for (let i = start; i < source.length; i += 1) {
    const char = source[i]!;

    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (inString) {
      if (char === inString) inString = null;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      inString = char;
      continue;
    }

    if (char === '{') {
      depth += 1;
      continue;
    }
    if (char === '}') {
      depth -= 1;
      if (depth === 1 && currentId !== null) {
        modules.push({ id: currentId, source: source.slice(bodyStart, i + 1) });
        currentId = null;
      }
      if (depth === 0) break;
      continue;
    }

    if (depth === 1 && currentId === null) {
      const ahead = source.slice(i);
      const match = /^(\d+)\s*:/.exec(ahead);
      if (match) {
        currentId = match[1]!;
        bodyStart = i + match[0].length;
        i += match[0].length - 1;
      }
    }
  }

  return modules;
}

export async function unpackChunks(bundle: LoadedBundle): Promise<UnpackedChunk[]> {
  const chunks: UnpackedChunk[] = [];

  for (const request of bundle.requests) {
    if (!request.mimeType?.includes('javascript')) continue;
    if (!request.responseBodyHash) continue;
    const source = bundle.text(request.responseBodyHash);
    if (source === null) continue;

    const modules = splitWebpackModules(source);
    chunks.push({
      url: request.url,
      hash: request.responseBodyHash,
      source: await beautify(source),
      splittable: modules.length > 0,
      modules: await Promise.all(
        modules.map(async (m) => ({ id: m.id, source: await beautify(m.source) }))
      ),
    });
  }

  return chunks;
}
```

- [ ] **Step 4: Verify and commit**

```bash
cd ~/projects/raidr_cli && bun test && bun run typecheck
git add -A && git commit -m "feat: chunk beautification and webpack module splitting"
```

---

### Task 25: JSON Schema inference

The core algorithm of the whole analysis half. Everything typed downstream —
the client, the types, the replay server — rests on this being right.

**Files:**
- Create: `~/projects/raidr_processor/src/analysis/schema.ts`
- Modify: `~/projects/raidr_processor/src/index.ts`
- Test: `~/projects/raidr_processor/tests/analysis/schema.test.ts`

**Interfaces:**
- Produces:
  - `type JsonSchema`
  - `inferSchema(samples: unknown[]): JsonSchema`
  - `unifySchemas(a: JsonSchema, b: JsonSchema): JsonSchema`

- [ ] **Step 1: Write the failing test**

```ts
// tests/analysis/schema.test.ts
import { expect, test } from 'bun:test';
import { inferSchema } from '../../src/analysis/schema';

test('infers primitive types', () => {
  expect(inferSchema(['a'])).toEqual({ type: 'string' });
  expect(inferSchema([1])).toEqual({ type: 'integer' });
  expect(inferSchema([1.5])).toEqual({ type: 'number' });
  expect(inferSchema([true])).toEqual({ type: 'boolean' });
  expect(inferSchema([null])).toEqual({ type: 'null' });
});

test('an integer sample followed by a float widens to number', () => {
  expect(inferSchema([1, 2.5])).toEqual({ type: 'number' });
});

test('infers object properties and marks all present fields required', () => {
  const schema = inferSchema([{ id: 1, name: 'a' }]);
  expect(schema).toEqual({
    type: 'object',
    properties: { id: { type: 'integer' }, name: { type: 'string' } },
    required: ['id', 'name'],
  });
});

test('a field missing from any sample becomes optional', () => {
  const schema = inferSchema([
    { id: 1, nickname: 'x' },
    { id: 2 },
  ]) as { required: string[]; properties: Record<string, unknown> };
  expect(schema.required).toEqual(['id']);
  expect(Object.keys(schema.properties).sort()).toEqual(['id', 'nickname']);
});

test('infers array element schemas by unifying elements', () => {
  const schema = inferSchema([[{ id: 1 }, { id: 2 }]]);
  expect(schema).toEqual({
    type: 'array',
    items: {
      type: 'object',
      properties: { id: { type: 'integer' } },
      required: ['id'],
    },
  });
});

test('an empty array yields an unknown element type rather than guessing', () => {
  expect(inferSchema([[]])).toEqual({ type: 'array', items: { type: 'unknown' } });
});

test('a string field with few distinct values across many samples becomes an enum', () => {
  const samples = Array.from({ length: 10 }, (_, i) => ({
    role: i % 2 === 0 ? 'admin' : 'member',
  }));
  const schema = inferSchema(samples) as {
    properties: { role: { type: string; enum?: string[] } };
  };
  expect(schema.properties.role.enum?.sort()).toEqual(['admin', 'member']);
});

test('a string field with many distinct values stays a plain string', () => {
  const samples = Array.from({ length: 10 }, (_, i) => ({ name: `name-${i}` }));
  const schema = inferSchema(samples) as {
    properties: { name: { type: string; enum?: string[] } };
  };
  expect(schema.properties.name.enum).toBeUndefined();
});

test('null alongside a type becomes a nullable union', () => {
  const schema = inferSchema([{ deletedAt: null }, { deletedAt: '2026-01-01' }]) as {
    properties: { deletedAt: { anyOf?: Array<{ type: string }> } };
  };
  const kinds = schema.properties.deletedAt.anyOf?.map((s) => s.type).sort();
  expect(kinds).toEqual(['null', 'string']);
});

test('genuinely different shapes become a union, not a merged mess', () => {
  const schema = inferSchema([
    { error: 'unauthorized', code: 401 },
    { id: 1, email: 'a@b.c' },
  ]) as { anyOf?: unknown[] };
  expect(schema.anyOf).toHaveLength(2);
});

test('unification is order-independent', () => {
  const a = inferSchema([{ id: 1 }, { id: 2, extra: true }]);
  const b = inferSchema([{ id: 2, extra: true }, { id: 1 }]);
  expect(a).toEqual(b);
});

test('no samples yields unknown rather than an empty object', () => {
  expect(inferSchema([])).toEqual({ type: 'unknown' });
});

test('deeply nested structures are inferred recursively', () => {
  const schema = inferSchema([
    { user: { profile: { tags: ['a'] } } },
  ]) as Record<string, never>;
  expect(JSON.stringify(schema)).toContain('"tags"');
  expect(JSON.stringify(schema)).toContain('"array"');
});
```

The order-independence test matters: unification that depends on sample order
silently produces different types for the same endpoint on different runs.

- [ ] **Step 2: Run to verify it fails**

Run: `cd ~/projects/raidr_processor && bun test tests/analysis/schema.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write `src/analysis/schema.ts`**

```ts
export type JsonSchema =
  | { type: 'unknown' }
  | { type: 'null' }
  | { type: 'boolean' }
  | { type: 'integer' }
  | { type: 'number' }
  | { type: 'string'; enum?: string[] }
  | { type: 'array'; items: JsonSchema }
  | {
      type: 'object';
      properties: Record<string, JsonSchema>;
      required: string[];
    }
  | { anyOf: JsonSchema[] };

/** A string field is an enum if it stays this narrow across this many samples. */
const ENUM_MAX_DISTINCT = 6;
const ENUM_MIN_SAMPLES = 4;

function schemaOf(value: unknown): JsonSchema {
  if (value === null) return { type: 'null' };
  if (Array.isArray(value)) {
    return {
      type: 'array',
      items: value.length === 0 ? { type: 'unknown' } : inferSchema(value),
    };
  }
  switch (typeof value) {
    case 'boolean':
      return { type: 'boolean' };
    case 'number':
      return Number.isInteger(value) ? { type: 'integer' } : { type: 'number' };
    case 'string':
      return { type: 'string' };
    case 'object': {
      const properties: Record<string, JsonSchema> = {};
      const required: string[] = [];
      for (const [key, child] of Object.entries(value as object)) {
        properties[key] = schemaOf(child);
        required.push(key);
      }
      return { type: 'object', properties, required };
    }
    default:
      return { type: 'unknown' };
  }
}

function kindOf(schema: JsonSchema): string {
  return 'anyOf' in schema ? 'anyOf' : schema.type;
}

export function unifySchemas(a: JsonSchema, b: JsonSchema): JsonSchema {
  if (kindOf(a) === 'unknown') return b;
  if (kindOf(b) === 'unknown') return a;

  // Numeric widening: one float among integers makes the field a number.
  const numeric = new Set(['integer', 'number']);
  if (numeric.has(kindOf(a)) && numeric.has(kindOf(b))) {
    return kindOf(a) === kindOf(b) ? a : { type: 'number' };
  }

  if (kindOf(a) === 'anyOf' || kindOf(b) === 'anyOf') {
    const members = [
      ...('anyOf' in a ? a.anyOf : [a]),
      ...('anyOf' in b ? b.anyOf : [b]),
    ];
    return collapseUnion(members);
  }

  if (kindOf(a) !== kindOf(b)) return collapseUnion([a, b]);

  if (a.type === 'array' && b.type === 'array') {
    return { type: 'array', items: unifySchemas(a.items, b.items) };
  }

  if (a.type === 'object' && b.type === 'object') {
    const properties: Record<string, JsonSchema> = {};
    for (const key of new Set([
      ...Object.keys(a.properties),
      ...Object.keys(b.properties),
    ])) {
      const left = a.properties[key];
      const right = b.properties[key];
      properties[key] =
        left && right ? unifySchemas(left, right) : (left ?? right)!;
    }
    // Required is the intersection: a field absent from any sample is optional.
    const required = a.required
      .filter((key) => b.required.includes(key))
      .sort();
    return { type: 'object', properties: sortKeys(properties), required };
  }

  if (a.type === 'string' && b.type === 'string') {
    if (a.enum && b.enum) {
      return { type: 'string', enum: Array.from(new Set([...a.enum, ...b.enum])).sort() };
    }
    return { type: 'string' };
  }

  return a;
}

/** Deduplicate union members and sort them, so unification is order-independent. */
function collapseUnion(members: JsonSchema[]): JsonSchema {
  const byKey = new Map<string, JsonSchema>();
  for (const member of members) {
    const key = JSON.stringify(member);
    if (!byKey.has(key)) byKey.set(key, member);
  }
  const unique = Array.from(byKey.entries())
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([, schema]) => schema);
  return unique.length === 1 ? unique[0]! : { anyOf: unique };
}

function sortKeys(properties: Record<string, JsonSchema>): Record<string, JsonSchema> {
  const out: Record<string, JsonSchema> = {};
  for (const key of Object.keys(properties).sort()) out[key] = properties[key]!;
  return out;
}

/** Promote narrow string fields to enums, using the full sample set. */
function applyEnums(schema: JsonSchema, samples: unknown[]): JsonSchema {
  if (!('type' in schema) || schema.type !== 'object') return schema;
  if (samples.length < ENUM_MIN_SAMPLES) return schema;

  const objects = samples.filter(
    (s): s is Record<string, unknown> =>
      typeof s === 'object' && s !== null && !Array.isArray(s)
  );

  const properties: Record<string, JsonSchema> = {};
  for (const [key, child] of Object.entries(schema.properties)) {
    if ('type' in child && child.type === 'string') {
      const values = objects
        .map((o) => o[key])
        .filter((v): v is string => typeof v === 'string');
      const distinct = Array.from(new Set(values)).sort();
      properties[key] =
        values.length >= ENUM_MIN_SAMPLES && distinct.length <= ENUM_MAX_DISTINCT
          ? { type: 'string', enum: distinct }
          : child;
      continue;
    }
    if ('type' in child && child.type === 'object') {
      properties[key] = applyEnums(
        child,
        objects.map((o) => o[key])
      );
      continue;
    }
    properties[key] = child;
  }

  return { ...schema, properties: sortKeys(properties) };
}

export function inferSchema(samples: unknown[]): JsonSchema {
  if (samples.length === 0) return { type: 'unknown' };
  const unified = samples
    .map(schemaOf)
    .reduce((acc, next) => unifySchemas(acc, next));
  return applyEnums(unified, samples);
}
```

- [ ] **Step 4: Verify and commit**

```bash
cd ~/projects/raidr_processor && bun test && bun run typecheck && bun run build
git add -A && git commit -m "feat: JSON Schema inference by sample unification"
```

---

### Task 26: API model

**Files:**
- Create: `~/projects/raidr_processor/src/analysis/apiModel.ts`
- Modify: `~/projects/raidr_processor/src/index.ts`
- Test: `~/projects/raidr_processor/tests/analysis/apiModel.test.ts`

**Interfaces:**
- Produces:
  - `buildApiModel(samples: EndpointSample[]): ApiModel`
  - `interface EndpointSample { method: string; url: string; status: number | null; requestBody: unknown; responseBody: unknown; requestHeaders: Record<string,string> }`
  - `interface ApiModel { baseUrl: string | null; endpoints: EndpointModel[] }`
  - `interface EndpointModel { key: string; method: string; template: string; calls: number; auth: 'bearer' | 'cookie' | 'none'; requestSchema: JsonSchema | null; responses: Array<{ status: number; count: number; schema: JsonSchema }> }`

Stage 4. Pure: the CLI resolves body hashes and passes decoded values in.

- [ ] **Step 1: Write the failing test**

```ts
// tests/analysis/apiModel.test.ts
import { expect, test } from 'bun:test';
import { buildApiModel } from '../../src/analysis/apiModel';

function sample(over: Partial<Parameters<typeof buildApiModel>[0][number]> = {}) {
  return {
    method: 'GET',
    url: 'https://api.example.com/api/users/1',
    status: 200,
    requestBody: null,
    responseBody: { id: 1, name: 'Ada' },
    requestHeaders: {},
    ...over,
  };
}

test('clusters calls into templated endpoints', () => {
  const model = buildApiModel([
    sample({ url: 'https://api.example.com/api/users/1' }),
    sample({ url: 'https://api.example.com/api/users/2' }),
  ]);
  expect(model.endpoints).toHaveLength(1);
  expect(model.endpoints[0]!.template).toBe('/api/users/{id}');
  expect(model.endpoints[0]!.calls).toBe(2);
});

test('infers the response schema from all samples of a status', () => {
  const model = buildApiModel([
    sample({ responseBody: { id: 1, name: 'Ada', nickname: 'ada' } }),
    sample({ responseBody: { id: 2, name: 'Alan' } }),
  ]);
  const ok = model.endpoints[0]!.responses.find((r) => r.status === 200)!;
  expect(ok.schema).toMatchObject({ type: 'object', required: ['id', 'name'] });
});

test('keeps distinct statuses as separate response shapes', () => {
  const model = buildApiModel([
    sample({ url: 'https://api.example.com/api/me', status: 200, responseBody: { id: 1 } }),
    sample({
      url: 'https://api.example.com/api/me',
      status: 401,
      responseBody: { error: 'unauthorized' },
    }),
  ]);
  const statuses = model.endpoints[0]!.responses.map((r) => r.status).sort();
  expect(statuses).toEqual([200, 401]);
});

test('detects bearer auth from request headers', () => {
  const model = buildApiModel([
    sample({ requestHeaders: { authorization: '<BEARER:a1b2>' } }),
  ]);
  expect(model.endpoints[0]!.auth).toBe('bearer');
});

test('detects cookie auth', () => {
  const model = buildApiModel([sample({ requestHeaders: { cookie: '<COOKIE:x>' } })]);
  expect(model.endpoints[0]!.auth).toBe('cookie');
});

test('infers a request schema for endpoints with bodies', () => {
  const model = buildApiModel([
    sample({
      method: 'POST',
      url: 'https://api.example.com/api/login',
      requestBody: { email: 'a@b.c', password: '<PASSWORD:x>' },
    }),
  ]);
  expect(model.endpoints[0]!.requestSchema).toMatchObject({ type: 'object' });
});

test('derives the base url from the most common api origin', () => {
  const model = buildApiModel([
    sample({ url: 'https://api.example.com/api/users' }),
    sample({ url: 'https://api.example.com/api/stats' }),
  ]);
  expect(model.baseUrl).toBe('https://api.example.com');
});

test('endpoints are ordered by call count', () => {
  const model = buildApiModel([
    sample({ url: 'https://api.example.com/api/a' }),
    sample({ url: 'https://api.example.com/api/b' }),
    sample({ url: 'https://api.example.com/api/b' }),
  ]);
  expect(model.endpoints[0]!.template).toBe('/api/b');
});

test('ignores samples whose body is not JSON', () => {
  const model = buildApiModel([sample({ responseBody: undefined })]);
  expect(model.endpoints[0]!.responses[0]!.schema).toEqual({ type: 'unknown' });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd ~/projects/raidr_processor && bun test tests/analysis/apiModel.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write `src/analysis/apiModel.ts`**

```ts
import { endpointKey, toPathTemplate } from '../coverage/pathTemplate';
import { inferSchema, type JsonSchema } from './schema';

export interface EndpointSample {
  method: string;
  url: string;
  status: number | null;
  requestBody: unknown;
  responseBody: unknown;
  requestHeaders: Record<string, string>;
}

export interface EndpointModel {
  key: string;
  method: string;
  template: string;
  calls: number;
  auth: 'bearer' | 'cookie' | 'none';
  requestSchema: JsonSchema | null;
  responses: Array<{ status: number; count: number; schema: JsonSchema }>;
}

export interface ApiModel {
  baseUrl: string | null;
  endpoints: EndpointModel[];
}

export function buildApiModel(samples: EndpointSample[]): ApiModel {
  const groups = new Map<
    string,
    {
      method: string;
      template: string;
      calls: number;
      auth: 'bearer' | 'cookie' | 'none';
      requestBodies: unknown[];
      byStatus: Map<number, unknown[]>;
    }
  >();

  const origins = new Map<string, number>();

  for (const sample of samples) {
    let pathname = sample.url;
    try {
      const url = new URL(sample.url);
      pathname = url.pathname;
      origins.set(url.origin, (origins.get(url.origin) ?? 0) + 1);
    } catch {
      // Keep the raw string; endpointKey handles malformed URLs.
    }

    const key = endpointKey(sample.method, sample.url);
    let group = groups.get(key);
    if (!group) {
      group = {
        method: sample.method,
        template: toPathTemplate(pathname),
        calls: 0,
        auth: 'none',
        requestBodies: [],
        byStatus: new Map(),
      };
      groups.set(key, group);
    }

    group.calls += 1;
    if (sample.requestHeaders.authorization) group.auth = 'bearer';
    else if (sample.requestHeaders.cookie && group.auth === 'none') {
      group.auth = 'cookie';
    }
    if (sample.requestBody !== null && sample.requestBody !== undefined) {
      group.requestBodies.push(sample.requestBody);
    }

    const status = sample.status ?? 0;
    const bucket = group.byStatus.get(status) ?? [];
    if (sample.responseBody !== undefined) bucket.push(sample.responseBody);
    group.byStatus.set(status, bucket);
  }

  const endpoints: EndpointModel[] = Array.from(groups.entries())
    .map(([key, group]) => ({
      key,
      method: group.method,
      template: group.template,
      calls: group.calls,
      auth: group.auth,
      requestSchema:
        group.requestBodies.length > 0 ? inferSchema(group.requestBodies) : null,
      responses: Array.from(group.byStatus.entries())
        .map(([status, bodies]) => ({
          status,
          count: bodies.length,
          schema: inferSchema(bodies),
        }))
        .sort((a, b) => a.status - b.status),
    }))
    .sort((a, b) => b.calls - a.calls || (a.key < b.key ? -1 : 1));

  let baseUrl: string | null = null;
  let best = 0;
  for (const [origin, count] of origins) {
    if (count > best) {
      best = count;
      baseUrl = origin;
    }
  }

  return { baseUrl, endpoints };
}
```

- [ ] **Step 4: Verify and commit**

```bash
cd ~/projects/raidr_processor && bun test && bun run typecheck && bun run build
git add -A && git commit -m "feat: API model clustering endpoints with per-status schemas"
```

---

### Task 27: Route model

**Files:**
- Create: `~/projects/raidr_processor/src/analysis/routeModel.ts`
- Modify: `~/projects/raidr_processor/src/index.ts`, `~/projects/raidr_cli/src/capture/harness.ts`
- Test: `~/projects/raidr_processor/tests/analysis/routeModel.test.ts`

**Interfaces:**
- Produces:
  - `buildRouteModel(input: RouteModelInput): RouteModel`
  - `interface RouteModel { routes: Array<{ path: string; params: string[]; visited: boolean; endpoints: string[]; lazy: boolean }>; unattributed: string[] }`

Stage 5. Joins the router table to the request timeline by `navigationId`, so
each route carries the endpoints that fired while it was mounted.

**Harness correction:** Task 21 wrote `navigationId: null` on every row. Fix it
now — track an incrementing id per `page.goto` and stamp rows with the current
value, exactly as the extension does. Without it this stage has nothing to join
on and every endpoint lands in `unattributed`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/analysis/routeModel.test.ts
import { expect, test } from 'bun:test';
import { buildRouteModel } from '../../src/analysis/routeModel';

test('extracts params from route patterns', () => {
  const model = buildRouteModel({
    routes: ['/users/:id', '/posts/:postId/comments/:commentId'],
    navigations: [],
    requests: [],
  });
  expect(model.routes[0]!.params).toEqual(['id']);
  expect(model.routes[1]!.params).toEqual(['postId', 'commentId']);
});

test('attributes endpoints to the route mounted when they fired', () => {
  const model = buildRouteModel({
    routes: ['/', '/users'],
    navigations: [
      { navigationId: 'nav1', path: '/' },
      { navigationId: 'nav2', path: '/users' },
    ],
    requests: [
      { method: 'GET', url: 'https://x.com/api/me', navigationId: 'nav1' },
      { method: 'GET', url: 'https://x.com/api/users', navigationId: 'nav2' },
    ],
  });
  const users = model.routes.find((r) => r.path === '/users')!;
  expect(users.endpoints).toEqual(['GET /api/users']);
  expect(users.visited).toBe(true);
});

test('a route never navigated to is unvisited with no endpoints', () => {
  const model = buildRouteModel({
    routes: ['/', '/admin'],
    navigations: [{ navigationId: 'nav1', path: '/' }],
    requests: [],
  });
  expect(model.routes.find((r) => r.path === '/admin')!.visited).toBe(false);
});

test('matches a concrete navigation path against a parameterised route', () => {
  const model = buildRouteModel({
    routes: ['/users/:id'],
    navigations: [{ navigationId: 'nav1', path: '/users/1138' }],
    requests: [
      { method: 'GET', url: 'https://x.com/api/users/1138', navigationId: 'nav1' },
    ],
  });
  expect(model.routes[0]!.visited).toBe(true);
  expect(model.routes[0]!.endpoints).toEqual(['GET /api/users/{id}']);
});

test('requests with no navigation land in unattributed rather than being dropped', () => {
  const model = buildRouteModel({
    routes: ['/'],
    navigations: [],
    requests: [{ method: 'GET', url: 'https://x.com/api/boot', navigationId: null }],
  });
  expect(model.unattributed).toEqual(['GET /api/boot']);
});

test('static asset requests are not treated as endpoints', () => {
  const model = buildRouteModel({
    routes: ['/'],
    navigations: [{ navigationId: 'nav1', path: '/' }],
    requests: [
      { method: 'GET', url: 'https://x.com/assets/app.js', navigationId: 'nav1' },
      { method: 'GET', url: 'https://x.com/api/me', navigationId: 'nav1' },
    ],
  });
  expect(model.routes[0]!.endpoints).toEqual(['GET /api/me']);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd ~/projects/raidr_processor && bun test tests/analysis/routeModel.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write `src/analysis/routeModel.ts`**

```ts
import { endpointKey } from '../coverage/pathTemplate';

export interface RouteModelInput {
  routes: string[];
  navigations: Array<{ navigationId: string; path: string }>;
  requests: Array<{ method: string; url: string; navigationId: string | null }>;
}

export interface RouteModel {
  routes: Array<{
    path: string;
    params: string[];
    visited: boolean;
    endpoints: string[];
    lazy: boolean;
  }>;
  unattributed: string[];
}

const ASSET_RE = /\.(js|mjs|css|map|png|jpe?g|gif|svg|webp|woff2?|ico|txt)$/i;

function paramsOf(pattern: string): string[] {
  return Array.from(pattern.matchAll(/:([A-Za-z0-9_]+)/g)).map((m) => m[1]!);
}

/** Does a concrete path match a route pattern with `:param` segments? */
function matches(pattern: string, path: string): boolean {
  const patternParts = pattern.split('/').filter(Boolean);
  const pathParts = path.split('/').filter(Boolean);
  if (patternParts.length !== pathParts.length) return false;
  return patternParts.every(
    (part, i) => part.startsWith(':') || part === pathParts[i]
  );
}

function isApiCall(url: string): boolean {
  try {
    return !ASSET_RE.test(new URL(url).pathname);
  } catch {
    return !ASSET_RE.test(url);
  }
}

export function buildRouteModel(input: RouteModelInput): RouteModel {
  const byNavigation = new Map<string, string[]>();
  const unattributed: string[] = [];

  for (const request of input.requests) {
    if (!isApiCall(request.url)) continue;
    const key = endpointKey(request.method, request.url);
    if (request.navigationId === null) {
      if (!unattributed.includes(key)) unattributed.push(key);
      continue;
    }
    const bucket = byNavigation.get(request.navigationId) ?? [];
    if (!bucket.includes(key)) bucket.push(key);
    byNavigation.set(request.navigationId, bucket);
  }

  const routes = input.routes.map((path) => {
    const navigations = input.navigations.filter((nav) => matches(path, nav.path));
    const endpoints: string[] = [];
    for (const nav of navigations) {
      for (const key of byNavigation.get(nav.navigationId) ?? []) {
        if (!endpoints.includes(key)) endpoints.push(key);
      }
    }
    return {
      path,
      params: paramsOf(path),
      visited: navigations.length > 0,
      endpoints,
      // Any route below the root is a lazy-chunk candidate; the chunk
      // manifest confirms it during codegen.
      lazy: path !== '/' && path.length > 1,
    };
  });

  return { routes, unattributed };
}
```

- [ ] **Step 4: Stamp navigation ids in the harness**

In `raidr_cli/src/capture/harness.ts`, add a counter and a navigations array:

```ts
  let navigationCounter = 0;
  let currentNavigationId: string | null = null;
  const navigations: Array<{ navigationId: string; path: string }> = [];
```

Set them inside the route loop, before `page.goto`:

```ts
    navigationCounter += 1;
    currentNavigationId = `nav${navigationCounter}`;
    navigations.push({ navigationId: currentNavigationId, path: route });
```

Change the row construction from `navigationId: null` to
`navigationId: currentNavigationId`, and pass `navigations` through the bundle.

In `raidr_processor/src/bundle/assemble.ts`, add the field to `RuntimeArtifacts` and
write the file:

```ts
export interface RuntimeArtifacts {
  framework: unknown;
  routes: unknown;
  stores: unknown;
  chunks: unknown;
  coverage: unknown;
  navigations: unknown;
}
```

and in `buildBundleFiles`, alongside the other runtime entries:

```ts
    'runtime/navigations.json': json(input.runtime.navigations ?? []),
```

Then add `navigations: []` to the extension's `SessionState.bundleInput()`
runtime object and `navigations` to the harness's, so both producers satisfy the
type. In `raidr_cli/src/bundle/load.ts`, read it back:

```ts
      navigations: readJson('runtime/navigations.json', []),
```

- [ ] **Step 5: Regenerate fixtures and verify**

```bash
cd ~/projects/raidr_processor && bun test && bun run build
cd ~/projects/raidr_cli && bun run fixtures:capture && bun test && bun run typecheck
```
Expected: fixtures rebuilt with populated `navigationId`; all tests PASS

- [ ] **Step 6: Commit both repos**

```bash
cd ~/projects/raidr_processor && git add -A && git commit -m "feat: route model joining router table to request timeline"
cd ~/projects/raidr_cli && git add -A && git commit -m "feat: stamp navigation ids during fixture capture"
```

---
# Milestone 7 — Codegen (stages 6–7)

All generators are pure `(model) => string` functions in `raidr_processor`. The CLI
writes their output to disk. Emitted source is formatted with Prettier by the
CLI, so generators may emit readable-but-unformatted code.

### Task 28: TypeScript types from schemas

**Files:**
- Create: `~/projects/raidr_processor/src/codegen/types.ts`
- Modify: `~/projects/raidr_processor/src/index.ts`
- Test: `~/projects/raidr_processor/tests/codegen/types.test.ts`

**Interfaces:**
- Produces:
  - `schemaToType(schema: JsonSchema): string` — an inline type expression
  - `declareType(name: string, schema: JsonSchema): string` — a full `export interface` / `export type`
  - `typeNameFor(method: string, template: string, suffix: string): string`

- [ ] **Step 1: Write the failing test**

```ts
// tests/codegen/types.test.ts
import { expect, test } from 'bun:test';
import { schemaToType, declareType, typeNameFor } from '../../src/codegen/types';

test('maps primitives', () => {
  expect(schemaToType({ type: 'string' })).toBe('string');
  expect(schemaToType({ type: 'integer' })).toBe('number');
  expect(schemaToType({ type: 'number' })).toBe('number');
  expect(schemaToType({ type: 'boolean' })).toBe('boolean');
  expect(schemaToType({ type: 'null' })).toBe('null');
  expect(schemaToType({ type: 'unknown' })).toBe('unknown');
});

test('emits string enums as literal unions', () => {
  expect(schemaToType({ type: 'string', enum: ['admin', 'member'] })).toBe(
    "'admin' | 'member'"
  );
});

test('emits arrays', () => {
  expect(schemaToType({ type: 'array', items: { type: 'string' } })).toBe('string[]');
});

test('emits objects with optional markers on non-required fields', () => {
  const out = schemaToType({
    type: 'object',
    properties: { id: { type: 'integer' }, nickname: { type: 'string' } },
    required: ['id'],
  });
  expect(out).toContain('id: number');
  expect(out).toContain('nickname?: string');
});

test('quotes keys that are not valid identifiers', () => {
  const out = schemaToType({
    type: 'object',
    properties: { 'content-type': { type: 'string' } },
    required: ['content-type'],
  });
  expect(out).toContain("'content-type': string");
});

test('emits unions', () => {
  expect(schemaToType({ anyOf: [{ type: 'string' }, { type: 'null' }] })).toBe(
    'string | null'
  );
});

test('declareType emits an exported interface for objects', () => {
  const out = declareType('User', {
    type: 'object',
    properties: { id: { type: 'integer' } },
    required: ['id'],
  });
  expect(out.startsWith('export interface User {')).toBe(true);
});

test('declareType emits a type alias for non-objects', () => {
  expect(declareType('Ids', { type: 'array', items: { type: 'integer' } })).toBe(
    'export type Ids = number[];'
  );
});

test('derives PascalCase names from method and template', () => {
  expect(typeNameFor('GET', '/api/users/{id}', 'Response')).toBe('GetApiUsersByIdResponse');
  expect(typeNameFor('POST', '/api/login', 'Request')).toBe('PostApiLoginRequest');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd ~/projects/raidr_processor && bun test tests/codegen/types.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write `src/codegen/types.ts`**

```ts
import type { JsonSchema } from '../analysis/schema';

const IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

export function schemaToType(schema: JsonSchema): string {
  if ('anyOf' in schema) {
    return schema.anyOf.map(schemaToType).join(' | ');
  }

  switch (schema.type) {
    case 'string':
      return schema.enum && schema.enum.length > 0
        ? schema.enum.map((value) => `'${value.replace(/'/g, "\\'")}'`).join(' | ')
        : 'string';
    case 'integer':
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'null':
      return 'null';
    case 'array':
      return `${wrap(schemaToType(schema.items))}[]`;
    case 'object': {
      const fields = Object.entries(schema.properties).map(([key, child]) => {
        const name = IDENTIFIER_RE.test(key) ? key : `'${key}'`;
        const optional = schema.required.includes(key) ? '' : '?';
        return `  ${name}${optional}: ${schemaToType(child)};`;
      });
      return fields.length === 0
        ? 'Record<string, never>'
        : `{\n${fields.join('\n')}\n}`;
    }
    default:
      return 'unknown';
  }
}

/** Parenthesise union members before `[]` so `(a | b)[]` is not `a | b[]`. */
function wrap(type: string): string {
  return type.includes(' | ') ? `(${type})` : type;
}

export function declareType(name: string, schema: JsonSchema): string {
  if ('type' in schema && schema.type === 'object') {
    return `export interface ${name} ${schemaToType(schema)}`;
  }
  return `export type ${name} = ${schemaToType(schema)};`;
}

export function typeNameFor(
  method: string,
  template: string,
  suffix: string
): string {
  const segments = template
    .split('/')
    .filter(Boolean)
    .map((segment) => {
      const param = /^\{(.+)\}$/.exec(segment);
      return param ? `By${pascal(param[1]!)}` : pascal(segment);
    });
  return `${pascal(method.toLowerCase())}${segments.join('')}${suffix}`;
}

function pascal(input: string): string {
  return input
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join('');
}
```

- [ ] **Step 4: Verify and commit**

```bash
cd ~/projects/raidr_processor && bun test && bun run typecheck && bun run build
git add -A && git commit -m "feat: JSON Schema to TypeScript code generation"
```

---

### Task 29: Typed API client generation

**Files:**
- Create: `~/projects/raidr_processor/src/codegen/client.ts`
- Modify: `~/projects/raidr_processor/src/index.ts`
- Test: `~/projects/raidr_processor/tests/codegen/client.test.ts`

**Interfaces:**
- Produces:
  - `generateTypes(model: ApiModel): string` — the whole `types.ts` file
  - `generateClient(model: ApiModel): string` — the whole `client.ts` file
  - `methodNameFor(method: string, template: string): string`

The generated client takes a `fetch`-shaped function by injection, matching the
NetworkClient convention used across the workspace, so it is testable without a
server.

- [ ] **Step 1: Write the failing test**

```ts
// tests/codegen/client.test.ts
import { expect, test } from 'bun:test';
import { generateClient, generateTypes, methodNameFor } from '../../src/codegen/client';
import type { ApiModel } from '../../src/analysis/apiModel';

const MODEL: ApiModel = {
  baseUrl: 'https://api.example.com',
  endpoints: [
    {
      key: 'GET /api/users',
      method: 'GET',
      template: '/api/users',
      calls: 3,
      auth: 'bearer',
      requestSchema: null,
      responses: [
        {
          status: 200,
          count: 3,
          schema: {
            type: 'object',
            properties: {
              users: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: { id: { type: 'integer' } },
                  required: ['id'],
                },
              },
            },
            required: ['users'],
          },
        },
      ],
    },
    {
      key: 'GET /api/users/{id}',
      method: 'GET',
      template: '/api/users/{id}',
      calls: 2,
      auth: 'bearer',
      requestSchema: null,
      responses: [
        {
          status: 200,
          count: 2,
          schema: {
            type: 'object',
            properties: { id: { type: 'integer' } },
            required: ['id'],
          },
        },
      ],
    },
    {
      key: 'POST /api/login',
      method: 'POST',
      template: '/api/login',
      calls: 1,
      auth: 'none',
      requestSchema: {
        type: 'object',
        properties: { email: { type: 'string' } },
        required: ['email'],
      },
      responses: [
        {
          status: 200,
          count: 1,
          schema: {
            type: 'object',
            properties: { access_token: { type: 'string' } },
            required: ['access_token'],
          },
        },
      ],
    },
  ],
};

test('derives readable method names', () => {
  expect(methodNameFor('GET', '/api/users')).toBe('getApiUsers');
  expect(methodNameFor('GET', '/api/users/{id}')).toBe('getApiUsersById');
  expect(methodNameFor('POST', '/api/login')).toBe('postApiLogin');
});

test('declares a response type per endpoint', () => {
  const out = generateTypes(MODEL);
  expect(out).toContain('export interface GetApiUsersResponse');
  expect(out).toContain('export interface PostApiLoginRequest');
});

test('generates a method per endpoint with the response type', () => {
  const out = generateClient(MODEL);
  expect(out).toContain('async getApiUsers(): Promise<GetApiUsersResponse>');
});

test('path parameters become typed method arguments', () => {
  const out = generateClient(MODEL);
  expect(out).toContain('getApiUsersById(id: string | number)');
  expect(out).toContain('`/api/users/${id}`');
});

test('endpoints with a request body take a typed body argument', () => {
  const out = generateClient(MODEL);
  expect(out).toContain('postApiLogin(body: PostApiLoginRequest)');
  expect(out).toContain('JSON.stringify(body)');
});

test('bearer endpoints send the Authorization header', () => {
  const out = generateClient(MODEL);
  expect(out).toContain('Authorization');
  expect(out).toContain('this.token');
});

test('the client injects fetch rather than calling global fetch', () => {
  const out = generateClient(MODEL);
  expect(out).toContain('constructor(');
  expect(out).toContain('fetchFn');
  expect(out).not.toMatch(/[^.]\bfetch\(/);
});

test('the generated base url comes from the model', () => {
  expect(generateClient(MODEL)).toContain('https://api.example.com');
});
```

The injected-`fetch` assertion is deliberate: it matches the workspace's
NetworkClient pattern and makes the generated client unit-testable.

- [ ] **Step 2: Run to verify it fails**

Run: `cd ~/projects/raidr_processor && bun test tests/codegen/client.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write `src/codegen/client.ts`**

```ts
import type { ApiModel, EndpointModel } from '../analysis/apiModel';
import { declareType, typeNameFor } from './types';

export function methodNameFor(method: string, template: string): string {
  const name = typeNameFor(method, template, '');
  return name[0]!.toLowerCase() + name.slice(1);
}

function paramsOf(template: string): string[] {
  return Array.from(template.matchAll(/\{([^}]+)\}/g)).map((m) => m[1]!);
}

function successResponse(endpoint: EndpointModel) {
  return (
    endpoint.responses.find((r) => r.status >= 200 && r.status < 300) ??
    endpoint.responses[0]
  );
}

export function generateTypes(model: ApiModel): string {
  const lines = [
    '// Generated by raidr. Types inferred from observed traffic.',
    '',
  ];

  for (const endpoint of model.endpoints) {
    if (endpoint.requestSchema) {
      lines.push(
        declareType(
          typeNameFor(endpoint.method, endpoint.template, 'Request'),
          endpoint.requestSchema
        ),
        ''
      );
    }
    for (const response of endpoint.responses) {
      const suffix =
        response.status >= 200 && response.status < 300
          ? 'Response'
          : `Response${response.status}`;
      lines.push(
        declareType(
          typeNameFor(endpoint.method, endpoint.template, suffix),
          response.schema
        ),
        ''
      );
    }
  }

  return lines.join('\n');
}

export function generateClient(model: ApiModel): string {
  const imported = new Set<string>();
  const methods: string[] = [];

  for (const endpoint of model.endpoints) {
    const params = paramsOf(endpoint.template);
    const response = successResponse(endpoint);
    const responseType = response
      ? typeNameFor(endpoint.method, endpoint.template, 'Response')
      : 'unknown';
    if (response) imported.add(responseType);

    const args = params.map((p) => `${p}: string | number`);
    let bodyArg = '';
    if (endpoint.requestSchema) {
      const requestType = typeNameFor(endpoint.method, endpoint.template, 'Request');
      imported.add(requestType);
      bodyArg = `body: ${requestType}`;
      args.push(bodyArg);
    }

    const path = endpoint.template.replace(/\{([^}]+)\}/g, '${$1}');
    const headers = [`'content-type': 'application/json'`];
    if (endpoint.auth === 'bearer') {
      headers.push(`...(this.token ? { Authorization: \`Bearer \${this.token}\` } : {})`);
    }

    methods.push(
      `  async ${methodNameFor(endpoint.method, endpoint.template)}(${args.join(', ')}): Promise<${responseType}> {
    const response = await this.fetchFn(\`\${this.baseUrl}${path}\`, {
      method: '${endpoint.method}',
      headers: { ${headers.join(', ')} },${
        endpoint.requestSchema ? '\n      body: JSON.stringify(body),' : ''
      }
    });
    if (!response.ok) {
      throw new Error(\`${endpoint.method} ${endpoint.template} failed: \${response.status}\`);
    }
    return (await response.json()) as ${responseType};
  }`
    );
  }

  const imports =
    imported.size > 0
      ? `import type {\n${Array.from(imported)
          .sort()
          .map((name) => `  ${name},`)
          .join('\n')}\n} from './types';\n\n`
      : '';

  return `// Generated by raidr. One method per observed endpoint.
${imports}export type FetchFn = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string }
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export class ApiClient {
  constructor(
    private readonly fetchFn: FetchFn,
    private readonly baseUrl: string = '${model.baseUrl ?? ''}',
    private token: string | null = null
  ) {}

  setToken(token: string | null): void {
    this.token = token;
  }

${methods.join('\n\n')}
}
`;
}
```

- [ ] **Step 4: Verify and commit**

```bash
cd ~/projects/raidr_processor && bun test && bun run typecheck && bun run build
git add -A && git commit -m "feat: typed API client and type declaration generation"
```

---

### Task 30: Replay server generation

**Files:**
- Create: `~/projects/raidr_processor/src/codegen/replay.ts`
- Modify: `~/projects/raidr_processor/src/index.ts`
- Test: `~/projects/raidr_processor/tests/codegen/replay.test.ts`

**Interfaces:**
- Produces:
  - `generateReplayServer(model: ApiModel): string`
  - `templateToHonoPath(template: string): string`

The generated server reads recorded responses from a sibling `recordings.json`
the CLI writes, so the server source stays small and the data stays inspectable.

- [ ] **Step 1: Write the failing test**

```ts
// tests/codegen/replay.test.ts
import { expect, test } from 'bun:test';
import { generateReplayServer, templateToHonoPath } from '../../src/codegen/replay';
import type { ApiModel } from '../../src/analysis/apiModel';

const MODEL: ApiModel = {
  baseUrl: 'https://api.example.com',
  endpoints: [
    {
      key: 'GET /api/users/{id}',
      method: 'GET',
      template: '/api/users/{id}',
      calls: 1,
      auth: 'none',
      requestSchema: null,
      responses: [{ status: 200, count: 1, schema: { type: 'unknown' } }],
    },
  ],
};

test('converts raidr templates to hono path params', () => {
  expect(templateToHonoPath('/api/users/{id}')).toBe('/api/users/:id');
  expect(templateToHonoPath('/api/a/{x}/b/{y}')).toBe('/api/a/:x/b/:y');
  expect(templateToHonoPath('/api/users')).toBe('/api/users');
});

test('registers a route per endpoint using the right verb', () => {
  const out = generateReplayServer(MODEL);
  expect(out).toContain("app.get('/api/users/:id'");
});

test('serves recorded bodies rather than fabricated ones', () => {
  const out = generateReplayServer(MODEL);
  expect(out).toContain('recordings');
  expect(out).toContain('GET /api/users/{id}');
});

test('returns 501 with an explicit marker when no recording exists', () => {
  const out = generateReplayServer(MODEL);
  expect(out).toContain('501');
  expect(out).toContain('RAIDR-GAP');
});

test('serves the built app with SPA fallback so deep links resolve', () => {
  const out = generateReplayServer(MODEL);
  expect(out).toContain('index.html');
});
```

The 501 behaviour is the gaps-propagate rule applied to runtime: a route with
no captured response must fail loudly, never return plausible invented data.

- [ ] **Step 2: Run to verify it fails**

Run: `cd ~/projects/raidr_processor && bun test tests/codegen/replay.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write `src/codegen/replay.ts`**

```ts
import type { ApiModel } from '../analysis/apiModel';

export function templateToHonoPath(template: string): string {
  return template.replace(/\{([^}]+)\}/g, ':$1');
}

export function generateReplayServer(model: ApiModel): string {
  const routes = model.endpoints
    .map((endpoint) => {
      const verb = endpoint.method.toLowerCase();
      const path = templateToHonoPath(endpoint.template);
      return `app.${verb}('${path}', (c) => respond(c, '${endpoint.key}'));`;
    })
    .join('\n');

  return `// Generated by raidr. Replays responses captured from the original app.
import { Hono } from 'hono';
import { serveStatic } from 'hono/bun';
import type { Context } from 'hono';
import recordings from './recordings.json';

type Recording = { status: number; headers: Record<string, string>; body: unknown };

const app = new Hono();

function respond(c: Context, key: string) {
  const recorded = (recordings as Record<string, Recording[]>)[key];
  if (!recorded || recorded.length === 0) {
    // RAIDR-GAP: no response was captured for this endpoint. Failing loudly is
    // deliberate — inventing one would make the reconstruction quietly wrong.
    return c.json(
      { error: 'RAIDR-GAP', detail: \`no captured response for \${key}\` },
      501
    );
  }
  const pick = recorded[0]!;
  return c.json(pick.body as never, pick.status as never);
}

${routes}

// Static assets, then SPA fallback so client-side routes resolve on reload.
app.use('/*', serveStatic({ root: './dist' }));
app.get('*', serveStatic({ path: './dist/index.html' }));

const port = Number(process.env.PORT ?? 8787);
export default { port, fetch: app.fetch };
`;
}
```

- [ ] **Step 4: Verify and commit**

```bash
cd ~/projects/raidr_processor && bun test && bun run typecheck && bun run build
git add -A && git commit -m "feat: Hono replay server generation"
```

---

### Task 31: Project scaffold generation

**Files:**
- Create: `~/projects/raidr_processor/src/codegen/project.ts`
- Modify: `~/projects/raidr_processor/src/index.ts`
- Test: `~/projects/raidr_processor/tests/codegen/project.test.ts`

**Interfaces:**
- Produces:
  - `generateProject(input: ProjectInput): Record<string, string>` — path → source, for every non-page file
  - `interface ProjectInput { name: string; stack: StackFingerprint; routes: RouteModel['routes']; api: ApiModel; gaps: Gap[] }`

Emits `package.json`, `tsconfig.json`, `vite.config.ts`, `index.html`, the
router, and a page stub per route. Dependency versions come from the runtime
fingerprint — the app told us what it shipped.

- [ ] **Step 1: Write the failing test**

```ts
// tests/codegen/project.test.ts
import { expect, test } from 'bun:test';
import { generateProject } from '../../src/codegen/project';
import type { StackFingerprint } from '../../src/bundle/types';

const REACT: StackFingerprint = {
  framework: 'react',
  frameworkVersion: '18.3.1',
  router: 'react-router',
  routerVersion: '6.28.0',
  stateLibraries: [],
  bundler: 'vite',
};

const BASE = {
  name: 'rebuilt',
  stack: REACT,
  routes: [
    { path: '/', params: [], visited: true, endpoints: ['GET /api/me'], lazy: false },
    {
      path: '/users/:id',
      params: ['id'],
      visited: true,
      endpoints: ['GET /api/users/{id}'],
      lazy: true,
    },
  ],
  api: { baseUrl: 'https://api.example.com', endpoints: [] },
  gaps: [],
};

test('emits the files a Vite project needs', () => {
  const files = generateProject(BASE);
  for (const path of [
    'package.json',
    'tsconfig.json',
    'vite.config.ts',
    'index.html',
    'src/main.tsx',
    'src/router.tsx',
  ]) {
    expect(Object.keys(files)).toContain(path);
  }
});

test('pins the framework version the original app actually shipped', () => {
  const pkg = JSON.parse(generateProject(BASE)['package.json']!);
  expect(pkg.dependencies.react).toBe('18.3.1');
  expect(pkg.dependencies['react-router-dom']).toBe('6.28.0');
});

test('emits a page component per route', () => {
  const files = generateProject(BASE);
  expect(Object.keys(files)).toContain('src/pages/Home.tsx');
  expect(Object.keys(files)).toContain('src/pages/UsersById.tsx');
});

test('the router references every route path', () => {
  const router = generateProject(BASE)['src/router.tsx']!;
  expect(router).toContain("path: '/'");
  expect(router).toContain("path: '/users/:id'");
});

test('lazy routes are emitted as dynamic imports', () => {
  const router = generateProject(BASE)['src/router.tsx']!;
  expect(router).toContain('lazy(');
});

test('a page whose route was never visited carries an RAIDR-GAP marker', () => {
  const files = generateProject({
    ...BASE,
    routes: [
      { path: '/admin', params: [], visited: false, endpoints: [], lazy: true },
    ],
  });
  expect(files['src/pages/Admin.tsx']).toContain('RAIDR-GAP');
  expect(files['src/pages/Admin.tsx']).toContain('never visited');
});

test('a page lists the endpoints observed for its route', () => {
  const files = generateProject(BASE);
  expect(files['src/pages/UsersById.tsx']).toContain('GET /api/users/{id}');
});

test('vue projects emit vue files and vue dependencies', () => {
  const files = generateProject({
    ...BASE,
    stack: {
      framework: 'vue',
      frameworkVersion: '3.4.21',
      router: 'vue-router',
      routerVersion: '4.4.0',
      stateLibraries: [],
      bundler: 'vite',
    },
  });
  const pkg = JSON.parse(files['package.json']!);
  expect(pkg.dependencies.vue).toBe('3.4.21');
  expect(Object.keys(files)).toContain('src/main.ts');
});

test('gaps from the capture are recorded in the project README', () => {
  const files = generateProject({
    ...BASE,
    gaps: [
      {
        requestId: '1',
        url: 'https://x.com/chunk-47.js',
        reason: 'body-evicted',
        ts: 0,
        detail: null,
      },
    ],
  });
  expect(files['RAIDR-GAPS.md']).toContain('chunk-47.js');
  expect(files['RAIDR-GAPS.md']).toContain('body-evicted');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd ~/projects/raidr_processor && bun test tests/codegen/project.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write `src/codegen/project.ts`**

```ts
import type { Gap, StackFingerprint } from '../bundle/types';
import type { ApiModel } from '../analysis/apiModel';
import type { RouteModel } from '../analysis/routeModel';

export interface ProjectInput {
  name: string;
  stack: StackFingerprint;
  routes: RouteModel['routes'];
  api: ApiModel;
  gaps: Gap[];
}

function pascal(input: string): string {
  return input
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join('');
}

/** `/` → Home; `/users/:id` → UsersById. Mirrors typeNameFor's convention. */
export function pageNameFor(path: string): string {
  if (path === '/') return 'Home';
  return path
    .split('/')
    .filter(Boolean)
    .map((segment) =>
      segment.startsWith(':') ? `By${pascal(segment.slice(1))}` : pascal(segment)
    )
    .join('');
}

function dependencies(stack: StackFingerprint): Record<string, string> {
  const version = stack.frameworkVersion ?? 'latest';
  const routerVersion = stack.routerVersion ?? 'latest';

  if (stack.framework === 'vue') {
    return { vue: version, 'vue-router': routerVersion };
  }
  return {
    react: version,
    'react-dom': version,
    'react-router-dom': routerVersion,
  };
}

function devDependencies(stack: StackFingerprint): Record<string, string> {
  const base: Record<string, string> = { typescript: '^5.7.3', vite: '^5.4.21' };
  if (stack.framework === 'vue') {
    base['@vitejs/plugin-vue'] = '^5.2.0';
  } else {
    base['@vitejs/plugin-react'] = '^4.5.1';
    base['@types/react'] = '^18.3.0';
    base['@types/react-dom'] = '^18.3.0';
  }
  base.hono = '^4.6.0';
  return base;
}

function pageHeader(route: ProjectInput['routes'][number]): string {
  const lines = [
    '/**',
    ` * Route: ${route.path}`,
    route.endpoints.length > 0
      ? ` * Observed endpoints: ${route.endpoints.join(', ')}`
      : ' * Observed endpoints: none',
  ];
  if (!route.visited) {
    lines.push(
      ' *',
      ' * RAIDR-GAP: this route was never visited during capture; there is no',
      ' * runtime evidence for its content. Only the router shell is reproduced.'
    );
  }
  lines.push(' */');
  return lines.join('\n');
}

function reactPage(route: ProjectInput['routes'][number]): string {
  const name = pageNameFor(route.path);
  return `${pageHeader(route)}
export function ${name}() {
  return (
    <main>
      <h1>${name}</h1>
    </main>
  );
}

export default ${name};
`;
}

function vuePage(route: ProjectInput['routes'][number]): string {
  const name = pageNameFor(route.path);
  return `<script setup lang="ts">
${pageHeader(route)}
</script>

<template>
  <main>
    <h1>${name}</h1>
  </main>
</template>
`;
}

function reactRouter(routes: ProjectInput['routes']): string {
  const lazyImports = routes
    .filter((route) => route.lazy)
    .map(
      (route) =>
        `const ${pageNameFor(route.path)} = lazy(() => import('./pages/${pageNameFor(route.path)}'));`
    )
    .join('\n');

  const eagerImports = routes
    .filter((route) => !route.lazy)
    .map(
      (route) =>
        `import { ${pageNameFor(route.path)} } from './pages/${pageNameFor(route.path)}';`
    )
    .join('\n');

  const entries = routes
    .map((route) => {
      const name = pageNameFor(route.path);
      const element = route.lazy
        ? `<Suspense fallback={null}><${name} /></Suspense>`
        : `<${name} />`;
      return `  { path: '${route.path}', element: ${element} },`;
    })
    .join('\n');

  return `import { lazy, Suspense } from 'react';
import { createBrowserRouter } from 'react-router-dom';
${eagerImports}

${lazyImports}

export const router = createBrowserRouter([
${entries}
]);
`;
}

function vueRouter(routes: ProjectInput['routes']): string {
  const entries = routes
    .map(
      (route) =>
        `  { path: '${route.path}', component: () => import('./pages/${pageNameFor(route.path)}.vue') },`
    )
    .join('\n');

  return `import { createRouter, createWebHistory } from 'vue-router';

export const router = createRouter({
  history: createWebHistory(),
  routes: [
${entries}
  ],
});
`;
}

export function generateProject(input: ProjectInput): Record<string, string> {
  const isVue = input.stack.framework === 'vue';
  const files: Record<string, string> = {};

  files['package.json'] = JSON.stringify(
    {
      name: input.name,
      private: true,
      type: 'module',
      scripts: {
        dev: 'vite',
        build: 'vite build',
        typecheck: 'tsc --noEmit',
        replay: 'bun run server/replay.ts',
      },
      dependencies: dependencies(input.stack),
      devDependencies: devDependencies(input.stack),
    },
    null,
    2
  );

  files['tsconfig.json'] = JSON.stringify(
    {
      compilerOptions: {
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'bundler',
        lib: ['ES2022', 'DOM', 'DOM.Iterable'],
        jsx: isVue ? undefined : 'react-jsx',
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        allowImportingTsExtensions: true,
        resolveJsonModule: true,
      },
      include: ['src', 'server'],
    },
    null,
    2
  );

  files['vite.config.ts'] = isVue
    ? `import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({ plugins: [vue()] });
`
    : `import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({ plugins: [react()] });
`;

  files['index.html'] = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>${input.name}</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/main.${isVue ? 'ts' : 'tsx'}"></script>
  </body>
</html>
`;

  if (isVue) {
    files['src/main.ts'] = `import { createApp } from 'vue';
import { router } from './router';
import App from './App.vue';

createApp(App).use(router).mount('#app');
`;
    files['src/App.vue'] = `<template>
  <RouterView />
</template>
`;
    files['src/router.ts'] = vueRouter(input.routes);
    for (const route of input.routes) {
      files[`src/pages/${pageNameFor(route.path)}.vue`] = vuePage(route);
    }
  } else {
    files['src/main.tsx'] = `import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router-dom';
import { router } from './router';

const container = document.getElementById('app');
if (!container) throw new Error('#app not found');
createRoot(container).render(<RouterProvider router={router} />);
`;
    files['src/router.tsx'] = reactRouter(input.routes);
    for (const route of input.routes) {
      files[`src/pages/${pageNameFor(route.path)}.tsx`] = reactPage(route);
    }
  }

  if (input.gaps.length > 0) {
    files['RAIDR-GAPS.md'] = [
      '# Capture gaps',
      '',
      'These resources were requested by the original app but not captured.',
      'Anything depending on them is missing evidence, not merely unimplemented.',
      '',
      ...input.gaps.map(
        (gap) => `- \`${gap.reason}\` — ${gap.url}${gap.detail ? ` (${gap.detail})` : ''}`
      ),
    ].join('\n');
  }

  return files;
}
```

- [ ] **Step 4: Verify and commit**

```bash
cd ~/projects/raidr_processor && bun test && bun run typecheck && bun run build
git add -A && git commit -m "feat: project scaffold generation with gap markers"
```

---
# Milestone 8 — CLI command, skill, verification (stages 8–9)

### Task 32: The `reconstruct` command

**Files:**
- Create: `~/projects/raidr_cli/src/commands/reconstruct.ts`
- Create: `~/projects/raidr_cli/src/emit.ts`
- Test: `~/projects/raidr_cli/tests/commands/reconstruct.test.ts`

**Interfaces:**
- Produces:
  - `runReconstruct(argv: string[]): Promise<void>`
  - `reconstruct(options: { bundlePath: string; outDir: string }): Promise<ReconstructReport>`
  - `interface ReconstructReport { recoveryRatio: number; mode: 'recovery' | 'inference'; routes: number; endpoints: number; gaps: number; filesWritten: number }`

Every stage writes its artifact under `<out>/.raidr/` before the next runs, so a
stage can be re-run or inspected in isolation — and so the skill has structured
input rather than having to re-derive anything.

**Artifact layout:**

```
<out>/.raidr/
  01-bundle.json        manifest, counts, gap list
  02-recovery.json      recovery ratio, per-chunk map status
  02-sources/           recovered original files (recovery mode only)
  03-chunks/            beautified chunks (inference mode only)
  04-api-model.json     the API model
  05-route-model.json   the route model
  recordings.json       captured responses keyed by endpoint
  report.md             summary the skill reads first
<out>/                  the generated project
```

- [ ] **Step 1: Write the failing test**

```ts
// tests/commands/reconstruct.test.ts
import { expect, test } from 'bun:test';
import { rm, readFile } from 'node:fs/promises';
import { reconstruct } from '../../src/commands/reconstruct';

const BUNDLE = `${import.meta.dir}/../../fixtures/bundles/react-sample.zip`;
const OUT = `${import.meta.dir}/../../.tmp/reconstruct-test`;

async function run() {
  await rm(OUT, { recursive: true, force: true });
  return reconstruct({ bundlePath: BUNDLE, outDir: OUT });
}

test('reconstructs a real bundle end to end', async () => {
  const report = await run();
  expect(report.endpoints).toBeGreaterThan(2);
  expect(report.routes).toBeGreaterThan(2);
  expect(report.filesWritten).toBeGreaterThan(5);
});

test('chooses recovery mode when the app shipped source maps', async () => {
  const report = await run();
  expect(report.recoveryRatio).toBeGreaterThan(50);
  expect(report.mode).toBe('recovery');
});

test('writes every stage artifact', async () => {
  await run();
  for (const path of [
    '.raidr/01-bundle.json',
    '.raidr/02-recovery.json',
    '.raidr/04-api-model.json',
    '.raidr/05-route-model.json',
    '.raidr/recordings.json',
    '.raidr/report.md',
  ]) {
    expect(await Bun.file(`${OUT}/${path}`).exists()).toBe(true);
  }
});

test('the api model contains the endpoints the fixture app called', async () => {
  await run();
  const model = JSON.parse(await readFile(`${OUT}/.raidr/04-api-model.json`, 'utf8'));
  const templates = model.endpoints.map((e: { template: string }) => e.template);
  expect(templates).toContain('/api/users');
  expect(templates).toContain('/api/users/{id}');
});

test('recovers original source files rather than minified chunks', async () => {
  await run();
  const recovery = JSON.parse(await readFile(`${OUT}/.raidr/02-recovery.json`, 'utf8'));
  expect(recovery.files.length).toBeGreaterThan(0);
  expect(recovery.files.some((f: string) => f.endsWith('.tsx'))).toBe(true);
});

test('generates a project that has the expected shape', async () => {
  await run();
  for (const path of ['package.json', 'vite.config.ts', 'src/router.tsx', 'server/replay.ts']) {
    expect(await Bun.file(`${OUT}/${path}`).exists()).toBe(true);
  }
});

test('recordings are keyed by endpoint and hold real captured bodies', async () => {
  await run();
  const recordings = JSON.parse(await readFile(`${OUT}/.raidr/recordings.json`, 'utf8'));
  const users = recordings['GET /api/users'];
  expect(users[0].status).toBe(200);
  expect(users[0].body.users.length).toBeGreaterThan(0);
});

test('refuses a bundle from an unsupported format version', async () => {
  await expect(
    reconstruct({ bundlePath: `${import.meta.dir}/../bundle/fixtures/badversion`, outDir: OUT })
  ).rejects.toThrow(/formatVersion/);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd ~/projects/raidr_cli && bun test tests/commands/reconstruct.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write `src/emit.ts`**

```ts
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import prettier from 'prettier';

const FORMATTABLE = /\.(ts|tsx|js|jsx|json|css|html)$/;

export async function emitFiles(
  outDir: string,
  files: Record<string, string>
): Promise<number> {
  let written = 0;
  for (const [relative, source] of Object.entries(files)) {
    const path = join(outDir, relative);
    await mkdir(dirname(path), { recursive: true });

    let content = source;
    if (FORMATTABLE.test(relative)) {
      try {
        content = await prettier.format(source, { filepath: path });
      } catch {
        // Emitting unformatted output beats failing the whole reconstruction.
      }
    }
    await writeFile(path, content, 'utf8');
    written += 1;
  }
  return written;
}
```

- [ ] **Step 4: Write `src/commands/reconstruct.ts`**

```ts
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  buildApiModel,
  buildRouteModel,
  endpointKey,
  generateClient,
  generateProject,
  generateReplayServer,
  generateTypes,
  parseSourceMap,
  recoverSources,
  recoveryRatio,
  type EndpointSample,
  type StackFingerprint,
} from '@sudobility/raidr_processor';
import { loadBundle } from '../bundle/load';
import { unpackChunks } from '../stages/unpack';
import { emitFiles } from '../emit';

export interface ReconstructReport {
  recoveryRatio: number;
  mode: 'recovery' | 'inference';
  routes: number;
  endpoints: number;
  gaps: number;
  filesWritten: number;
}

const RECOVERY_THRESHOLD = 80;
const ASSET_RE = /\.(js|mjs|css|map|png|jpe?g|gif|svg|webp|woff2?|ico)$/i;

function isApiCall(url: string): boolean {
  try {
    return !ASSET_RE.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

export async function reconstruct(options: {
  bundlePath: string;
  outDir: string;
}): Promise<ReconstructReport> {
  const bundle = await loadBundle(options.bundlePath);
  const raidrDir = join(options.outDir, '.raidr');
  await mkdir(raidrDir, { recursive: true });

  const writeJson = (name: string, value: unknown) =>
    writeFile(join(raidrDir, name), JSON.stringify(value, null, 2), 'utf8');

  // Stage 1 — bundle summary, gaps first.
  await writeJson('01-bundle.json', {
    manifest: bundle.manifest,
    gaps: bundle.gaps,
    redaction: bundle.redaction,
  });

  // Stage 2 — source-map recovery.
  const recovered: Record<string, string> = {};
  let mappedBytes = 0;
  let totalJsBytes = 0;
  for (const request of bundle.requests) {
    if (!request.mimeType?.includes('javascript') || !request.responseBodyHash) continue;
    const size = bundle.content.get(request.responseBodyHash)?.byteLength ?? 0;
    totalJsBytes += size;

    const mapHash = bundle.sourceMaps[request.url];
    if (!mapHash) continue;
    const mapText = bundle.text(mapHash);
    if (mapText === null) continue;
    const map = parseSourceMap(mapText);
    if (!map) continue;

    mappedBytes += size;
    for (const file of recoverSources(map)) recovered[file.path] = file.content;
  }

  const ratio = recoveryRatio({ mappedBytes, totalBytes: totalJsBytes });
  const mode = ratio >= RECOVERY_THRESHOLD ? 'recovery' : 'inference';
  await writeJson('02-recovery.json', {
    ratio,
    mode,
    files: Object.keys(recovered).sort(),
  });
  if (Object.keys(recovered).length > 0) {
    await emitFiles(join(raidrDir, '02-sources'), recovered);
  }

  // Stage 3 — unpack only when recovery did not carry the day.
  if (mode === 'inference') {
    const chunks = await unpackChunks(bundle);
    const files: Record<string, string> = {};
    chunks.forEach((chunk, index) => {
      files[`chunk-${index}.js`] = chunk.source;
      for (const module of chunk.modules) {
        files[`chunk-${index}/module-${module.id}.js`] = module.source;
      }
    });
    await emitFiles(join(raidrDir, '03-chunks'), files);
  }

  // Stage 4 — API model, plus the recordings the replay server serves.
  const samples: EndpointSample[] = [];
  const recordings: Record<string, Array<{ status: number; headers: Record<string, string>; body: unknown }>> = {};

  for (const request of bundle.requests) {
    if (!isApiCall(request.url)) continue;
    const responseBody =
      request.responseBodyHash === null ? undefined : bundle.json(request.responseBodyHash);
    const requestBody =
      request.requestBodyHash === null ? null : bundle.json(request.requestBodyHash);

    samples.push({
      method: request.method,
      url: request.url,
      status: request.status,
      requestBody,
      responseBody,
      requestHeaders: request.requestHeaders,
    });
  }

  const api = buildApiModel(samples);
  await writeJson('04-api-model.json', api);

  for (const sample of samples) {
    if (sample.responseBody === undefined) continue;
    // Re-derive the same key the model used. Substring matching on the template
    // would mis-bucket /api/users against /api/users/{id}.
    const key = endpointKey(sample.method, sample.url);
    const bucket = recordings[key] ?? [];
    bucket.push({ status: sample.status ?? 200, headers: {}, body: sample.responseBody });
    recordings[key] = bucket;
  }
  await writeJson('recordings.json', recordings);

  // Stage 5 — route model.
  const navigations = (bundle.runtime as { navigations?: Array<{ navigationId: string; path: string }> })
    .navigations ?? [];
  const routeModel = buildRouteModel({
    routes: (bundle.runtime.routes as string[]) ?? [],
    navigations,
    requests: bundle.requests.map((r) => ({
      method: r.method,
      url: r.url,
      navigationId: r.navigationId,
    })),
  });
  await writeJson('05-route-model.json', routeModel);

  // Stages 6–7 — stack decision and deterministic codegen.
  const stack = (bundle.manifest.stack ?? {
    framework: 'unknown',
    frameworkVersion: null,
    router: null,
    routerVersion: null,
    stateLibraries: [],
    bundler: 'unknown',
  }) as StackFingerprint;

  const project = generateProject({
    name: 'rebuilt',
    stack,
    routes: routeModel.routes,
    api,
    gaps: bundle.gaps,
  });
  project['src/api/types.ts'] = generateTypes(api);
  project['src/api/client.ts'] = generateClient(api);
  project['server/replay.ts'] = generateReplayServer(api);
  project['server/recordings.json'] = JSON.stringify(recordings, null, 2);

  const filesWritten = await emitFiles(options.outDir, project);

  const report: ReconstructReport = {
    recoveryRatio: ratio,
    mode,
    routes: routeModel.routes.length,
    endpoints: api.endpoints.length,
    gaps: bundle.gaps.length,
    filesWritten,
  };

  await writeFile(
    join(raidrDir, 'report.md'),
    [
      `# raidr reconstruction report`,
      ``,
      `- Origin: ${bundle.manifest.origin}`,
      `- Framework: ${stack.framework} ${stack.frameworkVersion ?? '(version unknown)'}`,
      `- Bundler: ${stack.bundler}`,
      `- Mode: **${mode}** (source-map recovery ${ratio}%)`,
      `- Routes: ${routeModel.routes.length} (${routeModel.routes.filter((r) => !r.visited).length} never visited)`,
      `- Endpoints: ${api.endpoints.length}`,
      `- Gaps: ${bundle.gaps.length}`,
      ``,
      `## Routes`,
      ``,
      ...routeModel.routes.map(
        (r) =>
          `- \`${r.path}\`${r.visited ? '' : ' — **never visited**'}${
            r.endpoints.length > 0 ? ` → ${r.endpoints.join(', ')}` : ''
          }`
      ),
      ``,
      `## Unattributed endpoints`,
      ``,
      ...(routeModel.unattributed.length > 0
        ? routeModel.unattributed.map((e) => `- ${e}`)
        : ['(none)']),
    ].join('\n'),
    'utf8'
  );

  return report;
}

export async function runReconstruct(argv: string[]): Promise<void> {
  const bundlePath = argv[0];
  const outIndex = argv.indexOf('--out');
  const outDir = outIndex >= 0 ? argv[outIndex + 1] : undefined;

  if (!bundlePath || !outDir) {
    console.error('usage: raidr reconstruct <bundle.zip|dir> --out <dir>');
    process.exit(1);
  }

  const report = await reconstruct({ bundlePath, outDir });
  console.log(JSON.stringify(report, null, 2));
  console.log(`\nArtifacts: ${join(outDir, '.raidr')}`);
  console.log(`Report:    ${join(outDir, '.raidr', 'report.md')}`);
}
```

- [ ] **Step 5: Verify and commit**

```bash
cd ~/projects/raidr_cli && bun test tests/commands/reconstruct.test.ts && bun run typecheck
git add -A && git commit -m "feat: reconstruct command orchestrating all deterministic stages"
```

---

### Task 33: The `reconstruct` skill

**Files:**
- Create: `~/projects/raidr_cli/skills/reconstruct/SKILL.md`
- Create: `~/projects/raidr_cli/skills/reconstruct/INSTALL.md`
- Test: `~/projects/raidr_cli/tests/skills/skillFormat.test.ts`

**Testing note:** `superpowers:writing-skills` prescribes subagent pressure
scenarios. Subagent dispatch is unavailable here, so this skill is verified two
other ways: a format test that pins the frontmatter contract, and Task 34's
round-trip, which executes the skill's own procedure against a real bundle and
asserts the result builds. For a technique skill — where the failure mode is a
wrong or incomplete application rather than a rule violation under pressure —
executing the procedure is the stronger check.

- [ ] **Step 1: Write the failing test**

```ts
// tests/skills/skillFormat.test.ts
import { expect, test } from 'bun:test';

const SKILL = `${import.meta.dir}/../../skills/reconstruct/SKILL.md`;

async function frontmatter(): Promise<Record<string, string>> {
  const text = await Bun.file(SKILL).text();
  const match = /^---\n([\s\S]*?)\n---/.exec(text);
  if (!match) throw new Error('no frontmatter');
  const out: Record<string, string> = {};
  for (const line of match[1]!.split('\n')) {
    const idx = line.indexOf(':');
    if (idx > 0) out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return out;
}

test('declares name and description', async () => {
  const fm = await frontmatter();
  expect(fm.name).toBeDefined();
  expect(fm.description).toBeDefined();
});

test('name uses only letters, numbers, and hyphens', async () => {
  expect((await frontmatter()).name).toMatch(/^[A-Za-z0-9-]+$/);
});

test('description states triggering conditions, not the workflow', async () => {
  const description = (await frontmatter()).description!;
  expect(description.startsWith('Use when')).toBe(true);
  // A description that summarizes the procedure invites agents to follow the
  // summary instead of reading the skill.
  for (const leak of ['then', 'first', 'step', 'stage']) {
    expect(description.toLowerCase()).not.toContain(leak);
  }
});

test('frontmatter stays within the 1024 character limit', async () => {
  const text = await Bun.file(SKILL).text();
  expect(/^---\n([\s\S]*?)\n---/.exec(text)![0].length).toBeLessThan(1024);
});

test('the skill names the exact command it drives', async () => {
  const text = await Bun.file(SKILL).text();
  expect(text).toContain('raidr reconstruct');
  expect(text).toContain('--out');
});

test('the skill carries the gap rule', async () => {
  const text = await Bun.file(SKILL).text();
  expect(text).toContain('RAIDR-GAP');
});

test('installation instructions cover both install paths', async () => {
  const text = await Bun.file(
    `${import.meta.dir}/../../skills/reconstruct/INSTALL.md`
  ).text();
  expect(text).toContain('~/.claude/skills');
  expect(text).toContain('bun link');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd ~/projects/raidr_cli && bun test tests/skills/skillFormat.test.ts`
Expected: FAIL — SKILL.md does not exist

- [ ] **Step 3: Write `skills/reconstruct/SKILL.md`**

```markdown
---
name: raidr-reconstruct
description: Use when rebuilding a web application from an raidr capture bundle, when handed an raidr-*.zip of captured traffic, or when asked to reverse engineer a site from its recorded network activity and JavaScript.
---

# Reconstructing an app from an raidr bundle

## Overview

An raidr bundle holds everything a running web app served: its JavaScript, its
HTML, its API traffic, its source maps where they existed, and an explicit list
of what the capture missed. The `raidr` CLI performs every deterministic stage.
Your job is the part it cannot do — turning recovered or minified source into
readable components wired to real routes.

**Core principle: the bundle is evidence, not inspiration.** Everything you
write must trace to something in it. Where the bundle is silent, say so.

## When to Use

- A `.zip` produced by the raidr capture extension, or an unpacked bundle directory
- A request to rebuild, clone, or reverse engineer an app from captured traffic
- Re-running a reconstruction with better judgment against an existing bundle

Not for: capturing traffic (that is the extension), or analyzing a HAR file
(wrong format — `validateManifest` will reject it).

## Procedure

**1. Run the CLI first. Always.**

```bash
raidr reconstruct <bundle.zip> --out <dir>
```

It writes the project and, under `<dir>/.raidr/`, the artifacts you work from.
Do not read the raw bundle before running it — the artifacts are the same data,
already clustered, typed, and de-duplicated.

**2. Read `<dir>/.raidr/report.md`.**

It tells you the framework, the reconstruction mode, the routes (including which
were never visited), the endpoints, and the gap count. Everything you do next
depends on the mode:

| Mode | Meaning | What you do |
|---|---|---|
| `recovery` | Source maps covered ≥80% of the JS | Copy real original sources from `.raidr/02-sources/` into the project. This is recovery, not inference — do not paraphrase them. |
| `inference` | Little or no source-map coverage | Read `.raidr/03-chunks/` and write components that reproduce observed behavior. |

**3. Implement one route at a time.**

For each route in `.raidr/05-route-model.json`, work through it alone rather than
holding the whole app in context. The route entry names the endpoints that fired
while it was mounted — those, and only those, are its data dependencies. Call
them through the generated client in `src/api/client.ts`; never re-derive fetch
calls by hand, and never invent an endpoint the model does not list.

**4. Honor the gaps.**

`.raidr/01-bundle.json` lists what the capture missed, and `RAIDR-GAPS.md` in the
project repeats it. A route marked `visited: false` has no runtime evidence
behind it. Leave its `RAIDR-GAP` comment in place and implement only the shell
the router requires. Deleting a gap marker because the page looks empty without
it is the one thing that turns a reconstruction into a fabrication.

**5. Verify before reporting.**

```bash
cd <dir> && bun install && bun run typecheck && bun run build
bun run server/replay.ts   # then hit each route
```

A reconstruction that does not build is not finished. Report the build output,
not your expectation of it.

## Quick Reference

| Artifact | Holds |
|---|---|
| `.raidr/report.md` | Start here: mode, routes, endpoints, gaps |
| `.raidr/02-sources/` | Recovered original files (recovery mode) |
| `.raidr/03-chunks/` | Beautified chunks (inference mode) |
| `.raidr/04-api-model.json` | Endpoints, per-status schemas, auth style |
| `.raidr/05-route-model.json` | Routes, params, visited flag, endpoints per route |
| `.raidr/recordings.json` | Real captured responses the replay server serves |

## Common Mistakes

| Mistake | Why it is wrong |
|---|---|
| Reading the raw zip instead of running the CLI | The artifacts are the same data, already analyzed. Re-deriving them wastes context and produces worse results. |
| Writing an endpoint absent from the API model | Endpoints come from observed traffic. One that is not in the model was never called; you are inventing an API. |
| Filling in a never-visited route with plausible content | There is no evidence for it. The `RAIDR-GAP` marker is the honest output. |
| Hand-writing `fetch` calls | The generated client is typed from real payloads. Bypassing it discards the schema work. |
| Reporting success without building | Generated code that typechecks in your head is not a deliverable. |
| Treating a redaction placeholder as a real value | `<JWT:a1b2>` marks where a credential was. The same placeholder in two places means it was the same credential — that is the auth flow, not a literal. |
```

- [ ] **Step 4: Write `skills/reconstruct/INSTALL.md`**

```markdown
# Installing the raidr reconstruct skill

The skill drives the `raidr` CLI, so install both.

## 1. Install the CLI

From a clone of this repository:

```bash
cd ~/projects/raidr_processor && bun install && bun run build
cd ~/projects/raidr_cli && bun install
bun link
```

`bun link` registers the `raidr` binary globally. Verify:

```bash
raidr reconstruct --help
```

If `bun link` is not on your PATH, invoke it directly instead — the skill works
either way, but you must then substitute the full path wherever it says `raidr`:

```bash
bun ~/projects/raidr_cli/src/cli.ts reconstruct <bundle.zip> --out <dir>
```

## 2. Install the skill

Claude Code discovers personal skills in `~/.claude/skills/`. Symlink rather
than copy, so the skill tracks the repository:

```bash
mkdir -p ~/.claude/skills
ln -s ~/projects/raidr_cli/skills/reconstruct ~/.claude/skills/raidr-reconstruct
```

Verify it is discovered:

```bash
ls ~/.claude/skills/raidr-reconstruct/SKILL.md
```

Then start a new Claude Code session — skills are read at session start. Ask it
to reconstruct a bundle, or invoke it by name with `/raidr-reconstruct`.

## 3. Confirm end to end

```bash
raidr reconstruct ~/projects/raidr_cli/fixtures/bundles/react-sample.zip --out /tmp/rebuilt
cat /tmp/rebuilt/.raidr/report.md
```

Expected: a report naming `react`, mode `recovery`, four routes, and the
`/api/users`, `/api/users/{id}`, `/api/me`, `/api/stats` endpoints.

## Uninstalling

```bash
rm ~/.claude/skills/raidr-reconstruct
cd ~/projects/raidr_cli && bun unlink
```
```

- [ ] **Step 5: Verify and commit**

```bash
cd ~/projects/raidr_cli && bun test tests/skills/skillFormat.test.ts
git add -A && git commit -m "feat: reconstruct skill and installation instructions"
```

---

### Task 34: Round-trip verification

The test that proves the product: capture → reconstruct → build → serve.

**Files:**
- Test: `~/projects/raidr_cli/tests/roundTrip.test.ts`
- Modify: whatever the round-trip exposes as broken

- [ ] **Step 1: Write the failing test**

```ts
// tests/roundTrip.test.ts
import { expect, test } from 'bun:test';
import { rm } from 'node:fs/promises';
import { $ } from 'bun';
import { reconstruct } from '../src/commands/reconstruct';

const OUT = `${import.meta.dir}/../.tmp/roundtrip`;
const TIMEOUT = 300_000;

test(
  'a reconstructed project installs, typechecks, and builds',
  async () => {
    await rm(OUT, { recursive: true, force: true });
    await reconstruct({
      bundlePath: `${import.meta.dir}/../fixtures/bundles/react-sample.zip`,
      outDir: OUT,
    });

    await $`bun install`.cwd(OUT).quiet();
    const typecheck = await $`bun run typecheck`.cwd(OUT).nothrow().quiet();
    expect(typecheck.exitCode).toBe(0);

    const build = await $`bun run build`.cwd(OUT).nothrow().quiet();
    expect(build.exitCode).toBe(0);
  },
  TIMEOUT
);

test(
  'the replay server serves every recorded endpoint',
  async () => {
    const server = Bun.spawn(['bun', 'run', 'server/replay.ts'], {
      cwd: OUT,
      env: { ...process.env, PORT: '8899' },
      stdout: 'pipe',
      stderr: 'pipe',
    });

    try {
      // Poll rather than sleep: the server is ready when it answers.
      let ready = false;
      for (let attempt = 0; attempt < 50 && !ready; attempt += 1) {
        try {
          await fetch('http://localhost:8899/api/users');
          ready = true;
        } catch {
          await Bun.sleep(100);
        }
      }
      expect(ready).toBe(true);

      const users = await fetch('http://localhost:8899/api/users');
      expect(users.status).toBe(200);
      expect((await users.json()).users.length).toBeGreaterThan(0);

      const detail = await fetch('http://localhost:8899/api/users/1');
      expect(detail.status).toBe(200);
    } finally {
      server.kill();
    }
  },
  TIMEOUT
);

test(
  'an endpoint with no recording fails loudly instead of inventing data',
  async () => {
    const server = Bun.spawn(['bun', 'run', 'server/replay.ts'], {
      cwd: OUT,
      env: { ...process.env, PORT: '8900' },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    try {
      let ready = false;
      for (let attempt = 0; attempt < 50 && !ready; attempt += 1) {
        try {
          await fetch('http://localhost:8900/api/users');
          ready = true;
        } catch {
          await Bun.sleep(100);
        }
      }
      const missing = await fetch('http://localhost:8900/api/never-captured');
      expect([404, 501]).toContain(missing.status);
    } finally {
      server.kill();
    }
  },
  TIMEOUT
);

test(
  'the vue bundle also reconstructs and builds',
  async () => {
    const vueOut = `${OUT}-vue`;
    await rm(vueOut, { recursive: true, force: true });
    const report = await reconstruct({
      bundlePath: `${import.meta.dir}/../fixtures/bundles/vue-sample.zip`,
      outDir: vueOut,
    });
    expect(report.endpoints).toBeGreaterThan(2);

    await $`bun install`.cwd(vueOut).quiet();
    const build = await $`bun run build`.cwd(vueOut).nothrow().quiet();
    expect(build.exitCode).toBe(0);
  },
  TIMEOUT
);
```

- [ ] **Step 2: Run and fix what it exposes**

Run: `cd ~/projects/raidr_cli && bun test tests/roundTrip.test.ts`

This test will fail the first several times. Each failure is a real defect in a
generator — a missing dependency in the emitted `package.json`, an import that
does not resolve, a type that does not compile. Fix the **generator**, never the
generated output: patching `<out>/` by hand produces a green test over broken
code, and the next reconstruction regresses.

Iterate until all four pass.

- [ ] **Step 3: Full verification across all three repos**

```bash
cd ~/projects/raidr_processor && bun test && bun run typecheck && bun run build
cd ~/projects/raidr_extension && bun test && bun run typecheck && bun run build
cd ~/projects/raidr_cli && bun test && bun run typecheck
```

- [ ] **Step 4: Commit**

```bash
cd ~/projects/raidr_cli && git add -A && git commit -m "test: round-trip capture to buildable reconstruction"
```

---

## Definition of done

- `bun test` green in all three repos.
- `bun run typecheck` clean in all three repos.
- Fixture bundles are real captures produced by Playwright CDP, committed.
- `raidr reconstruct` on the React fixture selects recovery mode and emits recovered `.tsx` sources.
- The reconstructed React project installs, typechecks, and builds.
- The replay server serves recorded endpoints and returns 501 with an `RAIDR-GAP` marker for uncaptured ones.
- The Vue fixture reconstructs and builds.
- `SKILL.md` passes its format test; `INSTALL.md` covers CLI and skill installation.

## Deliberately out of scope

- **Vite/Rollup chunk splitting.** Flat ES module chunks need an AST pass to separate; Task 24 beautifies and records `splittable: false`. Recovery mode makes this moot whenever source maps exist.
- **CSS reconstruction.** Stylesheets are captured and available in the bundle, but no stage attributes them to components.
- **WebSocket replay.** Frames are captured and typed; the replay server does not serve them.
- **`Profiler.startPreciseCoverage`.** Dead-code elimination from execution coverage remains deferred, as in the capture plan.
