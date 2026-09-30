/**
 * Bundle-relative paths for content-addressed files. Bodies are stored once
 * per hash, so these helpers are the single source of the `content/` and
 * `sourcemaps/` naming that readers in raidr_cli and raidr_crawler rely on.
 */

const MIME_EXTENSIONS: Record<string, string> = {
  'application/javascript': 'js',
  'text/javascript': 'js',
  'application/x-javascript': 'js',
  'module/javascript': 'js',
  'application/json': 'json',
  'text/json': 'json',
  'text/html': 'html',
  'text/css': 'css',
  'text/plain': 'txt',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
  'image/webp': 'webp',
  'font/woff2': 'woff2',
  'font/woff': 'woff',
};

/**
 * File extension for a response body's MIME type. Parameters such as
 * `; charset=utf-8` are ignored; unknown or missing types map to `'bin'`.
 */
export function extensionForMime(mime: string | null): string {
  if (!mime) return 'bin';
  const base = mime.split(';')[0]?.trim().toLowerCase() ?? '';
  return MIME_EXTENSIONS[base] ?? 'bin';
}

/** Path of a body inside the bundle: `content/<hash>.<ext>`. */
export function contentPath(hash: string, ext: string): string {
  return `content/${hash}.${ext}`;
}

/** Path of a source map inside the bundle: `sourcemaps/<hash>.map`. */
export function sourcemapPath(hash: string): string {
  return `sourcemaps/${hash}.map`;
}
