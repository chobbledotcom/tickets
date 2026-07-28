/**
 * Turning source/test globs into the files they name.
 *
 * Replaces `@std/fs`'s `expandGlob` (not in this project's lock, so unfetchable
 * in a sandboxed run) with `@std/path`'s `globToRegExp` over a `Deno.readDir`
 * walk — same contract: absolute paths to existing files, sorted and without
 * repeats.
 */

import { globToRegExp, join, normalize, SEPARATOR } from "@std/path";

/** Glob metacharacters; a path segment with none is a fixed directory name. */
const GLOB_CHARS = /[*?{}[\]]/;

/**
 * What `dir` holds, or nothing when there is no such directory — a path that
 * has since moved or gone is asked for and simply answers with nothing. Reading
 * the entries is what reaches the disk, so a missing directory shows up here
 * rather than where the reader was created.
 */
const dirEntriesOrNone = async (dir: string): Promise<Deno.DirEntry[]> => {
  const entries: Deno.DirEntry[] = [];
  try {
    for await (const entry of Deno.readDir(dir)) entries.push(entry);
  } catch (error) {
    const gone =
      error instanceof Deno.errors.NotFound ||
      error instanceof Deno.errors.NotADirectory;
    if (!gone) throw error;
    return [];
  }
  return entries;
};

/** Every file under `dir`, recursively; a missing directory yields nothing. */
async function* walkFiles(dir: string): AsyncGenerator<string> {
  for (const entry of await dirEntriesOrNone(dir)) {
    const path = join(dir, entry.name);
    if (entry.isDirectory) yield* walkFiles(path);
    else if (entry.isFile) yield path;
  }
}

/** The leading, glob-free directory of `glob` — where a walk can start without
 *  scanning the whole tree. An exact path (no metacharacters) returns itself. */
const staticBase = (glob: string): string => {
  const fixed: string[] = [];
  for (const segment of normalize(glob).split(SEPARATOR)) {
    if (GLOB_CHARS.test(segment)) break;
    fixed.push(segment);
  }
  return fixed.length > 0 ? fixed.join(SEPARATOR) : ".";
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
