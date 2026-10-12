import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { countAttendeesWithPendingFlags } from "#db/attendees/notification-flags.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { bookTestAttendeeWithFlags } from "#test-utils/db-helpers/attendees.ts";

describeWithEnv("the pending-notification count", { db: true }, () => {
  test("counts zero when no attendee owes a send", async () => {
    // A database with attendees but nothing pending: the count reads a row
    // whose aggregate is 0, so no row-fallback is involved.
    await bookTestAttendeeWithFlags("Settled Buyer", 0, 0);
    expect(await countAttendeesWithPendingFlags()).toBe(0);
  });

  test("counts each attendee that owes a send once", async () => {
    await bookTestAttendeeWithFlags("Owed Email", 1, 0);
    await bookTestAttendeeWithFlags("Owed Webhooks", 0, 1);
    await bookTestAttendeeWithFlags("Owed Both", 2, 2);
    expect(await countAttendeesWithPendingFlags()).toBe(3);
  });
});
