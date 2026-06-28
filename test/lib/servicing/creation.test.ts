/**
 * Servicing §3 — creation.
 *
 * A servicing event is an `attendees` row with `kind='servicing'` plus one
 * `listing_attendees` row per booked listing/date. It carries a ticket token
 * (kept, but never customer-facing — §5) and empty contact fields. The create
 * must be all-or-nothing across bookings and must NOT record a contact visit.
 *
 * Implementation contract (test-first):
 *   - `#shared/db/attendees/servicing.ts` exports `createServicingEvent`,
 *     `ServicingEventInput`, `ServicingEvent`. A `kind: 'servicing'` create
 *     reuses the atomic attendee create core with empty contact fields.
 *   - `#test-utils/servicing.ts` wraps it as `createTestServicingEvent`.
 */
// jscpd:ignore-start
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { SERVICING_KIND } from "#shared/db/attendees/kind.ts";
import { getDb, queryOne } from "#shared/db/client.ts";
import {
  createAnnualInspectionEvent,
  createDailyListingPair,
  createDailyTestListing,
  createServicingHold,
  createTestListing,
  createTestServicingEvent,
  decryptFirstServicingAttendee,
  describeWithEnv,
  expectEmptyContactFields,
  expectLogisticsDisabled,
  expectRejects,
  kindOf,
  SMUGGLED_CONTACT_FIELDS,
  servicingRowsForListing,
} from "#test-utils";

// jscpd:ignore-end

const bookingRows = (listingId: number) =>
  getDb().execute({
    args: [listingId],
    sql: "SELECT quantity, SUBSTR(start_at, 1, 10) AS date FROM listing_attendees WHERE listing_id = ? ORDER BY start_at",
  });

describeWithEnv("servicing §3 — creation", { db: true }, () => {
  test("creating a servicing event persists name, bookings and kind", async () => {
    const [a, b] = await createDailyListingPair("Room A", "Room B");
    const event = await createAnnualInspectionEvent(a, b);
    expect(await kindOf(event.id)).toBe(SERVICING_KIND);

    const decrypted = await decryptFirstServicingAttendee(a.id);
    expect(decrypted?.name).toBe("Annual Inspection");

    const aRows = (await bookingRows(a.id)).rows;
    expect(aRows.length).toBe(1);
    expect(Number(aRows[0]!.quantity)).toBe(2);
    expect(aRows[0]!.date).toBe("2026-07-01");
    const bRows = (await bookingRows(b.id)).rows;
    expect(bRows.length).toBe(1);
    expect(Number(bRows[0]!.quantity)).toBe(1);
  });

  test("a crafted servicing POST cannot smuggle customer-only fields", async () => {
    const listing = await createTestListing({ maxAttendees: 10 });
    const event = await createTestServicingEvent({
      ...SMUGGLED_CONTACT_FIELDS,
      bookings: [{ listingId: listing.id, quantity: 1 }],
      name: "Boiler Service",
    } as never);
    expectEmptyContactFields(await decryptFirstServicingAttendee(listing.id));
    await expectLogisticsDisabled(event.id);
  });

  test("a servicing event still gets a ticket token (token index populated)", async () => {
    const { event } = await createServicingHold();
    const row = await queryOne<{ idx: string }>(
      "SELECT ticket_token_index AS idx FROM attendees WHERE id = ?",
      [event.id],
    );
    expect(row?.idx).toBeTruthy();
    expect(event.ticketToken).toBeTruthy();
  });

  test("creating a servicing event records no contact activity", async () => {
    const { getVisits, hashEmail } = await import(
      "#shared/db/contact-preferences.ts"
    );
    const listing = await createTestListing({ maxAttendees: 10 });
    await createTestServicingEvent({
      ...SMUGGLED_CONTACT_FIELDS,
      bookings: [{ listingId: listing.id, quantity: 1 }],
      name: "Boiler Service",
    } as never);
    expect(await getVisits(await hashEmail("smuggler@example.com"))).toBe(0);
    const prefs = await queryOne<{ one: number }>(
      "SELECT 1 AS one FROM contact_preferences LIMIT 1",
    );
    expect(prefs).toBeNull();
  });

  test("servicing event stores empty contact fields (only name in the PII blob)", async () => {
    const { listing } = await createServicingHold({ name: "Deep Clean" });
    const decrypted = await decryptFirstServicingAttendee(listing.id);
    expect(decrypted?.name).toBe("Deep Clean");
    expectEmptyContactFields(decrypted);
  });

  test("servicing create is all-or-nothing across multiple bookings", async () => {
    const [a, b] = await createDailyListingPair("Cap1", "Cap1-b", 1);
    await createServicingHold({
      date: "2026-07-01",
      listing: { maxAttendees: 1, name: "Cap1" },
      name: "First Hold",
    });
    await expectRejects(
      createTestServicingEvent({
        bookings: [
          { date: "2026-07-02", listingId: b.id, quantity: 1 },
          { date: "2026-07-01", listingId: a.id, quantity: 1 },
        ],
        name: "Should Roll Back",
      }),
    );
    expect((await servicingRowsForListing(b.id)).length).toBe(0);
  });

  test("creating a servicing event rejects non-positive held quantities", async () => {
    const listing = await createTestListing({ maxAttendees: 10 });
    await expectRejects(
      createTestServicingEvent({
        bookings: [{ listingId: listing.id, quantity: 0 }],
        name: "Zero Hold",
      }),
      /at least one capacity slot/,
    );
  });

  test("creating a servicing event rejects a hold that does not fit", async () => {
    const listing = await createDailyTestListing({ maxAttendees: 1 });
    await expectRejects(
      createTestServicingEvent({
        bookings: [{ date: "2026-07-01", listingId: listing.id, quantity: 2 }],
        name: "Too Big",
      }),
    );
    expect((await servicingRowsForListing(listing.id)).length).toBe(0);
  });
});
