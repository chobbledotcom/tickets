import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { attendeeStatuses } from "#shared/db/attendee-statuses.ts";
import { getAttendeeBalanceState } from "#shared/db/attendees/balance.ts";
import {
  checkGroupCapAfterDurationChange,
  incrementAttachmentDownloads,
  recomputeListingBookingRanges,
  updateAttendeePII,
  updateAttendeeStatus,
  updateCheckedIn,
} from "#shared/db/attendees/update.ts";
import { executeUpdate, queryOne } from "#shared/db/client.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { bookAttendee } from "#test-utils/db-helpers/attendee-payments.ts";
import {
  createTestAttendee,
  createTestAttendeeDirect,
  decryptFirstAttendee,
} from "#test-utils/db-helpers/attendees.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import {
  createDailyTestListing,
  createTestListing,
} from "#test-utils/db-helpers/listings.ts";
import { postListingSale } from "#test-utils/ledger.ts";

describeWithEnv("db > attendees > updateCheckedIn", { db: true }, () => {
  const createAttendeeWithUpdates = async (updates: boolean[]) => {
    const listing = await createTestListing({ maxAttendees: 100 });
    const attendee = await createTestAttendee(
      listing.id,
      listing.slug,
      "Check User",
      "check@example.com",
    );
    for (const checked of updates) {
      await updateCheckedIn(attendee.id, listing.id, checked);
    }
    return listing;
  };

  const expectFirstAttendeeCheckedIn = async (
    listingId: number,
    expected: boolean,
  ) => {
    const attendee = await decryptFirstAttendee(listingId);
    expect(attendee.checked_in).toBe(expected);
  };

  test("updates checked_in to true for existing attendee", async () => {
    const listing = await createAttendeeWithUpdates([true]);
    await expectFirstAttendeeCheckedIn(listing.id, true);
  });

  test("updates checked_in back to false", async () => {
    const listing = await createAttendeeWithUpdates([true, false]);
    await expectFirstAttendeeCheckedIn(listing.id, false);
  });
});

describeWithEnv(
  "db > attendees > incrementAttachmentDownloads",
  { db: true },
  () => {
    /** The stored download counter for one (attendee, listing) booking row. */
    const downloadsFor = async (
      attendeeId: number,
      listingId: number,
    ): Promise<number> => {
      const row = await queryOne<{ attachment_downloads: number }>(
        "SELECT attachment_downloads FROM listing_attendees WHERE attendee_id = ? AND listing_id = ?",
        [attendeeId, listingId],
      );
      return row!.attachment_downloads;
    };

    test("adds 1 per call for the matching pair, leaving other rows alone", async () => {
      const listingA = await createTestListing({ maxAttendees: 10 });
      const listingB = await createTestListing({ maxAttendees: 10 });
      const { attendee: onA } = await createTestAttendeeDirect(
        listingA.id,
        "Downloader",
        "down@example.com",
      );
      const { attendee: onB } = await createTestAttendeeDirect(
        listingB.id,
        "Bystander",
        "by@example.com",
      );

      await incrementAttachmentDownloads(onA.id, listingA.id);
      await incrementAttachmentDownloads(onA.id, listingA.id);

      expect(await downloadsFor(onA.id, listingA.id)).toBe(2);
      // The other attendee's booking row is untouched.
      expect(await downloadsFor(onB.id, listingB.id)).toBe(0);
    });

    test("a mismatched attendee+listing pair matches no row", async () => {
      const listingA = await createTestListing({ maxAttendees: 10 });
      const listingB = await createTestListing({ maxAttendees: 10 });
      const { attendee } = await createTestAttendeeDirect(
        listingA.id,
        "Only A",
        "onlya@example.com",
      );

      // The attendee booked A, not B — both conditions must match one row.
      await incrementAttachmentDownloads(attendee.id, listingB.id);

      expect(await downloadsFor(attendee.id, listingA.id)).toBe(0);
    });
  },
);

describeWithEnv("db > attendees > updateAttendeePII", { db: true }, () => {
  test("rewrites the stored PII blob for that attendee only", async () => {
    const listingA = await createTestListing({ maxAttendees: 10 });
    const listingB = await createTestListing({ maxAttendees: 10 });
    const { attendee: edited } = await createTestAttendeeDirect(
      listingA.id,
      "Old Name",
      "old@example.com",
    );
    const { attendee: other } = await createTestAttendeeDirect(
      listingB.id,
      "Untouched",
      "same@example.com",
    );

    await updateAttendeePII(edited.id, {
      address: "1 New Street",
      email: "new@example.com",
      lat: "",
      lng: "",
      name: "New Name",
      payment_id: edited.payment_id,
      phone: "+447700900999",
      special_instructions: "gluten free",
      ticket_token: edited.ticket_token,
    });

    const reread = await decryptFirstAttendee(listingA.id);
    expect(reread.name).toBe("New Name");
    expect(reread.email).toBe("new@example.com");
    expect(reread.phone).toBe("+447700900999");
    expect(reread.address).toBe("1 New Street");
    expect(reread.special_instructions).toBe("gluten free");
    // Identity fields carried through the rebuilt blob are preserved.
    expect(reread.ticket_token).toBe(edited.ticket_token);

    // The write is keyed on the attendee id: the other attendee is untouched.
    const bystander = await decryptFirstAttendee(listingB.id);
    expect(bystander.name).toBe("Untouched");
    expect(bystander.email).toBe("same@example.com");
    expect(bystander.id).toBe(other.id);
  });
});

describeWithEnv("db > attendees > updateAttendeeStatus", { db: true }, () => {
  const attendeeOwing = async () => {
    const listing = await createTestListing({ maxAttendees: 10 });
    const { attendee } = await createTestAttendeeDirect(
      listing.id,
      "Reserved",
      "reserved@example.com",
    );
    const status = await attendeeStatuses.table.insert({ name: "Ready" });
    await postListingSale({
      amountPaid: 200,
      attendeeId: attendee.id,
      gross: 1000,
      listingId: listing.id,
    });
    return { attendee, status };
  };

  test("changes the status without clearing money owed by default", async () => {
    const { attendee, status } = await attendeeOwing();
    await updateAttendeeStatus(attendee.id, status.id);
    expect(await getAttendeeBalanceState(attendee.id)).toEqual({
      remainingBalance: 800,
      statusId: status.id,
    });
  });

  test("clears money owed in the same status update when requested", async () => {
    const { attendee } = await attendeeOwing();
    await updateAttendeeStatus(attendee.id, null, true);
    expect(await getAttendeeBalanceState(attendee.id)).toEqual({
      remainingBalance: 0,
      statusId: null,
    });
  });
});

describeWithEnv("db > attendees > booking ranges", { db: true }, () => {
  const DAY_1 = "2026-09-01";
  const DAY_2 = "2026-09-02";

  const cappedDailyPair = async () => {
    const group = await createTestGroup({ maxAttendees: 0 });
    const target = await createDailyTestListing({
      groupId: group.id,
      maxAttendees: 100,
      maximumDaysAfter: 100,
    });
    const sibling = await createDailyTestListing({
      groupId: group.id,
      maxAttendees: 100,
      maximumDaysAfter: 100,
    });
    return { group, sibling, target };
  };

  const setCap = async (groupId: number, cap: number): Promise<void> => {
    await executeUpdate("groups", { max_attendees: cap }, { id: groupId });
  };

  test("recomputes the stored end date from the booking start", async () => {
    const listing = await createDailyTestListing({
      maxAttendees: 10,
      maximumDaysAfter: 100,
    });
    const result = await bookAttendee(listing, { date: DAY_1 });
    if (!result.success) throw new Error("Expected booking to succeed");

    await recomputeListingBookingRanges(listing.id, 3);

    const row = await queryOne<{ end_at: string; start_at: string }>(
      "SELECT start_at, end_at FROM listing_attendees WHERE listing_id = ?",
      [listing.id],
    );
    expect(row).toEqual({
      end_at: "2026-09-04T00:00:00.000Z",
      start_at: "2026-09-01T00:00:00Z",
    });
  });

  test("an uncapped group cannot overflow", async () => {
    const { group, target } = await cappedDailyPair();
    await bookAttendee(target, { date: DAY_1, quantity: 50 });
    expect(
      await checkGroupCapAfterDurationChange(target.id, group.id),
    ).toBeNull();
  });

  test("a positive cap of one still reports an overflow", async () => {
    const { group, target } = await cappedDailyPair();
    await bookAttendee(target, { date: DAY_1, quantity: 2 });
    await setCap(group.id, 1);
    expect(await checkGroupCapAfterDurationChange(target.id, group.id)).toBe(
      DAY_1,
    );
  });

  test("reports the earliest overlap introduced by a longer duration", async () => {
    const { group, sibling, target } = await cappedDailyPair();
    await bookAttendee(target, { date: DAY_1, quantity: 6 });
    await bookAttendee(sibling, { date: DAY_2, quantity: 6 });
    await bookAttendee(sibling, { date: "2026-09-03", quantity: 6 });
    await recomputeListingBookingRanges(target.id, 3);
    await setCap(group.id, 10);

    expect(await checkGroupCapAfterDurationChange(target.id, group.id)).toBe(
      DAY_2,
    );
  });

  test("back-to-back ranges do not overlap on their shared boundary", async () => {
    const { group, target } = await cappedDailyPair();
    await bookAttendee(target, { date: DAY_1, quantity: 6 });
    await bookAttendee(target, { date: DAY_2, quantity: 6 });
    await setCap(group.id, 6);

    expect(
      await checkGroupCapAfterDurationChange(target.id, group.id),
    ).toBeNull();
  });

  test("a non-daily booking counts on every covered day", async () => {
    const { group, target } = await cappedDailyPair();
    const standard = await createTestListing({
      groupId: group.id,
      maxAttendees: 100,
    });
    await bookAttendee(target, { date: DAY_1, quantity: 5 });
    await bookAttendee(standard, { quantity: 6 });
    await setCap(group.id, 10);

    expect(await checkGroupCapAfterDurationChange(target.id, group.id)).toBe(
      DAY_1,
    );
  });

  test("ignores incomplete legacy daily ranges", async () => {
    const { group, sibling, target } = await cappedDailyPair();
    const legacyEnd = await createDailyTestListing({
      groupId: group.id,
      maxAttendees: 100,
      maximumDaysAfter: 100,
    });
    await bookAttendee(target, { date: DAY_1, quantity: 6 });
    await bookAttendee(sibling, { date: DAY_1, quantity: 5 });
    await bookAttendee(legacyEnd, { date: DAY_1, quantity: 20 });
    await executeUpdate(
      "listing_attendees",
      { end_at: null },
      { listing_id: sibling.id },
    );
    await executeUpdate(
      "listing_attendees",
      { start_at: null },
      { listing_id: legacyEnd.id },
    );
    await setCap(group.id, 10);

    expect(
      await checkGroupCapAfterDurationChange(target.id, group.id),
    ).toBeNull();
  });

  test("checks a later target range after an earlier range ends", async () => {
    const { group, sibling, target } = await cappedDailyPair();
    await bookAttendee(target, { date: DAY_1, quantity: 2 });
    await bookAttendee(target, { date: "2026-09-05", quantity: 2 });
    await bookAttendee(sibling, { date: "2026-09-06", quantity: 9 });
    await recomputeListingBookingRanges(target.id, 4);
    await setCap(group.id, 10);

    expect(await checkGroupCapAfterDurationChange(target.id, group.id)).toBe(
      "2026-09-06",
    );
  });

  test("does not report an overflow before the target's first range", async () => {
    const { group, sibling, target } = await cappedDailyPair();
    await bookAttendee(sibling, { date: DAY_1, quantity: 20 });
    await bookAttendee(target, { date: "2026-09-05", quantity: 2 });
    await setCap(group.id, 10);
    expect(
      await checkGroupCapAfterDurationChange(target.id, group.id),
    ).toBeNull();
  });
});
