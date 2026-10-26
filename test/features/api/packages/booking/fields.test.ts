import { it as test } from "@std/testing/bdd";
import { setGroupPackageMembers } from "#db/groups.ts";
import { settings } from "#db/settings.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import {
  describePackageBooking,
  expectPackageNeedsEmail,
  fixedPackage,
} from "../helpers.ts";

describePackageBooking(() => {
  test("POST rejects a booking missing the required contact fields", async () => {
    const { group } = await fixedPackage("Fields Kit", "fields-kit");
    await expectPackageNeedsEmail(group.slug);
  });

  test("POST requires email when a package costs money", async () => {
    const group = await createTestGroup({
      isPackage: true,
      name: "Paid field kit",
      slug: "paid-field-kit",
    });
    const member = await createTestListing({
      fields: "",
      groupId: group.id,
      name: "Paid field member",
      unitPrice: 100,
    });
    await setGroupPackageMembers(group.id, [
      { listingId: member.id, price: 100 },
    ]);
    await settings.update.paymentProvider("square");

    await expectPackageNeedsEmail(group.slug);
  });
});
