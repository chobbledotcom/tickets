/**
 * Turning source/test globs into the files they name.
 *
 * Replaces `@std/fs`'s `expandGlob` (not in this project's lock, so unfetchable
 * in a sandboxed run) with `@std/path`'s `globToRegExp` over a `Deno.readDir`
 * walk — same contract: absolute paths to existing files, sorted and without
 * repeats.
 */

import { globToRegExp, join, normalize, SEPARATOR } from "@std/path";
import { statOrNull } from "#scripts/not-found.ts";
import { collectFiles } from "#scripts/walk-files.ts";

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

/** Every file a glob names below `basePath` — or the path itself, when the
 *  glob named an exact file rather than somewhere to look. */
const matchesUnder = (
  base: Deno.FileInfo,
  basePath: string,
  matches: (path: string) => boolean,
): Promise<string[]> =>
  base.isDirectory
    ? collectFiles(basePath, matches)
    : Promise.resolve(matches(basePath) ? [basePath] : []);

/**
 * The files these globs name, sorted and without repeats. A glob whose
 * directory is not there names no files rather than failing: the changed set a
 * run is given is a branch's committed diff, which still names test files that
 * have since moved.
 */
export const expand = async (
  globs: string[],
  from: string = Deno.cwd(),
): Promise<string[]> => {
  const paths = new Set<string>();
  for (const glob of globs) {
    const absGlob = join(from, glob);
    const pattern = globToRegExp(absGlob, { extended: true, globstar: true });
    const basePath = staticBase(absGlob);
    const base = await statOrNull(basePath);
    if (base === null) continue;
    for (const path of await matchesUnder(base, basePath, (candidate) =>
      pattern.test(candidate),
    )) {
      paths.add(path);
    }
  }
  return [...paths].sort();
};
