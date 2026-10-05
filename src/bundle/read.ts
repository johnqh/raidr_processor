/**
 * Reads a bundle that is already in memory: its files by path, as unzipped
 * from a `.zip` or read from an unpacked directory by the caller. Pure, so the
 * extension can use it as well as raidr_cli and raidr_crawler, which only add
 * the file I/O around it.
 */
import { unzipSync } from 'fflate';
import type { RuntimeArtifacts } from './assemble';
import { parseJsonl, validateManifest } from './manifest';
import type { CapturedFrame, CapturedRequest, Gap, RaidrManifest, RedactionEntry } from './types';

/**
 * A bundle held entirely in memory. Missing optional files (gaps, redaction,
 * source maps, snapshots, runtime/*) load as empty defaults rather than
 * throwing; only `raidr.json` is required.
 */
export interface LoadedBundle {
  manifest: RaidrManifest;
  /** Rows of `network/requests.jsonl`, in file order. */
  requests: CapturedRequest[];
  /** Rows of `network/websockets.jsonl`. */
  frames: CapturedFrame[];
  gaps: Gap[];
  redaction: RedactionEntry[];
  /** Script URL → hash of its source map. */
  sourceMaps: Record<string, string>;
  /** Route path → hash of the rendered DOM, for client-rendered routes. */
  snapshots: Record<string, string>;
  runtime: RuntimeArtifacts;
  /** Every file in the bundle by path, for extras the format does not name. */
  files: Map<string, Uint8Array>;
  /** Hash → bytes, merged from `content/`, `sourcemaps/` and `snapshots/`. */
  content: Map<string, Uint8Array>;
  /** Content by hash as UTF-8, or null when absent. */
  text(hash: string): string | null;
  /** Content by hash parsed as JSON; undefined when absent or not JSON. */
  json(hash: string): unknown;
}

const decoder = new TextDecoder();

/**
 * A bundle from its files by path. `label` (the bundle's path, say) prefixes
 * errors. Throws when `raidr.json` is missing or fails `validateManifest`, or
 * when a named JSON file is malformed.
 */
export function readBundle(
  input: Map<string, Uint8Array> | Record<string, Uint8Array>,
  label = 'bundle'
): LoadedBundle {
  const files = input instanceof Map ? input : new Map(Object.entries(input));

  const readText = (name: string): string | null => {
    const bytes = files.get(name);
    return bytes ? decoder.decode(bytes) : null;
  };
  const readJson = <T>(name: string, fallback: T): T => {
    const text = readText(name);
    return text === null ? fallback : (JSON.parse(text) as T);
  };

  const manifestText = readText('raidr.json');
  if (manifestText === null) throw new Error(`${label}: raidr.json not found`);
  const validation = validateManifest(JSON.parse(manifestText));
  if (!validation.ok) {
    throw new Error(`${label}: invalid bundle — ${validation.errors.join('; ')}`);
  }

  // Gaps first: everything downstream must know what is missing before it
  // starts reasoning about what is present.
  const gaps = readJson<Gap[]>('gaps.json', []);

  const content = new Map<string, Uint8Array>();
  for (const [name, bytes] of files) {
    if (name.startsWith('content/')) {
      const hash = name.slice('content/'.length).split('.')[0];
      if (hash) content.set(hash, bytes);
    } else if (name.startsWith('sourcemaps/') && name.endsWith('.map')) {
      content.set(name.slice('sourcemaps/'.length, -'.map'.length), bytes);
    } else if (name.startsWith('snapshots/') && name.endsWith('.html')) {
      content.set(name.slice('snapshots/'.length, -'.html'.length), bytes);
    }
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
    snapshots: readJson<Record<string, string>>('snapshots/index.json', {}),
    runtime: {
      framework: readJson('runtime/framework.json', null),
      routes: readJson('runtime/routes.json', []),
      stores: readJson('runtime/stores.json', []),
      chunks: readJson('runtime/chunks.json', { known: [], loaded: [] }),
      coverage: readJson('runtime/coverage.json', {}),
      navigations: readJson('runtime/navigations.json', []),
    },
    files,
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

/** A bundle from the bytes of its `.zip`. */
export function unzipBundle(zip: Uint8Array, label = 'bundle'): LoadedBundle {
  return readBundle(unzipSync(zip), label);
}
