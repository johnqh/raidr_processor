/**
 * Recovers original source files from the `sourcesContent` of v3 source maps.
 * Mappings are never decoded; only embedded source text is recovered.
 */

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
