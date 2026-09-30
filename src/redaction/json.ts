/**
 * Structural redaction of JSON bodies and of the JSON state that SSR
 * frameworks inline into HTML. Keys, nesting and non-string values are
 * preserved so inferred schemas and the rebuilt app still line up.
 */
import type { Pseudonymizer } from './pseudonym';
import { classifyValue, isSensitiveKey } from './patterns';

/**
 * Recursively redacts string leaves of a parsed JSON value. `keyHint` is the
 * property name the value sits under; array items inherit their parent's key,
 * so `{"emails": [...]}` is judged by `emails`. Numbers, booleans and null are
 * never redacted.
 */
export function redactJsonValue(
  value: unknown,
  pseudonym: Pseudonymizer,
  keyHint: string | null = null
): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactJsonValue(item, pseudonym, keyHint));
  }

  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      out[key] = redactJsonValue(child, pseudonym, key);
    }
    return out;
  }

  if (typeof value === 'string') {
    const byValue = classifyValue(value);
    const byKey = keyHint ? isSensitiveKey(keyHint) : null;
    // Value shape wins when both match: it is the more specific signal.
    const kind = byValue ?? byKey;
    return kind ? pseudonym(kind, value) : value;
  }

  return value;
}

/**
 * Parses, redacts and re-serializes a JSON document. The output is compact
 * `JSON.stringify` output, so whitespace differs from the input even when
 * nothing was redacted. Non-JSON text is returned unchanged.
 */
export function redactJsonText(
  text: string,
  pseudonym: Pseudonymizer
): string {
  try {
    const parsed: unknown = JSON.parse(text);
    return JSON.stringify(redactJsonValue(parsed, pseudonym));
  } catch {
    // Not JSON. Returning it unchanged is correct: this function's contract is
    // JSON redaction, and the caller decides what non-JSON bodies deserve.
    return text;
  }
}

const HYDRATION_KEYS = [
  '__INITIAL_STATE__',
  '__PRELOADED_STATE__',
  '__NUXT__',
  '__NEXT_DATA__',
];

/** Extracts the balanced-brace object starting at `start`, or null. */
function readObjectLiteral(text: string, start: number): string | null {
  if (text[start] !== '{') return null;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const char = text[i]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Redacts the object literal that follows each known hydration global
 * (`__INITIAL_STATE__`, `__PRELOADED_STATE__`, `__NUXT__`, `__NEXT_DATA__`) in
 * an HTML document. The rest of the HTML is untouched. A literal that is not
 * strict JSON fails to parse and is left as-is, unredacted.
 */
export function redactHtmlHydration(
  html: string,
  pseudonym: Pseudonymizer
): string {
  let out = html;

  for (const key of HYDRATION_KEYS) {
    let searchFrom = 0;
    for (;;) {
      const keyIndex = out.indexOf(key, searchFrom);
      if (keyIndex < 0) break;

      const braceIndex = out.indexOf('{', keyIndex);
      if (braceIndex < 0) break;

      const literal = readObjectLiteral(out, braceIndex);
      if (!literal) {
        searchFrom = keyIndex + key.length;
        continue;
      }

      const redacted = redactJsonText(literal, pseudonym);
      out = out.slice(0, braceIndex) + redacted + out.slice(braceIndex + literal.length);
      searchFrom = braceIndex + redacted.length;
    }
  }

  return out;
}
