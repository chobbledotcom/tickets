import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { applyAttendeeAtomicEdit } from "#db/attendees/atomic-update.ts";
import { execute, queryOne } from "#db/client.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { bookAttendee } from "#test-utils/db-helpers/attendee-payments.ts";
import { createDailyTestListing } from "#test-utils/db-helpers/listings.ts";
import {
  addLine,
  bookForEdit,
  bookOnNewListing,
  expectRejected,
  keepLine,
  twoListings,
} from "./helpers.ts";

const withDatabaseTrigger = async <Result>(
  name: string,
  sql: string,
  run: () => Promise<Result>,
): Promise<Result> => {
  await execute(sql);
  try {
    return await run();
  } finally {
    await execute(`DROP TRIGGER ${name}`);
  }
};

describeWithEnv("db > attendees > atomic edit guards", { db: true }, () => {
  test("uses empty date and zero relationship ids in a standard line key", async () => {
    const { listing, existing } = await bookOnNewListing(
      { maxAttendees: 10 },
      { name: "Key", quantity: 1 },
    );

    expect(existing[0]!.key).toBe(`${listing.id}||0|0`);
  });

  test("clears logistics state when quantity becomes zero", async () => {
    const { listing, attendee, blob, existing } = await bookOnNewListing(
      { maxAttendees: 10 },
      { name: "No quantity", quantity: 1 },
    );
    await execute(
      `UPDATE listing_attendees
          SET checked_in = 1, start_agent_id = 7, end_agent_id = 8,
              start_time = '09:00', end_time = '10:00',
              start_done = 1, end_done = 1
        WHERE attendee_id = ?`,
      [attendee.id],
    );

    const update = await applyAttendeeAtomicEdit(attendee.id, blob, [
      keepLine(listing.id, existing[0]!.key, { quantity: 0 }),
    ]);

    expect(update.success).toBe(true);
    expect(
      await queryOne(
        `SELECT quantity, checked_in, start_agent_id, end_agent_id,
                start_time, end_time, start_done, end_done
           FROM listing_attendees WHERE attendee_id = ?`,
        [attendee.id],
      ),
    ).toEqual({
      checked_in: 0,
      end_agent_id: null,
      end_done: 0,
      end_time: "",
      quantity: 0,
      start_agent_id: null,
      start_done: 0,
      start_time: "",
    });
  });

  test("checks capacity when only the duration changes", async () => {
    const listing = await createDailyTestListing({ maxAttendees: 1 });
    await bookAttendee(listing, { date: "2026-06-02", quantity: 1 });
    const { attendee, blob, existing } = await bookForEdit(listing, {
      date: "2026-06-01",
      durationDays: 1,
      name: "Duration",
      quantity: 1,
    });

    const update = await applyAttendeeAtomicEdit(attendee.id, blob, [
      keepLine(listing.id, existing[0]!.key, {
        date: "2026-06-01",
        durationDays: 2,
      }),
    ]);

    expectRejected(update, "capacity_exceeded", [listing.id]);
  });

  test("rejects an existing-line update that affects no row", async () => {
    const { listing, attendee, blob, existing } = await bookOnNewListing(
      { maxAttendees: 10 },
      { name: "Ignored update", quantity: 1 },
    );

    await expect(
      withDatabaseTrigger(
        "test_ignore_booking_update",
        `CREATE TRIGGER test_ignore_booking_update
           BEFORE UPDATE ON listing_attendees
           BEGIN SELECT RAISE(IGNORE); END`,
        () =>
          applyAttendeeAtomicEdit(attendee.id, blob, [
            keepLine(listing.id, existing[0]!.key, { quantity: 2 }),
          ]),
      ),
    ).rejects.toThrow();
  });

  test("rejects a new-line insert that affects no row", async () => {
    const { listing1, listing2 } = await twoListings();
    const { attendee, blob, existing } = await bookForEdit(listing1, {
      name: "Ignored insert",
      quantity: 1,
    });

    await expect(
      withDatabaseTrigger(
        "test_take_insert_capacity",
        `CREATE TRIGGER test_take_insert_capacity
           AFTER UPDATE ON attendees
           BEGIN
             UPDATE listings SET booked_quantity = max_attendees
              WHERE id = ${listing2.id};
           END`,
        () =>
          applyAttendeeAtomicEdit(attendee.id, blob, [
            keepLine(listing1.id, existing[0]!.key),
            addLine(listing2.id),
          ]),
      ),
    ).rejects.toThrow();
  });
});
