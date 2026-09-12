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
 * Files no authored-code check reads, matching what `.jscpd.json` skips: a
 * shipped migration is history that must never change, and `ui/static` holds
 * built bundles rather than code anybody wrote.
 */
export const isFrozenBuildFile = (file: string): boolean =>
  /(^|\/)migrations\/2\d/.test(file) ||
  /(^|\/)migrations\/schema\/columns\.ts$/.test(file) ||
  /(^|\/)ui\/static\//.test(file);

/** Every authored TypeScript or JavaScript file beneath `directory`, sorted,
 * with the frozen trees left out. */
export const collectAuthoredScriptFiles = async (
  directory: string,
): Promise<string[]> =>
  (await collectScriptFiles(directory)).filter(
    (file) => !isFrozenBuildFile(file),
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
