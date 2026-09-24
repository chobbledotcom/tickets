import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { builderApi } from "#shared/builder.ts";
import { getSupportPageText } from "#shared/support.ts";
import {
  stubBuildSiteApis,
  stubDenoBuilderApis,
  withBuildSiteMocks,
} from "#test-utils/builder-mocks.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { withEnv } from "#test-utils/env.ts";
import { withMocks } from "#test-utils/mocks.ts";

const BUILD_INPUT = {
  dbToken: "token123",
  dbUrl: "libsql://test.turso.io",
  siteName: "Test",
} as const;

const buildSite = (
  overrides: Partial<Parameters<typeof builderApi.buildSite>[0]> = {},
) =>
  builderApi.buildSite({ ...BUILD_INPUT, ...overrides }, () =>
    Promise.resolve(),
  );

describeWithEnv(
  "buildSite support message seed",
  {
    env: {
      DENO_DEPLOY_ORG_SLUG: "test-org",
      SUPPORT_PAGE_TEXT: "# Help\\n\\nAsk us anything",
    },
  },
  () => {
    test("seeds a Bunny build with the host's support text as a variable", async () => {
      await withBuildSiteMocks(async ({ supportSeedStub }) => {
        const result = await buildSite();
        expect(result.ok).toBe(true);
        expect(supportSeedStub.calls.map((c) => c.args)).toEqual([
          ["42", getSupportPageText()],
        ]);
      });
    });

    test("does not seed when the host has no support text", async () => {
      using _env = withEnv({ SUPPORT_PAGE_TEXT: undefined });
      await withBuildSiteMocks(async ({ supportSeedStub }) => {
        const result = await buildSite();
        expect(result.ok).toBe(true);
        expect(supportSeedStub.calls).toHaveLength(0);
      });
    });

    test("fails the build when the variable write is refused", async () => {
      await withMocks(
        () =>
          stubBuildSiteApis({
            supportSeedResult: {
              error: "Set support message failed (400): no",
              ok: false,
            },
          }),
        async () => {
          const result = await buildSite();
          expect(result.ok).toBe(false);
          if (!result.ok) {
            expect(result.error).toContain("Set support message");
          }
        },
      );
    });

    test("still copies the support text as an env secret for Deno builds", async () => {
      // The seed is Bunny-only, so the Deno build keeps the plain copy.
      const savedNames: string[] = [];
      await withMocks(
        () => stubDenoBuilderApis(),
        async ({ setEnvStub }) => {
          await buildSite({ hostingProvider: "deno" });
          for (const call of setEnvStub.calls) {
            for (const [name] of call.args[1]) savedNames.push(name);
          }
        },
      );
      expect(savedNames).toContain("SUPPORT_PAGE_TEXT");
    });
  },
);
