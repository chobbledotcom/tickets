import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { uptimeKumaMonitorService } from "#shared/uptime-kuma/monitors.ts";
import { expectFlash } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { restoreStubsAfterEach } from "#test-utils/mocks.ts";
import {
  insertScheduledTestSite,
  SCHEDULED_OWNER_ENV,
} from "#test-utils/scheduled.ts";
import { adminFormPost } from "#test-utils/session.ts";

describeWithEnv(
  "built-site Uptime Kuma action",
  { db: true, env: SCHEDULED_OWNER_ENV },
  () => {
    const stubs: { restore(): void }[] = [];
    restoreStubsAfterEach(stubs);

    test("adds a missing monitor", async () => {
      const site = await insertScheduledTestSite();
      stubs.push(
        stub(uptimeKumaMonitorService, "add", (selected) => {
          expect(selected.id).toBe(site.id);
          return Promise.resolve({
            ok: true,
            value: { created: true, monitorId: 81 },
          });
        }),
      );

      const { response } = await adminFormPost(
        `/admin/built-sites/${site.id}/add-uptime-monitor`,
      );

      expectFlash(response, "Uptime Kuma monitor added.");
      const location = response.headers.get("location");
      expect(location).not.toBeNull();
      if (location === null) throw new Error("Redirect location is missing");
      expect(new URL(location, "https://example.test").pathname).toBe(
        `/admin/built-sites/${site.id}/maintenance`,
      );
    });

    test("reports an existing monitor without adding another", async () => {
      const site = await insertScheduledTestSite();
      stubs.push(
        stub(uptimeKumaMonitorService, "add", () =>
          Promise.resolve({
            ok: true,
            value: { created: false, monitorId: 81 },
          }),
        ),
      );

      const { response } = await adminFormPost(
        `/admin/built-sites/${site.id}/add-uptime-monitor`,
      );

      expectFlash(response, "The Uptime Kuma monitor already exists.");
    });

    test("shows provider failures", async () => {
      const site = await insertScheduledTestSite();
      stubs.push(
        stub(uptimeKumaMonitorService, "add", () =>
          Promise.resolve({ error: "Kuma is unavailable", ok: false }),
        ),
      );

      const { response } = await adminFormPost(
        `/admin/built-sites/${site.id}/add-uptime-monitor`,
      );

      expectFlash(response, "Kuma is unavailable", false);
    });
  },
);
