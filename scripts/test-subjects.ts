/**
 * What a test file actually exercises.
 *
 * A test rarely names its subject directly. It calls a shared helper — a
 * `#test-utils/` factory, a `shared.ts` next to its siblings — and that helper
 * is what imports the `src/` module under test. Reading only the test's own
 * import list therefore credits the test to whichever `src/` file it happened
 * to mention (a database client it seeds rows with, a CSRF helper it reads a
 * token from) and misses the module its assertions are really about.
 *
 * This module follows the imports one hop further: from the test file, through
 * every `test/` helper it reaches, collecting the `src/` files found along the
 * way. It stops at the `src/` boundary — a source's own imports are not the
 * test's subjects, or every test would exercise the whole tree.
 *
 * The unit-test coverage report uses this to work out which source each test
 * covers. The mutation gate deliberately does not: it selects tests by the
 * mirror path alone, so a source whose test sits elsewhere is reported as
 * missing its direct suite and gets moved, rather than quietly running whatever
 * reaches it through a shared helper.
 * Reading files is the caller's job: pass a `readText`, and the walk stays pure
 * enough to unit-test from an in-memory map.
 */

import {
  type ImportMap,
  parseImportSpecifiers,
  resolveImportToSourceOrNull,
} from "./unit-tests-report-imports.ts";

export type { ImportMap };

/** Reads a project-relative file's text. Missing files must throw. */
export type ReadText = (path: string) => Promise<string>;

/** Resolve a relative specifier against the file that wrote it. */
const resolveRelative = (fromFile: string, spec: string): string => {
  const parts = fromFile.split("/").slice(0, -1);
  for (const segment of spec.split("/")) {
    if (segment === ".") continue;
    if (segment === "..") parts.pop();
    else parts.push(segment);
  }
  return parts.join("/");
};

/**
 * Resolve one import specifier written in `fromFile` to the project file it
 * names, or `null` when it names something outside the project (an npm or jsr
 * module, a std package). Both forms a project file can use are handled: a
 * `./`-relative path, and a `#` alias from the import map.
 */
export const resolveProjectImportOrNull = (
  spec: string,
  importMap: ImportMap,
  fromFile: string,
): string | null => {
  if (spec.startsWith("./") || spec.startsWith("../"))
    return resolveRelative(fromFile, spec);
  if (!spec.startsWith("#")) return null;
  for (const root of ["src", "test", "scripts", "cli"]) {
    const resolved = resolveImportToSourceOrNull(spec, importMap, root);
    if (resolved !== null) return resolved;
  }
  return null;
};

/**
 * Every `src/` file `testFile` exercises: the ones it imports itself, plus the
 * ones imported by any `test/` helper it reaches. Helper files are followed;
 * sources are collected and not followed. Each file is read once.
 *
 * `testTreeFiles` is every file in the test tree. A resolved path outside that
 * set is not followed, which keeps a specifier quoted as fixture data — the
 * code-quality tests scan for `import "…"` strings — from sending the walk
 * after a file that was never meant to exist.
 */
export const collectTestSubjects = async (
  testFile: string,
  readText: ReadText,
  importMap: ImportMap,
  testTreeFiles: ReadonlySet<string>,
): Promise<string[]> => {
  const subjects = new Set<string>();
  const visited = new Set<string>([testFile]);
  const queue = [testFile];
  while (queue.length > 0) {
    const current = queue.shift()!;
    const specifiers = parseImportSpecifiers(await readText(current));
    for (const spec of specifiers) {
      const resolved = resolveProjectImportOrNull(spec, importMap, current);
      if (resolved === null) continue;
      if (resolved.startsWith("src/")) {
        subjects.add(resolved);
        continue;
      }
      if (!testTreeFiles.has(resolved) || visited.has(resolved)) continue;
      visited.add(resolved);
      queue.push(resolved);
    }
  }
  return [...subjects];
};

/** A `readText` that reads from disk once per path and caches the text, so a
 *  helper shared by fifty tests is read one time for the whole walk. */
export const cachingReader = (read: ReadText): ReadText => {
  const cache = new Map<string, Promise<string>>();
  return (path) => {
    const cached = cache.get(path);
    if (cached !== undefined) return cached;
    const pending = read(path);
    cache.set(path, pending);
    return pending;
  };
};
