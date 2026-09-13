/** Deposit and owed quotes on the `/calculate` running total: with no
 * provider a paid order surfaces the full value as owed, a free order owes
 * nothing, and a reservation status prices each line as its deposit. */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { formatCurrency } from "#shared/currency.ts";
import { postRunningTotal } from "#test-utils/csrf.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { setPublicReservation } from "#test-utils/reservation/helpers.ts";
import { setupStripe } from "#test-utils/settings.ts";

describeWithEnv("server (/calculate deposit quotes)", { db: true }, () => {
  test("shows the full value as owed when payments are disabled", async () => {
    // No payment provider configured: the submit path still completes the
    // booking but records the full value as the amount owed (like a zero-deposit
    // reservation), so the quote must surface that figure.
    const listing = await createTestListing({
      maxQuantity: 5,
      name: "Paid Seat",
      unitPrice: 1,
    });

    const html = await (
      await postRunningTotal(listing.slug, listing.slug, {
        [`quantity_${listing.id}`]: "1",
      })
    ).text();
    // The smallest paid value must remain distinct from a free booking.
    expect(html).toContain("you'll owe");
    expect(html).toContain(formatCurrency(1));
  });

  test("shows no amount owed for a free booking when payments are disabled", async () => {
    // A genuinely free order owes nothing, so the quote keeps the free wording.
    const listing = await createTestListing({
      maxQuantity: 5,
      name: "Free Seat",
      unitPrice: 0,
    });

    const html = await (
      await postRunningTotal(listing.slug, listing.slug, {
        [`quantity_${listing.id}`]: "1",
      })
    ).text();
    expect(html).toContain("No payment required");
    expect(html).not.toContain("you'll owe");
  });

  test("shows the deposit charged now for a reservation, not the full list price", async () => {
    await setupStripe();
    await setPublicReservation("10%");
    const listing = await createTestListing({
      maxQuantity: 5,
      name: "Weekend Pass",
      unitPrice: 2000,
    });

    const html = await (
      await postRunningTotal(listing.slug, listing.slug, {
        [`quantity_${listing.id}`]: "1",
      })
    ).text();

    // A deposit summary shows what's due now (10% of £20.00 = £2.00), not the
    // full £20.00 list price — the deposit already reflects the reservation.
    expect(html).toContain("Weekend Pass");
    expect(html).toContain(formatCurrency(200));
    expect(html).not.toContain(formatCurrency(2000));
    expect(html).toContain("order-summary-total");
  });
});
