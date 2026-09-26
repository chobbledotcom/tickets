import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { withMessageGroups } from "#i18n";
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
    Promise.resolve(0),
  );

describeWithEnv(
  "buildSite support message seed",
  {
    // The build deletes the retained row itself when a later step fails, so
    // the seed-failure path runs against a test database.
    db: true,
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

    // 1,025 two-byte characters hold 2,050 bytes: past the byte limit while
    // looking like half of it in characters.
    const tooLongHostTexts = ["a".repeat(2100), "é".repeat(1025)];

    for (const hostText of tooLongHostTexts) {
      test("fails the build before any resource when the host text is too long", async () => {
        using _env = withEnv({ SUPPORT_PAGE_TEXT: hostText });
        await withBuildSiteMocks(
          async ({ createDbStub, createStub, supportSeedStub }) => {
            // No dbUrl or dbToken: the build would auto-provision the
            // database before it reaches the hosting provider.
            const result = await builderApi.buildSite(
              { siteName: "Test" },
              () => Promise.resolve(0),
            );
            expect(result).toEqual({
              error:
                "The support message is too long. A site holds at most 2,048 bytes of text.",
              ok: false,
            });
            expect(createDbStub.calls).toHaveLength(0);
            expect(createStub.calls).toHaveLength(0);
            expect(supportSeedStub.calls).toHaveLength(0);
          },
        );
      });
    }
    test("reports the too-long copy inside a public route's message groups", async () => {
      using _env = withEnv({
        SUPPORT_PAGE_TEXT: `# Big\n\n${"a".repeat(2100)}`,
      });
      await withBuildSiteMocks(async () => {
        // A site-plan purchase auto-builds its site inside the booking
        // request's pending work, where only the public message groups are
        // visible: the builder must still answer the too-long refusal
        // instead of throwing a missing-translation error.
        const result = await withMessageGroups(["order"], () =>
          builderApi.buildSite({ siteName: "Test" }, () => Promise.resolve(0)),
        );
        expect(result).toEqual({
          error:
            "The support message is too long. A site holds at most 2,048 bytes of text.",
          ok: false,
        });
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
