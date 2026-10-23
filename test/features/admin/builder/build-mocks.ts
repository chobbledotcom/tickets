import { expect } from "@std/expect";
import { stub } from "@std/testing/mock";
import { builtSites } from "#db/built-sites.ts";
import { settings } from "#db/settings.ts";
import { builderApi } from "#shared/builder.ts";
import { expectFlash, expectRedirect } from "#test-utils/assertions.ts";
import { stubBuildSiteApis } from "#test-utils/builder-mocks.ts";
import { TEST_SCHEDULED_KEY } from "#test-utils/scheduled.ts";

/** Stub `testDbConnection` to resolve `ok: true`. */
export const stubDbOk = () =>
  stub(builderApi, "testDbConnection", () =>
    Promise.resolve({ ok: true as const }),
  );

/** Stub all Bunny + GitHub APIs for a successful build */
export const stubSuccessfulBuild = () => ({
  ...stubBuildSiteApis(),
  dbTestStub: stubDbOk(),
});

/** Assert a build redirected to /admin/builder with the "created successfully"
 *  flash, then return the single recorded built site for per-test checks. */
export const expectSiteCreated = async (response: Response) => {
  expectRedirect(response, "/admin/builder");
  expectFlash(response, expect.stringContaining("created successfully"));
  const sites = await builtSites.getAll();
  expect(sites).toHaveLength(1);
  return sites[0]!;
};

/** Stub `buildSite` to capture its input and return a success result. */
export const stubBuildAndCapture = () => {
  const capture: {
    currentTask: string | null;
    input: Parameters<typeof builderApi.buildSite>[0] | null;
    restore?: () => void;
  } = { currentTask: null, input: null };
  return {
    buildStub: stub(builderApi, "buildSite", async (input, retain) => {
      capture.currentTask = settings.currentTask;
      capture.input = input;
      const result = {
        dbProvider: "bunny" as const,
        dbToken: "tok",
        dbUrl: "libsql://test.io",
        defaultHostname: "https://test-42.b-cdn.net",
        hostingId: "42",
        hostingProvider: "bunny" as const,
        ok: true as const,
      };
      await retain({ ...result, scheduledTaskKey: TEST_SCHEDULED_KEY });
      return result;
    }),
    capture,
    dbTestStub: stub(builderApi, "testDbConnection", () =>
      Promise.resolve({ ok: true as const }),
    ),
  };
};
