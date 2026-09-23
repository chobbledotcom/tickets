/**
 * What a test file actually exercises.
 *
 * A test rarely names its subject directly. It calls a shared helper — a
 * factory, a `shared.ts` next to its siblings — and that helper is what
 * imports the `src/` module under test. Reading only the test's own import
 * list therefore credits the test to whichever `src/` file it happened to
 * mention (a database client it seeds rows with, a CSRF helper it reads a
 * token from) and misses the module its assertions are really about.
 *
 * This module follows the imports: from the test file, through every `test/`
 * helper it reaches, collecting the `src/` files named on the way. It stops
 * at the `src/` boundary — a source's own imports are not the test's
 * subjects, or every test would exercise the whole tree. Helpers under
 * `test/test-utils/` name no subjects (see `TestSubjects`).
 *
 * The unit-test coverage report uses this to work out which source each test
 * covers. The mutation gate deliberately does not: it selects tests by the
 * mirror path alone, so a source whose test sits elsewhere is reported as
 * missing its direct suite and gets moved, rather than quietly running whatever
 * reaches it through a shared helper.
 *
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
 * Helpers under `test/test-utils/` are followed but add no subjects. Their
 * imports — a database row, a config value, a rendered page — are plumbing
 * nearly every test needs on the way, not what the test is about. Counting
 * them buries single-source findings under dozens of incidental imports.
 *
 * The walk still reads them, because a helper that drives the app (it imports
 * the `#routes` entry, or a route module under `#routes/…`) says the test is
 * an integration suite however it reaches the pages. `loadsApp` carries that
 * out; the misplaced-test list refuses to move such a test (issue #2312).
 */
export type TestSubjects = {
  /** True when a helper the test reaches imports the `#routes` app entry or a
   * route module under `#routes/…`. The test drives real pages, so it is an
   * integration suite, never a single-source unit. */
  loadsApp: boolean;
  /** Every `src/` file the test exercises: the ones it imports itself, plus
   * the ones imported on its behalf by helpers outside `test/test-utils/`. */
  subjects: string[];
};

/** The specifiers that name the app: its entry point (`#routes`) and the
 * route modules beneath it (`#routes/…`). */
const isRoutesSpecifier = (spec: string): boolean =>
  /^#routes(\/|$)/.test(spec);

export const collectTestSubjects = async (
  testFile: string,
  readText: ReadText,
  importMap: ImportMap,
  testTreeFiles: ReadonlySet<string>,
): Promise<TestSubjects> => {
  const walk: Walk = {
    importMap,
    loadsApp: false,
    queue: [testFile],
    subjects: new Set<string>(),
    testFile,
    testTreeFiles,
    visited: new Set<string>([testFile]),
  };
  while (walk.queue.length > 0) {
    await readFileIntoWalk(walk, walk.queue.shift()!, readText);
  }
  return { loadsApp: walk.loadsApp, subjects: [...walk.subjects] };
};

/** Everything the walk learns about one test, in the state it gathers it. */
type Walk = {
  importMap: ImportMap;
  /** Set when a helper the test reaches imports `#routes` or a module under
   * `#routes/…` — the test drives real pages, so it is an integration suite. */
  loadsApp: boolean;
  /** Test-tree files still to read; starts at the test file itself. */
  queue: string[];
  subjects: Set<string>;
  testFile: string;
  testTreeFiles: ReadonlySet<string>;
  visited: Set<string>;
};

/** Read one file and fold each of its specifiers into `walk`. */
const readFileIntoWalk = async (
  walk: Walk,
  file: string,
  readText: ReadText,
): Promise<void> => {
  // The test names its own imports as subjects; so does a helper beside it.
  // The shared helpers under test/test-utils/ are plumbing nearly every test
  // needs, so their imports name no subject (see `TestSubjects`).
  const namesSubjects =
    file === walk.testFile || !file.startsWith("test/test-utils/");
  for (const spec of parseImportSpecifiers(await readText(file))) {
    foldIntoWalk(walk, file, namesSubjects, spec);
  }
};

/** Fold one specifier into the walk: app reach from a helper, a subject a
 * naming file imports, and a still-unread helper queued for reading. */
const foldIntoWalk = (
  walk: Walk,
  file: string,
  namesSubjects: boolean,
  spec: string,
): void => {
  if (file !== walk.testFile && isRoutesSpecifier(spec)) walk.loadsApp = true;
  const resolved = resolveProjectImportOrNull(spec, walk.importMap, file);
  if (resolved === null) return;
  if (resolved.startsWith("src/")) {
    if (namesSubjects) walk.subjects.add(resolved);
  } else if (followsFrom(walk, resolved)) {
    walk.visited.add(resolved);
    walk.queue.push(resolved);
  }
};

/** A helper worth reading: a test-tree file the walk has not read yet. */
const followsFrom = (walk: Walk, path: string): boolean =>
  walk.testTreeFiles.has(path) && !walk.visited.has(path);

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
