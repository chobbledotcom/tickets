import { afterEach, beforeEach } from "@std/testing/bdd";
import { setTestEnv } from "#test-utils/env.ts";

/** Register hooks that point LOCAL_STORAGE_PATH at a fresh temp dir for each
 *  test, then restore the env and delete the dir afterward. Call inside a
 *  describe body so the hooks stay scoped to that suite — the storage is where
 *  the pre-update backup gate looks. */
export const useLocalStoragePath = (): void => {
  let storageTmp: string;
  let restoreStorage: () => void;

  beforeEach(() => {
    storageTmp = Deno.makeTempDirSync();
    restoreStorage = setTestEnv({ LOCAL_STORAGE_PATH: storageTmp });
  });

  afterEach(() => {
    restoreStorage?.();
    if (storageTmp) Deno.removeSync(storageTmp, { recursive: true });
  });
};
