import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getActiveListingStats } from "#shared/db/attendees.ts";
import { getAllListings } from "#shared/db/listings.ts";
import {
  createPaidTestAttendee,
  createTestListing,
  describeWithEnv,
} from "#test-utils";

describeWithEnv("db > attendees > getActiveListingStats", { db: true }, () => {
  test("returns zeros for empty listings", async () => {
    const stats = await getActiveListingStats([]);
    expect(stats).toEqual({ attendees: 0, income: 0, tickets: 0 });
  });

  test("returns zeros when all listings inactive", async () => {
    const listing = await createTestListing({
      maxAttendees: 50,
      unitPrice: 500,
    });
    await createPaidTestAttendee(
      listing.id,
      "Alice",
      "alice@example.com",
      "pay_1",
      1000,
    );
    const listings = await getAllListings();
    const inactive = listings.map((e) => ({ ...e, active: false }));
    const stats = await getActiveListingStats(inactive);
    expect(stats).toEqual({ attendees: 0, income: 0, tickets: 0 });
  });

  test("counts tickets and sums income for active listings", async () => {
    const listing = await createTestListing({
      maxAttendees: 50,
      unitPrice: 500,
    });
    await createPaidTestAttendee(
      listing.id,
      "Alice",
      "alice@example.com",
      "pay_1",
      1000,
    );
    await createPaidTestAttendee(
      listing.id,
      "Bob",
      "bob@example.com",
      "pay_2",
      2000,
    );
    const listings = await getAllListings();
    const stats = await getActiveListingStats(listings);
    expect(stats.tickets).toBe(2);
    expect(stats.income).toBe(3000);
    expect(stats.attendees).toBe(2);
  });

  test("excludes inactive listings", async () => {
    const listing1 = await createTestListing({
      maxAttendees: 50,
      unitPrice: 500,
    });
    const listing2 = await createTestListing({
      maxAttendees: 50,
      unitPrice: 500,
    });
    await createPaidTestAttendee(
      listing1.id,
      "Alice",
      "alice@example.com",
      "pay_1",
      1000,
    );
    await createPaidTestAttendee(
      listing2.id,
      "Bob",
      "bob@example.com",
      "pay_2",
      2000,
    );
    const listings = await getAllListings();
    const mixed = listings.map((e) =>
      e.id === listing2.id ? { ...e, active: false } : e,
    );
    const stats = await getActiveListingStats(mixed);
    expect(stats.tickets).toBe(1);
    expect(stats.income).toBe(1000);
    expect(stats.attendees).toBe(1);
  });

  test("treats non-numeric price_paid as zero", async () => {
    const listing = await createTestListing({
      maxAttendees: 50,
      unitPrice: 0,
    });
    await createPaidTestAttendee(
      listing.id,
      "Free Alice",
      "free@example.com",
      "",
      0,
    );
    const listings = await getAllListings();
    const stats = await getActiveListingStats(listings);
    expect(stats.tickets).toBe(1);
    expect(stats.income).toBe(0);
    expect(stats.attendees).toBe(1);
  });
});
