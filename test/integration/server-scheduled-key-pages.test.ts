import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { handleRequest } from "#routes";
import { bunnyHostingProvider } from "#shared/bunny-cdn.ts";
import {
  ensureBuiltSiteSchedulerNextKey,
  readBuiltSiteScheduler,
} from "#shared/db/built-site-scheduler.ts";
import { queryAll } from "#shared/db/client.ts";
import { expectFlash } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { stubFetch } from "#test-utils/fetch-stub.ts";
import { mockRequest, restoreStubsAfterEach } from "#test-utils/mocks.ts";
import {
  insertScheduledTestSite,
  stubBunnySchedulerSecrets,
  TEST_SCHEDULED_KEY,
} from "#test-utils/scheduled.ts";
import {
  adminFormPost,
  adminGet,
  createTestManagerSession,
} from "#test-utils/session.ts";

describeWithEnv(
  "scheduled key owner pages",
  {
    db: true,
    env: {
      BUNNY_API_KEY: "test-key",
      CAN_BUILD_SITES: "true",
      SCHEDULED_TASK_KEY: TEST_SCHEDULED_KEY,
    },
  },
  () => {
    const stubs: { restore(): void }[] = [];
    restoreStubsAfterEach(stubs);

    test("shows the local active key only on the owner advanced page", async () => {
      const response = await adminGet("/admin/settings-advanced");

      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(await response.text()).toContain(TEST_SCHEDULED_KEY);
    });

    test("does not show the local key to a manager", async () => {
      const managerCookie = await createTestManagerSession();
      const response = await handleRequest(
        mockRequest("/admin/settings-advanced", {
          headers: { cookie: managerCookie },
        }),
      );

      expect(response.status).toBe(403);
      expect(await response.text()).not.toContain(TEST_SCHEDULED_KEY);
    });

    test("shows encrypted active and pending child values on the builder tab", async () => {
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

    test("provisions and verifies a child key", async () => {
      const site = await insertScheduledTestSite(null);
      stubBunnySchedulerSecrets(stubs, [], { ok: true });
      using _fetch = stubFetch(new Response(null, { status: 204 }));

      const { response } = await adminFormPost(
        `/admin/built-sites/${site.id}/provision-scheduler`,
      );

      expectFlash(response, "Scheduled maintenance key set up.");
      expect((await readBuiltSiteScheduler(site.id)).active?.length).toBe(43);
    });

    test("promotes a pending child key", async () => {
      const site = await insertScheduledTestSite();
      const { pending } = await ensureBuiltSiteSchedulerNextKey(site.id);
      stubs.push(
        stub(bunnyHostingProvider, "promoteSecrets", () =>
          Promise.resolve({ ok: true }),
        ),
      );

      const { response } = await adminFormPost(
        `/admin/built-sites/${site.id}/promote-scheduler`,
      );

      expectFlash(response, "Next scheduled maintenance key promoted.");
      expect(await readBuiltSiteScheduler(site.id)).toMatchObject({
        active: pending,
        pending: null,
      });
    });

    test("shows a provider failure without leaking the pending key", async () => {
      const site = await insertScheduledTestSite();
      stubBunnySchedulerSecrets(stubs, ["SCHEDULED_TASK_KEY"], {
        error: "provider failed",
        ok: false,
      });

      const { response } = await adminFormPost(
        `/admin/built-sites/${site.id}/stage-scheduler`,
      );

      expectFlash(response, "provider failed", false);
    });

    test("keeps a staged key out of redirects, flashes, and activity rows", async () => {
      const site = await insertScheduledTestSite();
      stubBunnySchedulerSecrets(stubs, ["SCHEDULED_TASK_KEY"], { ok: true });
      using _fetch = stubFetch(new Response(null, { status: 204 }));

      const { response } = await adminFormPost(
        `/admin/built-sites/${site.id}/stage-scheduler`,
      );
      const pending = (await readBuiltSiteScheduler(site.id)).pending!;
      const wire = JSON.stringify({
        body: await response.text(),
        headers: [...response.headers],
        url: response.url,
      });
      const activity = await queryAll<{ message: string }>(
        "SELECT message FROM activity_log",
      );

      expect(response.status).toBe(302);
      expect(wire).not.toContain(pending);
      expect(JSON.stringify(activity)).not.toContain(pending);
    });
  },
);
