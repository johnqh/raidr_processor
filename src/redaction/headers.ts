/** Header redaction for captured request and response headers. */
import type { Pseudonymizer } from './pseudonym';
import { classifyValue, isSensitiveKey } from './patterns';

/**
 * Returns a copy of `headers` with sensitive values replaced. A header is
 * redacted if its name is sensitive or its value is recognisably sensitive
 * (`classifyValue`); header names are kept as-is.
 */
export function redactHeaders(
  headers: Record<string, string>,
  pseudonym: Pseudonymizer
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const byKey = isSensitiveKey(key);
    if (byKey) {
      // Prefer the value's own shape when it is more specific than the header
      // name — an Authorization header holding a JWT is tagged as a JWT.
      const byValue = classifyValue(value);
      out[key] = pseudonym(byValue ?? byKey, value);
      continue;
    }
    const byValue = classifyValue(value);
    out[key] = byValue ? pseudonym(byValue, value) : value;
  }
  return out;
}
