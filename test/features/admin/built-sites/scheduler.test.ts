import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { builtSitesCrudTable } from "#shared/db/built-sites.ts";
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

      expectFlash(response, "Scheduled maintenance key set up.");
      expect(
        (await builtSitesCrudTable.findById(site.id))?.scheduledTaskKey?.length,
      ).toBe(43);
    });

    test("keeps the generated key for retry after a provider failure", async () => {
      const site = await insertScheduledTestSite(null);
      stubBunnySchedulerSecrets(stubs, [], {
        error: "provider failed",
        ok: false,
      });

      const { response } = await adminFormPost(
        `/admin/built-sites/${site.id}/provision-scheduler`,
      );

      expectFlash(response, "provider failed", false);
      expect(
        (await builtSitesCrudTable.findById(site.id))?.scheduledTaskKey?.length,
      ).toBe(43);
    });
  },
);
