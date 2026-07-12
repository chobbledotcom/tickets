/** Open (creating if needed) a file to hold an advisory lock. Shared by the
 * mutation-run isolation lock and the stripe-mock install lock. */
export const openLockFile = (path: string): Promise<Deno.FsFile> =>
  Deno.open(path, { create: true, read: true, write: true });
