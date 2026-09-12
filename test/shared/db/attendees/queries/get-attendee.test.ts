import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { attendeesApi } from "#db/attendees/api.ts";
import {
  getAttendeeKindsByIds,
  getAttendeeOrNull,
  getAttendeePackageRowsRaw,
  getAttendeePiiBlobsForListings,
  getAttendeesByIds,
  getFirstBooking,
  hasPaidLine,
} from "#db/attendees/queries.ts";
import { getTestPrivateKey } from "#test-utils/crypto.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestAttendee } from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { postListingSale } from "#test-utils/ledger.ts";

describeWithEnv("db > attendees > getAttendeeOrNull", { db: true }, () => {
  test("returns null for missing attendee", async () => {
    const privateKey = await getTestPrivateKey();
    const attendee = await getAttendeeOrNull(999, privateKey);
    expect(attendee).toBeNull();
  });

  test("returns attendee by id", async () => {
    const listing = await createTestListing({
      maxAttendees: 50,
      thankYouUrl: "https://example.com",
    });
    const created = await createTestAttendee(
      listing.id,
      listing.slug,
      "John Doe",
      "john@example.com",
    );
    const privateKey = await getTestPrivateKey();
    const fetched = await getAttendeeOrNull(created.id, privateKey);

    expect(fetched).not.toBeNull();
    expect(fetched?.name).toBe("John Doe");
  });
});

describeWithEnv("db > attendees > raw lookups", { db: true }, () => {
  test("getAttendeesByIds returns nothing for no ids and rows for one", async () => {
    const listing = await createTestListing();
    const made = await attendeesApi.createAttendeeAtomic({
      bookings: [{ listingId: listing.id, quantity: 1 }],
      email: "by-ids@example.com",
      name: "By Ids",
    });
    if (!made.success) throw new Error("booking setup failed");
    const attendeeId = made.attendees[0]!.id;

    expect(await getAttendeesByIds([])).toEqual([]);
    const rows = await getAttendeesByIds([attendeeId]);
    expect(rows.length).toBe(1);
    expect(rows[0]!.id).toBe(attendeeId);
  });

  test("getFirstBooking reports a one-ticket line as active and a ghost as not", async () => {
    const listing = await createTestListing({ maxAttendees: 10 });
    const made = await attendeesApi.createAttendeeAtomic({
      bookings: [{ listingId: listing.id, quantity: 1 }],
      email: "first-booking@example.com",
      name: "First Booking",
    });
    if (!made.success) throw new Error("booking setup failed");
    expect(await getFirstBooking(made.attendees[0]!.id)).toEqual({
      active: true,
      listingId: listing.id,
    });

    const ghost = await attendeesApi.createAttendeeAtomic({
      bookings: [{ listingId: listing.id, quantity: 0 }],
      email: "first-ghost@example.com",
      name: "First Ghost",
    });
    if (!ghost.success) throw new Error("booking setup failed");
    // No real line remains, so the first booking is the placeholder: inactive.
    expect(await getFirstBooking(ghost.attendees[0]!.id)).toEqual({
      active: false,
      listingId: listing.id,
    });
    expect(await getFirstBooking(999_999)).toBeNull();
  });

  test("hasPaidLine reads the ledger sale stamped on the row", async () => {
    const listing = await createTestListing({ maxAttendees: 10 });
    const other = await createTestListing({ maxAttendees: 10 });
    const made = await attendeesApi.createAttendeeAtomic({
      bookings: [{ listingId: listing.id, quantity: 1 }],
      email: "paid-line@example.com",
      name: "Paid Line",
    });
    if (!made.success) throw new Error("booking setup failed");
    const attendeeId = made.attendees[0]!.id;
    await postListingSale({
      attendeeId,
      gross: 500,
      listingId: listing.id,
    });

    expect(await hasPaidLine(attendeeId, [listing.id])).toBe(true);
    expect(await hasPaidLine(attendeeId, [other.id])).toBe(false);
  });

  test("getAttendeePackageRowsRaw keeps real lines and drops ghost lines", async () => {
    const listing = await createTestListing({ maxAttendees: 10 });
    const ghostListing = await createTestListing({ maxAttendees: 10 });
    const made = await attendeesApi.createAttendeeAtomic({
      bookings: [
        { listingId: listing.id, pricePaid: 500, quantity: 1 },
        { listingId: ghostListing.id, quantity: 0 },
      ],
      email: "package-rows@example.com",
      name: "Package Rows",
    });
    if (!made.success) throw new Error("booking setup failed");
    const attendeeId = made.attendees[0]!.id;

    const rows = await getAttendeePackageRowsRaw(attendeeId, 0);

    expect(rows.length).toBe(1);
    expect(rows[0]!.listing_id).toBe(listing.id);
  });

  test("getAttendeePiiBlobsForListings answers blobs for a listing and nothing for none", async () => {
    const listing = await createTestListing();
    await createTestAttendee(
      listing.id,
      listing.slug,
      "Pii Blobs",
      "pii-blobs@example.com",
    );

    expect(await getAttendeePiiBlobsForListings([])).toEqual([]);
    const blobs = await getAttendeePiiBlobsForListings([listing.id]);
    expect(blobs.length).toBe(1);
  });

  test("getAttendeeKindsByIds maps each id to its stored kind", async () => {
    const listing = await createTestListing();
    const created = await createTestAttendee(
      listing.id,
      listing.slug,
      "Kind Lookup",
      "kind-lookup@example.com",
    );

    const kinds = await getAttendeeKindsByIds([created.id]);
    expect(kinds.get(created.id)).toBe("attendee");
    expect(await getAttendeeKindsByIds([])).toEqual(new Map());
  });
});
