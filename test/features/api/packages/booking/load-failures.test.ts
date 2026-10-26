import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { setGroupPackageMembers } from "#db/groups.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import {
  createTestListing,
  pastCloseTime,
} from "#test-utils/db-helpers/listings.ts";
import { statementSql, wrapDbClient } from "#test-utils/record-queries.ts";
import {
  apiBookPackage,
  bookingRows,
  describePackageBooking,
} from "../helpers.ts";

describePackageBooking(() => {
  test("POST keeps a package fact read failure after a free booking", async () => {
    const group = await createTestGroup({
      isPackage: true,
      name: "Free notify kit",
      slug: "free-notify-kit",
    });
    const member = await createTestListing({
      groupId: group.id,
      maxAttendees: 10,
      maxQuantity: 10,
      name: "Free notify member",
      unitPrice: 0,
      webhookUrl: "https://example.com/registration",
    });
    await setGroupPackageMembers(group.id, [
      { listingId: member.id, price: null },
    ]);
    let packageFactFailureRan = false;
    const restoreDb = wrapDbClient({
      batch: () => {},
      execute: (statement) => {
        if (
          !statementSql(statement).includes("groupRecord.hide_package_listings")
        ) {
          return null;
        }
        packageFactFailureRan = true;
        return Promise.reject(new Error("package facts unavailable"));
      },
    });

    let result: Awaited<ReturnType<typeof apiBookPackage>>;
    try {
      result = await apiBookPackage(group.slug, { quantity: 1 });
    } finally {
      restoreDb();
    }

    expect(packageFactFailureRan).toBe(true);
    expect(result.response.status).toBe(200);
    expect(await bookingRows(member.id)).toHaveLength(1);
  });

  test("POST refuses a package whose member's registration closed", async () => {
    // A closed member caps the bundle at zero: the package load answers
    // 404 before any fold or capacity math, and no booking row persists.
    const group = await createTestGroup({
      isPackage: true,
      name: "Closed Kit",
      slug: "closed-kit",
    });
    const open = await createTestListing({
      groupId: group.id,
      maxAttendees: 10,
      maxQuantity: 10,
      name: "Closed Kit Open",
      unitPrice: 1000,
    });
    const closing = await createTestListing({
      closesAt: pastCloseTime(),
      groupId: group.id,
      maxAttendees: 10,
      maxQuantity: 10,
      name: "Closed Kit Shut",
      unitPrice: 800,
    });
    await setGroupPackageMembers(group.id, [
      { listingId: open.id, price: null, quantity: 2 },
      { listingId: closing.id, price: 500 },
    ]);

    const { response, body } = await apiBookPackage(group.slug, {
      quantity: 1,
    });
    expect(response.status).toBe(404);
    expect(body.error).toBe("Package not found");
    expect((await bookingRows(closing.id)).length).toBe(0);
    expect((await bookingRows(open.id)).length).toBe(0);
  });

  test("POST returns 404 for an unknown package", async () => {
    const { response } = await apiBookPackage("nope", { quantity: 1 });
    expect(response.status).toBe(404);
  });
});
