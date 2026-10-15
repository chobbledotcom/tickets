/** Deposit and owed quotes on the `/calculate` running total: with no
 * provider a paid order surfaces the full value as owed, a free order owes
 * nothing, and a reservation status prices each line as its deposit. */

import { assert, assertStringIncludes } from "@std/assert";
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
    assertStringIncludes(html, "you'll owe");
    assertStringIncludes(html, formatCurrency(1));
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
    assertStringIncludes(html, "No payment required");
    assert(
      !html.includes("you'll owe"),
      "the value should not contain the searched item",
    );
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
    assertStringIncludes(html, "Weekend Pass");
    assertStringIncludes(html, formatCurrency(200));
    assert(
      !html.includes(formatCurrency(2000)),
      "the value should not contain the searched item",
    );
    assertStringIncludes(html, "order-summary-total");
  });
});
