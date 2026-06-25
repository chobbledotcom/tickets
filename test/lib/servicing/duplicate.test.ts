/**
 * Servicing §18 — duplicating a service event.
 *
 * Duplicating produces a new `kind='servicing'` row with the same name and one
 * `listing_attendees` row per original booking (listing, quantity, date range),
 * a fresh ticket token, empty contact fields, and capacity held independently
 * of the original. The duplicate goes through the shared duplicate helper
 * (§20), not a bespoke copier — duplicate-then-edit leaves the original intact.
 *
 * Implementation contract (test-first):
 *   - `#shared/db/attendees/servicing.ts` exports `duplicateServicingEvent(id)`
 *     and `buildDuplicateServicingInput(event)`; the duplicate is created via
 *     `createServicingEvent(buildDuplicateServicingInput(original))`.
 */
// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { getListingRemainingForRange } from "#shared/db/attendees/capacity.ts";
import { SERVICING_KIND } from "#shared/db/attendees/kind.ts";
import {
  buildDuplicateServicingInput,
  createDailyListingPair,
  createServicingHold,
  decryptFirstAttendee,
  deleteServicingEvent,
  describeWithEnv,
  duplicateServicingEvent,
  expectRejects,
  getServicingEvent,
  kindOf,
  servicingRowsForListing,
  tokenIndexOf,
  updateServicingEvent,
} from "#test-utils";

// jscpd:ignore-end

/** Create a daily listing + a servicing hold on 2026-07-01. */
const createHoldOnNewDailyListing = async (
  name: string,
  quantity = 1,
  listingOverrides: { maxAttendees?: number; name?: string } = {},
) => {
  const maxAttendees = listingOverrides.maxAttendees ?? 10;
  const listingName = listingOverrides.name ?? "A";
  const { createDailyTestListing } = await import("#test-utils");
  const listing = await createDailyTestListing({
    maxAttendees,
    name: listingName,
  });
  const event = await createServicingHold({
    date: "2026-07-01",
    listing: { maxAttendees, name: listingName },
    name,
    quantity,
  });
  return { listing, original: event };
};

describeWithEnv(
  "servicing §18 — duplicating a service event",
  { db: true },
  () => {
    test("the duplicate copies name and all listing bookings", async () => {
      const [a, b] = await createDailyListingPair("A", "B");
      const { createTestServicingEvent } = await import("#test-utils");
      const original = await createTestServicingEvent({
        bookings: [
          { date: "2026-07-01", listingId: a.id, quantity: 2 },
          { date: "2026-07-02", listingId: b.id, quantity: 1 },
        ],
        name: "Annual Inspection",
      });
      const copy = await duplicateServicingEvent(original.id);
      expect(copy.id).not.toBe(original.id);
      expect(copy.name).toBe("Annual Inspection");
      expect((await servicingRowsForListing(a.id))[0]!.quantity).toBe(2);
      expect((await servicingRowsForListing(b.id))[0]!.quantity).toBe(1);
    });

    test("a duplicated service event holds capacity independently (two holds, not one)", async () => {
      const { original, listing } = await createHoldOnNewDailyListing(
        "Original",
        2,
        { maxAttendees: 5 },
      );
      await duplicateServicingEvent(original.id);
      // Original (2) + copy (2) = 4 held against cap 5 ⇒ 1 remains.
      expect(await getListingRemainingForRange(listing.id, "2026-07-01")).toBe(
        1,
      );
      // Deleting the original leaves the duplicate's holds intact.
      await deleteServicingEvent(original.id);
      expect(await getListingRemainingForRange(listing.id, "2026-07-01")).toBe(
        3,
      );
    });

    test("the duplicate mints a fresh token and copies no contact data, kind stays servicing", async () => {
      const { original, listing } =
        await createHoldOnNewDailyListing("Annual Inspection");
      const copy = await duplicateServicingEvent(original.id);
      expect(await tokenIndexOf(copy.id)).not.toBe(
        await tokenIndexOf(original.id),
      );
      expect(await kindOf(copy.id)).toBe(SERVICING_KIND);
      const decrypted = await decryptFirstAttendee(listing.id);
      expect(decrypted?.email).toBe("");
      expect(decrypted?.phone).toBe("");
    });

    test("duplicate-then-edit is independent of the original", async () => {
      const { original, listing } =
        await createHoldOnNewDailyListing("Original");
      const copy = await duplicateServicingEvent(original.id);
      await updateServicingEvent(copy.id, {
        bookings: [{ date: "2026-07-01", listingId: listing.id, quantity: 4 }],
        name: "Edited Copy",
      });
      const reloadedOriginal = await getServicingEvent(original.id);
      expect(reloadedOriginal?.name).toBe("Original");
      expect(
        (await servicingRowsForListing(listing.id))
          .map((a) => a.quantity)
          .sort(),
      ).toEqual([1, 4]);
    });

    test("duplicating a missing servicing event reports not found", async () => {
      await expectRejects(duplicateServicingEvent(999_999), /not found/);
    });
  },
);

describe("servicing §18 — duplicate reuses the shared duplicate helper, not a bespoke copy", () => {
  test("buildDuplicateServicingInput carries the name + bookings and forces kind='servicing'", () => {
    const original = {
      bookings: [{ date: "2026-07-01", listingId: 7, quantity: 2 }],
      id: 42,
      kind: SERVICING_KIND,
      name: "Annual Inspection",
      ticketToken: "abc",
    } as never;
    const input = buildDuplicateServicingInput(original);
    expect(input.kind).toBe(SERVICING_KIND);
    expect(input.name).toBe("Annual Inspection");
    expect(input.bookings).toEqual([
      { date: "2026-07-01", listingId: 7, quantity: 2 },
    ]);
  });
});
