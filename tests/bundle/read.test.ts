import { expect, test } from 'bun:test';
import {
  MemoryContentStore,
  buildBundleFiles,
  readBundle,
  recoverBundleSources,
  unzipBundle,
  zipBundle,
  type CapturedRequest,
} from '../../src/index';

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

const encoder = new TextEncoder();

function script(id: string, url: string, hash: string): CapturedRequest {
  return {
    id,
    ts: 1756029600000,
    method: 'GET',
    url,
    resourceType: 'Script',
    requestHeaders: {},
    requestBodyHash: null,
    status: 200,
    responseHeaders: {},
    responseBodyHash: hash,
    mimeType: 'application/javascript',
    fromCache: false,
    navigationId: 'nav1',
  };
}

/** A bundle with two 100-byte scripts, one of them source-mapped. */
async function bundleFiles() {
  const store = new MemoryContentStore(sha256Hex);
  const app = await store.put(encoder.encode('a'.repeat(100)));
  const vendor = await store.put(encoder.encode('v'.repeat(100)));
  const map = await store.put(
    encoder.encode(
      JSON.stringify({
        version: 3,
        sources: ['webpack://app/./src/api.ts', 'webpack://app/./node_modules/x/index.js'],
        sourcesContent: ['export const me = () => fetch("/api/me");', 'x'],
        mappings: '',
      })
    )
  );
  return buildBundleFiles({
    store,
    manifest: {
      formatVersion: 1 as const,
      sessionId: 's1',
      origin: 'https://example.com',
      startedAt: '2026-08-24T10:00:00.000Z',
      endedAt: '2026-08-24T10:05:00.000Z',
      counts: { requests: 2, frames: 0, bodies: 2, gaps: 0 },
      stack: null,
    },
    requests: [
      script('r1', 'https://example.com/app.js', app),
      script('r2', 'https://example.com/vendor.js', vendor),
    ],
    frames: [],
    gaps: [],
    redaction: [],
    sourceMaps: { 'https://example.com/app.js': map },
    snapshots: {},
    runtime: {
      framework: { framework: 'react' },
      routes: ['/'],
      stores: [],
      chunks: { known: [], loaded: [] },
      coverage: {},
      navigations: [],
    },
  });
}

test('reads a zipped bundle back: manifest, requests, content by hash', async () => {
  const bundle = unzipBundle(await zipBundle(await bundleFiles()));
  expect(bundle.manifest.origin).toBe('https://example.com');
  expect(bundle.requests.map((r) => r.id)).toEqual(['r1', 'r2']);
  expect(bundle.text(bundle.requests[0]!.responseBodyHash!)).toBe('a'.repeat(100));
  expect(bundle.runtime.routes).toEqual(['/']);
  expect(bundle.files.has('raidr.json')).toBe(true);
  expect(bundle.text('nonexistent')).toBeNull();
  expect(bundle.json('nonexistent')).toBeUndefined();
});

test('optional files read as empty defaults', async () => {
  const files = await bundleFiles();
  const bundle = readBundle({ 'raidr.json': files['raidr.json']! });
  expect(bundle.requests).toEqual([]);
  expect(bundle.gaps).toEqual([]);
  expect(bundle.sourceMaps).toEqual({});
  expect(bundle.runtime.chunks).toEqual({ known: [], loaded: [] });
});

test('a missing or invalid manifest throws, labelled', () => {
  expect(() => readBundle(new Map(), 'x.zip')).toThrow(/x\.zip: raidr\.json not found/);
  const bad = new Map([['raidr.json', encoder.encode(JSON.stringify({ formatVersion: 99 }))]]);
  expect(() => readBundle(bad, 'x.zip')).toThrow(/x\.zip: invalid bundle/);
});

test("recovers the app's sources and the share of JavaScript the maps cover", async () => {
  const sources = recoverBundleSources(readBundle(await bundleFiles()));
  expect(sources.files).toEqual([{ path: 'src/api.ts', content: 'export const me = () => fetch("/api/me");' }]);
  expect(sources).toMatchObject({ mappedBytes: 100, totalBytes: 200, ratio: 50 });
});
