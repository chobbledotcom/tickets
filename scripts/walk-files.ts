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
