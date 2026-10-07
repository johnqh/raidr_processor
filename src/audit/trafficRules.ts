/**
 * Rules over recorded traffic: response security headers, CORS, cookie
 * attributes, mixed content, version banners, and API responses that expose
 * personal data, secret fields or error internals.
 */
import { endpointKey } from '../coverage/pathTemplate';
import type { AuditCandidate, AuditInput, AuditRequest } from './types';
import { excerpt, fnv1a, header, hostOf } from './text';

type Draft = Omit<AuditCandidate, 'id'>;

function siteHostTest(input: AuditInput): (host: string) => boolean {
  if (input.isSiteHost) return input.isSiteHost;
  const own = hostOf(input.origin);
  return (host) => host === own;
}

function isDocument(r: AuditRequest): boolean {
  return (
    r.resourceType === 'Document' &&
    r.status !== null &&
    r.status >= 200 &&
    r.status < 300 &&
    /html/i.test(r.mimeType ?? '')
  );
}

function isApiCall(r: AuditRequest): boolean {
  return (r.resourceType === 'XHR' || r.resourceType === 'Fetch') && r.method !== 'OPTIONS';
}

/** Site documents grouped by host, in request order. */
function documentsByHost(input: AuditInput): Map<string, AuditRequest[]> {
  const isSite = siteHostTest(input);
  const out = new Map<string, AuditRequest[]>();
  for (const r of input.requests) {
    if (!isDocument(r)) continue;
    const host = hostOf(r.url);
    if (!host || !isSite(host)) continue;
    const list = out.get(host) ?? [];
    list.push(r);
    out.set(host, list);
  }
  return out;
}

interface HeaderRule {
  rule: string;
  /** True when this document lacks the protection. */
  missing: (r: AuditRequest) => boolean;
  title: string;
  description: (host: string) => string;
  recommendation: string;
  severity: AuditCandidate['severity'];
  cwe: string;
  owasp: string;
  header: string;
  httpsOnly?: boolean;
}

const MIN_HSTS_SECONDS = 15552000; // 180 days

function csp(r: AuditRequest): string {
  return header(r.responseHeaders, 'content-security-policy') ?? '';
}

/** The script policy of a CSP: `script-src`, else `default-src`. */
function scriptPolicy(policy: string): string | null {
  const directives = policy.split(';').map((d) => d.trim().toLowerCase());
  return (
    directives.find((d) => d.startsWith('script-src ')) ??
    directives.find((d) => d.startsWith('default-src ')) ??
    null
  );
}

const HEADER_RULES: HeaderRule[] = [
  {
    rule: 'missing-csp',
    missing: (r) => csp(r) === '',
    title: 'No Content Security Policy',
    description: (host) =>
      `Pages on ${host} are served without a Content-Security-Policy header, so nothing limits what an injected script can load or run.`,
    recommendation: 'Send a Content-Security-Policy with a strict script-src (nonces or hashes), starting in report-only mode.',
    severity: 'low',
    cwe: 'CWE-693',
    owasp: 'A05:2021',
    header: 'content-security-policy',
  },
  {
    rule: 'weak-csp',
    missing: (r) => {
      const policy = scriptPolicy(csp(r));
      if (!policy) return false;
      const hasNonce = /'nonce-|'sha(256|384|512)-|'strict-dynamic'/.test(policy);
      return (/'unsafe-inline'/.test(policy) && !hasNonce) || / \*( |$)/.test(policy) || /'unsafe-eval'/.test(policy);
    },
    title: 'Content Security Policy allows inline or any script',
    description: (host) =>
      `The script policy on ${host} allows 'unsafe-inline', 'unsafe-eval' or any host, which takes away most of the protection against injected scripts.`,
    recommendation: "Replace 'unsafe-inline' with nonces or hashes, drop 'unsafe-eval', and list script hosts explicitly.",
    severity: 'low',
    cwe: 'CWE-693',
    owasp: 'A05:2021',
    header: 'content-security-policy',
  },
  {
    rule: 'missing-hsts',
    missing: (r) => {
      const value = header(r.responseHeaders, 'strict-transport-security');
      if (!value) return true;
      const age = /max-age\s*=\s*"?(\d+)/i.exec(value)?.[1];
      return age === undefined || Number(age) < MIN_HSTS_SECONDS;
    },
    title: 'HTTPS is not enforced with HSTS',
    description: (host) =>
      `${host} sends no Strict-Transport-Security header (or one shorter than 180 days), so a first visit over plain HTTP can be intercepted and downgraded.`,
    recommendation: 'Send Strict-Transport-Security: max-age=31536000; includeSubDomains.',
    severity: 'low',
    cwe: 'CWE-319',
    owasp: 'A02:2021',
    header: 'strict-transport-security',
    httpsOnly: true,
  },
  {
    rule: 'missing-frame-protection',
    missing: (r) =>
      !header(r.responseHeaders, 'x-frame-options') && !/frame-ancestors/i.test(csp(r)),
    title: 'Pages can be framed by any site',
    description: (host) =>
      `Pages on ${host} set neither X-Frame-Options nor a CSP frame-ancestors directive, so another site can load them in a hidden frame and trick people into clicking (clickjacking).`,
    recommendation: "Send Content-Security-Policy: frame-ancestors 'self' (or X-Frame-Options: DENY).",
    severity: 'low',
    cwe: 'CWE-1021',
    owasp: 'A05:2021',
    header: 'x-frame-options',
  },
  {
    rule: 'missing-nosniff',
    missing: (r) => !/nosniff/i.test(header(r.responseHeaders, 'x-content-type-options') ?? ''),
    title: 'Content type sniffing is not disabled',
    description: (host) =>
      `${host} does not send X-Content-Type-Options: nosniff, so browsers may treat an uploaded or reflected file as script or HTML.`,
    recommendation: 'Send X-Content-Type-Options: nosniff on every response.',
    severity: 'info',
    cwe: 'CWE-693',
    owasp: 'A05:2021',
    header: 'x-content-type-options',
  },
];

function headerCandidates(input: AuditInput): Draft[] {
  const out: Draft[] = [];
  for (const [host, docs] of documentsByHost(input)) {
    const https = docs[0]?.url.startsWith('https:') ?? false;
    for (const rule of HEADER_RULES) {
      if (rule.httpsOnly && !https) continue;
      const lacking = docs.filter(rule.missing);
      // Most of the host's pages: one odd error page does not make an issue.
      if (lacking.length === 0 || lacking.length * 2 < docs.length) continue;
      const first = lacking[0]!;
      // A weak policy is quoted by its script directive: the whole header is often too long.
      const seen = rule.rule === 'weak-csp' ? (scriptPolicy(csp(first)) ?? undefined) : header(first.responseHeaders, rule.header);
      out.push({
        rule: rule.rule,
        category: 'headers-cookies',
        severity: rule.severity,
        confidence: 'high',
        title: rule.title,
        description: rule.description(host),
        recommendation: rule.recommendation,
        cwe: rule.cwe,
        owasp: rule.owasp,
        api_host: host,
        evidence: [
          {
            kind: 'header',
            url: first.url,
            header: rule.header,
            snippet: seen ? `${rule.header}: ${seen}`.slice(0, 500) : `${rule.header} absent on ${lacking.length} of ${docs.length} page(s)`,
          },
        ],
        fingerprint: `${rule.rule}:${host}`,
      });
    }
  }
  return out;
}

/** `nginx/1.18.0`, `PHP/7.4.3`: a product with a version number. */
const VERSION_BANNER_RE = /[A-Za-z][\w.-]*\/\d+(\.\d+)+/;
const BANNER_HEADERS = ['server', 'x-powered-by', 'x-aspnet-version', 'x-aspnetmvc-version'];

function versionBanners(input: AuditInput): Draft[] {
  const isSite = siteHostTest(input);
  const byHost = new Map<string, { header: string; value: string; url: string }>();
  for (const r of input.requests) {
    const host = hostOf(r.url);
    if (!host || !isSite(host) || byHost.has(host)) continue;
    for (const name of BANNER_HEADERS) {
      const value = header(r.responseHeaders, name);
      if (value && (name.startsWith('x-aspnet') || VERSION_BANNER_RE.test(value))) {
        byHost.set(host, { header: name, value, url: r.url });
        break;
      }
    }
  }
  return [...byHost.entries()].map(([host, hit]) => ({
    rule: 'version-disclosure',
    category: 'headers-cookies' as const,
    severity: 'info' as const,
    confidence: 'high' as const,
    title: 'Server software version is disclosed',
    description: `${host} names its software and version in the ${hit.header} header (${hit.value}), which helps an attacker pick known exploits.`,
    recommendation: `Remove the version from the ${hit.header} header.`,
    cwe: 'CWE-497',
    owasp: 'A05:2021',
    api_host: host,
    evidence: [{ kind: 'header' as const, url: hit.url, header: hit.header, snippet: `${hit.header}: ${hit.value}`.slice(0, 500) }],
    fingerprint: `version-disclosure:${host}:${hit.header}`,
  }));
}

function corsCandidates(input: AuditInput): Draft[] {
  const isSite = siteHostTest(input);
  const out: Draft[] = [];
  const seen = new Set<string>();
  for (const r of input.requests) {
    if (!isApiCall(r)) continue;
    const host = hostOf(r.url);
    if (!host || !isSite(host)) continue;
    const allowOrigin = header(r.responseHeaders, 'access-control-allow-origin')?.trim();
    const credentials = /^true$/i.test(header(r.responseHeaders, 'access-control-allow-credentials')?.trim() ?? '');
    if (!allowOrigin || !credentials) continue;
    let rule: string | null = null;
    if (allowOrigin === 'null') rule = 'cors-null-origin';
    else if (allowOrigin === '*') rule = 'cors-wildcard-credentials';
    if (!rule) continue;
    const fingerprint = `${rule}:${host}`;
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    const nullOrigin = rule === 'cors-null-origin';
    out.push({
      rule,
      category: 'headers-cookies',
      severity: nullOrigin ? 'high' : 'medium',
      confidence: nullOrigin ? 'high' : 'medium',
      title: nullOrigin ? 'API trusts the "null" origin with credentials' : 'API allows any origin with credentials',
      description: nullOrigin
        ? `${host} answers Access-Control-Allow-Origin: null with credentials allowed. Sandboxed frames and local files send the null origin, so any site can read signed-in responses.`
        : `${host} answers Access-Control-Allow-Origin: * together with Access-Control-Allow-Credentials: true. Browsers refuse that pair, which suggests the origin check is loose and may reflect other origins.`,
      recommendation: 'Allow only an explicit list of trusted origins when credentials are allowed.',
      cwe: 'CWE-942',
      owasp: 'A05:2021',
      api_host: host,
      evidence: [
        {
          kind: 'header',
          url: r.url,
          endpoint: endpointKey(r.method, r.url),
          header: 'access-control-allow-origin',
          snippet: `access-control-allow-origin: ${allowOrigin}; access-control-allow-credentials: true`,
        },
      ],
      fingerprint,
    });
  }
  return out;
}

/** Cookie names that carry a session or login. */
const SESSION_COOKIE_RE =
  /sess|(^|[-_.])sid($|[-_.])|auth|token|jwt|login|remember|^connect\.sid$|^phpsessid$|^jsessionid$|^asp\.net_sessionid$/i;
/** Double-submit CSRF cookies must be readable by script. */
const CSRF_COOKIE_RE = /csrf|xsrf/i;

function cookieCandidates(input: AuditInput): Draft[] {
  const isSite = siteHostTest(input);
  const https = input.origin.startsWith('https:');
  const out: Draft[] = [];
  const siteHosts = new Set<string>();
  for (const r of input.requests) {
    const host = hostOf(r.url)?.replace(/:\d+$/, '');
    if (host && isSite(host)) siteHosts.add(host);
  }
  for (const cookie of input.cookies) {
    const domain = cookie.domain.replace(/^\./, '');
    const siteCookie =
      isSite(domain) || [...siteHosts].some((h) => h === domain || h.endsWith(`.${domain}`));
    if (!siteCookie || !SESSION_COOKIE_RE.test(cookie.name)) continue;
    const flaws: string[] = [];
    const cwes: string[] = [];
    if (!cookie.httpOnly && !CSRF_COOKIE_RE.test(cookie.name)) {
      flaws.push('is readable by scripts (no HttpOnly)');
      cwes.push('CWE-1004');
    }
    if (https && !cookie.secure) {
      flaws.push('can be sent over plain HTTP (no Secure)');
      cwes.push('CWE-614');
    }
    const sameSite = (cookie.sameSite ?? '').toLowerCase();
    if (sameSite === 'none' && !cookie.secure) {
      flaws.push('is SameSite=None without Secure');
      cwes.push('CWE-1275');
    }
    if (flaws.length === 0) continue;
    out.push({
      rule: 'insecure-session-cookie',
      category: 'headers-cookies',
      severity: cwes.includes('CWE-1004') ? 'medium' : 'low',
      confidence: 'medium',
      title: `Session cookie "${cookie.name}" is missing protections`,
      description: `The cookie ${cookie.name} (${cookie.domain}) looks like it holds a session and ${flaws.join(', and ')}.`,
      recommendation: 'Set HttpOnly, Secure and SameSite=Lax (or Strict) on session cookies.',
      cwe: cwes[0] ?? null,
      owasp: 'A05:2021',
      api_host: domain,
      evidence: [
        {
          kind: 'cookie',
          cookie: cookie.name,
          snippet: `domain=${cookie.domain}; path=${cookie.path}; httpOnly=${cookie.httpOnly}; secure=${cookie.secure}; sameSite=${cookie.sameSite ?? 'unset'}`,
        },
      ],
      fingerprint: `insecure-session-cookie:${domain}:${cookie.name}`,
    });
  }
  return out;
}

function mixedContent(input: AuditInput): Draft[] {
  if (!input.origin.startsWith('https:')) return [];
  const hosts = new Map<string, string>();
  for (const r of input.requests) {
    if (!r.url.startsWith('http:')) continue;
    const host = hostOf(r.url);
    if (!host || /^(localhost|127\.|\[::1\])/.test(host) || hosts.has(host)) continue;
    hosts.set(host, r.url);
  }
  if (hosts.size === 0) return [];
  const site = hostOf(input.origin) ?? input.origin;
  return [
    {
      rule: 'mixed-content',
      category: 'headers-cookies',
      severity: 'low',
      confidence: 'high',
      title: 'Secure pages load content over plain HTTP',
      description: `HTTPS pages load ${hosts.size} resource host(s) over unencrypted HTTP (${[...hosts.keys()].slice(0, 3).join(', ')}), which a network attacker can read or replace.`,
      recommendation: 'Load every resource over HTTPS (or send CSP upgrade-insecure-requests).',
      cwe: 'CWE-319',
      owasp: 'A02:2021',
      api_host: site,
      evidence: [...hosts.values()].slice(0, 5).map((url) => ({ kind: 'traffic' as const, url })),
      fingerprint: `mixed-content:${fnv1a([...hosts.keys()].sort().join(','))}`,
    },
  ];
}

/** Error internals in a response: stack traces, SQL errors, server paths. */
const VERBOSE_ERROR_RES: Array<[RegExp, string]> = [
  [/Traceback \(most recent call last\)/, 'Python traceback'],
  [/\bat [\w$.<>]+ \((?:\/|[A-Za-z]:\\|webpack:|file:)[^)]*:\d+:\d+\)/, 'JavaScript stack trace'],
  [/"stack"\s*:\s*"(?:\w*Error)[^"]{0,80}\\n\s*at /, 'JavaScript stack trace'],
  [/\bat (?:java|javax|org\.springframework|com\.[a-z]+)\.[\w.$]+\([\w]+\.java:\d+\)/, 'Java stack trace'],
  [/Exception in thread "|java\.lang\.\w+Exception/, 'Java exception'],
  [/SQLSTATE\[|You have an error in your SQL syntax|ORA-\d{5}|PG::\w+Error|SQLite3?::|psycopg2\.\w+/, 'SQL error'],
  [/<b>(?:Fatal error|Warning|Notice)<\/b>:.* on line <b>\d+<\/b>/, 'PHP error'],
  [/Server Error in '\/' Application|System\.\w+Exception:/, 'ASP.NET error'],
  [/You're seeing this error because you have <code>DEBUG = True<\/code>/, 'Django debug page'],
  [/\b(?:\/var\/www|\/home\/\w+|\/usr\/src\/app|\/opt\/app|C:\\\\inetpub)\/[\w./-]+\.(?:php|py|rb|js|ts|java|cs)\b/, 'server file path'],
];

function verboseErrors(input: AuditInput): Draft[] {
  const isSite = siteHostTest(input);
  const out: Draft[] = [];
  const seen = new Set<string>();
  for (const r of input.requests) {
    if (!r.responseText || (!isApiCall(r) && r.resourceType !== 'Document')) continue;
    const host = hostOf(r.url);
    if (!host || !isSite(host)) continue;
    const text = r.responseText.slice(0, 200_000);
    for (const [re, what] of VERBOSE_ERROR_RES) {
      const match = re.exec(text);
      if (!match) continue;
      const endpoint = endpointKey(r.method, r.url);
      const fingerprint = `verbose-error:${fnv1a(`${host}:${endpoint}:${what}`)}`;
      if (seen.has(fingerprint)) break;
      seen.add(fingerprint);
      out.push({
        rule: 'verbose-error',
        category: 'api-exposure',
        severity: 'low',
        confidence: 'medium',
        title: `Responses reveal internals (${what})`,
        description: `${endpoint} on ${host} returned a ${what}, which reveals code paths, libraries or queries an attacker can use.`,
        recommendation: 'Return generic error messages to clients and log the details on the server.',
        cwe: 'CWE-209',
        owasp: 'A05:2021',
        api_host: host,
        evidence: [
          {
            kind: 'traffic',
            url: r.url,
            endpoint,
            snippet: excerpt(text, match.index, match.index + match[0].length, 80, 200),
          },
        ],
        fingerprint,
      });
      break;
    }
  }
  return out;
}

/** Field names that should never reach a browser. */
const SECRET_FIELD_RE =
  /^(password|passwd|password_?hash|hashed_?password|pass_?hash|salt|client_?secret|api_?secret|secret_?key|private_?key|ssn|social_?security(_?number)?|credit_?card(_?number)?|card_?number|cvv|cvc)$/i;
/**
 * Personal data fields: a field name, and the shape its value must have to be
 * data rather than a label (`"email": "Email address"` in a translation file).
 * Redacted values keep their shape (`user1@example.com`, `+15550000001`).
 */
const PII_FIELDS: Array<[RegExp, RegExp]> = [
  [/^(e_?mail(_?address)?|email_?addr)$/i, /^[^\s@]+@[^\s@]+\.[^\s@]+$/],
  [/^(phone|mobile|tel|telephone|cell)(_?(number|no))?$/i, /^\+?[\d\s().-]{7,20}$/],
  [/^(date_?of_?birth|dob|birth_?date|birthday)$/i, /^\d{4}-\d{2}-\d{2}|^\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}$/],
  [/^(home_?|street_?)?address(_?line_?\d)?$/i, /^(?=.*\d)(?=.*[A-Za-z]).{10,}$/],
  [/^(national_?id|passport(_?number)?|tax_?id|ssn_?last_?4)$/i, /\d{4,}/],
];

interface FieldHits {
  secret: Set<string>;
  pii: Set<string>;
  /** Distinct personal values, to tell one record from a list of people. */
  values: Set<string>;
}

function piiValue(key: string, value: unknown): boolean {
  if (typeof value !== 'string' && typeof value !== 'number') return false;
  const text = String(value).trim();
  return PII_FIELDS.some(([name, shape]) => name.test(key) && shape.test(text));
}

function walk(value: unknown, path: string, hits: FieldHits, depth = 0): void {
  if (depth > 12 || value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 50)) walk(item, `${path}[]`, hits, depth + 1);
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const childPath = path ? `${path}.${key}` : key;
    const filled = child !== null && child !== '' && typeof child !== 'object' && typeof child !== 'boolean';
    if (filled && SECRET_FIELD_RE.test(key)) hits.secret.add(childPath);
    else if (piiValue(key, child)) {
      hits.pii.add(childPath.replace(/\[\]/g, '[]'));
      hits.values.add(String(child));
    }
    walk(child, childPath, hits, depth + 1);
  }
}

/**
 * Static content files (translations, CMS exports, `banners.json`): their
 * "email" and "mobile" are copy and sample values, not someone's data.
 */
function isStaticData(url: string): boolean {
  try {
    const path = new URL(url).pathname.toLowerCase();
    return /\/(locales?|i18n|lang|langs|translations?|messages|_data|static|assets|content)\//.test(path) || (/\.json$/.test(path) && !/\/api\//.test(path));
  } catch {
    return false;
  }
}

function signedIn(r: AuditRequest): boolean {
  return Object.keys(r.requestHeaders).some((name) =>
    /^(authorization|x-[\w-]*(token|auth|session)[\w-]*)$/i.test(name)
  );
}

function apiResponseCandidates(input: AuditInput): Draft[] {
  const isSite = siteHostTest(input);
  const out: Draft[] = [];
  const seen = new Set<string>();
  for (const r of input.requests) {
    if (!isApiCall(r) || !r.responseText || r.status === null || r.status >= 300) continue;
    if (!/json/i.test(r.mimeType ?? '') && !/^\s*[[{]/.test(r.responseText)) continue;
    const host = hostOf(r.url);
    if (!host || !isSite(host) || input.isNoiseHost?.(host)) continue;
    let body: unknown;
    try {
      body = JSON.parse(r.responseText);
    } catch {
      continue;
    }
    const endpoint = endpointKey(r.method, r.url);
    const hits: FieldHits = { secret: new Set(), pii: new Set(), values: new Set() };
    walk(body, '', hits);

    if (hits.secret.size > 0) {
      const fingerprint = `sensitive-field-in-response:${fnv1a(`${host}:${endpoint}`)}`;
      if (!seen.has(fingerprint)) {
        seen.add(fingerprint);
        const fields = [...hits.secret].slice(0, 5);
        out.push({
          rule: 'sensitive-field-in-response',
          category: 'api-exposure',
          severity: 'high',
          confidence: 'medium',
          title: 'API response carries secret fields',
          description: `${endpoint} on ${host} returns fields that should never leave the server (${fields.join(', ')}).`,
          recommendation: 'Remove these fields from the response model; return only what the page displays.',
          cwe: 'CWE-200',
          owasp: 'A01:2021',
          api_host: host,
          evidence: [{ kind: 'traffic', url: r.url, endpoint, snippet: `fields: ${fields.join(', ')}` }],
          fingerprint,
          context: excerpt(r.responseText, 0, 0, 0, 1200),
        });
      }
    }

    if (signedIn(r) || hits.pii.size === 0 || isStaticData(r.url)) continue;
    const fingerprint = `unauthenticated-pii:${fnv1a(`${host}:${endpoint}`)}`;
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    const byId = /\{id\}|\{uuid\}/.test(endpoint);
    const people = hits.values.size;
    const fields = [...hits.pii].slice(0, 5);
    out.push({
      rule: 'unauthenticated-pii',
      category: 'api-exposure',
      severity: byId || people >= 3 ? 'high' : 'medium',
      confidence: 'low',
      title: 'API returns personal data without signing in',
      description: `${endpoint} on ${host} answered a request without credentials with personal data (${fields.join(', ')}; ${people} distinct value(s))${byId ? '; the record is chosen by an id in the path, which can be enumerated' : ''}.`,
      recommendation:
        'Require authentication and check that the caller owns the record; return only public fields to anonymous callers.',
      cwe: byId ? 'CWE-639' : 'CWE-359',
      owasp: 'A01:2021',
      api_host: host,
      evidence: [{ kind: 'traffic', url: r.url, endpoint, snippet: `fields: ${fields.join(', ')}` }],
      fingerprint,
      context: excerpt(r.responseText, 0, 0, 0, 1200),
    });
  }
  return out;
}

export function trafficCandidates(input: AuditInput): Draft[] {
  return [
    ...headerCandidates(input),
    ...versionBanners(input),
    ...corsCandidates(input),
    ...cookieCandidates(input),
    ...mixedContent(input),
    ...verboseErrors(input),
    ...apiResponseCandidates(input),
  ];
}
