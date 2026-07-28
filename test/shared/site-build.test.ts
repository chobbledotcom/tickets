import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { builderApi } from "#shared/builder.ts";
import { setEncryptionKeyForTest } from "#shared/crypto/encryption.ts";
import { builtSites } from "#shared/db/built-sites.ts";
import { buildAssignableSite, buildRetainedSite } from "#shared/site-build.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  BUILT_SITE_RESULT,
  PREPARED_BUILT_SITE,
} from "#test-utils/db-helpers/built-sites.ts";
import { setupTestEncryptionKey, withEnv } from "#test-utils/env.ts";
import { TEST_SCHEDULED_KEY } from "#test-utils/scheduled.ts";

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
      await retain(PREPARED_BUILT_SITE);
      return BUILT_SITE_RESULT;
    });
    try {
      expect(
        await buildRetainedSite("Local Site", {
          code: "local bundle",
          siteName: "Local Site",
        }),
      ).toMatchObject({ result: BUILT_SITE_RESULT });
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
      await retain(PREPARED_BUILT_SITE);
      retainedAssignable = (await builtSites.getAll())[0]!.assignable;
      return BUILT_SITE_RESULT;
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
      Promise.resolve(BUILT_SITE_RESULT),
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
