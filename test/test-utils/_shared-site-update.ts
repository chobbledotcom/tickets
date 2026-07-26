import { afterEach, beforeEach } from "@std/testing/bdd";
import { type EnvScope, withEnv } from "#test-utils/env.ts";
import { type TempPath, tempDir } from "#test-utils/files.ts";

/** Register hooks that point LOCAL_STORAGE_PATH at a fresh temp dir for each
 *  test, then restore the env and delete the dir afterward. Call inside a
 *  describe body so the hooks stay scoped to that suite — the storage is where
 *  the pre-update backup gate looks. */
export const useLocalStoragePath = (): void => {
  let storageTmp: TempPath;
  let storageEnv: EnvScope;

  beforeEach(() => {
    storageTmp = tempDir();
    storageEnv = withEnv({ LOCAL_STORAGE_PATH: storageTmp.path });
  });

  afterEach(() => {
    storageEnv.dispose();
    storageTmp.dispose();
  });
};
