// Shared helpers for every tool this plugin registers.
//
// The registry accepts a plain definition object; the official `defineTool`
// helper only rewrites a friendlier parameter spec into the same raw JSON
// Schema and adds argument validation the registry already performs for every
// definition. Writing the raw form directly is what keeps this plugin free of
// any `@deepseek-ai/*` import, which in turn is what lets it load from a profile
// whose node_modules cannot see the application's own packages.

import path from 'node:path';

/** One model-facing text block. */
export const text = (value) => [{ type: 'text', text: value }];

/**
 * Build a registry-ready tool definition.
 * @param spec - the definition's fields.
 * @returns the same object, typed for readers.
 */
export function tool(spec) {
  return spec;
}

/** A UTC timestamp safe to embed in a file name. */
export function fileStamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

/**
 * Resolve a caller-supplied output path against the session workspace.
 * @param raw - the requested path, or undefined for a generated one.
 * @param cwd - the owning session's working directory.
 * @param fallbackName - file name to generate when `raw` is absent.
 * @returns an absolute path.
 */
export function resolveOutputPath(raw, cwd, fallbackName) {
  if (typeof raw === 'string' && raw.trim().length > 0) {
    const trimmed = raw.trim();
    return path.isAbsolute(trimmed) ? trimmed : path.resolve(cwd ?? process.cwd(), trimmed);
  }
  return path.resolve(cwd ?? process.cwd(), '.dsh-screenshots', fallbackName);
}

/**
 * Squeeze a captured stream for display: keep the head and tail of very long
 * output, because both the first error and the final summary matter.
 * @param value - raw text.
 * @param limit - maximum characters kept.
 * @returns the possibly shortened text.
 */
export function condense(value, limit = 8000) {
  const trimmed = value.replace(/\r\n/g, '\n').trimEnd();
  if (trimmed.length <= limit) return trimmed;
  const head = trimmed.slice(0, Math.floor(limit * 0.6));
  const tail = trimmed.slice(-Math.floor(limit * 0.3));
  return `${head}\n… [${trimmed.length - head.length - tail.length} characters omitted] …\n${tail}`;
}
