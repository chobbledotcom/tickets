/**
 * The rings of modules that import each other.
 *
 * A ring is not a fault by itself, and this tree carries several harmless
 * ones. A ring becomes a fault when a module in it does work as it loads: the
 * module that loses the race reads a name before it exists, and the app dies
 * at startup with "Cannot access X before initialization". That happened when
 * `#shared/env.ts` — which the database client and the encryption both read
 * before anything else — took a date helper from `#shared/dates.ts`, which
 * reaches the database for a site's timezone. The ring that closed took every
 * Cucumber spec down with it.
 *
 * A type-only import is erased before anything runs, so it cannot make this
 * kind of ring and does not count here.
 */

import {
  type Alias,
  resolveSpecifier,
  topLevelImports,
} from "#scripts/check-imports/rules.ts";

/** One module, and the modules it loads at run time. */
export interface Module {
  loads: readonly string[];
  path: string;
}

/** One file of the tree being read, as a repository-relative path. */
export interface SourceFile {
  content: string;
  path: string;
}

/** The file a sibling specifier names, relative to the file that wrote it.
 *  `./x.ts` beside `src/a/b.ts` is `src/a/x.ts`. */
const beside = (from: string, specifier: string): string => {
  const parts = from.split("/").slice(0, -1);
  for (const step of specifier.split("/")) {
    if (step === ".") continue;
    if (step === "..") parts.pop();
    else parts.push(step);
  }
  return parts.join("/");
};

/** The file one import names, or null when it names something outside the
 *  tree — a package, or an alias pointing anywhere but `src/`. */
const fileFor = (
  aliases: Alias[],
  from: string,
  specifier: string,
): string | null => {
  if (specifier.startsWith(".")) return beside(from, specifier);
  const target = resolveSpecifier(aliases, specifier);
  return target === null ? null : target.replace(/^\.\//, "");
};

/** Every module in the tree, each carrying the modules it loads at run time.
 *  An import of something outside the tree is dropped, because a ring can only
 *  close inside it. */
export const modulesOf = (
  files: readonly SourceFile[],
  aliases: Alias[],
): Module[] => {
  const known = new Set(files.map((file) => file.path));
  return files.map((file) => ({
    loads: topLevelImports(file.content)
      .filter((line) => !line.typeOnly)
      .map((line) => fileFor(aliases, file.path, line.specifier))
      .filter((path): path is string => path !== null && known.has(path)),
    path: file.path,
  }));
};

/** What a walk knows about one module while it is looking for rings. */
interface Visit {
  /** The lowest position this module can reach by following loads. */
  lowest: number;
  /** Where the walk first met this module. */
  position: number;
  waiting: boolean;
}

/** The walk's own state, shared by every step of one run. */
interface Walk {
  found: string[][];
  loads: Map<string, readonly string[]>;
  next: number;
  seen: Map<string, Visit>;
  waiting: string[];
}

/** The ring that closes at `path`: every module still waiting since the walk
 *  first met this one. A one-member ring is a module that loads itself —
 *  legal to write and a startup crash to run — so it stays a finding. */
const ringAt = (walk: Walk, path: string): void => {
  const ring: string[] = [];
  let taken: string;
  do {
    taken = walk.waiting.pop() as string;
    (walk.seen.get(taken) as Visit).waiting = false;
    ring.push(taken);
  } while (taken !== path);
  const loadsItself = (walk.loads.get(path) ?? []).includes(path);
  if (ring.length > 1 || loadsItself) walk.found.push(ring.sort());
};

/** Walk everything `path` loads, then say whether a ring closed here. This is
 *  Tarjan's algorithm: a module whose lowest reachable position is its own
 *  opens a ring, and everything still waiting above it is in that ring. */
const walkFrom = (walk: Walk, path: string): void => {
  const own: Visit = { lowest: walk.next, position: walk.next, waiting: true };
  walk.next++;
  walk.seen.set(path, own);
  walk.waiting.push(path);
  for (const next of walk.loads.get(path) ?? []) {
    const met = walk.seen.get(next);
    if (met === undefined) {
      walkFrom(walk, next);
      own.lowest = Math.min(own.lowest, (walk.seen.get(next) as Visit).lowest);
    } else if (met.waiting) {
      own.lowest = Math.min(own.lowest, met.position);
    }
  }
  if (own.lowest === own.position) ringAt(walk, path);
};

/**
 * Every ring in the tree, each as its members' paths sorted, and the rings
 * themselves in a settled order so two runs over one tree read alike.
 */
export const importCycles = (modules: readonly Module[]): string[][] => {
  const walk: Walk = {
    found: [],
    loads: new Map(modules.map((module) => [module.path, module.loads])),
    next: 0,
    seen: new Map(),
    waiting: [],
  };
  for (const module of modules) {
    if (!walk.seen.has(module.path)) walkFrom(walk, module.path);
  }
  return walk.found.sort((one, other) =>
    (one[0] as string).localeCompare(other[0] as string),
  );
};
