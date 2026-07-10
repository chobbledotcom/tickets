import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { FakeTime } from "@std/testing/time";
import { getDb } from "#shared/db/client.ts";
import { maybeRunPrunes } from "#shared/db/prune.ts";
import { settings } from "#shared/db/settings.ts";
import {
  PRUNE_INTERVAL_MS,
  PRUNE_PAYMENTS_RETENTION_MS,
} from "#shared/limits.ts";
import { nowMs } from "#shared/now.ts";
import { describeWithEnv } from "#test-utils";
import {
  attendeeExists,
  clearAllLastPruned,
  expectFreshPrunedTimestampAfterRun,
  insertFinalizedPayment,
  insertOrphanAttendee,
  oldOrphanIso,
  paymentExists,
  setAllLastPruned,
} from "./prune-helpers.ts";

describeWithEnv("db > prune scheduler", { db: true }, () => {
  describe("orphan auto-purge scheduling", () => {
    test("maybeRunPrunes purges orphans when auto-purge is on", async () => {
      await settings.update.autoPurgeOrphans(true);
      await settings.update.orphanPurgeRetention("182");
      await clearAllLastPruned();
      const id = await insertOrphanAttendee(oldOrphanIso());

      await maybeRunPrunes();

      expect(await attendeeExists(id)).toBe(false);
      expect(settings.lastPrunedOrphans).not.toBe("");
    });

    test("maybeRunPrunes leaves orphans alone when auto-purge is off", async () => {
      await settings.update.autoPurgeOrphans(false);
      await clearAllLastPruned();
      const id = await insertOrphanAttendee(oldOrphanIso());

      await maybeRunPrunes();

      expect(await attendeeExists(id)).toBe(true);
      expect(settings.lastPrunedOrphans).toBe("");
    });
  });

  describe("maybeRunPrunes scheduler", () => {
    test("records fresh payments timestamp after running", async () => {
      await clearAllLastPruned();
      await expectFreshPrunedTimestampAfterRun(
        () => settings.lastPrunedPayments,
      );
    });

    test("records fresh sessions timestamp after running", async () => {
      await clearAllLastPruned();
      await expectFreshPrunedTimestampAfterRun(
        () => settings.lastPrunedSessions,
      );
    });

    test("records fresh sumup timestamp after running", async () => {
      await clearAllLastPruned();
      await expectFreshPrunedTimestampAfterRun(() => settings.lastPrunedSumup);
    });

    test("records fresh strings timestamp after running", async () => {
      await clearAllLastPruned();
      await expectFreshPrunedTimestampAfterRun(
        () => settings.lastPrunedStrings,
      );
    });

    test("records fresh logins timestamp after running", async () => {
      await clearAllLastPruned();
      await expectFreshPrunedTimestampAfterRun(() => settings.lastPrunedLogins);
    });

    test("records fresh tokens timestamp after running", async () => {
      await clearAllLastPruned();
      await expectFreshPrunedTimestampAfterRun(() => settings.lastPrunedTokens);
    });

    test("records fresh contacts timestamp after running", async () => {
      await clearAllLastPruned();
      await expectFreshPrunedTimestampAfterRun(
        () => settings.lastPrunedContacts,
      );
    });

    test("records fresh address-cache timestamp after running", async () => {
      await clearAllLastPruned();
      await expectFreshPrunedTimestampAfterRun(
        () => settings.lastPrunedAddresses,
      );
    });

    test("records fresh invites timestamp after running", async () => {
      await clearAllLastPruned();
      await expectFreshPrunedTimestampAfterRun(
        () => settings.lastPrunedInvites,
      );
    });

    test("skips tasks not yet due since last run", async () => {
      await setAllLastPruned(String(nowMs()));
      const old = new Date(
        nowMs() - PRUNE_PAYMENTS_RETENTION_MS - 60_000,
      ).toISOString();
      await insertFinalizedPayment("sess_skip", old);

      await maybeRunPrunes();

      expect(await paymentExists("sess_skip")).toBe(true);
    });

    test("runs tasks when last-run is older than the interval", async () => {
      const old = new Date(
        nowMs() - PRUNE_PAYMENTS_RETENTION_MS - 60_000,
      ).toISOString();
      await insertFinalizedPayment("sess_due", old);
      await setAllLastPruned(String(nowMs() - PRUNE_INTERVAL_MS - 60_000));

      await maybeRunPrunes();

      expect(await paymentExists("sess_due")).toBe(false);
    });

    test("one task's failure does not block the others", async () => {
      const old = new Date(
        nowMs() - PRUNE_PAYMENTS_RETENTION_MS - 60_000,
      ).toISOString();
      await insertFinalizedPayment("sess_isolation", old);
      await clearAllLastPruned();
      await getDb().execute("DROP TABLE sessions");

      await maybeRunPrunes();

      expect(await paymentExists("sess_isolation")).toBe(false);
    });

    test("treats an invalid last-pruned value as never-run", async () => {
      await settings.update.lastPrunedPayments("not-a-number");
      await expectFreshPrunedTimestampAfterRun(
        () => settings.lastPrunedPayments,
      );
    });

    test("concurrent calls leave the DB in a consistent state", async () => {
      const old = new Date(
        nowMs() - PRUNE_PAYMENTS_RETENTION_MS - 60_000,
      ).toISOString();
      await insertFinalizedPayment("sess_concurrent", old);
      await clearAllLastPruned();

      await Promise.all([maybeRunPrunes(), maybeRunPrunes(), maybeRunPrunes()]);

      expect(await paymentExists("sess_concurrent")).toBe(false);
    });
  });

  test("a task becomes due exactly PRUNE_INTERVAL_MS after its last run", async () => {
    const start = 1_700_000_000_000;
    using time = new FakeTime(start);
    await setAllLastPruned(String(start));
    const old = new Date(
      start - PRUNE_PAYMENTS_RETENTION_MS - 60_000,
    ).toISOString();
    await insertFinalizedPayment("sess_interval", old);

    time.tick(PRUNE_INTERVAL_MS - 1);
    await maybeRunPrunes();
    expect(await paymentExists("sess_interval")).toBe(true);

    time.tick(1);
    await maybeRunPrunes();
    expect(await paymentExists("sess_interval")).toBe(false);
  });
});
