import { expect, test } from 'bun:test';
import { createPseudonymizer } from '../../src/redaction/pseudonym';
import { redactHeaders } from '../../src/redaction/headers';
import { isSensitiveKey, classifyValue } from '../../src/redaction/patterns';

test('recognises sensitive key names', () => {
  expect(isSensitiveKey('password')).toBe('password');
  expect(isSensitiveKey('access_token')).toBe('jwt');
  expect(isSensitiveKey('client_secret')).toBe('api-key');
  expect(isSensitiveKey('secret')).toBe('api-key');
  // A session token is issued per user, not baked into the build.
  expect(isSensitiveKey('X-Session-Id')).toBe('session');
  // Per-user tokens in custom headers are credentials, not shipped config.
  for (const header of ['x-auth-token', 'X-Access-Token', 'x-user-token', 'x-csrf-token', 'X-XSRF-TOKEN', 'x-auth-key']) {
    expect(isSensitiveKey(header)).toBe('session');
  }
});

/**
 * A key the browser ships is public by construction — anyone can read it out
 * of the bundle. Redacting it protects nothing and leaves the reconstructed
 * app unable to reach its own backend.
 */
test('leaves publishable frontend api keys alone', () => {
  expect(isSensitiveKey('apiKey')).toBeNull();
  expect(isSensitiveKey('api_key')).toBeNull();
  expect(isSensitiveKey('x-api-key')).toBeNull();
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
});

/**
 * Length and alphabet are not evidence of a secret. Every content hash, trace
 * id, nonce, signature and public key has exactly this shape, and treating the
 * shape alone as sensitive replaced them all with placeholders the rebuilt app
 * cannot use.
 */
test('does not treat a long base64-ish value as a secret on shape alone', () => {
  expect(classifyValue('a'.repeat(40))).toBeNull();
  // A sha256 content hash.
  expect(
    classifyValue('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  ).toBeNull();
  // A publishable frontend api key of the kind that ships inside a bundle.
  // Deliberately not written in any vendor's real key format: a literal that
  // looks like a live credential trips secret scanners wherever this file goes,
  // and the classifier only ever sees length and alphabet anyway.
  expect(classifyValue('publishable-frontend-key-0123456789abcdefghij')).toBeNull();
});

test('still redacts a value whose key names it as sensitive', () => {
  const { pseudonym } = createPseudonymizer('s');
  const out = redactHeaders(
    { 'x-session-token': 'a'.repeat(40), etag: 'b'.repeat(40) },
    pseudonym
  );
  expect(out['x-session-token']).toMatch(/^<SESSION:[0-9a-f]{4}>$/);
  // An ETag is not a credential under any key name.
  expect(out.etag).toBe('b'.repeat(40));
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

/**
 * A session token authenticates a person, so it stays redacted — but it is not
 * an API key, and reporting it as one made a capture look full of leaked keys
 * when it held none.
 */
test('reports a session credential under its own kind', () => {
  expect(isSensitiveKey('session')).toBe('session');
  expect(isSensitiveKey('reddit_session')).toBe('session');
  expect(isSensitiveKey('x-session-id')).toBe('session');
  expect(isSensitiveKey('session_tracker')).toBe('session');
});

test('a session value gets a session placeholder', () => {
  const { pseudonym } = createPseudonymizer('s');
  const out = redactHeaders({ 'reddit_session': 'abc123def456' }, pseudonym);
  expect(out['reddit_session']).toMatch(/^<SESSION:[0-9a-f]{4}>$/);
});

test('a genuine client secret is still an api-key', () => {
  expect(isSensitiveKey('client_secret')).toBe('api-key');
});
