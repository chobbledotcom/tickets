import { afterEach, beforeEach } from "@std/testing/bdd";
import { type Stub, stub } from "@std/testing/mock";
import { bunnyCdnApi } from "#shared/bunny-cdn.ts";
import {
  type UpdateGuardIo,
  updateBuildTagMeta,
  updatePageMeta,
} from "#shared/update-guard.ts";
import { type EnvScope, withEnv } from "#test-utils/env.ts";
import { stubFetch } from "#test-utils/fetch-stub.ts";
import { type TempPath, tempDir } from "#test-utils/files.ts";
import { MOCK_RELEASE } from "#test-utils/mocks.ts";

/** The stubbed update page: active, and naming the build the stubs deploy
 * (MOCK_RELEASE's tag_name, which the deploy stubs return, so guarded waits
 * pass against it). */
export const ACTIVE_UPDATE_PAGE = `${updatePageMeta("active")}${updateBuildTagMeta(MOCK_RELEASE.tag_name)}`;

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
      return new Response(ACTIVE_UPDATE_PAGE);
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

/** A wait clock the update-wait tests step forward on every sleep, so a
 * timed-out wait needs no real delay. */
export const fakeClock = (): {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
} => {
  let time = 0;
  return {
    now: () => time,
    sleep: async (ms) => {
      time += ms;
    },
  };
};

/** The body of a /read-only page serving `state`, naming `buildTag` when
 * the caller pins one. */
export const page = (
  state: "unsupported" | "supported" | "active",
  buildTag?: string,
): string => {
  if (state === "unsupported") return "<html><head></head></html>";
  const tag = buildTag === undefined ? "" : updateBuildTagMeta(buildTag);
  return `<html><head>${updatePageMeta(state)}${tag}</head></html>`;
};

/** An update guard io that records every call in `calls`, in order. The page
 * fetch serves `pages` one by one. After the list runs out, it answers with
 * the active update page, so both waits pass at once. `overrides` stands in
 * io options such as a fake clock for tests that run a wait to its
 * deadline. */
export const recordingUpdateGuard = (
  pages: string[] = [],
  overrides: Partial<UpdateGuardIo> = {},
): { calls: string[]; io: UpdateGuardIo } => {
  const calls: string[] = [];
  return {
    calls,
    io: {
      ...overrides,
      clearFlag: async () => {
        calls.push("clear");
      },
      fetchPage: () => {
        calls.push("fetch");
        return Promise.resolve(
          pages[calls.filter((c) => c === "fetch").length - 1] ??
            ACTIVE_UPDATE_PAGE,
        );
      },
      setFlag: async (value) => {
        calls.push(`set:${value}`);
      },
    },
  };
};
