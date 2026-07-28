/**
 * Turning source/test globs into the files they name.
 *
 * Replaces `@std/fs`'s `expandGlob` (not in this project's lock, so unfetchable
 * in a sandboxed run) with `@std/path`'s `globToRegExp` over a `Deno.readDir`
 * walk — same contract: absolute paths to existing files, sorted and without
 * repeats.
 */

import { globToRegExp, join, normalize, SEPARATOR } from "@std/path";
import { walkFiles } from "#scripts/walk-files.ts";

/** Glob metacharacters; a path segment with none is a fixed directory name. */
const GLOB_CHARS = /[*?{}[\]]/;

/**
 * The leading, glob-free directory of `glob` — where a walk can start without
 * scanning the whole tree. An exact path (no metacharacters) returns itself.
 * Every glob reaching here is an absolute path, so there is always at least the
 * leading separator to start from.
 */
const staticBase = (glob: string): string => {
  const fixed: string[] = [];
  for (const segment of normalize(glob).split(SEPARATOR)) {
    if (GLOB_CHARS.test(segment)) break;
    fixed.push(segment);
  }
  return fixed.join(SEPARATOR);
};

/** The files these globs name, sorted and without repeats. A glob whose
 *  directory is not there names no files rather than failing. */
export const expand = async (globs: string[]): Promise<string[]> => {
  const cwd = Deno.cwd();
  const paths = new Set<string>();
  for (const glob of globs) {
    const absGlob = join(cwd, glob);
    const pattern = globToRegExp(absGlob, { extended: true, globstar: true });
    const base = staticBase(absGlob);
    try {
      if ((await Deno.stat(base)).isFile) {
        if (pattern.test(base)) paths.add(base);
        continue;
      }
    } catch {
      // base doesn't exist; the walk below simply yields nothing
    }
    for await (const path of walkFiles(base)) {
      if (pattern.test(path)) paths.add(path);
    }
  }
  return [...paths].sort();
};
