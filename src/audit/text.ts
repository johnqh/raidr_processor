/** Text helpers for the audit: masking, excerpts, line numbers, fingerprints. */

/** Evidence snippets are cut to this many characters (raidr_types' `MAX_EVIDENCE_SNIPPET`). */
export const SNIPPET_CHARS = 500;

/** `sk_live_abcdef…` → `sk_l…ef`: enough to recognise the key, not to use it. */
export function maskSecret(value: string): string {
  if (value.length <= 8) return '****';
  return `${value.slice(0, 4)}…${value.slice(-2)}`;
}

/**
 * Patterns of credential values. Shared by the secret rule and by masking:
 * every snippet the audit emits goes through `maskSecrets`, so a key quoted by
 * another rule's evidence is never stored whole.
 */
export const SECRET_VALUE_RES: RegExp[] = [
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\b(?:sk|rk)_live_[0-9A-Za-z]{16,}\b/g,
  /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{40,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bGOCSPX-[A-Za-z0-9_-]{20,}\b/g,
  // Google OAuth refresh and access tokens.
  /\b1\/\/0[A-Za-z0-9_-]{20,}/g,
  /\bya29\.[A-Za-z0-9_-]{20,}/g,
  /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{20,}\b/g,
  /\bkey-[0-9a-f]{32}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----[\s\S]{0,4000}?-----END (?:[A-Z]+ )?PRIVATE KEY-----/g,
];

/** Credentials inside URLs (`postgres://user:pass@host`): the password part. */
const URL_PASSWORD_RE = /(\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@'"`]+:)([^\s/@'"`]+)(@)/gi;

/**
 * A quoted value under a secret-named key (`client_secret:"13ac…"`,
 * `"refresh_token": "…"`), whatever its shape: a Facebook app secret is plain
 * hex, which no value pattern can tell from a hash (share.myjosh.in,
 * 2026-10-08, stored the whole secret in a snippet).
 */
const KEYED_SECRET_RE =
  /(\b(?:(?:client|app|api|consumer)_?secret|secret_?key|refresh_?token|access_?token|private_?key|password|passwd)["']?\s*[:=]\s*["'`])([^"'`\s]{8,})(["'`])/gi;

/** Every credential-shaped value in `text`, masked. */
export function maskSecrets(text: string): string {
  let out = text;
  for (const re of SECRET_VALUE_RES) {
    out = out.replace(re, (m) => maskSecret(m));
  }
  out = out.replace(KEYED_SECRET_RE, (_m, key: string, value: string, end: string) =>
    // An already-masked value (`GOCS…gf`) stays as it is.
    value.includes('…') ? `${key}${value}${end}` : `${key}${maskSecret(value)}${end}`,
  );
  return out.replace(URL_PASSWORD_RE, (_m, a: string, pass: string, b: string) => `${a}${maskSecret(pass)}${b}`);
}

/** 1-based line of `index` in `text`. */
export function lineAt(text: string, index: number): number {
  let line = 1;
  for (let i = text.indexOf('\n'); i !== -1 && i < index; i = text.indexOf('\n', i + 1)) {
    line += 1;
  }
  return line;
}

/**
 * The text around a match, `before`/`after` characters each way, on one line
 * (minified code has no useful line breaks), masked and cut to `SNIPPET_CHARS`.
 */
export function excerpt(text: string, start: number, end: number, before = 120, after = 120): string {
  const from = Math.max(0, start - before);
  const to = Math.min(text.length, end + after);
  const piece = text.slice(from, to).replace(/\s+/g, ' ').trim();
  const masked = maskSecrets(piece);
  return masked.length > SNIPPET_CHARS ? `${masked.slice(0, SNIPPET_CHARS - 1)}…` : masked;
}

/**
 * 64-bit FNV-1a as 16 hex digits. Not a security hash: it only makes
 * fingerprints short and stable across crawls.
 */
export function fnv1a(text: string): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, '0');
}

/**
 * A file name without its build hash, so the same file in the next deploy
 * gets the same fingerprint: `main.3f2a9c1b.js` → `main.js`,
 * `chunk-AB12CD34.mjs` → `chunk.mjs`, query and directories dropped.
 */
export function stableFileName(file: string): string {
  let name = file.split('?')[0] ?? file;
  name = name.split('/').pop() ?? name;
  return name
    .replace(/[.-][0-9a-f]{6,}(?=[.-])/gi, '')
    .replace(/[.-][A-Za-z0-9_]{8,}(?=\.m?js$)/, '')
    .replace(/^\d+\./, '');
}

/** `host` of a URL, or null. */
export function hostOf(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

/** Header lookup ignoring case. */
export function header(headers: Record<string, string>, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return value;
  }
  return undefined;
}
