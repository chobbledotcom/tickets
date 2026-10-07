import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { executeWithoutCacheInvalidation } from "#db/client.ts";
import { settings } from "#db/settings.ts";
import { handleRequest } from "#routes";
import { handleRobotsTxt } from "#routes/robots-txt.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { mockRequest } from "#test-utils/mocks.ts";

describeWithEnv(
  "server public > robots.txt settings failures",
  { db: true, triggers: true },
  () => {
    test("rethrows a settings failure that is not a missing table", async () => {
      // Only the missing-table case is the pre-setup state. Anything else is
      // a real failure and stays loud.
      using _stub = stub(settings, "loadKeys", () =>
        Promise.reject(new Error("database unreachable")),
      );
      await expect(handleRobotsTxt()).rejects.toThrow("database unreachable");
    });

    test("answers the default body when the settings table is missing", async () => {
      // A site before setup has no settings table: the public site feature
      // cannot be on, so robots.txt answers the default text instead of an
      // error.
      await executeWithoutCacheInvalidation("DROP TABLE settings", []);
      const response = await handleRequest(mockRequest("/robots.txt"));
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(
        "User-agent: *\nAllow: /listings/\nDisallow: /\n",
      );
    });
  },
);
