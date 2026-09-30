/**
 * Groups observed API traffic into endpoints with inferred request and
 * response schemas. The result feeds type, client and replay-server codegen.
 */
import { endpointKey, toPathTemplate } from '../coverage/pathTemplate';
import { inferSchema, type JsonSchema } from './schema';

/**
 * One observed API call with its bodies already parsed. Pass `null` for an
 * absent request body; an `undefined` response body is not sampled, but the
 * call and its status still count.
 */
export interface EndpointSample {
  method: string;
  url: string;
  status: number | null;
  requestBody: unknown;
  responseBody: unknown;
  requestHeaders: Record<string, string>;
}

/**
 * One endpoint (all samples sharing an `endpointKey`). `responses` has one
 * entry per status, ascending; a missing status is recorded as 0.
 */
export interface EndpointModel {
  key: string;
  method: string;
  template: string;
  calls: number;
  auth: 'bearer' | 'cookie' | 'none';
  requestSchema: JsonSchema | null;
  responses: Array<{ status: number; count: number; schema: JsonSchema }>;
}

/**
 * All observed endpoints, most-called first (ties by key). `baseUrl` is the
 * origin that served the most samples, or null if no sample URL parsed.
 */
export interface ApiModel {
  baseUrl: string | null;
  endpoints: EndpointModel[];
}

/**
 * Builds the API model from samples. Callers decide which requests are API
 * calls; every sample passed in becomes part of an endpoint.
 *
 * `auth` is `'bearer'` if any sample carried an `authorization` header, else
 * `'cookie'` if any carried `cookie`. Header lookups use the lowercase name
 * only, so a mixed-case `Authorization` key is not detected.
 */
export function buildApiModel(samples: EndpointSample[]): ApiModel {
  const groups = new Map<
    string,
    {
      method: string;
      template: string;
      calls: number;
      auth: 'bearer' | 'cookie' | 'none';
      requestBodies: unknown[];
      byStatus: Map<number, unknown[]>;
    }
  >();

  const origins = new Map<string, number>();

  for (const sample of samples) {
    let pathname = sample.url;
    try {
      const url = new URL(sample.url);
      pathname = url.pathname;
      origins.set(url.origin, (origins.get(url.origin) ?? 0) + 1);
    } catch {
      // Keep the raw string; endpointKey handles malformed URLs.
    }

    const key = endpointKey(sample.method, sample.url);
    let group = groups.get(key);
    if (!group) {
      group = {
        method: sample.method,
        template: toPathTemplate(pathname),
        calls: 0,
        auth: 'none',
        requestBodies: [],
        byStatus: new Map(),
      };
      groups.set(key, group);
    }

    group.calls += 1;
    if (sample.requestHeaders.authorization) group.auth = 'bearer';
    else if (sample.requestHeaders.cookie && group.auth === 'none') {
      group.auth = 'cookie';
    }
    if (sample.requestBody !== null && sample.requestBody !== undefined) {
      group.requestBodies.push(sample.requestBody);
    }

    const status = sample.status ?? 0;
    const bucket = group.byStatus.get(status) ?? [];
    if (sample.responseBody !== undefined) bucket.push(sample.responseBody);
    group.byStatus.set(status, bucket);
  }

  const endpoints: EndpointModel[] = Array.from(groups.entries())
    .map(([key, group]) => ({
      key,
      method: group.method,
      template: group.template,
      calls: group.calls,
      auth: group.auth,
      requestSchema:
        group.requestBodies.length > 0 ? inferSchema(group.requestBodies) : null,
      responses: Array.from(group.byStatus.entries())
        .map(([status, bodies]) => ({
          status,
          count: bodies.length,
          schema: inferSchema(bodies),
        }))
        .sort((a, b) => a.status - b.status),
    }))
    .sort((a, b) => b.calls - a.calls || (a.key < b.key ? -1 : 1));

  let baseUrl: string | null = null;
  let best = 0;
  for (const [origin, count] of origins) {
    if (count > best) {
      best = count;
      baseUrl = origin;
    }
  }

  return { baseUrl, endpoints };
}
