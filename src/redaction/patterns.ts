/**
 * What counts as sensitive: by key name (`isSensitiveKey`) and by value shape
 * (`classifyValue`). Both are consulted by header and JSON redaction.
 *
 * Deliberately not sensitive: `api_key`, `apikey` and `x-api-key` (see the
 * comment in KEY_KINDS), UUIDs, and long opaque strings with no credential
 * syntax. tests/redaction/headers.test.ts pins the x-api-key behaviour.
 */
import type { RedactionKind } from '../bundle/types';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const JWT_RE = /^ey[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/;
const BEARER_RE = /^Bearer\s+\S{8,}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const KEY_KINDS: Array<[RegExp, RedactionKind]> = [
  [/^(password|passwd|pwd)$/i, 'password'],
  [/^(access_?token|refresh_?token|id_?token|jwt)$/i, 'jwt'],
  // Deliberately excludes api_key / apikey / x-api-key. A key the browser
  // ships is public by construction: anyone can read it out of the bundle, so
  // redacting it protects nothing and leaves the reconstructed app unable to
  // reach its own backend. A client secret is never legitimately public.
  [/^(client_?secret|secret)$/i, 'api-key'],
  [/^(cookie|set-cookie)$/i, 'cookie'],
  [/^(authorization|proxy-authorization)$/i, 'bearer'],
  // Its own kind, not 'api-key': a session token authenticates a person, and
  // filing it under the label for keys made a capture look full of leaked API
  // keys when it held none.
  [/(^|[-_])session([-_]|$)/i, 'session'],
  // Per-user credentials in custom headers: X-Auth-Token, X-Access-Token,
  // X-User-Token, X-CSRF-Token and friends. Unlike x-api-key, these are issued
  // to a person at login and never appear in the shipped bundle.
  [/^x-(auth|access|user|id|refresh|csrf|xsrf)[-_]?token$/i, 'session'],
  [/^x-(auth|authorization|access)[-_]?key$/i, 'session'],
  [/^(ssn|social_?security)$/i, 'password'],
  [/^(credit_?card|card_?number|cvv|cvc)$/i, 'password'],
  [/^(email|email_?address)$/i, 'email'],
  [/^(phone|phone_?number|mobile)$/i, 'phone'],
];

/**
 * Redaction kind implied by a header name or JSON property name, or null. The
 * first matching rule in KEY_KINDS wins, so order matters. Case-insensitive.
 */
export function isSensitiveKey(key: string): RedactionKind | null {
  for (const [pattern, kind] of KEY_KINDS) {
    if (pattern.test(key)) return kind;
  }
  return null;
}

/**
 * Redaction kind implied by a string's own syntax (JWT, `Bearer ...`, email),
 * or null. Must match the whole string; embedded occurrences are not found.
 */
export function classifyValue(value: string): RedactionKind | null {
  // UUIDs first. Nothing below matches one today, but the guard states the
  // invariant that keeps a future shape rule from breaking foreign-key
  // correspondence: an id is structural, not secret.
  if (UUID_RE.test(value)) return null;
  if (JWT_RE.test(value)) return 'jwt';
  if (BEARER_RE.test(value)) return 'bearer';
  if (EMAIL_RE.test(value)) return 'email';
  // Nothing is inferred from length and alphabet alone. A long base64-ish
  // string is equally the shape of a content hash, a trace id, a nonce, a
  // signature and a public key; treating the shape as sensitive replaced all
  // of them with placeholders the rebuilt app cannot use. A credential is
  // recognised by its own syntax (JWT, Bearer) or by the key that carries it.
  return null;
}
