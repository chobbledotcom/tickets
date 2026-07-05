/**
 * Servicing §10 — listing aggregates.
 *
 * A servicing hold is a real `listing_attendees` row, so it must count toward
 * `booked_quantity` (that's what blocks capacity — §2) but NOT toward
 * `tickets_count` ("tickets sold" is a customer metric) and NOT toward `income`
 * (servicing is free). The trigger-maintained aggregates and the explicit
 * recompute (`getListingAggregateRecalculation` / `resetListingAggregateFields`)
 * must agree on this split, so a recalc never re-introduces servicing into
 * tickets_count.
 *
 * Implementation contract (test-first):
 *   - `TICKET_COUNTS_PREDICATE` (`schema.ts`) becomes `quantity > 0 AND kind =
 *     'attendee'` (or the trigger/recompute SQL joins attendees and filters
 *     kind), so the predicate is the single source of truth for "is a ticket".
 *   - `booked_quantity` keeps counting every quantity > 0 row regardless of kind.
 */
// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { revenueAccount } from "#shared/accounting/accounts.ts";
import { accountBalance } from "#shared/accounting/queries.ts";
import { getDb } from "#shared/db/client.ts";
import {
  getListingAggregateRecalculation,
  getListingWithCount,
  invalidateListingsCache,
  resetListingAggregateFields,
} from "#shared/db/listings.ts";
import { TICKET_COUNTS_PREDICATE } from "#shared/db/migrations/schema.ts";
import {
  createServicingHold,
  createTestListing,
  describeWithEnv,
} from "#test-utils";

// jscpd:ignore-end

/** Create a listing + a servicing hold of `quantity` on it, then invalidate
 *  the listings cache so `getListingWithCount` re-reads the aggregate. */
const createHoldAndInvalidate = async (quantity: number) => {
  const listing = await createTestListing({ maxAttendees: 10, name: "L" });
  await createServicingHold({
    listing: { maxAttendees: 10, name: "L" },
    quantity,
  });
  invalidateListingsCache();
  return listing;
};

describe("servicing §10 — tickets_count predicate excludes servicing by kind", () => {
  test("TICKET_COUNTS_PREDICATE gates on kind='attendee' (mutation: dropping it counts servicing as tickets)", () => {
    expect(TICKET_COUNTS_PREDICATE).toMatch(/kind\s*=\s*'attendee'/);
    expect(TICKET_COUNTS_PREDICATE).toMatch(/quantity\s*>\s*0/);
  });
});

describeWithEnv("servicing §10 — listing aggregates", { db: true }, () => {
  test("booked_quantity includes servicing holds (this is what blocks capacity)", async () => {
    const listing = await createHoldAndInvalidate(3);
    expect((await getListingWithCount(listing.id))?.attendee_count).toBe(3);
  });

  test("tickets_count excludes servicing holds (servicing is not a ticket)", async () => {
    const listing = await createHoldAndInvalidate(3);
    expect((await getListingWithCount(listing.id))?.tickets_count).toBe(0);
  });

  test("income is unaffected by servicing holds (servicing is free)", async () => {
    const listing = await createHoldAndInvalidate(3);
    // Income projects from the ledger; a servicing hold posts no sale leg (§22).
    expect(await accountBalance(revenueAccount(listing.id))).toBe(0);
  });

  test("aggregate recompute matches the triggers (recalc never re-introduces servicing into tickets_count)", async () => {
    const listing = await createHoldAndInvalidate(3);
    const before = await getListingWithCount(listing.id);
    // Reset to zero then recompute from the live rows: the split must hold.
    await resetListingAggregateFields(listing.id, [
      "booked_quantity",
      "tickets_count",
    ]);
    const recalc = await getListingAggregateRecalculation(
      (await getListingWithCount(listing.id))!,
    );
    expect(recalc.booked_quantity.recalculated).toBe(3);
    expect(recalc.tickets_count.recalculated).toBe(0);
    // Apply the recalculated values and confirm the trigger-maintained shape.
    await getDb().execute({
      args: [
        recalc.booked_quantity.recalculated,
        recalc.tickets_count.recalculated,
        listing.id,
      ],
      sql: "UPDATE listings SET booked_quantity = ?, tickets_count = ? WHERE id = ?",
    });
    invalidateListingsCache();
    const after = await getListingWithCount(listing.id);
    expect(after?.attendee_count).toBe(before?.attendee_count);
    expect(after?.tickets_count).toBe(0);
  });
});
