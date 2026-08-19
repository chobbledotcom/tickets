/** Transaction-scoped package booking checks for groups.ts. */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { execute, withTransaction } from "#db/client.ts";
import { hasPackageBookingsTx } from "#db/groups.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestAttendeeDirect } from "#test-utils/db-helpers/attendees.ts";
import { createHiddenPackageGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";

describeWithEnv("db > groups > hasPackageBookingsTx", { db: true }, () => {
  test("returns true for a package with a sold attendee", async () => {
    const group = await createHiddenPackageGroup("Sold package");
    const member = await createTestListing({
      groupId: group.id,
      maxAttendees: 10,
      name: "Sold member",
    });
    const { attendee } = await createTestAttendeeDirect(
      member.id,
      "Sold buyer",
      "sold-buyer@example.com",
    );
    await execute(
      "UPDATE listing_attendees SET package_group_id = ? WHERE attendee_id = ?",
      [group.id, attendee.id],
    );

    await withTransaction(async (tx) => {
      expect(await hasPackageBookingsTx(tx, group.id)).toBe(true);
    });
  });

  test("returns false for a package with no attendees", async () => {
    const group = await createHiddenPackageGroup("Empty package");

    await withTransaction(async (tx) => {
      expect(await hasPackageBookingsTx(tx, group.id)).toBe(false);
    });
  });

  test("returns false for a package with only zero-quantity attendees", async () => {
    const group = await createHiddenPackageGroup("Zero-qty package");
    const member = await createTestListing({
      groupId: group.id,
      maxAttendees: 10,
      name: "Zero member",
    });
    const { attendee } = await createTestAttendeeDirect(
      member.id,
      "Zero buyer",
      "zero-buyer@example.com",
    );
    await execute(
      "UPDATE listing_attendees SET package_group_id = ?, quantity = 0 WHERE attendee_id = ?",
      [group.id, attendee.id],
    );

    await withTransaction(async (tx) => {
      expect(await hasPackageBookingsTx(tx, group.id)).toBe(false);
    });
  });
});
