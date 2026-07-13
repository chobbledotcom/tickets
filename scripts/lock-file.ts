/** Open (creating if needed) a file to hold an advisory lock. Shared by the
 * mutation-run isolation lock and the stripe-mock install lock. */
export const openLockFile = (path: string): Promise<Deno.FsFile> =>
  Deno.open(path, { create: true, read: true, write: true });

/** Hold an exclusive advisory lock on the file at `path` while `body` runs,
 * then release and close it no matter how `body` ends. The one "lock a file,
 * run something, unlock" dance the stripe-mock start and install locks share. */
export const withFileLock = async <T>(
  path: string,
  body: () => Promise<T>,
): Promise<T> => {
  const file = await openLockFile(path);
  try {
    await file.lock();
    try {
      return await body();
    } finally {
      file.unlock();
    }
  } finally {
    file.close();
  }
};
