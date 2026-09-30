/**
 * Collapses concrete URL paths into endpoint templates so that
 * `/users/42` and `/users/43` count as one endpoint.
 */
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

/**
 * Replaces variable-looking path segments with placeholders, checked in this
 * order: all digits → `{id}`, UUID → `{uuid}`, 16+ hex chars → `{hash}`, 24+
 * URL-safe chars → `{token}`. Placeholder names are not unique, so
 * `/a/1/b/2` becomes `/a/{id}/b/{id}`.
 */
export function toPathTemplate(pathname: string): string {
  return pathname.split('/').map(templateSegment).join('/');
}

/**
 * Canonical endpoint identity, `"<METHOD> <template>"`, e.g. `GET /users/{id}`.
 * The query string and origin are dropped. This key joins the API model, the
 * route model, replay recordings and coverage, so changing its format changes
 * all of them.
 */
export function endpointKey(method: string, url: string): string {
  try {
    return `${method} ${toPathTemplate(new URL(url).pathname)}`;
  } catch {
    return `${method} ${url}`;
  }
}
