import { join } from "@std/path";
import { statOrNull } from "./not-found.ts";

/**
 * What `directory` holds, or nothing when it is not a directory at all — a path
 * that has moved or gone answers with nothing rather than failing. Whether it
 * is there is asked before reading, because reading is what reaches the disk: a
 * check around opening the reader would never see the answer.
 */
export const directoryEntries = async (
  directory: string,
): Promise<Deno.DirEntry[]> => {
  const info = await statOrNull(directory);
  if (info === null || !info.isDirectory) return [];
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
