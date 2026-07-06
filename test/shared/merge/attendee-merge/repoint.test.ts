import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { attendeeAccount } from "#shared/accounting/accounts.ts";
import { transfersByAccount } from "#shared/accounting/queries.ts";
import { createAttendeeAtomic } from "#shared/db/attendees.ts";
import {
  createTestGroup,
  createTestListing,
  describeWithEnv,
} from "#test-utils";
import {
  createAttendee,
  getBookings,
  postPaidSale,
  runMerge,
} from "./helpers.ts";

describeWithEnv("attendee merge service", { db: true }, () => {
  test("repoints the source's ledger rows onto the target", async () => {
    const listing1 = await createTestListing({ maxAttendees: 10 });
    const listing2 = await createTestListing({ maxAttendees: 10 });
    const target = await createAttendee(listing1.id, "Alice", "alice@test.com");
    const source = await createAttendee(listing2.id, "Bob", "bob@test.com");

    // A paid booking on the source attendee, recorded in the ledger.
    await postPaidSale({
      attendeeId: source.id,
      eventGroup: "evt",
      listingId: listing2.id,
    });

    const { result } = await runMerge({ source, target });

    expect(result.success).toBe(true);
    // The source's legs now belong to the target; nothing strands on the
    // deleted source attendee.
    expect((await transfersByAccount(attendeeAccount(source.id))).length).toBe(
      0,
    );
    expect((await transfersByAccount(attendeeAccount(target.id))).length).toBe(
      2,
    );
  });

  test("preserves package_group_id when moving a source package booking", async () => {
    const group = await createTestGroup({ isPackage: true, name: "MergePkg" });
    const targetListing = await createTestListing({ maxAttendees: 10 });
    const member = await createTestListing({
      groupId: group.id,
      maxAttendees: 10,
    });
    const target = await createAttendee(
      targetListing.id,
      "Alice",
      "alice@test.com",
    );
    const sourceResult = await createAttendeeAtomic({
      bookings: [{ listingId: member.id, packageGroupId: group.id }],
      email: "bob@test.com",
      name: "Bob",
    });
    if (!sourceResult.success) throw new Error("source booking failed");
    const source = sourceResult.attendees[0]!;

    const { result } = await runMerge({ source, target });

    expect(result.success).toBe(true);
    // The moved package booking keeps its group, so the merged attendee's
    // ticket still renders/hides as the package rather than a bare listing.
    const moved = (await getBookings(target.id)).find(
      (b) => b.listing_id === member.id,
    );
    expect(moved?.package_group_id).toBe(group.id);
  });
});
