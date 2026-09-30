/**
 * Creating and validating `raidr.json`, plus the JSONL codec used for
 * `network/requests.jsonl` and `network/websockets.jsonl`.
 *
 * Note: RAIDR_FORMAT_VERSION is imported from the package index, which itself
 * re-exports this module. The cycle is safe only because the constant is read
 * inside functions, never at module top level.
 */
import { RAIDR_FORMAT_VERSION } from '../index';
import type { RaidrManifest } from './types';

/** Identity of a new capture session. `startedAt` is an ISO-8601 string. */
export interface CreateManifestInput {
  sessionId: string;
  origin: string;
  startedAt: string;
}

/**
 * A fresh manifest for a session that has just started: zero counts, no
 * `endedAt`, and no stack fingerprint yet. The capturer fills those in later.
 */
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

/** Outcome of `validateManifest`: the typed manifest, or every problem found. */
export type ValidateResult =
  | { ok: true; manifest: RaidrManifest }
  | { ok: false; errors: string[] };

/**
 * Structural check of a parsed `raidr.json`. Collects all errors rather than
 * stopping at the first. Deliberately shallow: it checks the format version
 * and required top-level fields, not the contents of `counts` or `stack`.
 */
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

/** Serializes rows as JSON Lines, one object per line, with a trailing newline. */
export function toJsonl(rows: unknown[]): string {
  return rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
}

/**
 * Parses JSON Lines, skipping blank lines. The rows are cast, not validated;
 * a malformed line throws from `JSON.parse`.
 */
export function parseJsonl<T>(text: string): T[] {
  return text
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as T);
}
