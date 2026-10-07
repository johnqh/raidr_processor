/**
 * Public entry point of @sudobility/raidr_processor.
 *
 * Everything exported here is a pure function or plain type: callers supply
 * bytes and records, this package returns values. It is bundled into the
 * Chrome MV3 extension as well as run under Bun by raidr_cli and
 * raidr_crawler, so nothing reachable from this file may perform I/O or touch
 * the DOM.
 */

/**
 * Version of the on-disk bundle layout written by `buildBundleFiles` and
 * stamped into `raidr.json` by `createManifest`. `validateManifest` rejects any
 * other value, so bumping it makes every existing capture unreadable by new
 * consumers until they add a migration.
 */
export const RAIDR_FORMAT_VERSION = 1 as const;

export type {
  CapturedRequest,
  CapturedFrame,
  Gap,
  GapReason,
  RedactionEntry,
  RedactionKind,
  StackFingerprint,
  RaidrManifest,
} from './bundle/types';

export { contentPath, sourcemapPath, extensionForMime } from './bundle/paths';

export {
  createManifest,
  validateManifest,
  toJsonl,
  parseJsonl,
} from './bundle/manifest';
export type { CreateManifestInput, ValidateResult } from './bundle/manifest';

export { createPseudonymizer } from './redaction/pseudonym';
export type { Pseudonymizer } from './redaction/pseudonym';

export { isSensitiveKey, classifyValue } from './redaction/patterns';
export { redactHeaders } from './redaction/headers';

export {
  redactJsonValue,
  redactJsonText,
  redactHtmlHydration,
} from './redaction/json';
export { redactRequest } from './redaction/index';
export type { RedactableRequest, RedactedRequest } from './redaction/index';

export { toPathTemplate, endpointKey } from './coverage/pathTemplate';

export { computeCoverage } from './coverage/coverage';
export type {
  ChunkManifest,
  RouteRecord,
  CoverageInput,
  CoverageReport,
  EndpointCoverage,
} from './coverage/coverage';

export { MemoryContentStore } from './bundle/store';
export type { ContentStore, HashFn } from './bundle/store';
export {
  buildBundleFiles,
  zipBundle,
  bundleFilename,
} from './bundle/assemble';
export type { BundleInput, RuntimeArtifacts } from './bundle/assemble';
export { readBundle, unzipBundle } from './bundle/read';
export type { LoadedBundle } from './bundle/read';

export {
  parseSourceMap,
  recoverSources,
  recoveryRatio,
  normalizeSourcePath,
  recoverBundleSources,
} from './analysis/sourceMap';
export type { SourceMap, RecoveredFile, BundleSources } from './analysis/sourceMap';

export { inferSchema, unifySchemas } from './analysis/schema';
export type { JsonSchema } from './analysis/schema';

export { buildApiModel } from './analysis/apiModel';
export type { ApiModel, EndpointModel, EndpointSample } from './analysis/apiModel';
export { buildRouteModel } from './analysis/routeModel';
export type { RouteModel, RouteModelInput } from './analysis/routeModel';

export { schemaToType, declareType, typeNameFor } from './codegen/types';
export { generateTypes, generateClient, methodNameFor } from './codegen/client';
export { generateReplayServer, templateToHonoPath } from './codegen/replay';

export { generateProject, pageNameFor } from './codegen/project';
export type { ProjectInput } from './codegen/project';

export { deriveTimeline } from './analysis/navigations';
export type { DerivedNavigation, DerivedTimeline } from './analysis/navigations';

export { auditLinks } from './analysis/linkAudit';
export type { LinkAudit, AuditPage, UnreachableLink } from './analysis/linkAudit';

export {
  auditCandidates,
  auditPrompt,
  applyAuditAnswer,
  parseAuditAnswer,
  candidatesToIssues,
  countBySeverity,
  maskSecret,
  maskSecrets,
  AUDIT_INSTRUCTIONS,
  AUDIT_SEVERITIES,
  MAX_AUDIT_CANDIDATES,
} from './audit/index';
export type {
  AuditAnswerItem,
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
} from './audit/index';
