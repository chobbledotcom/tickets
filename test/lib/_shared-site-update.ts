import { afterEach, beforeEach } from "@std/testing/bdd";
import { type EnvScope, withEnv } from "#test-utils/env.ts";

/** Register hooks that point LOCAL_STORAGE_PATH at a fresh temp dir for each
 *  test, then restore the env and delete the dir afterward. Call inside a
 *  describe body so the hooks stay scoped to that suite — the storage is where
 *  the pre-update backup gate looks. */
export const useLocalStoragePath = (): void => {
  let storageTmp: string;
  let storageEnv: EnvScope;

  beforeEach(() => {
    storageTmp = Deno.makeTempDirSync();
    storageEnv = withEnv({ LOCAL_STORAGE_PATH: storageTmp });
  });

  afterEach(() => {
    storageEnv.dispose();
    if (storageTmp) Deno.removeSync(storageTmp, { recursive: true });
  });
};
