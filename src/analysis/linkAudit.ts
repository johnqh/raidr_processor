/**
 * Finds internal links in mirrored HTML that point at nothing the capture
 * holds. Only root-relative `href`/`src` attributes are checked; absolute URLs,
 * relative paths and template-looking links are skipped.
 */

/** One mirrored HTML page to scan. */
export interface AuditPage {
  /** Mirror-relative path of the page, e.g. `/index.html`. */
  path: string;
  html: string;
}

/** A link target missing from the mirror; `kind` is decided by file extension. */
export interface UnreachableLink {
  link: string;
  /** Pages that link to it. */
  linkedFrom: string[];
  kind: 'page' | 'asset';
}

/**
 * Audit result. `linksChecked` counts distinct links per page, so a link on
 * two pages counts twice. Unreachable pages sort before assets.
 */
export interface LinkAudit {
  linksChecked: number;
  unreachable: UnreachableLink[];
}

const ASSET_RE = /\.(js|mjs|css|png|jpe?g|gif|svg|webp|avif|ico|woff2?|ttf|otf|mp4|webm|json|rsc|wasm|map|txt|xml|pdf)$/i;
const SKIP_RE = /^(https?:|mailto:|tel:|data:|javascript:|#|\/\/)/i;
/** `/fe/{plugin}/{name}.js` is a documentation example, not a link. */
const TEMPLATE_RE = /[{}$]|:[A-Za-z]/;

/**
 * A link resolves if the mirror holds the file itself, or the index document a
 * static host would serve for it. `/league` is reachable when `/league.html` or
 * `/league/index.html` was captured — not merely when a `/league/` directory
 * exists for some deeper page.
 */
function resolves(link: string, available: Set<string>): boolean {
  const clean = link.replace(/\/+$/, '');
  return (
    available.has(link) ||
    available.has(clean) ||
    available.has(`${clean}/index.html`) ||
    available.has(`${clean}.html`) ||
    (link === '/' && available.has('/index.html'))
  );
}

function extractLinks(html: string): string[] {
  const found = new Set<string>();
  for (const match of html.matchAll(/(?:href|src)=["']([^"']+)["']/gi)) {
    const raw = match[1]!.trim();
    if (!raw || SKIP_RE.test(raw)) continue;
    if (!raw.startsWith('/')) continue;
    if (TEMPLATE_RE.test(raw)) continue;
    found.add(raw.split('#')[0]!.split('?')[0]!);
  }
  return Array.from(found);
}

/**
 * Cross-checks every internal link in the captured pages against what the
 * capture actually contains. A reconstruction whose own navigation 404s is not
 * finished, and nothing else in the pipeline would notice: the bytes that were
 * captured are all present and correct — the point is the ones that are not.
 */
export function auditLinks(input: {
  pages: AuditPage[];
  available: string[];
}): LinkAudit {
  const available = new Set(input.available);
  const byLink = new Map<string, Set<string>>();
  let linksChecked = 0;

  for (const page of input.pages) {
    for (const link of extractLinks(page.html)) {
      linksChecked += 1;
      if (resolves(link, available)) continue;
      const sources = byLink.get(link) ?? new Set<string>();
      sources.add(page.path);
      byLink.set(link, sources);
    }
  }

  const unreachable: UnreachableLink[] = Array.from(byLink.entries())
    .map(([link, sources]) => ({
      link,
      linkedFrom: Array.from(sources).sort(),
      kind: ASSET_RE.test(link) ? ('asset' as const) : ('page' as const),
    }))
    // Pages first: a missing page is a hole in the site, a missing asset is a
    // degraded one.
    .sort((a, b) =>
      a.kind === b.kind ? (a.link < b.link ? -1 : 1) : a.kind === 'page' ? -1 : 1
    );

  return { linksChecked, unreachable };
}
