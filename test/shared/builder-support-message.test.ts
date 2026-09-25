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
          ["bunny", "42", getSupportPageText()],
        ]);
      });
    });

    test("seeds a Deno build with the same variable write", async () => {
      const savedNames: string[] = [];
      await withMocks(
        () => stubDenoBuilderApis(),
        async ({ setEnvStub, supportSeedStub }) => {
          const result = await buildSite({ hostingProvider: "deno" });
          expect(result.ok).toBe(true);
          expect(supportSeedStub.calls.map((c) => c.args)).toEqual([
            ["deno", "app_abc123", getSupportPageText()],
          ]);
          // The support message is no longer a secret copy on any provider.
          for (const call of setEnvStub.calls) {
            for (const [name] of call.args[1]) savedNames.push(name);
          }
        },
      );
      expect(savedNames).not.toContain("SUPPORT_PAGE_TEXT");
    });

    test("does not seed when the host has no support text", async () => {
      using _env = withEnv({ SUPPORT_PAGE_TEXT: undefined });
      await withBuildSiteMocks(async ({ supportSeedStub }) => {
        const result = await buildSite();
        expect(result.ok).toBe(true);
        expect(supportSeedStub.calls).toHaveLength(0);
      });
    });

    test("fails the build before any resource when the host text is too long", async () => {
      using _env = withEnv({
        SUPPORT_PAGE_TEXT: `# Big\n\n${"a".repeat(2100)}`,
      });
      await withBuildSiteMocks(async ({ createStub, supportSeedStub }) => {
        const result = await buildSite();
        expect(result).toEqual({
          error:
            "The support message is too long. A site can hold at most about 2,000 characters.",
          ok: false,
        });
        expect(createStub.calls).toHaveLength(0);
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
  },
);
