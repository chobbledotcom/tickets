import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  getContactRecord,
  getVisits,
  hashEmail,
  hashPhone,
} from "#shared/db/contact-preferences.ts";
import { getTestPrivateKey } from "#test-utils/crypto.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestAttendeeDirect } from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";

const rowExists = async (hash: string): Promise<boolean> =>
  (await getVisits(hash)) > 0;

describeWithEnv("contact activity from bookings", { db: true }, () => {
  test("booking with an email records a visit", async () => {
    const listing = await createTestListing({ maxAttendees: 5, name: "Gig" });
    await createTestAttendeeDirect(listing.id, "Alice", "alice@example.com");
    expect(await getVisits(await hashEmail("alice@example.com"))).toBe(1);
  });

  test("booking with a phone records a phone visit", async () => {
    const listing = await createTestListing({ maxAttendees: 5, name: "Gig" });
    await createTestAttendeeDirect(
      listing.id,
      "Phoned",
      "phoned@example.com",
      1,
      "07700 900222",
    );
    expect(await getVisits(await hashPhone("07700 900222"))).toBe(1);
  });

  test("a multi-listing order records one visit, not one per booking", async () => {
    const a = await createTestListing({ maxAttendees: 5, name: "A" });
    const b = await createTestListing({ maxAttendees: 5, name: "B" });
    const { createAttendeeAtomic } = await import("#shared/db/attendees.ts");
    const result = await createAttendeeAtomic({
      bookings: [{ listingId: a.id }, { listingId: b.id }],
      email: "multi@example.com",
      name: "Multi",
    });
    expect(result.success).toBe(true);
    expect(await getVisits(await hashEmail("multi@example.com"))).toBe(1);
  });

  test("booking without an email or phone records no row", async () => {
    const listing = await createTestListing({ maxAttendees: 5, name: "Gig" });
    await createTestAttendeeDirect(listing.id, "Nameless", "");
    expect(await rowExists(await hashEmail(""))).toBe(false);
  });

  test("a default order counts as a public booking", async () => {
    const pk = await getTestPrivateKey();
    const listing = await createTestListing({ maxAttendees: 5, name: "Pub" });
    const { createAttendeeAtomic } = await import("#shared/db/attendees.ts");
    await createAttendeeAtomic({
      bookings: [{ listingId: listing.id }],
      email: "public-buyer@example.com",
      name: "Buyer",
    });
    const record = await getContactRecord(
      await hashEmail("public-buyer@example.com"),
      pk,
    );
    expect(record.publicBookingCount).toBe(1);
    expect(record.adminBookingCount).toBe(0);
  });

  test("an admin-source order counts as an admin booking", async () => {
    const pk = await getTestPrivateKey();
    const listing = await createTestListing({ maxAttendees: 5, name: "Adm" });
    const { createAttendeeAtomic } = await import("#shared/db/attendees.ts");
    await createAttendeeAtomic({
      bookings: [{ listingId: listing.id }],
      email: "admin-added@example.com",
      name: "Added",
      source: "admin",
    });
    const record = await getContactRecord(
      await hashEmail("admin-added@example.com"),
      pk,
    );
    expect(record.adminBookingCount).toBe(1);
    expect(record.publicBookingCount).toBe(0);
  });
});
