import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { executeWithoutCacheInvalidation } from "#db/client.ts";
import { handleRequest } from "#routes";
import { describeWithEnv } from "#test-utils/db.ts";
import { mockRequest } from "#test-utils/mocks.ts";

describeWithEnv(
  "server public > robots.txt before setup",
  { db: true, triggers: true },
  () => {
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
