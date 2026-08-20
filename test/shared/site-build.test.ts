import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { setEncryptionKeyForTest } from "#crypto/encryption.ts";
import { builtSites } from "#db/built-sites.ts";
import {
  type BuildSiteResult,
  builderApi,
  type PreparedBuildSite,
} from "#shared/builder.ts";
import { buildAssignableSite, buildRetainedSite } from "#shared/site-build.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { setupTestEncryptionKey, withEnv } from "#test-utils/env.ts";
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
      setupTestEncryptionKey();
      buildStub.restore();
    }
  });

  test("retains a local bundle before reporting success", async () => {
    const buildStub = stub(builderApi, "buildSite", async (input, retain) => {
      expect(input).toEqual({ code: "local bundle", siteName: "Local Site" });
      await retain(PREPARED_SITE);
      return BUILD_RESULT;
    });
    try {
      expect(
        await buildRetainedSite("Local Site", {
          code: "local bundle",
          siteName: "Local Site",
        }),
      ).toMatchObject({ result: BUILD_RESULT });
      expect(await builtSites.getAll()).toMatchObject([
        {
          name: "Local Site",
          scheduledTaskKey: TEST_SCHEDULED_KEY,
        },
      ]);
    } finally {
      buildStub.restore();
    }
  });

  test("retains the scheduled key before making the site assignable", async () => {
    let requestedName = "";
    let retainedAssignable: boolean | undefined;
    const buildStub = stub(builderApi, "buildSite", async (input, retain) => {
      requestedName = input.siteName;
      await retain(PREPARED_SITE);
      retainedAssignable = (await builtSites.getAll())[0]!.assignable;
      return BUILD_RESULT;
    });
    try {
      const site = await buildAssignableSite();

      expect(requestedName).toBe("00001");
      expect(retainedAssignable).toBe(false);
      expect(site).toMatchObject({
        assignable: true,
        name: "00001",
        scheduledTaskKey: TEST_SCHEDULED_KEY,
      });
    } finally {
      buildStub.restore();
    }
  });

  test("returns null when the builder fails", async () => {
    const buildStub = stub(builderApi, "buildSite", () =>
      Promise.resolve({ error: "provider failed", ok: false }),
    );
    const errorStub = stub(console, "error");
    try {
      expect(await buildAssignableSite()).toBeNull();
    } finally {
      errorStub.restore();
      buildStub.restore();
    }
  });

  test("rejects a builder success that was not retained", async () => {
    const buildStub = stub(builderApi, "buildSite", () =>
      Promise.resolve(BUILD_RESULT),
    );
    try {
      await expect(buildAssignableSite()).rejects.toThrow(
        "Built site was not retained",
      );
    } finally {
      buildStub.restore();
    }
  });
});
