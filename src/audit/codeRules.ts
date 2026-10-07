/**
 * Rules over the JavaScript a site ships: secrets, public source maps,
 * DOM sinks fed from the URL or messages, message handlers without an origin
 * check, and tokens kept in web storage. First-party files only.
 */
import type { AuditCandidate, AuditInput, AuditScript } from "./types";
import { excerpt, fnv1a, lineAt, maskSecret, stableFileName } from "./text";

type Draft = Omit<AuditCandidate, "id">;

interface SecretKind {
  name: string;
  re: RegExp;
  severity: AuditCandidate["severity"];
  confidence: AuditCandidate["confidence"];
  /** Return false to drop a match (a public key, a placeholder). */
  accept?: (value: string, text: string, index: number) => boolean;
}

/** Values that are documentation or placeholders, not keys. */
const PLACEHOLDER_RE =
  /x{6,}|0{8,}|example|your[_-]?|dummy|test|sample|placeholder|changeme|\*{4,}|<[^>]+>/i;

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** base64url → text (Latin-1 is enough for a JWT payload's keys). No `atob`: not in ES2022. */
function base64UrlDecode(value: string): string {
  const clean = value.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
  let bits = 0;
  let buffer = 0;
  let out = "";
  for (const ch of clean) {
    const n = B64.indexOf(ch);
    if (n < 0) throw new Error("not base64");
    buffer = ((buffer << 6) | n) & 0xffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out += String.fromCharCode((buffer >> bits) & 0xff);
    }
  }
  return out;
}

/** `"role":"service_role"` (Supabase) and friends inside a JWT payload. */
function jwtRole(token: string): string | null {
  const payload = token.split(".")[1];
  if (!payload) return null;
  try {
    const json = JSON.parse(base64UrlDecode(payload)) as Record<
      string,
      unknown
    >;
    return typeof json.role === "string" ? json.role : null;
  } catch {
    return null;
  }
}

const SECRET_KINDS: SecretKind[] = [
  {
    name: "AWS access key id",
    re: /\bAKIA[0-9A-Z]{16}\b/g,
    severity: "high",
    confidence: "medium",
  },
  {
    name: "Stripe secret key",
    re: /\b(?:sk|rk)_live_[0-9A-Za-z]{16,}\b/g,
    severity: "critical",
    confidence: "high",
  },
  {
    name: "Anthropic API key",
    re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
    severity: "critical",
    confidence: "high",
  },
  {
    name: "OpenAI API key",
    re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/g,
    severity: "critical",
    confidence: "medium",
  },
  {
    name: "GitHub token",
    re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})\b/g,
    severity: "critical",
    confidence: "high",
  },
  {
    name: "Slack token",
    re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
    severity: "high",
    confidence: "high",
  },
  {
    name: "Google OAuth client secret",
    re: /\bGOCSPX-[A-Za-z0-9_-]{20,}\b/g,
    severity: "high",
    confidence: "high",
  },
  {
    name: "SendGrid API key",
    re: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{20,}\b/g,
    severity: "high",
    confidence: "high",
  },
  {
    name: "Mailgun API key",
    re: /\bkey-[0-9a-f]{32}\b/g,
    severity: "high",
    confidence: "medium",
  },
  {
    name: "Private key",
    re: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/g,
    severity: "critical",
    confidence: "high",
  },
  {
    name: "Service-role JWT",
    re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    severity: "critical",
    confidence: "high",
    // An anon or public key is meant to ship; a service role bypasses row security.
    accept: (value) => jwtRole(value) === "service_role",
  },
  {
    name: "Credentials in a connection URL",
    re: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqps?|ftp):\/\/[^\s/:@'"`]+:[^\s/@'"`]{3,}@[^\s'"`]+/g,
    severity: "critical",
    confidence: "medium",
  },
  {
    name: "Hard-coded secret",
    re: /\b(?:client_?secret|secret_?key|private_?key|api_?secret|db_?password|password)["']?\s*[:=]\s*["'`]([^"'`\s]{12,})["'`]/gi,
    severity: "medium",
    confidence: "low",
    // Random-looking only: letters and digits mixed, not a field or label name (`passwordInput`).
    accept: (value) =>
      /\d/.test(value) &&
      /[A-Za-z]/.test(value) &&
      !/^[a-z]+([A-Z][a-z]+)*\d*$/.test(value),
  },
];

/** Library-looking paths inside recovered sources that slipped through. */
const VENDOR_PATH_RE = /(^|\/)(node_modules|vendor|bower_components)\//;

function ownScripts(input: AuditInput): AuditScript[] {
  return input.scripts.filter(
    (s) => s.firstParty && !VENDOR_PATH_RE.test(s.file),
  );
}

/** First-party code for client-code rules: original sources over the built file they came from. */
function ownCode(input: AuditInput): AuditScript[] {
  return ownScripts(input).filter((s) => !s.mapped);
}

function secretsInCode(input: AuditInput): Draft[] {
  const out: Draft[] = [];
  const seen = new Set<string>();
  for (const script of ownScripts(input)) {
    for (const kind of SECRET_KINDS) {
      kind.re.lastIndex = 0;
      for (const match of script.text.matchAll(kind.re)) {
        const value = match[1] ?? match[0];
        const index = match.index ?? 0;
        if (PLACEHOLDER_RE.test(value)) continue;
        if (kind.accept && !kind.accept(value, script.text, index)) continue;
        const fingerprint = `secret-in-code:${fnv1a(`${kind.name}:${value}`)}`;
        if (seen.has(fingerprint)) continue;
        seen.add(fingerprint);
        out.push({
          rule: "secret-in-code",
          category: "secrets",
          severity: kind.severity,
          confidence: kind.confidence,
          title: `${kind.name} in the site's JavaScript`,
          description: `A value that looks like a ${kind.name.toLowerCase()} (${maskSecret(value)}) is in JavaScript every visitor downloads, so anyone can read it.`,
          recommendation:
            "Revoke the credential, move it to the server and have the browser call a server endpoint that uses it.",
          cwe: "CWE-798",
          owasp: "A07:2021",
          api_host: null,
          evidence: [
            {
              kind: "code",
              file: script.file,
              line: lineAt(script.text, index),
              snippet: excerpt(script.text, index, index + match[0].length),
              ...(script.url ? { url: script.url } : {}),
            },
          ],
          fingerprint,
        });
      }
    }
  }
  return out;
}

/** Private-network hosts in URLs: build config leaking internal infrastructure. */
const INTERNAL_URL_RE =
  /\bhttps?:\/\/((?:10\.\d{1,3}|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}|[a-z0-9.-]+\.(?:internal|corp|intranet|lan))(?::\d+)?(?:\/[^\s'"`]*)?/gi;

function internalUrls(input: AuditInput): Draft[] {
  const byHost = new Map<
    string,
    { script: AuditScript; index: number; length: number; count: number }
  >();
  for (const script of ownScripts(input)) {
    for (const match of script.text.matchAll(INTERNAL_URL_RE)) {
      const host = (match[1] ?? "").toLowerCase();
      const hit = byHost.get(host);
      if (hit) hit.count += 1;
      else
        byHost.set(host, {
          script,
          index: match.index ?? 0,
          length: match[0].length,
          count: 1,
        });
    }
  }
  return [...byHost.entries()].map(([host, hit]) => ({
    rule: "internal-url-in-code",
    category: "secrets" as const,
    severity: "low" as const,
    confidence: "medium" as const,
    title: "Internal network address in the site's JavaScript",
    description: `The JavaScript names ${host}, a private network host, which tells an attacker about internal infrastructure.`,
    recommendation:
      "Keep internal hosts out of client builds; use environment-specific configuration.",
    cwe: "CWE-200",
    owasp: "A05:2021",
    api_host: null,
    evidence: [
      {
        kind: "code" as const,
        file: hit.script.file,
        line: lineAt(hit.script.text, hit.index),
        snippet: excerpt(
          hit.script.text,
          hit.index,
          hit.index + hit.length,
          60,
          60,
        ),
      },
    ],
    fingerprint: `internal-url-in-code:${fnv1a(host)}`,
  }));
}

function publicSourceMaps(input: AuditInput): Draft[] {
  const siteHost = hostOfOrigin(input.origin);
  const own = input.sourceMappedScripts.filter((url) => {
    try {
      const host = new URL(url).host;
      return input.isSiteHost ? input.isSiteHost(host) : host === siteHost;
    } catch {
      return false;
    }
  });
  if (own.length === 0) return [];
  return [
    {
      rule: "public-source-map",
      category: "secrets",
      severity: "low",
      confidence: "high",
      title: "Source maps are public",
      description: `${own.length} script(s) link to source maps anyone can download, which hand out the original, unminified source code with file names and comments.`,
      recommendation:
        "Stop serving .map files publicly (upload them to the error tracker instead, or restrict them by IP or auth).",
      cwe: "CWE-540",
      owasp: "A05:2021",
      api_host: siteHost,
      evidence: own
        .slice(0, 5)
        .map((url) => ({ kind: "traffic" as const, url: `${url}.map` })),
      fingerprint: `public-source-map:${siteHost}`,
    },
  ];
}

function hostOfOrigin(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

/** Values an attacker controls: the URL, the referrer, the window name, a message. */
const TAINT_RE =
  /\b(?:location\.(?:hash|search)|document\.(?:URL|documentURI|referrer)|window\.name|URLSearchParams|searchParams\.get|(?:e|ev|evt|event|msg|message)\.data)\b/;

interface Sink {
  rule: string;
  re: RegExp;
  title: string;
  description: string;
  recommendation: string;
  severity: AuditCandidate["severity"];
  cwe: string;
  owasp: string;
}

const SINKS: Sink[] = [
  {
    rule: "dom-xss-sink",
    re: /\.(?:innerHTML|outerHTML)\s*\+?=|\.insertAdjacentHTML\s*\(|\bdocument\.write(?:ln)?\s*\(|dangerouslySetInnerHTML\s*[:=]/g,
    title: "HTML built from the URL or a message",
    description:
      "Markup is written into the page from a value an attacker can control (the URL, the referrer or a message), which can run their script in the site's origin.",
    recommendation:
      "Insert text with textContent, or sanitise the markup (DOMPurify) before inserting it.",
    severity: "high",
    cwe: "CWE-79",
    owasp: "A03:2021",
  },
  {
    rule: "eval-of-input",
    re: /\beval\s*\(|\bnew\s+Function\s*\(|\bset(?:Timeout|Interval)\s*\(\s*[^,()]*?\+/g,
    title: "Code evaluated from the URL or a message",
    description:
      "A string an attacker can influence reaches eval-like execution.",
    recommendation:
      "Never evaluate strings; parse data with JSON.parse and call functions directly.",
    severity: "high",
    cwe: "CWE-95",
    owasp: "A03:2021",
  },
  {
    rule: "open-redirect",
    re: /\b(?:window\.|document\.)?location(?:\.href)?\s*=(?!=)|\blocation\.(?:assign|replace)\s*\(/g,
    title: "Redirect to a URL taken from the request",
    description:
      "The page navigates to an address read from the URL or a message, so a link on the site can send people to an attacker's page.",
    recommendation:
      "Redirect only to relative paths or to an allow-list of hosts.",
    severity: "medium",
    cwe: "CWE-601",
    owasp: "A01:2021",
  },
];

/** How far around a sink a tainted source may be to count as feeding it. */
const TAINT_WINDOW = 200;

function taintedSinks(input: AuditInput): Draft[] {
  const out: Draft[] = [];
  const seen = new Set<string>();
  for (const script of ownCode(input)) {
    for (const sink of SINKS) {
      let perFile = 0;
      for (const match of script.text.matchAll(sink.re)) {
        if (perFile >= 3) break;
        const index = match.index ?? 0;
        // The value written: from the sink to the end of its expression (minified
        // code joins statements with commas), within the window.
        const written =
          script.text
            .slice(
              index + match[0].length,
              index + match[0].length + TAINT_WINDOW,
            )
            .split(/[;,\n}]/)[0] ?? "";
        if (!TAINT_RE.test(written)) continue;
        const snippet = excerpt(script.text, index, index + match[0].length);
        const fingerprint = `${sink.rule}:${fnv1a(`${stableFileName(script.file)}:${snippet.replace(/[A-Za-z_$][\w$]?\b/g, "")}`)}`;
        if (seen.has(fingerprint)) continue;
        seen.add(fingerprint);
        perFile += 1;
        out.push({
          rule: sink.rule,
          category: "client-code",
          severity: sink.severity,
          confidence: "low",
          title: sink.title,
          description: sink.description,
          recommendation: sink.recommendation,
          cwe: sink.cwe,
          owasp: sink.owasp,
          api_host: null,
          evidence: [
            {
              kind: "code",
              file: script.file,
              line: lineAt(script.text, index),
              snippet,
            },
          ],
          fingerprint,
          context: excerpt(
            script.text,
            index,
            index + match[0].length,
            600,
            400,
          ),
        });
      }
    }
  }
  return out;
}

/**
 * A window message handler written inline (`addEventListener("message",
 * function…` / `e => …`, `window.onmessage = …`): only an inline body can be
 * checked for an origin test. `self.` and `.port` listeners belong to workers.
 */
const MESSAGE_LISTENER_RE =
  /(?:\bwindow\.|[^.\w$]|^)addEventListener\s*\(\s*["'`]message["'`]\s*,\s*(?:async\s+)?(?:function\b|\([^()]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)|\bwindow\.onmessage\s*=\s*(?:async\s+)?(?:function\b|\([^()]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/g;

/**
 * Handlers of libraries that sites bundle into their own chunks, recognised
 * by names minification keeps: Web3Modal / Reown AppKit's `W3mFrame`
 * (`FRAME_EVENT_KEY`, `APP_EVENT_KEY`). Not the site's code to fix.
 */
const LIBRARY_HANDLER_RE = /\b(?:FRAME_EVENT_KEY|APP_EVENT_KEY)\b|W3mFrame/;

function messageHandlers(input: AuditInput): Draft[] {
  const out: Draft[] = [];
  for (const script of ownCode(input)) {
    let perFile = 0;
    for (const match of script.text.matchAll(MESSAGE_LISTENER_RE)) {
      if (perFile >= 3) break;
      const index = match.index ?? 0;
      const body = script.text.slice(index, index + 800);
      if (/\.origin\b/.test(body)) continue;
      if (LIBRARY_HANDLER_RE.test(body)) continue;
      // Workers and service workers receive messages only from their own page.
      if (
        /\bself\.|serviceWorker|MessageChannel|\bport\d?\./.test(
          script.text.slice(Math.max(0, index - 80), index + 80),
        )
      )
        continue;
      perFile += 1;
      const snippet = excerpt(
        script.text,
        index,
        index + match[0].length,
        40,
        300,
      );
      out.push({
        rule: "postmessage-no-origin-check",
        category: "client-code",
        severity: "medium",
        confidence: "low",
        title: "Message handler does not check the sender",
        description:
          "A window message handler acts on messages without checking event.origin, so any page that opens or frames the site can send it commands or data.",
        recommendation:
          "Compare event.origin with an allow-list before using event.data.",
        cwe: "CWE-346",
        owasp: "A01:2021",
        api_host: null,
        evidence: [
          {
            kind: "code",
            file: script.file,
            line: lineAt(script.text, index),
            snippet,
          },
        ],
        fingerprint: `postmessage-no-origin-check:${fnv1a(`${stableFileName(script.file)}:${perFile}`)}`,
        context: excerpt(script.text, index, index + match[0].length, 200, 800),
      });
    }
  }
  return out;
}

/** Storage key names that hold a credential. */
const TOKEN_KEY_RE =
  /(^|[^a-z])(access|id|refresh|auth|jwt|session|bearer)?[-_.]?(token|jwt)($|[^a-z])|(^|[-_.])(auth|session)($|[-_.])/i;
const SET_ITEM_RE =
  /\b(?:localStorage|sessionStorage)\.setItem\s*\(\s*["'`]([^"'`]{1,80})["'`]/g;

function tokensInStorage(input: AuditInput): Draft[] {
  const keys = new Map<
    string,
    { file?: string; line?: number; snippet?: string }
  >();
  for (const key of input.storageKeys) {
    if (TOKEN_KEY_RE.test(key)) keys.set(key, {});
  }
  for (const script of ownCode(input)) {
    for (const match of script.text.matchAll(SET_ITEM_RE)) {
      const key = match[1] ?? "";
      if (!TOKEN_KEY_RE.test(key) || keys.get(key)?.file) continue;
      const index = match.index ?? 0;
      keys.set(key, {
        file: script.file,
        line: lineAt(script.text, index),
        snippet: excerpt(script.text, index, index + match[0].length, 40, 120),
      });
    }
  }
  if (keys.size === 0) return [];
  const names = [...keys.keys()].sort();
  return [
    {
      rule: "token-in-web-storage",
      category: "client-code",
      severity: "low",
      confidence: "medium",
      title: "Credentials kept in web storage",
      description: `The site keeps what look like credentials in localStorage or sessionStorage (${names.slice(0, 5).join(", ")}), where any script on the page, including an injected one, can read them.`,
      recommendation: "Keep session credentials in HttpOnly, Secure cookies.",
      cwe: "CWE-922",
      owasp: "A04:2021",
      api_host: null,
      evidence: names.slice(0, 5).map((name) => {
        const at = keys.get(name) ?? {};
        return at.file
          ? {
              kind: "code" as const,
              file: at.file,
              line: at.line,
              snippet: at.snippet,
            }
          : { kind: "code" as const, snippet: `storage key "${name}"` };
      }),
      fingerprint: `token-in-web-storage:${fnv1a(names.join(","))}`,
    },
  ];
}

export function codeCandidates(input: AuditInput): Draft[] {
  return [
    ...secretsInCode(input),
    ...internalUrls(input),
    ...publicSourceMaps(input),
    ...taintedSinks(input),
    ...messageHandlers(input),
    ...tokensInStorage(input),
  ];
}
