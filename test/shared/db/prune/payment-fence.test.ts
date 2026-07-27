import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { runDatabasePruning } from "#shared/db/prune.ts";
import { settings } from "#shared/db/settings.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  createPausedAttendeePayment,
  expectAttendeePaymentFence,
} from "#test-utils/payment-aggregate.ts";
import {
  attendeeExists,
  insertOrphanAttendee,
  oldOrphanIso,
} from "./helpers.ts";

describeWithEnv("orphan pruning payment fence", { db: true }, () => {
  test("detaches orphan payments and rejects a stale claim", async () => {
    await settings.update.autoPurgeOrphans(true);
    await settings.update.orphanPurgeRetention("182");
    const attendeeId = await insertOrphanAttendee(oldOrphanIso());
    const payment = await createPausedAttendeePayment(
      "prune-attendee-payment",
      attendeeId,
    );

    await runDatabasePruning();

    await expectAttendeePaymentFence(payment, attendeeId, null);
    expect(await attendeeExists(attendeeId)).toBe(false);
  });
});
