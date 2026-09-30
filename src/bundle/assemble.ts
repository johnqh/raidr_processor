/**
 * Turns an in-memory capture into the file map of a bundle and zips it. This
 * module defines the bundle's directory layout; readers in raidr_cli and
 * raidr_crawler expect exactly these paths.
 */
import { zipSync } from 'fflate';
import { contentPath, extensionForMime, sourcemapPath } from './paths';
import { toJsonl } from './manifest';
import type {
  CapturedFrame,
  CapturedRequest,
  Gap,
  RedactionEntry,
  RaidrManifest,
} from './types';
import type { ContentStore } from './store';

/**
 * Runtime facts extracted in the page by the introspection probes, each
 * written verbatim to `runtime/<name>.json`. Typed `unknown` because this
 * package does not interpret their shape.
 */
export interface RuntimeArtifacts {
  framework: unknown;
  routes: unknown;
  stores: unknown;
  chunks: unknown;
  coverage: unknown;
  navigations: unknown;
}

/** Everything `buildBundleFiles` needs. Bodies are fetched from `store` by hash. */
export interface BundleInput {
  store: ContentStore;
  manifest: RaidrManifest;
  requests: CapturedRequest[];
  frames: CapturedFrame[];
  gaps: Gap[];
  redaction: RedactionEntry[];
  /** script URL → content hash of its source map */
  sourceMaps: Record<string, string>;
  /**
   * Route path → content hash of the rendered DOM at navigation time. Present
   * only for client-rendered routes, where no document was ever served and the
   * DOM is the sole evidence the page existed. Kept apart from `content` so
   * "what the server sent" is never confused with "what the DOM looked like".
   */
  snapshots?: Record<string, string>;
  runtime: RuntimeArtifacts;
}

const encoder = new TextEncoder();

function json(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(value, null, 2));
}

/**
 * Lays a capture out as bundle-relative path → bytes, ready for `zipBundle`.
 *
 * Only bodies referenced by a request, frame, source map or snapshot are
 * included, and a hash missing from the store is skipped silently (the
 * capturer is expected to have recorded a Gap for it). Request bodies are
 * always written with a `.json` extension regardless of their content type.
 */
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
    'runtime/navigations.json': json(input.runtime.navigations ?? []),
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

  for (const hash of Object.values(input.sourceMaps)) {
    const path = sourcemapPath(hash);
    if (files[path]) continue;
    const bytes = await input.store.get(hash);
    if (bytes) files[path] = bytes;
  }
  files['sourcemaps/index.json'] = json(input.sourceMaps);

  const snapshots = input.snapshots ?? {};
  for (const hash of Object.values(snapshots)) {
    const path = `snapshots/${hash}.html`;
    if (files[path]) continue;
    const bytes = await input.store.get(hash);
    if (bytes) files[path] = bytes;
  }
  files['snapshots/index.json'] = json(snapshots);

  return files;
}

/**
 * Uses zipSync deliberately. fflate's async `zip` offloads entries above a size
 * threshold to a Web Worker, and under Bun the worker receives undefined data
 * ("dat.length" of undefined). Small entries stay on the main thread, so the
 * failure only appears once a real bundle is zipped. Synchronous compression is
 * correct on every runtime; the cost is a blocking call during a one-shot export.
 */
export function zipBundle(
  files: Record<string, Uint8Array>
): Promise<Uint8Array> {
  return Promise.resolve(zipSync(files, { level: 6 }));
}

/**
 * Download name for a bundle, e.g. `raidr-example.com-20260824-1000.zip`.
 * `startedAt` must be ISO-8601; date and time are sliced from it by position,
 * so the time is whatever zone the string is in (UTC for `toISOString()`).
 * Throws if `origin` is not a valid URL.
 */
export function bundleFilename(origin: string, startedAt: string): string {
  const host = new URL(origin).host;
  const date = startedAt.slice(0, 10).replace(/-/g, '');
  const time = startedAt.slice(11, 16).replace(':', '');
  return `raidr-${host}-${date}-${time}.zip`;
}
