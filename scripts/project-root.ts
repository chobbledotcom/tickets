import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Render `file` for display relative to `base`: strip a leading `./` from
 * relative paths, and show absolute paths as a `base`-relative path unless they
 * escape `base` (in which case the absolute path is kept). A file whose name
 * merely starts with `..` (e.g. `..cache.ts`) does not escape.
 */
export const toDisplayPath = (base: string, file: string): string => {
  if (!isAbsolute(file)) return file.replace(/^\.\//, "");
  const rel = relative(base, file);
  const escapesBase = rel === ".." || rel.startsWith(`..${sep}`);
  return escapesBase ? file : rel || ".";
};
