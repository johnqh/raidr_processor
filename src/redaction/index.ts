/**
 * Per-request redaction entry point used by every capturer (raidr_extension,
 * raidr_cli's capture harness, raidr_crawler).
 */
import type { Pseudonymizer } from './pseudonym';
import { redactHeaders } from './headers';
import { redactHtmlHydration, redactJsonText } from './json';

/** Headers and decoded text bodies of one request, before redaction. */
export interface RedactableRequest {
  requestHeaders: Record<string, string>;
  responseHeaders: Record<string, string>;
  mimeType: string | null;
  requestBody: string | null;
  responseBody: string | null;
}

/** The same fields after redaction. The URL is not part of either shape. */
export interface RedactedRequest {
  requestHeaders: Record<string, string>;
  responseHeaders: Record<string, string>;
  requestBody: string | null;
  responseBody: string | null;
}

/**
 * JavaScript and CSS are public code. Mutating them would corrupt parsing and
 * invalidate source-map offsets, destroying the material reconstruction needs.
 */
function isImmutableAsset(mimeType: string | null): boolean {
  if (!mimeType) return false;
  const base = mimeType.split(';')[0]?.trim().toLowerCase() ?? '';
  return (
    base.includes('javascript') ||
    base === 'text/css' ||
    base.startsWith('image/') ||
    base.startsWith('font/')
  );
}

function isHtml(mimeType: string | null): boolean {
  return (mimeType ?? '').toLowerCase().includes('html');
}

/**
 * Redacts one request/response pair.
 *
 * - Headers: always, via `redactHeaders`.
 * - Response body: JS, CSS, images and fonts are left byte-for-byte; HTML gets
 *   hydration-state redaction only; anything else is treated as JSON.
 * - Request body: always treated as JSON, whatever its content type, so a
 *   form-encoded body passes through unchanged.
 *
 * The request URL (including its query string) is not redacted here.
 */
export function redactRequest(
  input: RedactableRequest,
  pseudonym: Pseudonymizer
): RedactedRequest {
  let responseBody = input.responseBody;

  if (responseBody !== null) {
    if (isImmutableAsset(input.mimeType)) {
      // left exactly as served
    } else if (isHtml(input.mimeType)) {
      responseBody = redactHtmlHydration(responseBody, pseudonym);
    } else {
      responseBody = redactJsonText(responseBody, pseudonym);
    }
  }

  return {
    requestHeaders: redactHeaders(input.requestHeaders, pseudonym),
    responseHeaders: redactHeaders(input.responseHeaders, pseudonym),
    requestBody:
      input.requestBody === null
        ? null
        : redactJsonText(input.requestBody, pseudonym),
    responseBody,
  };
}
