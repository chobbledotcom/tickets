import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { ensureBuiltSiteSchedulerNextKey } from "#shared/db/built-site-scheduler.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  insertScheduledTestSite,
  SCHEDULED_OWNER_ENV,
  TEST_SCHEDULED_KEY,
} from "#test-utils/scheduled.ts";
import { adminGet } from "#test-utils/session.ts";

describeWithEnv(
  "built-site maintenance page",
  { db: true, env: SCHEDULED_OWNER_ENV },
  () => {
    test("shows the active and pending child keys", async () => {
      const site = await insertScheduledTestSite();
      const { pending } = await ensureBuiltSiteSchedulerNextKey(site.id);

      const response = await adminGet(
        `/admin/built-sites/${site.id}/maintenance`,
      );
      const html = await response.text();

      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(html).toContain(TEST_SCHEDULED_KEY);
      expect(html).toContain(pending!);
    });

    test("offers setup when a child has no retained key", async () => {
      const site = await insertScheduledTestSite(null);

      const response = await adminGet(
        `/admin/built-sites/${site.id}/maintenance`,
      );

      expect(await response.text()).toContain("provision-scheduler");
    });

    test("offers rotation when a child has only an active key", async () => {
      const site = await insertScheduledTestSite();

      const response = await adminGet(
        `/admin/built-sites/${site.id}/maintenance`,
      );

      expect(await response.text()).toContain("stage-scheduler");
    });
  },
);
