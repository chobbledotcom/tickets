import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { countAttendeesWithPendingFlags } from "#db/attendees/notification-flags.ts";
import { execute } from "#db/client.ts";
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

  test("reads the trimmed field tokens the parser reads", async () => {
    const padded = await bookTestAttendeeWithFlags("Padded Fields Buyer", 1, 0);
    await execute("UPDATE listings SET fields = 'phone, email' WHERE id = ?", [
      padded.listing.id,
    ]);
    expect(await countAttendeesWithPendingFlags()).toBe(1);

    const lookalike = await bookTestAttendeeWithFlags(
      "Lookalike Fields Buyer",
      1,
      0,
    );
    await execute("UPDATE listings SET fields = 'emailx' WHERE id = ?", [
      lookalike.listing.id,
    ]);
    // The lookalike listing never collects an email, so only the padded one
    // still counts.
    expect(await countAttendeesWithPendingFlags()).toBe(1);

    const spaced = await bookTestAttendeeWithFlags("Spaced Buyer", 1, 0);
    await execute("UPDATE listings SET fields = 'e mail' WHERE id = ?", [
      spaced.listing.id,
    ]);
    // An inner space is part of the token: the parser reads no email field
    // here, so the count must not fold 'e mail' into 'email' and stays at
    // the padded buyer's one.
    expect(await countAttendeesWithPendingFlags()).toBe(1);
  });
});
