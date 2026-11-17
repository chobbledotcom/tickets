/** Transaction-scoped package booking checks for groups.ts. */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { execute, withTransaction } from "#db/client.ts";
import { hasPackageBookingsTx } from "#db/groups/package-display.ts";
import { sql } from "#db/sql.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestAttendeeDirect } from "#test-utils/db-helpers/attendees.ts";
import { createHiddenPackageGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";

type PackageOptions = {
  /** The package group's name. */
  groupName: string;
  /** Leave out for a package with no member listing. */
  memberName?: string;
  /** The one attendee booked on the member listing, and its unit quantity. */
  buyer?: { email: string; name: string; quantity: number };
};

/** Make a package group, and when asked, one member with one attendee on it. */
const createPackage = async (options: PackageOptions): Promise<number> => {
  const group = await createHiddenPackageGroup(options.groupName);
  if (!options.memberName || !options.buyer) return group.id;

  const member = await createTestListing({
    groupId: group.id,
    maxAttendees: 10,
    name: options.memberName,
  });
  const { attendee } = await createTestAttendeeDirect(
    member.id,
    options.buyer.name,
    options.buyer.email,
  );
  await execute(
    sql`UPDATE listing_attendees SET package_group_id = ${group.id}, quantity = ${options.buyer.quantity} WHERE attendee_id = ${attendee.id}`,
  );
  return group.id;
};

describeWithEnv("db > groups > hasPackageBookingsTx", { db: true }, () => {
  for (const [name, options, expected] of [
    [
      "returns true for a package with a sold attendee",
      {
        buyer: {
          email: "sold-buyer@example.com",
          name: "Sold buyer",
          quantity: 1,
        },
        groupName: "Sold package",
        memberName: "Sold member",
      },
      true,
    ],
    [
      "returns false for a package with no attendees",
      { groupName: "Empty package" },
      false,
    ],
    [
      "returns false for a package with only zero-quantity attendees",
      {
        buyer: {
          email: "zero-buyer@example.com",
          name: "Zero buyer",
          quantity: 0,
        },
        groupName: "Zero-qty package",
        memberName: "Zero member",
      },
      false,
    ],
  ] as const) {
    test(name, async () => {
      const groupId = await createPackage(options);

      await withTransaction(async (tx) => {
        expect(await hasPackageBookingsTx(tx, groupId)).toBe(expected);
      });
    });
  }
});
