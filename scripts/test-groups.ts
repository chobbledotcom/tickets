/**
 * Group test files into generated entry modules so many files share one
 * isolate.
 *
 * `deno test` runs every test file in its own isolate, and each isolate
 * re-evaluates the whole app module graph — several hundred milliseconds of
 * CPU per file, times ~940 files per full run. A group entry file simply
 * imports a shard of test files, so all of them register their tests into one
 * isolate and the module graph is evaluated once per group instead. The
 * focused runner (`deno task test:files`) never groups — you always get the
 * exact files you asked for, each in its own isolate.
 *
 * Files with global (module-level) BDD hooks cannot be merged: with
 * @std/testing/bdd a module-level `beforeEach(...)` applies to the whole
 * module, and registering a global hook after another module's tests is an
 * error. Those files run as their own entries, exactly as before. The same
 * escape is available to any file that genuinely needs its own isolate: give
 * it a module-level `// test-groups: run-alone` comment.
 */

import { isAbsolute, join, relative } from "node:path";
import { rethrowUnlessNotFound } from "./not-found.ts";
import { isSourcePath, isTestPath } from "./unit-tests-report-lib.ts";
import { collectFiles } from "./walk-files.ts";
import { parseWorkerCount } from "./workers.ts";

/** Where the generated group entry files live, relative to the project root.
 * Outside test/ so tree-walking checks (code quality, i18n coverage) never see
 * them, and gitignored. */
export const GROUPS_DIR = ".test-groups";

/** Marker a test file can carry to opt out of isolate sharing. */
export const RUN_ALONE_MARKER = "test-groups: run-alone";

// A hook call at column 0 is a *global* BDD hook (inside a describe it is
// always indented — Biome enforces the formatting). A module-level
// useSetting call hides the same bug behind an expression. The helper wraps
// beforeEach and afterEach, so a top-level call pins every test in the
// isolate under root-scoped hooks. A worker whose isolate carries such
// hooks dies at shutdown with no failed test and no stderr (found by the
// bisect behind issue #2508).
const GLOBAL_HOOK_SOURCES = [/^(?:beforeAll|beforeEach|afterAll|afterEach)\(/m];

/** The test-utils helper whose module-level call registers root hooks. */
const WRAPPER_HOOK = "useSetting";

/** The index past the quoted string or template literal that opens at
 *  `start`, honouring escapes. The scan reads a template interpolation's
 *  body as literal text, so its braces never move the depth count. */
const skipPastQuote = (
  source: string,
  start: number,
  quote: string,
): number => {
  let index = start + 1;
  while (index < source.length) {
    if (source[index] === "\\") {
      index += 2;
      continue;
    }
    if (source[index] === quote) return index + 1;
    index += 1;
  }
  return index;
};

/** Whether the name at `index` is `callee`, stands alone, and is called: no
 *  letter, digit, `_`, `$`, or dot before it, and a `(` after any spaces. */
const callsCallee = (
  source: string,
  index: number,
  callee: string,
): boolean => {
  if (!source.startsWith(callee, index)) return false;
  const before = index === 0 ? "" : source[index - 1]!;
  if (/[A-Za-z0-9_$.]/.test(before)) return false;
  let after = index + callee.length;
  while (source[after] === " " || source[after] === "\t") after += 1;
  return source[after] === "(";
};

/** The index past the comment or string literal at `index`, or null when
 *  the position holds ordinary code. */
const skipCommentOrString = (source: string, index: number): number | null => {
  const char = source[index]!;
  const next = source[index + 1] ?? "";
  if (char === "/" && next === "/") {
    const end = source.indexOf("\n", index);
    return end === -1 ? source.length : end;
  }
  if (char === "/" && next === "*") {
    const end = source.indexOf("*/", index + 2);
    return end === -1 ? source.length : end + 2;
  }
  if (char === '"' || char === "'" || char === "`") {
    return skipPastQuote(source, index, char);
  }
  return null;
};

const isOpener = (char: string): boolean =>
  char === "(" || char === "[" || char === "{";

const isCloser = (char: string): boolean =>
  char === ")" || char === "]" || char === "}";

/** The arrow-body state after one code character: a braceless arrow opens a
 *  body, and the statement's `;` closes it. */
const arrowStateAfter = (
  char: string,
  next: string,
  inArrowBody: boolean,
): boolean => (char === ";" ? false : inArrowBody || next === ">");

/** Whether the brace at `index` opens a function body: the previous code
 *  character is a signature's `)` or an arrow's `>`. Any other brace is an
 *  object, block, or class literal whose body still runs at module load. */
const opensFunctionBody = (source: string, index: number): boolean => {
  let look = index - 1;
  while (look >= 0 && /\s/.test(source[look]!)) look -= 1;
  const char = source[look];
  return char === ")" || char === ">";
};

/** One scanner state: the open delimiters (each true when it opened a
 *  function body), how many of those are function bodies, and whether a
 *  braceless arrow body is open. */
type ScanState = {
  bodies: boolean[];
  functionDepth: number;
  inArrowBody: boolean;
};

/** The state after the code character at `index`: delimiters push and pop
 *  their scopes, a brace opens a function body when it follows `)` or `=>`,
 *  and a braceless arrow's body runs to the statement's `;`. */
const scanStateAfter = (
  source: string,
  index: number,
  state: ScanState,
): ScanState => {
  const char = source[index]!;
  if (isOpener(char)) {
    const body = char === "{" && opensFunctionBody(source, index);
    return {
      bodies: [...state.bodies, body],
      functionDepth: state.functionDepth + (body ? 1 : 0),
      inArrowBody: state.inArrowBody,
    };
  }
  if (isCloser(char)) {
    const closed = state.bodies.at(-1) === true;
    return {
      bodies: state.bodies.slice(0, -1),
      functionDepth: state.functionDepth - (closed ? 1 : 0),
      inArrowBody: state.inArrowBody,
    };
  }
  return {
    ...state,
    inArrowBody: arrowStateAfter(
      char,
      source[index + 1] ?? "",
      state.inArrowBody,
    ),
  };
};

/** Whether `callee` is called at the file's top level. The scan skips
 *  comments and string literals and reads a call outside every function
 *  body. A parenthesised, bracket, or object initialiser runs at module
 *  load, so a call inside one is a module-level call; only a function body
 *  suppresses, and a `{` opens one when it follows `)` or `=>`. A braceless
 *  arrow's body is one statement: the scan suppresses calls from the
 *  arrow's `=>` to the statement's `;`. */
const hasModuleScopeCall = (source: string, callee: string): boolean => {
  let state: ScanState = { bodies: [], functionDepth: 0, inArrowBody: false };
  let index = 0;
  while (index < source.length) {
    const past = skipCommentOrString(source, index);
    if (past !== null) {
      index = past;
      continue;
    }
    state = scanStateAfter(source, index, state);
    if (
      state.functionDepth === 0 &&
      !state.inArrowBody &&
      callsCallee(source, index, callee)
    ) {
      return true;
    }
    index += 1;
  }
  return false;
};

const registersGlobalHooks = (source: string): boolean =>
  GLOBAL_HOOK_SOURCES.some((pattern) => pattern.test(source)) ||
  hasModuleScopeCall(source, WRAPPER_HOOK);

/** True when a test file must run in its own isolate instead of a group. */
export const mustRunAlone = (source: string): boolean =>
  registersGlobalHooks(source) || source.includes(RUN_ALONE_MARKER);

/** Deal `items` round-robin into `groupCount` piles (sorted input stays
 * spread across piles, so no pile ends up with one directory's heavy files). */
export const shardRoundRobin = <T>(items: T[], groupCount: number): T[][] => {
  const count = Math.max(1, Math.min(groupCount, items.length));
  const piles: T[][] = Array.from({ length: count }, () => []);
  items.forEach((item, index) => {
    piles[index % count]!.push(item);
  });
  return piles;
};

/** The source of one generated group entry: an import per member file. */
export const renderGroupEntry = (importPaths: string[]): string =>
  `// Generated by scripts/test-groups.ts — do not edit, do not commit.\n${importPaths
    .map((path) => `import "${path}";`)
    .join("\n")}\n`;

export type TestGroupPlan = {
  /** Shards of files that share an isolate via a generated entry. */
  grouped: string[][];
  /** Files that keep their own isolate (global hooks or run-alone marker). */
  solo: string[];
};

/** Read each file once and pair it with whether it must run alone. */
export const classifyRunAlone = (
  paths: string[],
): Promise<{ path: string; runsAlone: boolean }[]> =>
  Promise.all(
    paths.map(async (path) => ({
      path,
      runsAlone: mustRunAlone(await Deno.readTextFile(path)),
    })),
  );

/** Split test files into isolate-sharing shards and solo files. Pure. */
export const planTestGroups = (
  files: { path: string; runsAlone: boolean }[],
  groupCount: number,
): TestGroupPlan => {
  const groupable = files.filter((file) => !file.runsAlone);
  return {
    grouped: shardRoundRobin(
      groupable.map((file) => file.path),
      groupCount,
    ),
    solo: files.filter((file) => file.runsAlone).map((file) => file.path),
  };
};

/** Every test file under `root`/test, sorted for determinism. Throws if a
 * shared helper (a non-test .ts/.tsx file) registers global hooks: its
 * importers look groupable but would blow up the whole group at load, so the
 * helper must expose a setup function the test files call from their own
 * suites. */
export const collectTestFiles = async (root: string): Promise<string[]> => {
  const sources = await collectFiles(join(root, "test"), isSourcePath);
  for (const helper of sources.filter((path) => !isTestPath(path))) {
    if (registersGlobalHooks(await Deno.readTextFile(helper))) {
      throw new Error(
        `${helper} is a shared test helper but registers a global BDD hook — ` +
          "export a setup function and call it from each test file's own suite instead",
      );
    }
  }
  for (const file of sources.filter(isTestPath)) {
    if (hasModuleScopeCall(await Deno.readTextFile(file), WRAPPER_HOOK)) {
      throw new Error(
        `${file} calls useSetting at the top level. Call it inside the ` +
          "describe instead: a module-level call registers root hooks for " +
          "every test in the shared isolate, and the worker dies at shutdown.",
      );
    }
  }
  return sources.filter(isTestPath);
};

/**
 * How many groups to shard into: a few per test worker, so `--parallel`
 * (which runs one entry per worker at a time) always has entries queued and
 * an unlucky heavy shard cannot dominate the tail. A group entry shares one
 * isolate, whose coverage buffers and module graph grow with its file count,
 * so the count also rises with the file count to keep every group's isolate
 * inside the memory budget the coverage gate runs under.
 */
export const defaultGroupCount = (
  workers: number,
  fileCount?: number,
): number => {
  const byWorkers = Math.max(8, workers * 4);
  if (fileCount === undefined) return byWorkers;
  return Math.max(byWorkers, Math.ceil(fileCount / 40));
};

const testWorkerCount = (): number =>
  parseWorkerCount(Deno.env.get("DENO_JOBS"), navigator.hardwareConcurrency);

/** Swallow the two expected ways removing the groups dir can fail — already
 * gone, or still holding files someone else put there (Deno reports a
 * non-empty dir as a plain Error, so it is matched by message) — and rethrow
 * anything else, e.g. a permissions failure. */
export const rethrowUnlessLeftoverDir = (error: unknown): void => {
  if (error instanceof Deno.errors.NotFound) return;
  if (String(error).includes("Directory not empty")) return;
  throw error;
};

/** How an entry imports one of its members. Entries sit one level below the
 *  project root, so the specifier climbs out of the entries directory to the
 *  member's project-relative path — which keeps the project's import map
 *  applying to it, and is what lets a mutated module bind through its alias. */
export const groupEntryImport = (root: string, member: string): string =>
  `../${relative(root, isAbsolute(member) ? member : join(root, member))}`;

/**
 * Write one entry module per shard into the entries directory, naming each by
 * its index. Returns the entry paths to run and a cleanup that removes them.
 */
export const writeGroupEntries = async (
  root: string,
  shards: string[][],
  nameFor: (index: number) => string,
): Promise<{ cleanup: () => Promise<void>; paths: string[] }> => {
  const entriesDir = join(root, GROUPS_DIR);
  await Deno.mkdir(entriesDir, { recursive: true });
  const paths: string[] = [];
  for (const [index, members] of shards.entries()) {
    const entry = join(entriesDir, nameFor(index));
    await Deno.writeTextFile(
      entry,
      renderGroupEntry(members.map((member) => groupEntryImport(root, member))),
    );
    paths.push(entry);
  }
  return {
    // Only an already-removed entry is expected; anything else must surface
    // rather than leave generated files behind silently.
    cleanup: async () => {
      for (const entry of paths) {
        await Deno.remove(entry).catch(rethrowUnlessNotFound);
      }
    },
    paths,
  };
};

export type WrittenTestGroups = {
  /** Paths to hand to `deno test`: group entries plus solo files. */
  runArgs: string[];
  /** The real test files, for the progress bar's test-count estimate. */
  testFiles: string[];
  /** Remove the generated entries. */
  cleanup: () => Promise<void>;
};

/**
 * Plan and write the group entry files for a full-suite run. Entries import
 * their members with paths relative to GROUPS_DIR, so the project's import
 * map applies unchanged.
 */
export const writeTestGroups = async (
  root: string,
  groupCount?: number,
): Promise<WrittenTestGroups> => {
  const paths = await collectTestFiles(root);
  const plan = planTestGroups(
    await classifyRunAlone(paths),
    groupCount ?? defaultGroupCount(testWorkerCount(), paths.length),
  );

  const entries = await writeGroupEntries(
    root,
    plan.grouped,
    (index) => `group-${index}.test.ts`,
  );

  return {
    cleanup: async () => {
      await entries.cleanup();
      await Deno.remove(join(root, GROUPS_DIR)).catch(rethrowUnlessLeftoverDir);
    },
    runArgs: [...entries.paths, ...plan.solo],
    testFiles: paths,
  };
};
