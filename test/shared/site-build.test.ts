import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { setEncryptionKeyForTest } from "#crypto/encryption.ts";
import { builtSites, builtSitesCrudTable } from "#db/built-sites.ts";
import {
  type BuildSiteResult,
  builderApi,
  type PreparedBuildSite,
} from "#shared/builder.ts";
import { buildRetainedSite } from "#shared/site-build.ts";
import { withBuildSiteMocks } from "#test-utils/builder-mocks.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { withEnv } from "#test-utils/env.ts";
import { TEST_SCHEDULED_KEY } from "#test-utils/scheduled.ts";

const BUILD_RESULT = {
  dbProvider: "bunny",
  dbToken: "database-token",
  dbUrl: "libsql://built-site.test",
  defaultHostname: "00001.example.test",
  hostingId: "123",
  hostingProvider: "bunny",
  ok: true,
} satisfies BuildSiteResult;

const PREPARED_SITE = {
  ...BUILD_RESULT,
  scheduledTaskKey: TEST_SCHEDULED_KEY,
} satisfies PreparedBuildSite;

describeWithEnv("site build", { db: true }, () => {
  test("checks builder storage before provider provisioning", async () => {
    const buildStub = stub(builderApi, "buildSite", () =>
      Promise.resolve({ error: "provider should not start", ok: false }),
    );
    setEncryptionKeyForTest(null);
    using _env = withEnv({ DB_ENCRYPTION_KEY: undefined });
    try {
      await expect(
        buildRetainedSite("Unchecked Site", { siteName: "Unchecked Site" }),
      ).rejects.toThrow("DB_ENCRYPTION_KEY environment variable is required");
      expect(buildStub.calls).toHaveLength(0);
    } finally {
      buildStub.restore();
    }
  });

  test("retains a local bundle before reporting success", async () => {
    let retainedIdSeenByBuild: number | null = null;
    const buildStub = stub(builderApi, "buildSite", async (input, retain) => {
      await retain(PREPARED_SITE);
      retainedIdSeenByBuild = (await builtSites.getAll())[0]!.id;
      return { ...BUILD_RESULT, ...input };
    });
    try {
      const built = await buildRetainedSite("Local Site", {
        code: "local bundle",
        siteName: "Local Site",
      });

      expect(retainedIdSeenByBuild).toBe(built.retainedId);
      expect((await builtSites.getAll())[0]).toMatchObject({
        assignable: false,
        name: "Local Site",
        scheduledTaskKey: TEST_SCHEDULED_KEY,
      });
    } finally {
      buildStub.restore();
    }
  });

  test("rejects a builder success that was not retained", async () => {
    const buildStub = stub(builderApi, "buildSite", () =>
      Promise.resolve(BUILD_RESULT),
    );
    try {
      await expect(
        buildRetainedSite("Vanished Site", { siteName: "Vanished Site" }),
      ).rejects.toThrow("Built site was not retained");
    } finally {
      buildStub.restore();
    }
  });

  test("reports a failed build without retaining anything", async () => {
    const buildStub = stub(builderApi, "buildSite", () =>
      Promise.resolve({ error: "provider failed", ok: false as const }),
    );
    try {
      const built = await buildRetainedSite("Failed Site", {
        siteName: "Failed Site",
      });

      expect(built.result).toEqual({ error: "provider failed", ok: false });
      expect(built.retainedId).toBe(0);
      expect(await builtSites.getAll()).toHaveLength(0);
    } finally {
      buildStub.restore();
    }
  });

  test("removes the retained row when publishing fails", async () => {
    await withBuildSiteMocks(
      async () => {
        const { result } = await buildRetainedSite("Failed Site", {
          siteName: "Failed Site",
        });
        expect(result.ok).toBe(false);
        expect(await builtSites.getAll()).toEqual([]);
      },
      { publishResult: { error: "publish refused", ok: false } },
    );
  });

  test("removes the retained row when the support-message seed fails", async () => {
    using _support = withEnv({ SUPPORT_PAGE_TEXT: "# Seed" });
    await withBuildSiteMocks(
      async () => {
        const { result } = await buildRetainedSite("Failed Site", {
          siteName: "Failed Site",
        });
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error).toContain("seed refused");
        expect(await builtSites.getAll()).toEqual([]);
      },
      { supportSeedResult: { error: "seed refused", ok: false } },
    );
  });

  test("keeps the build failure first when the record cannot be deleted", async () => {
    // A delete that cannot run appends its own failure to the answer; the
    // provider error stays the first cause the caller reports.
    await withBuildSiteMocks(
      async () => {
        using _delete = stub(builtSitesCrudTable, "deleteById", () =>
          Promise.reject(new Error("delete boom")),
        );
        const { result } = await buildRetainedSite("Failed Site", {
          siteName: "Failed Site",
        });
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error).toBe(
          "publish refused; the retained record could not be deleted: delete boom",
        );
      },
      { publishResult: { error: "publish refused", ok: false } },
    );
  });
});
