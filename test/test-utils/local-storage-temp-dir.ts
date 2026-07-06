import { afterEach, beforeEach } from "@std/testing/bdd";
import { setTestEnv } from "#test-utils/env.ts";

/** Give a suite its own throwaway local-storage folder for each test, pointed at
 *  by LOCAL_STORAGE_PATH and removed again afterwards. Pass extra cleanup to run
 *  at the very start of teardown, before the folder is deleted. */
export const useLocalStorageTempDir = (extraCleanup?: () => void): void => {
  let storageTmp: string;
  let restoreStorage: () => void;

  beforeEach(() => {
    storageTmp = Deno.makeTempDirSync();
    restoreStorage = setTestEnv({ LOCAL_STORAGE_PATH: storageTmp });
  });

  afterEach(() => {
    extraCleanup?.();
    restoreStorage?.();
    if (storageTmp) Deno.removeSync(storageTmp, { recursive: true });
  });
};
