/**
 * The mechanics the `.bin` installers share: stage work in a temp folder, and
 * install under a lock when a binary is missing. jscpd and stripe-mock both
 * fetch a native binary into `.bin/`, so the pieces they repeat live here.
 */

import { removeTree } from "#scripts/process.ts";

/** Whether a regular file sits at `path`. */
export const isFileAt = async (path: string): Promise<boolean> => {
  try {
    return (await Deno.stat(path)).isFile;
  } catch {
    return false;
  }
};

/**
 * Run `body` with a fresh temp folder under `parentDir`, deleting the folder
 * afterwards even when `body` throws.
 */
export const withTempDir = async <Result>(
  parentDir: string,
  prefix: string,
  body: (tempDir: string) => Promise<Result>,
): Promise<Result> => {
  const tempDir = await Deno.makeTempDir({ dir: parentDir, prefix });
  try {
    return await body(tempDir);
  } finally {
    await removeTree(tempDir);
  }
};

/**
 * Always-install-once: run `install` when no binary sits at `binaryPath`,
 * serializing the check against other processes through `lock`. Both
 * installers check again inside the lock, so two of them cannot both install.
 */
export const ensureInstalled = async ({
  binaryPath,
  install,
  lock,
}: {
  binaryPath: string;
  install: () => Promise<void>;
  lock: <Result>(body: () => Promise<Result>) => Promise<Result>;
}): Promise<void> => {
  if (await isFileAt(binaryPath)) return;
  await lock(async () => {
    if (await isFileAt(binaryPath)) return;
    await install();
  });
};
