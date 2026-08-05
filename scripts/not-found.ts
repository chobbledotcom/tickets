/**
 * Re-throw `error` unless it is a Deno `NotFound` — the common "treat a missing
 * file/dir as absent, surface everything else" guard for filesystem catches.
 */
export const rethrowUnlessNotFound = (error: unknown): void => {
  if (!(error instanceof Deno.errors.NotFound)) throw error;
};

/**
 * Answer `null` when the thing simply is not there. Any other failure means
 * the disk could not be read at all, which throws rather than reading as
 * "nothing here".
 */
export const nullIfNotFound = <Found>(
  work: Promise<Found>,
): Promise<Found | null> =>
  work.catch((error: unknown) => {
    rethrowUnlessNotFound(error);
    return null;
  });

/** A file's text, or `null` when there is no such file. */
export const readTextFileOrNull = (
  file: string | URL,
): Promise<string | null> => nullIfNotFound(Deno.readTextFile(file));

/** The entry names in a directory that the keep-filter accepts, or none when
 * the directory itself is not there. */
export const namesInDirectory = async (
  dir: string | URL,
  keep: (entry: Deno.DirEntry) => boolean,
): Promise<string[]> => {
  const names: string[] = [];
  try {
    for await (const entry of Deno.readDir(dir)) {
      if (keep(entry)) names.push(entry.name);
    }
  } catch (error) {
    rethrowUnlessNotFound(error);
  }
  return names;
};

/** What one of Deno's look-at-a-path calls says, or `null` when nothing is there. */
const infoOrNull =
  (look: "lstat" | "stat") =>
  (path: string): Promise<Deno.FileInfo | null> =>
    nullIfNotFound(Deno[look](path));

export const statOrNull: (path: string) => Promise<Deno.FileInfo | null> =
  infoOrNull("stat");

/** As `statOrNull`, but tells you about a link rather than what it points at. */
export const lstatOrNull: (path: string) => Promise<Deno.FileInfo | null> =
  infoOrNull("lstat");

/**
 * A number from a path's details — its size, when it changed — or `null` when
 * there is nothing there, or the filesystem does not keep that number.
 */
export const statNumberOrNull =
  (
    pick: (info: Deno.FileInfo) => number | null | undefined,
  ): ((path: string) => Promise<number | null>) =>
  async (path: string): Promise<number | null> => {
    const info = await statOrNull(path);
    return info === null ? null : (pick(info) ?? null);
  };
