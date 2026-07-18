import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  buildCapacityCheckedInsert,
  checkLinesCapacity,
} from "#shared/db/attendees/capacity/checks.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";

import "../../../../lib/db/attendees/availability-consistency.test.ts";
import "../../../../lib/db/attendees/check-batch-availability.test.ts";
import "../../../../lib/db/attendees/has-available-spots.test.ts";

test("buildCapacityCheckedInsert keeps every booking default and its guard", () => {
  const statement = buildCapacityCheckedInsert({
    date: "2030-01-01",
    listingId: 7,
  });

  expect(statement.args.slice(0, 7)).toEqual([
    7,
    "2030-01-01T00:00:00Z",
    "2030-01-02T00:00:00.000Z",
    1,
    "",
    0,
    0,
  ]);
  expect(statement.sql).toContain(
    "SELECT ?, last_insert_rowid(), ?, ?, ?, ?, ?, ?",
  );
  expect(statement.sql).toContain("WHERE");
});

test("buildCapacityCheckedInsert binds an explicit attendee and overbook fields", () => {
  const statement = buildCapacityCheckedInsert(
    {
      listingId: 7,
      orderToken: "order",
      packageGroupId: 13,
      parentListingId: 11,
      quantity: 2,
    },
    "?",
    17,
    true,
  );

  expect(statement.args).toEqual([7, 17, null, null, 2, "order", 11, 13]);
  expect(statement.sql).toBe(
    "INSERT INTO listing_attendees (listing_id, attendee_id, start_at, end_at, quantity, order_token, parent_listing_id, package_group_id)\n          SELECT ?, ?, ?, ?, ?, ?, ?, ?",
  );
});

describeWithEnv("attendee capacity line checks", { db: true }, () => {
  test("checks more than one line in one select", async () => {
    const first = await createTestListing({ maxAttendees: 2 });
    const second = await createTestListing({ maxAttendees: 2 });

    expect(
      await checkLinesCapacity([
        { date: null, durationDays: 1, listingId: first.id, quantity: 1 },
        { date: null, durationDays: 1, listingId: second.id, quantity: 3 },
      ]),
    ).toEqual([true, false]);
  });
});
