/**
 * Re-throw `error` unless it is a Deno `NotFound` — the common "treat a missing
 * file/dir as absent, surface everything else" guard for filesystem catches.
 */
export const rethrowUnlessNotFound = (error: unknown): void => {
  if (!(error instanceof Deno.errors.NotFound)) throw error;
};

/**
 * Remove a file/dir synchronously, ignoring a missing path. The sync sibling of
 * `removeIfPresent` (in `cleanup.ts`); use it where the caller is already in a
 * sync context and a missing file is the expected, harmless case.
 */
export const removeIfExistsSync = (path: string): void => {
  try {
    Deno.removeSync(path);
  } catch (error) {
    rethrowUnlessNotFound(error);
  }
};
