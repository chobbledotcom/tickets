import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  buildCreateForm,
  buildTemplateData,
  type PackagePath,
} from "#routes/admin/attendee-page-data.ts";
import { listingChildren } from "#shared/db/listing-parents.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { testListingWithCount } from "#test-utils/factories.ts";

describeWithEnv("attendee page warnings", { db: true }, () => {
  test("names every required child when a parent is booked alone", async () => {
    const parent = await createTestListing({ name: "Main pass" });
    const firstChild = await createTestListing({ name: "Morning child" });
    const secondChild = await createTestListing({ name: "Evening child" });
    await listingChildren.setIds(parent.id, [firstChild.id, secondChild.id]);
    const parsed = buildCreateForm(
      [parent, firstChild, secondChild].map(testListingWithCount),
      [],
      new Map([[parent.id, 1]]),
      "",
    );

    const data = await buildTemplateData("create", parsed, null);

    const warning =
      "Main pass requires one of its child listings to be booked too (Morning child, Evening child) — public bookings choose one automatically; add it here.";
    expect(data.topWarnings).toEqual([warning]);
    expect(data.lineWarnings).toEqual(new Map([[parent.id, [warning]]]));
  });

  test("sums standalone and package quantities into one capacity warning", async () => {
    const listing = await createTestListing({
      maxAttendees: 2,
      name: "Shared capacity",
    });
    const paths: PackagePath[] = [
      {
        groupId: 42,
        memberListingIds: [listing.id],
        memberPrices: new Map(),
        packageName: "Capacity package",
      },
    ];
    const parsed = buildCreateForm(
      [testListingWithCount(listing)],
      paths,
      new Map([[listing.id, 1]]),
      "",
    );
    parsed.lines.find((line) => line.packageGroupId === 42)!.quantity = 2;

    const data = await buildTemplateData("create", parsed, null);

    const warning =
      "Shared capacity is overbooked — there isn't capacity for 3 on these dates.";
    expect(data.topWarnings).toEqual([warning]);
    expect(data.lineWarnings).toEqual(new Map([[listing.id, [warning]]]));
  });

  test("loads a stored parent name for an add-on booking path", async () => {
    const parent = await createTestListing({ name: "Named parent" });
    const child = await createTestListing({ name: "Named child" });
    const parsed = buildCreateForm(
      [testListingWithCount(child)],
      [],
      new Map([[child.id, 1]]),
      "",
    );
    parsed.lines[0]!.parentListingId = parent.id;

    const data = await buildTemplateData("create", parsed, null);

    expect(data.parentNamesById).toEqual(new Map([[parent.id, parent.name]]));
  });
});
