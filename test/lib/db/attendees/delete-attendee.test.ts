import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { deleteAttendee, getAttendee } from "#shared/db/attendees.ts";
import { getDb, queryOne } from "#shared/db/client.ts";
import {
  getListingWithCount,
  invalidateListingsCache,
} from "#shared/db/listings.ts";
import {
  consumeModifierStock,
  modifierUsedQuantities,
} from "#shared/db/modifier-usage.ts";
import { modifiersTable } from "#shared/db/modifiers.ts";
import {
  finalizeSession as finalizePaymentSession,
  isSessionProcessed,
  reserveSession,
} from "#shared/db/processed-payments.ts";
import {
  createPaidTestAttendee,
  createTestAttendee,
  createTestListing,
  describeWithEnv,
  getTestPrivateKey,
} from "#test-utils";

describeWithEnv("db > attendees > deleteAttendee", { db: true }, () => {
  test("removes attendee", async () => {
    const listing = await createTestListing({
      maxAttendees: 50,
      thankYouUrl: "https://example.com",
    });
    const attendee = await createTestAttendee(
      listing.id,
      listing.slug,
      "John Doe",
      "john@example.com",
    );

    await deleteAttendee(attendee.id);

    const privateKey = await getTestPrivateKey();
    const fetched = await getAttendee(attendee.id, privateKey);
    expect(fetched).toBeNull();
  });

  test("removes processed payment records", async () => {
    const listing = await createTestListing({
      maxAttendees: 50,
      thankYouUrl: "https://example.com",
    });
    const attendee = await createTestAttendee(
      listing.id,
      listing.slug,
      "Jane Doe",
      "jane@example.com",
    );

    await reserveSession("sess_attendee_delete");
    await finalizePaymentSession("sess_attendee_delete", attendee.id);

    await deleteAttendee(attendee.id);

    const processed = await isSessionProcessed("sess_attendee_delete");
    expect(processed).toBeNull();
  });

  test("releases listing aggregate totals by default", async () => {
    const listing = await createTestListing({ maxAttendees: 50 });
    const attendee = await createPaidTestAttendee(
      listing.id,
      "Release Me",
      "release@example.com",
      "pay_release",
      1200,
      3,
    );

    await deleteAttendee(attendee.id);

    const updated = await getListingWithCount(listing.id);
    expect(updated).toMatchObject({
      attendee_count: 0,
      income: 0,
      tickets_count: 0,
    });
  });

  test("can delete attendee without releasing listing aggregate totals", async () => {
    const listing = await createTestListing({ maxAttendees: 50 });
    const attendee = await createPaidTestAttendee(
      listing.id,
      "Keep Totals",
      "keep@example.com",
      "pay_keep",
      1200,
      3,
    );

    await deleteAttendee(attendee.id, { releaseBookings: false });

    const privateKey = await getTestPrivateKey();
    const fetched = await getAttendee(attendee.id, privateKey);
    const updated = await getListingWithCount(listing.id);
    expect(fetched).toBeNull();
    expect(updated).toMatchObject({
      attendee_count: 3,
      income: 1200,
      tickets_count: 1,
    });
  });

  test("deleting a quantity-0-only attendee without releasing does not inflate tickets_count", async () => {
    const listing = await createTestListing({ maxAttendees: 50 });
    const attendee = await createTestAttendee(
      listing.id,
      listing.slug,
      "Ghost Line",
      "ghost@example.com",
    );
    // Turn the single line into a no-quantity sentinel: the UPDATE trigger drops
    // tickets_count to 0. The hold-delete restore must add 0 back (SUM(CASE …)),
    // not 1 (a plain COUNT(*) would permanently inflate tickets_count).
    await getDb().execute({
      args: [attendee.id],
      sql: "UPDATE listing_attendees SET quantity = 0, price_paid = 0 WHERE attendee_id = ?",
    });
    // The raw UPDATE bypasses the wrapped client's cache invalidation.
    invalidateListingsCache();
    expect(await getListingWithCount(listing.id)).toMatchObject({
      attendee_count: 0,
      tickets_count: 0,
    });

    await deleteAttendee(attendee.id, { releaseBookings: false });

    expect(await getListingWithCount(listing.id)).toMatchObject({
      attendee_count: 0,
      income: 0,
      tickets_count: 0,
    });
  });

  test("keeps modifier usage rows and totals after attendee deletion", async () => {
    const listing = await createTestListing({
      maxAttendees: 50,
      thankYouUrl: "https://example.com",
    });
    const attendee = await createTestAttendee(
      listing.id,
      listing.slug,
      "Modifier User",
      "modifier@example.com",
    );
    const modifier = await modifiersTable.insert({
      calcKind: "fixed",
      calcValue: 5,
      direction: "charge",
      name: "Add-on",
      stock: null,
    });

    const consumed = await consumeModifierStock(attendee.id, [
      { amountApplied: 1500, modifierId: modifier.id, quantity: 3 },
    ]);
    expect(consumed).toBe(true);
    const before = await queryOne<{ n: number }>(
      "SELECT COUNT(*) AS n FROM modifier_usages WHERE attendee_id = ?",
      [attendee.id],
    );
    expect(before?.n).toBe(1);

    await deleteAttendee(attendee.id);

    const after = await queryOne<{ n: number }>(
      "SELECT COUNT(*) AS n FROM modifier_usages WHERE attendee_id = ?",
      [attendee.id],
    );
    expect(after?.n).toBe(1);
    expect(await modifierUsedQuantities([modifier.id])).toEqual(
      new Map([[modifier.id, 3]]),
    );
    expect(await modifiersTable.findById(modifier.id)).toMatchObject({
      total_revenue: 1500,
      total_uses: 3,
      usage_count: 1,
    });
  });

  test("succeeds when the attendee has no modifier usage", async () => {
    const listing = await createTestListing({
      maxAttendees: 50,
      thankYouUrl: "https://example.com",
    });
    const attendee = await createTestAttendee(
      listing.id,
      listing.slug,
      "No Modifier",
      "none@example.com",
    );

    await expect(deleteAttendee(attendee.id)).resolves.toBeUndefined();

    const privateKey = await getTestPrivateKey();
    const fetched = await getAttendee(attendee.id, privateKey);
    expect(fetched).toBeNull();
  });
});
