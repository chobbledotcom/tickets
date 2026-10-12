import { afterEach, beforeEach } from "@std/testing/bdd";
import { type Stub, stub } from "@std/testing/mock";
import { bunnyCdnApi } from "#shared/bunny-cdn.ts";
import { type UpdateGuardIo, updatePageMeta } from "#shared/update-guard.ts";
import { type EnvScope, withEnv } from "#test-utils/env.ts";
import { stubFetch } from "#test-utils/fetch-stub.ts";
import { type TempPath, tempDir } from "#test-utils/files.ts";
import { MOCK_RELEASE } from "#test-utils/mocks.ts";

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

/** The fetches a guarded site update makes: the site's read-only page
 * (answering the update marker, so both waits pass at once), the GitHub
 * release lookup, and the release download. */
export const stubUpdateFetch = (
  opts: { download?: () => Response; release?: Response } = {},
): Stub =>
  stubFetch((url) => {
    if (url.includes("/read-only")) {
      return new Response(updatePageMeta("active"));
    }
    if (url.includes("releases/latest")) {
      return (
        opts.release ??
        new Response(JSON.stringify(MOCK_RELEASE), { status: 200 })
      );
    }
    return (
      opts.download ??
      (() => new Response("console.log('updated')", { status: 200 }))
    )();
  });

/** Bunny's edge script secret store, accepting the update flag write. */
export const stubBunnyUpdateFlag = (): Stub =>
  stub(bunnyCdnApi, "setEdgeScriptSecret", () =>
    Promise.resolve({ ok: true as const }),
  );

/** An update guard io that records every call in `calls`, in order. The page
 * fetch serves `pages` one by one. After the list runs out, it answers with
 * the update page, so both waits pass at once. */
export const recordingUpdateGuard = (
  pages: string[] = [],
): { calls: string[]; io: UpdateGuardIo } => {
  const calls: string[] = [];
  return {
    calls,
    io: {
      clearFlag: async () => {
        calls.push("clear");
      },
      fetchPage: () => {
        calls.push("fetch");
        return Promise.resolve(
          pages[calls.filter((c) => c === "fetch").length - 1] ??
            updatePageMeta("active"),
        );
      },
      setFlag: async (value) => {
        calls.push(`set:${value}`);
      },
    },
  };
};
