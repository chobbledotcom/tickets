import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { bunnyHostingProvider } from "#shared/bunny-cdn.ts";
import {
  ensureBuiltSiteSchedulerNextKey,
  readBuiltSiteScheduler,
} from "#shared/db/built-site-scheduler.ts";
import { queryAll } from "#shared/db/client.ts";
import { expectFlash } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { stubFetch } from "#test-utils/fetch-stub.ts";
import { restoreStubsAfterEach } from "#test-utils/mocks.ts";
import {
  insertScheduledTestSite,
  SCHEDULED_OWNER_ENV,
  stubBunnySchedulerSecrets,
} from "#test-utils/scheduled.ts";
import { adminFormPost } from "#test-utils/session.ts";

describeWithEnv(
  "built-site scheduler actions",
  { db: true, env: SCHEDULED_OWNER_ENV },
  () => {
    const stubs: { restore(): void }[] = [];
    restoreStubsAfterEach(stubs);

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
