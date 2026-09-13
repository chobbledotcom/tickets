import { join } from "@std/path";

/**
 * What `directory` holds, as a list. A directory that is not there fails here,
 * loudly: a caller asking to walk somewhere that has gone is asking about a
 * root it believes in, and answering "nothing" would read as "nothing to do".
 */
export const directoryEntries = async (
  directory: string,
): Promise<Deno.DirEntry[]> => {
  const entries: Deno.DirEntry[] = [];
  for await (const entry of Deno.readDir(directory)) entries.push(entry);
  return entries;
};

/** Recursively yield every file path beneath `directory` (depth-first). */
export async function* walkFiles(directory: string): AsyncGenerator<string> {
  for (const entry of await directoryEntries(directory)) {
    const path = join(directory, entry.name);
    if (entry.isDirectory) {
      yield* walkFiles(path);
      continue;
    }
    yield path;
  }
}

/** Every file beneath `directory` whose path passes `keep`, sorted. */
export const collectFiles = async (
  directory: string,
  keep: (path: string) => boolean,
): Promise<string[]> => {
  const files: string[] = [];
  for await (const path of walkFiles(directory)) {
    if (keep(path)) files.push(path);
  }
  return files.sort();
};

/** Every file beneath a directory whose path matches, sorted. */
const collectMatching =
  (pattern: RegExp): ((directory: string) => Promise<string[]>) =>
  (directory) =>
    collectFiles(directory, (path) => pattern.test(path));

/** Every TypeScript file beneath `directory`, sorted. */
export const collectSourceFiles = collectMatching(/\.tsx?$/);

/** Every TypeScript or JavaScript file beneath `directory`, sorted. A browser
 * script we ship as plain `.js` is source too, so a check that has to read all
 * of our code reaches for this one. */
export const collectScriptFiles = collectMatching(/\.[cm]?[jt]sx?$/);

/**
 * A script collector that leaves out every file `frozen` names. One mechanism
 * behind both collectors below, so they cannot drift apart.
 */
const scriptsSkipping =
  (frozen: (file: string) => boolean) =>
  async (directory: string): Promise<string[]> =>
    (await collectScriptFiles(directory)).filter((file) => !frozen(file));

/**
 * Files no code check reads: the browser bundles in `ui/static`, which esbuild
 * builds, and the schema-columns module, which a script generates. Nobody
 * writes them by hand, so a finding in one has no author to fix it.
 */
export const isGeneratedFile = (file: string): boolean =>
  /(^|\/)migrations\/schema\/columns\.ts$/.test(file) ||
  /(^|\/)ui\/static\//.test(file);

/**
 * A migration that shipped: history that must never change. A duplication scan
 * skips these because a migration repeats by design. The rule gates still read
 * every one, so a migration added on a branch is checked like any new file.
 */
export const isShippedMigration = (file: string): boolean =>
  /(^|\/)migrations\/2\d/.test(file);

/** Every script the rule gates read: all TypeScript and JavaScript beneath
 * `directory`, built output left out — shipped migrations included. */
export const collectGateScriptFiles = scriptsSkipping(isGeneratedFile);

/** Every file a rule gate reads: the gate scripts, plus the authored
 * stylesheets. The stylesheet under `ui/static` is written by hand even though
 * the bundles beside it are built, so it joins this collector while the
 * built files stay out. */
export const collectGateFiles = async (
  directory: string,
): Promise<string[]> => {
  const gateScripts = await collectGateScriptFiles(directory);
  const stylesheets = await collectMatching(/\.scss$/)(directory);
  return [...gateScripts, ...stylesheets].sort();
};

/** Every script a duplication scan reads: gate-checked files minus the
 * shipped migrations, sorted. */
export const collectAuthoredScriptFiles = scriptsSkipping(
  (file) => isGeneratedFile(file) || isShippedMigration(file),
);

/**
 * Read every file the collector gathers under each root, and collect what one
 * reader derives from a file's path and text. The reader returns its items
 * for that file. A reader with nothing to say about a file returns an empty
 * list for it.
 */
export const collectFromFiles = async <Item>(
  roots: readonly string[],
  collect: (root: string) => Promise<string[]>,
  read: (file: string, content: string) => Item[],
): Promise<Item[]> => {
  const items: Item[] = [];
  for (const root of roots) {
    for (const file of await collect(root)) {
      items.push(...read(file, await Deno.readTextFile(file)));
    }
  }
  return items;
};
