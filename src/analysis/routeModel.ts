/**
 * Attaches observed API endpoints to the app's route table, by joining each
 * request's navigationId to the routes whose pattern matches that navigation.
 */
import { endpointKey } from '../coverage/pathTemplate';

/**
 * `routes` are router patterns with `:param` segments (e.g. `/users/:id`);
 * `navigations` are concrete visited paths.
 */
export interface RouteModelInput {
  routes: string[];
  navigations: Array<{ navigationId: string; path: string }>;
  requests: Array<{
    method: string;
    url: string;
    navigationId: string | null;
    /** CDP resource type. When absent, falls back to a URL heuristic. */
    resourceType?: string;
  }>;
}

/**
 * Routes in input order, each with the endpoint keys called while on it.
 * `unattributed` holds endpoints with no navigation, or whose navigation
 * matched no route. `lazy` is true for every route except the root.
 */
export interface RouteModel {
  routes: Array<{
    path: string;
    params: string[];
    visited: boolean;
    endpoints: string[];
    lazy: boolean;
  }>;
  unattributed: string[];
}

const ASSET_RE = /\.(js|mjs|css|map|png|jpe?g|gif|svg|webp|woff2?|ico|txt)$/i;

function paramsOf(pattern: string): string[] {
  return Array.from(pattern.matchAll(/:([A-Za-z0-9_]+)/g)).map((m) => m[1]!);
}

/** Does a concrete path match a route pattern with `:param` segments? */
function matches(pattern: string, path: string): boolean {
  const patternParts = pattern.split('/').filter(Boolean);
  const pathParts = path.split('/').filter(Boolean);
  if (patternParts.length !== pathParts.length) return false;
  return patternParts.every((part, i) => part.startsWith(':') || part === pathParts[i]);
}

const API_RESOURCE_TYPES = new Set(['XHR', 'Fetch']);

function isApiCall(request: {
  url: string;
  method: string;
  resourceType?: string;
}): boolean {
  // Preflights are transport, not API surface.
  if (request.method === 'OPTIONS') return false;
  // Prefer the resource type the browser reported: an SPA route has no file
  // extension, so a URL heuristic mistakes HTML navigations for API calls.
  if (request.resourceType) return API_RESOURCE_TYPES.has(request.resourceType);
  try {
    return !ASSET_RE.test(new URL(request.url).pathname);
  } catch {
    return !ASSET_RE.test(request.url);
  }
}

/**
 * Builds the route model. Only API calls are attributed: XHR/Fetch when a
 * resource type is present, otherwise any non-asset URL; OPTIONS preflights
 * are always ignored. A route is `visited` if any navigation path matches it.
 */
export function buildRouteModel(input: RouteModelInput): RouteModel {
  const byNavigation = new Map<string, string[]>();
  const unattributed: string[] = [];

  for (const request of input.requests) {
    if (!isApiCall(request)) continue;
    const key = endpointKey(request.method, request.url);
    if (request.navigationId === null) {
      if (!unattributed.includes(key)) unattributed.push(key);
      continue;
    }
    const bucket = byNavigation.get(request.navigationId) ?? [];
    if (!bucket.includes(key)) bucket.push(key);
    byNavigation.set(request.navigationId, bucket);
  }

  const routes = input.routes.map((path) => {
    const navigations = input.navigations.filter((nav) => matches(path, nav.path));
    const endpoints: string[] = [];
    for (const nav of navigations) {
      for (const key of byNavigation.get(nav.navigationId) ?? []) {
        if (!endpoints.includes(key)) endpoints.push(key);
      }
    }
    return {
      path,
      params: paramsOf(path),
      visited: navigations.length > 0,
      endpoints,
      // Any route below the root is a lazy-chunk candidate; the chunk
      // manifest confirms it during codegen.
      lazy: path !== '/' && path.length > 1,
    };
  });

  // An endpoint attributed to a navigation that no route matched would
  // otherwise vanish from the model entirely — neither under a route nor in
  // `unattributed`. Silent loss is the one outcome the format must never have.
  const claimed = new Set(routes.flatMap((route) => route.endpoints));
  for (const keys of byNavigation.values()) {
    for (const key of keys) {
      if (!claimed.has(key) && !unattributed.includes(key)) unattributed.push(key);
    }
  }

  return { routes, unattributed };
}
