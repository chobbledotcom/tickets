import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import {
  type BuildSiteResult,
  builderApi,
  type PreparedBuildSite,
} from "#shared/builder.ts";
import { builtSites } from "#shared/db/built-sites.ts";
import { buildAssignableSite } from "#shared/site-build.ts";
import { describeWithEnv } from "#test-utils/db.ts";
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
        scheduledTaskKeyNext: null,
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
