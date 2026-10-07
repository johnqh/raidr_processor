/**
 * Passive security audit. `auditCandidates` runs the fixed rules over what a
 * crawl recorded; a model (Claude Code, run by the caller) then confirms or
 * drops each hit with `auditPrompt` / `applyAuditAnswer`. Without a model,
 * `candidatesToIssues` keeps every hit with the rule's own text.
 *
 * Nothing here sends a request: the audit reads only the capture.
 */
import { codeCandidates } from './codeRules';
import { trafficCandidates } from './trafficRules';
import type {
  AuditCandidate,
  AuditConfidence,
  AuditInput,
  AuditIssue,
  AuditSeverity,
} from './types';
import { AUDIT_SEVERITIES } from './types';

/** At most this many candidates per site go to the model or the store. */
export const MAX_AUDIT_CANDIDATES = 150;

const SEVERITY_RANK = new Map(AUDIT_SEVERITIES.map((s, i) => [s, i]));
const CONFIDENCE_RANK: Record<AuditConfidence, number> = { high: 0, medium: 1, low: 2 };

/**
 * Every rule hit, most severe (then most certain) first, numbered `c1`, `c2`, …
 * and capped at `MAX_AUDIT_CANDIDATES`. Fingerprints are unique.
 */
export function auditCandidates(input: AuditInput): AuditCandidate[] {
  const drafts = [...codeCandidates(input), ...trafficCandidates(input)];
  const seen = new Set<string>();
  const unique = drafts.filter((d) => {
    if (seen.has(d.fingerprint)) return false;
    seen.add(d.fingerprint);
    return true;
  });
  unique.sort(
    (a, b) =>
      (SEVERITY_RANK.get(a.severity) ?? 9) - (SEVERITY_RANK.get(b.severity) ?? 9) ||
      CONFIDENCE_RANK[a.confidence] - CONFIDENCE_RANK[b.confidence]
  );
  return unique.slice(0, MAX_AUDIT_CANDIDATES).map((d, i) => ({ id: `c${i + 1}`, ...d }));
}

/** A candidate as stored when no model reviews it. */
export function candidatesToIssues(candidates: AuditCandidate[]): AuditIssue[] {
  return candidates.map(({ id: _id, context: _context, ...issue }) => issue);
}

/**
 * Instructions for the reviewing model. Fixed text, so a caller can send it as
 * a cached system prompt; `auditPrompt` holds the per-site part.
 */
export const AUDIT_INSTRUCTIONS = `You review candidate security issues that fixed rules found in a website's recorded traffic and shipped JavaScript. Nothing was sent to the site beyond normal browsing; judge only from the evidence given.

For each candidate decide whether it is a real weakness of this site:
- Drop false positives: public-by-design keys (publishable, anon, maps, analytics), test or placeholder values, library code, sinks fed by constants, handlers that check the origin elsewhere in the shown code, personal data that is clearly the site's own public contact details.
- Keep real issues and set severity (critical, high, medium, low, info) and confidence (high, medium, low) from the evidence. Do not raise severity for things the evidence cannot show.
- Write a plain title (at most 120 characters), a description of the risk to this site (2-3 sentences, name the file, endpoint, header or cookie) and a concrete fix (1-2 sentences). Never quote a secret value in full.

Answer with JSON only: {"issues":[{"id":"c1","keep":true,"severity":"high","confidence":"medium","title":"...","description":"...","recommendation":"..."},{"id":"c2","keep":false}]}. Give one entry per candidate id. For a kept candidate you may omit title, description or recommendation to keep the rule's text.`;

/** The per-site prompt: the site and its candidates as compact JSON. */
export function auditPrompt(origin: string, candidates: AuditCandidate[]): string {
  const items = candidates.map((c) => ({
    id: c.id,
    rule: c.rule,
    category: c.category,
    severity: c.severity,
    confidence: c.confidence,
    title: c.title,
    description: c.description,
    evidence: c.evidence,
    ...(c.context ? { context: c.context } : {}),
  }));
  return `Site: ${origin}\nCandidates:\n${JSON.stringify(items)}`;
}

export interface AuditAnswerItem {
  id: string;
  keep: boolean;
  severity?: AuditSeverity;
  confidence?: AuditConfidence;
  title?: string;
  description?: string;
  recommendation?: string;
}

const LIMITS = { title: 200, description: 4000, recommendation: 2000 } as const;

function text(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

/**
 * The model's answer as items, or null when it is not the expected shape.
 * Accepts the JSON object, or text with the object inside (a fenced block).
 */
export function parseAuditAnswer(answer: unknown): AuditAnswerItem[] | null {
  let value = answer;
  if (typeof value === 'string') {
    const start = value.indexOf('{');
    const end = value.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try {
      value = JSON.parse(value.slice(start, end + 1));
    } catch {
      return null;
    }
  }
  const issues = (value as { issues?: unknown } | null)?.issues;
  if (!Array.isArray(issues)) return null;
  const out: AuditAnswerItem[] = [];
  for (const raw of issues) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    if (typeof item.id !== 'string') continue;
    const severity = AUDIT_SEVERITIES.includes(item.severity as AuditSeverity)
      ? (item.severity as AuditSeverity)
      : undefined;
    const confidence = ['high', 'medium', 'low'].includes(item.confidence as string)
      ? (item.confidence as AuditConfidence)
      : undefined;
    out.push({
      id: item.id,
      keep: item.keep !== false,
      ...(severity ? { severity } : {}),
      ...(confidence ? { confidence } : {}),
      ...(text(item.title, LIMITS.title) ? { title: text(item.title, LIMITS.title) } : {}),
      ...(text(item.description, LIMITS.description)
        ? { description: text(item.description, LIMITS.description) }
        : {}),
      ...(text(item.recommendation, LIMITS.recommendation)
        ? { recommendation: text(item.recommendation, LIMITS.recommendation) }
        : {}),
    });
  }
  return out;
}

/**
 * Candidates after the model's review: dropped ones removed, kept ones with
 * its severity, confidence and text. A candidate the answer does not mention
 * keeps the rule's defaults. Rule, category, CWE, OWASP, evidence and
 * fingerprint always come from the rule, never from the model.
 */
export function applyAuditAnswer(
  candidates: AuditCandidate[],
  items: AuditAnswerItem[]
): AuditIssue[] {
  const byId = new Map(items.map((i) => [i.id, i]));
  const out: AuditIssue[] = [];
  for (const candidate of candidates) {
    const item = byId.get(candidate.id);
    if (item && !item.keep) continue;
    const [issue] = candidatesToIssues([candidate]);
    if (!issue) continue;
    out.push({
      ...issue,
      ...(item?.severity ? { severity: item.severity } : {}),
      ...(item?.confidence ? { confidence: item.confidence } : {}),
      ...(item?.title ? { title: item.title } : {}),
      ...(item?.description ? { description: item.description } : {}),
      ...(item?.recommendation ? { recommendation: item.recommendation } : {}),
    });
  }
  return out;
}

/** Issue counts by severity. */
export function countBySeverity(issues: Array<{ severity: AuditSeverity }>): Record<AuditSeverity, number> {
  const counts = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const issue of issues) counts[issue.severity] += 1;
  return counts;
}

export { maskSecret, maskSecrets } from './text';
export { AUDIT_SEVERITIES } from './types';
export type {
  AuditCandidate,
  AuditCategory,
  AuditConfidence,
  AuditCookie,
  AuditEvidence,
  AuditInput,
  AuditIssue,
  AuditRequest,
  AuditScript,
  AuditSeverity,
} from './types';
