/**
 * Types of the passive security audit. The shapes match raidr_types'
 * `SecurityIssueInput` field for field (this package does not depend on
 * raidr_types), so a caller can post `AuditIssue`s to raidr_api as they are.
 */

export type AuditCategory = 'secrets' | 'client-code' | 'headers-cookies' | 'api-exposure';
export type AuditSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';
export type AuditConfidence = 'high' | 'medium' | 'low';

/** Most severe first. */
export const AUDIT_SEVERITIES: readonly AuditSeverity[] = [
  'critical',
  'high',
  'medium',
  'low',
  'info',
];

/** Where a finding was seen. Secret values are already masked. */
export interface AuditEvidence {
  kind: 'code' | 'traffic' | 'header' | 'cookie';
  file?: string;
  line?: number;
  snippet?: string;
  url?: string;
  endpoint?: string;
  header?: string;
  cookie?: string;
}

/** A script the site shipped, or a source recovered from its source map. */
export interface AuditScript {
  /** File name or URL used in evidence (`static/js/main.3f2a.js`, `src/api/client.ts`). */
  file: string;
  url: string | null;
  text: string;
  /**
   * The site's own code. Client-code and secret rules read only first-party
   * files: library and third-party widget code is not the site's to fix.
   */
  firstParty: boolean;
  /**
   * Its original files are also in `scripts` (recovered from its source map).
   * Client-code rules then read those instead, so one flaw is not reported
   * twice; secret rules still read the built file, where build-time values
   * (`process.env.X`) are filled in.
   */
  mapped?: boolean;
}

/** Cookie attributes; never the value. */
export interface AuditCookie {
  domain: string;
  name: string;
  path: string;
  httpOnly: boolean;
  secure: boolean;
  sameSite: string | null;
}

/** One recorded request, the part of `CapturedRequest` the rules read. */
export interface AuditRequest {
  method: string;
  url: string;
  resourceType: string;
  status: number | null;
  requestHeaders: Record<string, string>;
  responseHeaders: Record<string, string>;
  mimeType: string | null;
  /** Response body as text (already redacted), when recorded. */
  responseText: string | null;
}

/** Everything the audit reads; the caller assembles it from a bundle. */
export interface AuditInput {
  /** The crawled origin, `https://www.example.com`. */
  origin: string;
  requests: AuditRequest[];
  scripts: AuditScript[];
  /** URLs of scripts whose source map the crawl downloaded from the site. */
  sourceMappedScripts: string[];
  cookies: AuditCookie[];
  /** localStorage and sessionStorage key names. */
  storageKeys: string[];
  /** True for the site's own hosts (same registrable domain). Default: same host as `origin`. */
  isSiteHost?: (host: string) => boolean;
  /** True for analytics and tracker hosts, whose traffic is ignored. */
  isNoiseHost?: (host: string) => boolean;
}

/**
 * A rule hit: what a fixed check found, before Claude Code confirms it.
 * `severity`, `title`, `description` and `recommendation` are the rule's own
 * defaults, used as they are when no model reviews the candidates.
 */
export interface AuditCandidate {
  /** `c1`, `c2`, …: how the model's answer refers to it. */
  id: string;
  rule: string;
  category: AuditCategory;
  severity: AuditSeverity;
  confidence: AuditConfidence;
  title: string;
  description: string;
  recommendation: string;
  cwe: string | null;
  owasp: string | null;
  api_host: string | null;
  evidence: AuditEvidence[];
  fingerprint: string;
  /** Extra lines the model needs to judge it (surrounding code, the response excerpt). Masked. */
  context?: string;
}

/** An issue ready to store: `SecurityIssueInput` in raidr_types. */
export type AuditIssue = Omit<AuditCandidate, 'id' | 'context'>;
