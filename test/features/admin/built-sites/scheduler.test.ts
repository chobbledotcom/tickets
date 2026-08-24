import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { builtSitesCrudTable } from "#db/built-sites.ts";
import { bunnyHostingProvider } from "#shared/bunny-cdn.ts";
import { isScheduledTaskKey } from "#shared/scheduled-keys.ts";
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
  "built-site scheduler action",
  { db: true, env: SCHEDULED_OWNER_ENV },
  () => {
    const stubs: { restore(): void }[] = [];
    restoreStubsAfterEach(stubs);

    test("provisions and verifies one child key", async () => {
      const site = await insertScheduledTestSite(null);
      stubBunnySchedulerSecrets(stubs, [], { ok: true });
      using _fetch = stubFetch(new Response(null, { status: 204 }));

      const { response } = await adminFormPost(
        `/admin/built-sites/${site.id}/provision-scheduler`,
      );

      expectFlash(response, "Scheduled maintenance key sent to the site.");
      const key = (await builtSitesCrudTable.read.one({ id: site.id }))
        ?.scheduledTaskKey;
      expect(isScheduledTaskKey(key ?? "")).toBe(true);
    });

    test("retries a failed provider write with the retained key", async () => {
      const site = await insertScheduledTestSite(null);
      const pushed: string[] = [];
      stubs.push(
        stub(bunnyHostingProvider, "getSecretNames", () =>
          Promise.resolve({ ok: true, value: [] }),
        ),
        stub(bunnyHostingProvider, "setSecrets", (_hostingId, secrets) => {
          pushed.push(secrets[0]![1]);
          return Promise.resolve(
            pushed.length === 1
              ? { error: "provider failed", ok: false as const }
              : { ok: true as const, value: undefined },
          );
        }),
      );
      using _fetch = stubFetch(new Response(null, { status: 204 }));

      const { response: failed } = await adminFormPost(
        `/admin/built-sites/${site.id}/provision-scheduler`,
      );
      expectFlash(failed, "provider failed", false);
      const retained = (await builtSitesCrudTable.read.one({ id: site.id }))
        ?.scheduledTaskKey;

      const { response: retried } = await adminFormPost(
        `/admin/built-sites/${site.id}/provision-scheduler`,
      );

      expectFlash(retried, "Scheduled maintenance key sent to the site.");
      expect(pushed).toEqual([retained, retained]);
    });
  },
);
