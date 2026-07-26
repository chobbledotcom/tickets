/** Open (creating if needed) a file to hold an advisory lock. Shared by local
 * tooling that must not run the same expensive operation concurrently. */
export const openLockFile = (path: string): Promise<Deno.FsFile> =>
  Deno.open(path, { create: true, read: true, write: true });

/** Hold an exclusive advisory lock on the file at `path` while `body` runs,
 * then release and close it no matter how `body` ends.
 *
 * `lock(true)`, not `lock()`: Deno's default is a *shared* lock, which any
 * number of holders can take at once — so the plain call excluded nobody and
 * every caller here ran side by side with the operation it meant to serialise. */
export const withFileLock = async <T>(
  path: string,
  body: () => Promise<T>,
): Promise<T> => {
  const file = await openLockFile(path);
  try {
    await file.lock(true);
    try {
      return await body();
    } finally {
      await file.unlock();
    }
  } finally {
    file.close();
  }
};
