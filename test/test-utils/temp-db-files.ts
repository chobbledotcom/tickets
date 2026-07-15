import { lazyRef } from "#fp";
import { type TempPath, tempDir } from "#test-utils/files.ts";

export const DB_FILE_SUFFIXES = ["", "-journal", "-shm", "-wal"];

const trackedDbFiles = new Set<string>();
const [getCreatedTempDir, setCreatedTempDir] = lazyRef<TempPath | null>(
  () => null,
);

const ignoreCleanupError = (): void => {};

const removeIfPresent = (path: string): void => {
  try {
    Deno.removeSync(path);
  } catch {
    ignoreCleanupError();
  }
};

const getTempDir = (): string => {
  const existing = getCreatedTempDir();
  if (existing) return existing.path;
  const dir = tempDir({ prefix: "tickets-test-db-" });
  setCreatedTempDir(dir);
  return dir.path;
};

export const createTrackedTestDbFile = async (
  suffix: string,
): Promise<string> => {
  const path = await Deno.makeTempFile({ dir: getTempDir(), suffix });
  trackedDbFiles.add(path);
  return path;
};

export const cleanupTestDbPath = (path: string): void => {
  for (const suffix of DB_FILE_SUFFIXES) {
    removeIfPresent(`${path}${suffix}`);
  }
  trackedDbFiles.delete(path);
};

export const cleanupTrackedTestDbFiles = (): void => {
  for (const path of [...trackedDbFiles]) {
    cleanupTestDbPath(path);
  }
  const dir = getCreatedTempDir();
  if (!dir) return;
  dir.dispose();
  setCreatedTempDir(null);
};

globalThis.addEventListener("unload", cleanupTrackedTestDbFiles);
