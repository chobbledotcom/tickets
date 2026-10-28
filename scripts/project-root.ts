import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** `file` as a path under `base`: a relative path passes through with a
 *  leading `./` stripped, an absolute path is read against `base`, and one
 *  outside `base` comes back null. A file whose name merely starts with `..`
 *  (e.g. `..cache.ts`) does not escape. */
export const underPath = (base: string, file: string): string | null => {
  if (!isAbsolute(file)) return file.replace(/^\.\//, "");
  const rel = relative(base, file);
  const escapesBase = rel === ".." || rel.startsWith(`..${sep}`);
  return escapesBase ? null : rel || ".";
};

/**
 * Render `file` for display relative to `base`: show absolute paths as a
 * `base`-relative path unless they escape `base` (in which case the absolute
 * path is kept).
 */
export const toDisplayPath = (base: string, file: string): string =>
  underPath(base, file) ?? file;

/** Project-relative path for display (absolute paths get noisy in reports). */
export const rel = (file: string): string => toDisplayPath(projectRoot, file);
