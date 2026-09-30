/** Navigation timeline recovered from Document requests alone. */
import type { CapturedRequest } from '../bundle/types';

/** A distinct page, with a synthetic id of the form `doc<N>`. */
export interface DerivedNavigation {
  navigationId: string;
  path: string;
}

/**
 * Pages in first-visit order, and the page each request belongs to. Requests
 * made before the first Document are absent from `assignments`.
 */
export interface DerivedTimeline {
  navigations: DerivedNavigation[];
  /** requestId → navigationId */
  assignments: Record<string, string>;
}

/**
 * Recovers the navigation timeline from the capture itself.
 *
 * The extension stamps a navigationId on each row, and a client-side router
 * exposes its route table — but neither is available for every app. A
 * server-rendered or multi-page site has no client router at all, and a capture
 * may carry no navigation list. What every capture does have is Document
 * requests: each one is, by definition, a navigation. Everything requested
 * afterwards belongs to that page until the next Document arrives.
 */
export function deriveTimeline(
  requests: Array<Pick<CapturedRequest, 'id' | 'ts' | 'url' | 'resourceType'>>
): DerivedTimeline {
  const ordered = [...requests].sort((a, b) => a.ts - b.ts);

  const navigations: DerivedNavigation[] = [];
  const assignments: Record<string, string> = {};
  let current: string | null = null;
  let counter = 0;

  for (const request of ordered) {
    if (request.resourceType === 'Document') {
      let path = request.url;
      try {
        path = new URL(request.url).pathname;
      } catch {
        // Keep the raw value; a malformed URL is still a distinct page.
      }
      // A reload of the same page is the same route, not a new one.
      const existing = navigations.find((nav) => nav.path === path);
      if (existing) {
        current = existing.navigationId;
      } else {
        counter += 1;
        current = `doc${counter}`;
        navigations.push({ navigationId: current, path });
      }
    }
    if (current !== null) assignments[request.id] = current;
  }

  return { navigations, assignments };
}
