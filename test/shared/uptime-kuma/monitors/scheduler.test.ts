import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { uptimeKumaMonitorService } from "#shared/uptime-kuma/monitors.ts";
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
    test("shows every built-site tab with its exact label and URL", async () => {
      const site = await insertScheduledTestSite();

      const response = await adminGet(`/admin/built-sites/${site.id}`);
      const html = await response.text();

      expect(response.status).toBe(200);
      expect(html).toContain(
        `<a class="active" href="/admin/built-sites">Builds</a>`,
      );
      expect(html).toContain(
        `href="/admin/built-sites/${site.id}/renewal">Renewal</a>`,
      );
      expect(html).toContain(
        `href="/admin/built-sites/${site.id}/maintenance">Scheduled maintenance</a>`,
      );
      expect(html).toContain(
        `href="/admin/built-sites/${site.id}/secrets">Secrets</a>`,
      );
      expect(html).toContain(
        `href="/admin/built-sites/${site.id}/update">Software update</a>`,
      );
    });

    test("shows the exact delete action on the actions tab", async () => {
      const site = await insertScheduledTestSite();

      const response = await adminGet(`/admin/built-sites/${site.id}/actions`);
      const html = await response.text();

      expect(response.status).toBe(200);
      expect(html).toContain(`href="/admin/built-sites/${site.id}/delete"`);
      expect(html).toContain("Delete this site");
    });

    test("shows the child key without rotation controls", async () => {
      const site = await insertScheduledTestSite();

      const response = await adminGet(
        `/admin/built-sites/${site.id}/maintenance`,
      );
      const html = await response.text();

      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(html).toContain(TEST_SCHEDULED_KEY);
      expect(html).not.toContain("stage-scheduler");
      expect(html).not.toContain("promote-scheduler");
    });

    test("offers setup when a child has no retained key", async () => {
      const site = await insertScheduledTestSite(null);

      const response = await adminGet(
        `/admin/built-sites/${site.id}/maintenance`,
      );

      expect(await response.text()).toContain("provision-scheduler");
    });

    test("shows monitor details returned by Uptime Kuma", async () => {
      const site = await insertScheduledTestSite();
      using _load = stub(uptimeKumaMonitorService, "load", () =>
        Promise.resolve({
          kind: "found",
          monitor: {
            active: true,
            group: "Chobble Tickets",
            id: 51,
            intervalSeconds: 900,
            method: "POST",
            name: "Live child monitor",
            url: "https://child.example.test/scheduled",
          },
        }),
      );

      const response = await adminGet(
        `/admin/built-sites/${site.id}/maintenance`,
      );
      const html = await response.text();

      expect(response.status).toBe(200);
      expect(html).toContain("Live child monitor");
      expect(html).toContain("Every 15 minutes");
      expect(html).not.toContain("add-uptime-monitor");
    });
  },
);
