/** Write one JSON file the way every guide document writes it. */
export const writeJson = (path: string, value: unknown): Promise<void> =>
  Deno.writeTextFile(path, `${JSON.stringify(value, null, 2)}\n`);
