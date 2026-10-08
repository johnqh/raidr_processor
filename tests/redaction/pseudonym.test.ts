import { expect, test } from 'bun:test';
import { createPseudonymizer } from '../../src/redaction/pseudonym';

test('the same value always yields the same placeholder', () => {
  const { pseudonym } = createPseudonymizer('salt-1');
  const a = pseudonym('jwt', 'eyJhbGciOi.payload.sig');
  const b = pseudonym('jwt', 'eyJhbGciOi.payload.sig');
  expect(a).toBe(b);
});

test('different values yield different placeholders', () => {
  const { pseudonym } = createPseudonymizer('salt-1');
  expect(pseudonym('jwt', 'token-a')).not.toBe(pseudonym('jwt', 'token-b'));
});

test('placeholder format is <KIND:hash>', () => {
  const { pseudonym } = createPseudonymizer('salt-1');
  expect(pseudonym('jwt', 'token-a')).toMatch(/^<JWT:[0-9a-f]{4}>$/);
  expect(pseudonym('api-key', 'k')).toMatch(/^<API_KEY:[0-9a-f]{4}>$/);
  expect(pseudonym('high-entropy', 'x')).toMatch(/^<SECRET:[0-9a-f]{4}>$/);
});

test('a different salt yields a different placeholder for the same value', () => {
  const one = createPseudonymizer('salt-1');
  const two = createPseudonymizer('salt-2');
  expect(one.pseudonym('jwt', 'token-a')).not.toBe(two.pseudonym('jwt', 'token-a'));
});

test('emails become sequential example.com addresses, stably', () => {
  const { pseudonym } = createPseudonymizer('salt-1');
  expect(pseudonym('email', 'jane@corp.com')).toBe('user1@example.com');
  expect(pseudonym('email', 'bob@corp.com')).toBe('user2@example.com');
  expect(pseudonym('email', 'jane@corp.com')).toBe('user1@example.com');
});

test('phones become sequential placeholder numbers, stably', () => {
  const { pseudonym } = createPseudonymizer('salt-1');
  expect(pseudonym('phone', '+14155550001')).toBe('+15550000001');
  expect(pseudonym('phone', '+14155550002')).toBe('+15550000002');
  expect(pseudonym('phone', '+14155550001')).toBe('+15550000001');
});

test('entries report each placeholder with its kind and occurrence count', () => {
  const { pseudonym, entries } = createPseudonymizer('salt-1');
  pseudonym('jwt', 'token-a');
  pseudonym('jwt', 'token-a');
  pseudonym('jwt', 'token-b');

  const report = entries();
  expect(report).toHaveLength(2);
  const first = report.find((e) => e.occurrences === 2);
  expect(first!.kind).toBe('jwt');
});

test('entries never contain the original values', () => {
  const { pseudonym, entries } = createPseudonymizer('salt-1');
  pseudonym('jwt', 'super-secret-token');
  expect(JSON.stringify(entries())).not.toContain('super-secret-token');
});

test('emails the site masked get their own placeholders', () => {
  const { pseudonym } = createPseudonymizer('salt-1');
  expect(pseudonym('email', 'jane@corp.com')).toBe('user1@example.com');
  expect(pseudonym('email', 'ja***@corp.com')).toBe('masked1@example.com');
  expect(pseudonym('email', 'b•••@corp.com')).toBe('masked2@example.com');
  expect(pseudonym('email', 'ja***')).toBe('masked3@example.com');
  expect(pseudonym('email', 'ja***@corp.com')).toBe('masked1@example.com');
  expect(pseudonym('email', 'bob@corp.com')).toBe('user2@example.com');
});

test('an empty value stays empty', () => {
  const { pseudonym, entries } = createPseudonymizer('salt-1');
  expect(pseudonym('email', '')).toBe('');
  expect(entries()).toHaveLength(0);
});
