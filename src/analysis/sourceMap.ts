/**
 * Recovers original source files from the `sourcesContent` of v3 source maps.
 * Mappings are never decoded; only embedded source text is recovered.
 */
import type { LoadedBundle } from '../bundle/read';

/** The fields of a v3 source map this package reads. */
export interface SourceMap {
  version: 3;
  file?: string;
  sources: string[];
  sourcesContent?: Array<string | null>;
  mappings: string;
}

/** One recovered source file, with a repo-relative path. */
export interface RecoveredFile {
  path: string;
  content: string;
}

/** Parses a source map, returning null unless it is JSON with version 3 and a `sources` array. */
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

/**
 * Returns the embedded sources of a map, skipping empty entries and anything
 * under `node_modules`. Two sources that normalize to the same path are both
 * returned; the caller decides which wins.
 */
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

/** `mappedBytes` as an integer percentage of `totalBytes`; 0 when `totalBytes` is 0. */
export function recoveryRatio(input: {
  mappedBytes: number;
  totalBytes: number;
}): number {
  if (input.totalBytes === 0) return 0;
  return Math.round((input.mappedBytes / input.totalBytes) * 100);
}

/** What a bundle's source maps give back. */
export interface BundleSources {
  /** One file per path, the last map naming a path winning, in first-seen order. */
  files: RecoveredFile[];
  /** Bytes of captured JavaScript a usable source map covers. */
  mappedBytes: number;
  /** Bytes of captured JavaScript. */
  totalBytes: number;
  /** `recoveryRatio` of the two. */
  ratio: number;
}

/**
 * The original sources of every captured script that has a usable source map
 * in the bundle (`sourcemaps/index.json`), and how much of the JavaScript
 * those maps cover.
 */
export function recoverBundleSources(
  bundle: Pick<LoadedBundle, 'requests' | 'sourceMaps' | 'content' | 'text'>
): BundleSources {
  const byPath = new Map<string, string>();
  let mappedBytes = 0;
  let totalBytes = 0;
  for (const request of bundle.requests) {
    if (!request.mimeType?.includes('javascript') || !request.responseBodyHash) continue;
    const size = bundle.content.get(request.responseBodyHash)?.byteLength ?? 0;
    totalBytes += size;
    const mapHash = bundle.sourceMaps[request.url];
    const mapText = mapHash ? bundle.text(mapHash) : null;
    const map = mapText === null ? null : parseSourceMap(mapText);
    if (!map) continue;
    mappedBytes += size;
    for (const file of recoverSources(map)) byPath.set(file.path, file.content);
  }
  return {
    files: [...byPath].map(([path, content]) => ({ path, content })),
    mappedBytes,
    totalBytes,
    ratio: recoveryRatio({ mappedBytes, totalBytes }),
  };
}
