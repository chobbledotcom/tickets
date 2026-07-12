/** Recursively yield every file path beneath `directory` (depth-first). */
export async function* walkFiles(directory: string): AsyncGenerator<string> {
  for await (const entry of Deno.readDir(directory)) {
    const path = `${directory}/${entry.name}`;
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
