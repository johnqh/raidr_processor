/**
 * Types that make up the capture bundle format. They describe what is
 * serialized into `raidr.json`, `network/*.jsonl`, `gaps.json` and
 * `redaction.json`, so changing a field is a format change for every consumer.
 */

/** Why a request's body is missing from the bundle; recorded in `gaps.json`. */
export type GapReason =
  | 'body-evicted'
  | 'cors-opaque'
  | 'detached'
  | 'quota'
  | 'too-large'
  | 'cdp-error';

/**
 * Category of a redacted value. Determines the placeholder label
 * (`<JWT:a1b2>`, `user1@example.com`, ...) chosen by `createPseudonymizer`.
 * `'high-entropy'` is still accepted and labelled `SECRET`, but
 * `classifyValue` no longer produces it: shape-only detection was removed.
 */
export type RedactionKind =
  | 'jwt'
  | 'bearer'
  | 'cookie'
  | 'api-key'
  /** A per-user credential issued by the server, not build-time config. */
  | 'session'
  | 'password'
  | 'email'
  | 'phone'
  | 'high-entropy';

/** One captured request/response pair. Bodies are referenced by SHA-256 hash. */
export interface CapturedRequest {
  /** CDP requestId, unique within a session. */
  id: string;
  /** Epoch milliseconds when the request was sent. */
  ts: number;
  method: string;
  url: string;
  /** CDP resource type: Document, Script, XHR, Fetch, Stylesheet, Image, ... */
  resourceType: string;
  requestHeaders: Record<string, string>;
  requestBodyHash: string | null;
  status: number | null;
  responseHeaders: Record<string, string>;
  responseBodyHash: string | null;
  mimeType: string | null;
  fromCache: boolean;
  /** Navigation id this request occurred under, joining requests to routes. */
  navigationId: string | null;
}

/** One WebSocket frame. The payload lives in `content/<payloadHash>.txt`. */
export interface CapturedFrame {
  /** CDP requestId of the WebSocket connection. */
  id: string;
  /** Epoch milliseconds. */
  ts: number;
  direction: 'sent' | 'received';
  opcode: number;
  payloadHash: string;
}

/**
 * A request whose body could not be captured. Reconstruction treats anything
 * that depends on it as missing evidence (see `RAIDR-GAPS.md` in
 * `generateProject`), never as something to invent.
 */
export interface Gap {
  requestId: string;
  url: string;
  reason: GapReason;
  ts: number;
  /** Human-readable detail, e.g. the CDP error message. */
  detail: string | null;
}

/**
 * One distinct placeholder written during redaction, with how many times it
 * was substituted. Serialized as `redaction.json`; never holds the original
 * value.
 */
export interface RedactionEntry {
  /** e.g. "<JWT:a1b2>" */
  placeholder: string;
  kind: RedactionKind;
  occurrences: number;
}

/**
 * Framework, router, state libraries and bundler detected at capture time.
 * `generateProject` picks React or Vue scaffolding from `framework`: anything
 * other than `'vue'` is scaffolded as React.
 */
export interface StackFingerprint {
  framework: 'react' | 'vue' | 'unknown';
  frameworkVersion: string | null;
  router: string | null;
  routerVersion: string | null;
  stateLibraries: string[];
  bundler: 'webpack' | 'vite' | 'unknown';
}

/**
 * Contents of `raidr.json`, the bundle's root manifest. Only
 * `formatVersion`, `sessionId`, `origin`, `startedAt` and `counts` are checked
 * by `validateManifest`.
 */
export interface RaidrManifest {
  formatVersion: 1;
  sessionId: string;
  origin: string;
  /** ISO-8601 timestamp; `bundleFilename` slices date and time out of it. */
  startedAt: string;
  /** ISO-8601 timestamp, or null while the capture is still running. */
  endedAt: string | null;
  counts: {
    requests: number;
    frames: number;
    bodies: number;
    gaps: number;
  };
  stack: StackFingerprint | null;
}
