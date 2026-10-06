/**
 * Direct tests for the minimum-quantity booking rule at form parse: a posted
 * quantity in 1..minimum-1 on an offered row refuses with the buyer reason,
 * while sold-out and closed rows keep their existing skip behaviour.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { bookingError } from "#booking/form.ts";
import { buildTicketListing, type TicketListing } from "#booking/model.ts";
import { validateFormState } from "#routes/public/ticket-submit/parse.ts";
import {
  REGISTRATION_CLOSED_SUBMIT_MESSAGE,
  type TicketCtx,
} from "#routes/public/types.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { quantityForm, ticketContext } from "#test-utils/ticket-ctx.ts";

/** The page context with its listings replaced, for the states a real page
 * cannot reach in one shot (sold out by the minimum, or closed). */
const withListings = (
  ctx: TicketCtx,
  listings: TicketListing[],
): TicketCtx => ({ ...ctx, listings });

describeWithEnv("ticket-submit parse — minimum quantity", { db: true }, () => {
  describe("validateFormState", () => {
    /** A listing that sells at least three per purchase. */
    const makeMinimumListing = () =>
      createTestListing({
        maxAttendees: 5,
        maxQuantity: 10,
        minQuantity: 3,
      });

    test("refuses a posted quantity below the minimum on an offered row", async () => {
      const listing = await makeMinimumListing();
      const ctx = await ticketContext([listing.id]);

      expect(validateFormState(quantityForm({ [listing.id]: 2 }), ctx)).toBe(
        bookingError.minimum(listing.name, listing.min_quantity),
      );
    });

    test("accepts a quantity of exactly the minimum", async () => {
      const listing = await makeMinimumListing();
      const ctx = await ticketContext([listing.id]);

      expect(validateFormState(quantityForm({ [listing.id]: 3 }), ctx)).toBe(
        null,
      );
    });

    test("accepts a quantity of zero", async () => {
      const listing = await makeMinimumListing();
      const ctx = await ticketContext([listing.id]);

      expect(validateFormState(quantityForm({ [listing.id]: 0 }), ctx)).toBe(
        null,
      );
    });

    test("a sold-out row's posted quantity is skipped, below or above the minimum", async () => {
      const listing = await makeMinimumListing();
      const spare = await createTestListing({ maxAttendees: 5 });
      const ctx = await ticketContext([listing.id, spare.id]);
      // The minimum listing's group pool (2) sits below its minimum (3), so
      // its row is sold out; the spare row keeps the page bookable. The
      // sold-out behaviour wins for a posted count of any size — the minimum
      // refusal never fires.
      const soldOutByMinimum = withListings(ctx, [
        buildTicketListing(ctx.listings[0]!.listing, false, 2),
        ctx.listings[1]!,
      ]);

      expect(
        validateFormState(
          quantityForm({ [listing.id]: 5, [spare.id]: 0 }),
          soldOutByMinimum,
        ),
      ).toBe(null);
      expect(
        validateFormState(
          quantityForm({ [listing.id]: 2, [spare.id]: 0 }),
          soldOutByMinimum,
        ),
      ).toBe(null);
    });

    test("a closed row refuses with the closed message, not the minimum one", async () => {
      const listing = await makeMinimumListing();
      const spare = await createTestListing({ maxAttendees: 5 });
      const ctx = await ticketContext([listing.id, spare.id]);
      const closedRow = withListings(ctx, [
        buildTicketListing(ctx.listings[0]!.listing, true, undefined),
        ctx.listings[1]!,
      ]);

      expect(
        validateFormState(quantityForm({ [listing.id]: 2 }), closedRow),
      ).toBe(REGISTRATION_CLOSED_SUBMIT_MESSAGE);
    });
  });
});
