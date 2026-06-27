/**
 * Servicing §4 — editing.
 *
 * Editing a servicing event reuses the attendee atomic-edit core: it preserves
 * the existing ticket token (read-and-reencrypt), updates name + bookings
 * (added/changed/removed `listing_attendees` rows), and cannot change its kind
 * or be unhidden through the form — `kind` is immutable, the hidden state is
 * owned by the kind.
 *
 * Implementation contract (test-first):
 *   - `#shared/db/attendees/servicing.ts` exports `updateServicingEvent(id,
 *     input)` and `getServicingEvent(id)`. The edit path goes through the same
 *     atomic-edit core as attendees, scoped to `kind='servicing'`.
 */
// jscpd:ignore-start
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { ATTENDEE_KIND, SERVICING_KIND } from "#shared/db/attendees/kind.ts";
import {
  adminPost,
  createDailyListingPair,
  createDailyTestListing,
  createServicingHold,
  decryptFirstServicingAttendee,
  describeWithEnv,
  expectRejects,
  getServicingEvent,
  kindOf,
  renderAdminPage,
  servicingRowsForListing,
  tokenIndexOf,
  updateServicingEvent,
} from "#test-utils";

// jscpd:ignore-end

describeWithEnv("servicing §4 — editing", { db: true }, () => {
  test("editing a servicing event preserves its token", async () => {
    const { event, listing } = await createServicingHold();
    const before = await tokenIndexOf(event.id);
    await updateServicingEvent(event.id, {
      bookings: [{ listingId: listing.id, quantity: 2 }],
      name: "Boiler Service +1",
    });
    expect(await tokenIndexOf(event.id)).toBe(before);
  });

  test("editing updates name and bookings (changed qty, removed listing)", async () => {
    const [a, b] = await createDailyListingPair("A", "B");
    const { createTestServicingEvent } = await import("#test-utils");
    const event = await createTestServicingEvent({
      bookings: [
        { date: "2026-07-01", listingId: a.id, quantity: 1 },
        { date: "2026-07-01", listingId: b.id, quantity: 1 },
      ],
      name: "Annual Inspection",
    });
    await updateServicingEvent(event.id, {
      bookings: [{ date: "2026-07-01", listingId: a.id, quantity: 3 }],
      name: "Annual Inspection (revised)",
    });
    expect((await servicingRowsForListing(a.id))[0]!.quantity).toBe(3);
    expect((await servicingRowsForListing(b.id)).length).toBe(0);
    const decrypted = await decryptFirstServicingAttendee(a.id);
    expect(decrypted?.name).toBe("Annual Inspection (revised)");
  });

  test("editing cannot change kind or unhide the event", async () => {
    const { event, listing } = await createServicingHold();
    // A hostile edit tries to flip kind to 'attendee' and toggle hidden off.
    await updateServicingEvent(event.id, {
      bookings: [{ listingId: listing.id, quantity: 1 }],
      hidden: false,
      kind: ATTENDEE_KIND,
      name: "Boiler Service",
    } as never);
    expect(await kindOf(event.id)).toBe(SERVICING_KIND);
    const reloaded = await getServicingEvent(event.id);
    expect(reloaded?.kind).toBe(SERVICING_KIND);
  });

  test("editing a missing servicing event reports not found", async () => {
    await expectRejects(
      updateServicingEvent(999_999, {
        bookings: [{ listingId: 1, quantity: 1 }],
        name: "Missing",
      }),
      /not found/,
    );
  });

  test("editing onto a full date is rejected by the atomic capacity guard", async () => {
    const listing = await createDailyTestListing({
      maxAttendees: 1,
      name: "Tiny Room",
    });
    await createServicingHold({
      date: "2026-07-01",
      listing: { maxAttendees: 1, name: "Tiny Room" },
      name: "First Hold",
      quantity: 1,
    });
    const second = await createServicingHold({
      date: "2026-07-02",
      listing: { maxAttendees: 1, name: "Tiny Room" },
      name: "Second Hold",
      quantity: 1,
    });
    await expectRejects(
      updateServicingEvent(second.id, {
        bookings: [{ date: "2026-07-01", listingId: listing.id, quantity: 1 }],
        name: "Second Hold",
      }),
    );
    expect(
      (await servicingRowsForListing(listing.id)).map((row) => row.date),
    ).toEqual(["2026-07-01", "2026-07-02"]);
  });
});

describeWithEnv(
  "servicing §4 — inactive/deleted held listings stay visible on the edit form",
  { db: true },
  () => {
    test("an inactive held listing still renders (with a marker) and is preserved on save", async () => {
      // The edit page used `activeListings` only, so a listing deactivated after
      // the hold was created vanished from the form — and saving the form then
      // silently dropped the hold. The edit page must include held listings
      // regardless of active state, mark them inactive, and preserve them.
      const { deactivateTestListing } = await import("#test-utils");
      const listing = await createDailyTestListing({
        maxAttendees: 10,
        name: "Boiler Room",
      });
      const { id } = await createServicingHold({
        date: "2099-07-01",
        listing: { maxAttendees: 10, name: "Boiler Room" },
        quantity: 2,
      });
      await deactivateTestListing(listing.id);

      const body = await renderAdminPage(`/admin/servicing/${id}`);
      expect(body).toContain("Boiler Room");
      expect(body).toContain("(inactive)");
      expect(body).toMatch(
        new RegExp(`name="quantity_${listing.id}"[^>]*value="2"`),
      );

      // Saving the form (preserving the held quantity) must keep the hold — it
      // is not silently dropped because the listing is inactive.
      const response = await adminPost(`/admin/servicing/${id}`, {
        [`quantity_${listing.id}`]: "2",
        day_count: "1",
        name: "Boiler Service",
        start_date: "2099-07-01",
      });
      expect(response.status).toBe(302);
      const after = await getServicingEvent(id);
      expect(
        after?.bookings.find((b) => b.listingId === listing.id)?.quantity,
      ).toBe(2);
    });

    test("a held listing that has been deleted shows a removal indicator", async () => {
      // A booking row left pointing at a deleted listing (an orphaned hold, e.g.
      // from a partial failure or direct DB edit) must not be silently hidden:
      // the edit page surfaces a "will be removed on save" indicator so the
      // operator sees the repair instead of a form that quietly drops it.
      const { getDb } = await import("#shared/db/client.ts");
      const listing = await createDailyTestListing({
        maxAttendees: 10,
        name: "Doomed Room",
      });
      const { id } = await createServicingHold({
        date: "2099-07-01",
        listing: { maxAttendees: 10, name: "Doomed Room" },
        quantity: 3,
      });
      // Delete the listing row directly, leaving the booking link in place —
      // the inconsistent state the indicator is for.
      await getDb().execute({
        args: [listing.id],
        sql: "DELETE FROM listings WHERE id = ?",
      });

      const body = await renderAdminPage(`/admin/servicing/${id}`);
      expect(body).toContain("no longer exist");
      expect(body).toContain("will be removed");
    });
  },
);
