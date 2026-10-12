/**
 * Direct tests for the page-state checks at form parse: the quantity limits
 * for listings, packages, and add-ons; the terms box; and the closed and
 * sold-out page states.
 */

/* jscpd:ignore-start -- imports */
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { bookingError } from "#booking/form.ts";
import { buildTicketListing } from "#booking/model.ts";
import { validateFormState } from "#routes/public/ticket-submit/parse.ts";
import type { TicketCtx } from "#routes/public/types.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { hiddenPackageWithMember } from "#test-utils/hidden-package.ts";
import { insertModifier, patchModifier } from "#test-utils/modifiers.ts";
import {
  pageBookingTree,
  quantityForm,
  ticketContext,
  twoListingContext,
} from "#test-utils/ticket-ctx.ts";

/* jscpd:ignore-end */

/** The page context with its listings replaced, for the state a real page
 * cannot reach in one shot (a closed listing beside an open one). */
const withListings = (
  ctx: TicketCtx,
  listings: ReturnType<typeof buildTicketListing>[],
): TicketCtx => ({ ...ctx, listings });

describeWithEnv("ticket-submit parse", { db: true }, () => {
  describe("validateFormState", () => {
    test("refuses a standalone quantity above what the listing can sell", async () => {
      const listing = await createTestListing({
        maxAttendees: 5,
        maxQuantity: 3,
      });
      const ctx = await ticketContext([listing.id]);

      expect(
        validateFormState(
          quantityForm({ [listing.id]: 4 }),
          ctx,
          pageBookingTree(ctx),
        ),
      ).toBe(bookingError.maximum(listing.name, 3));
      expect(
        validateFormState(
          quantityForm({ [listing.id]: 3 }),
          ctx,
          pageBookingTree(ctx),
        ),
      ).toBeNull();
    });

    test("refuses a package count above the bundles the page can sell", async () => {
      const { ctx, group, tree } = await hiddenPackageWithMember();

      expect(
        validateFormState(quantityForm({}, { [group.id]: 6 }), ctx, tree),
      ).toBe(bookingError.packageMaximum("Mystery Box", 5));
      expect(
        validateFormState(quantityForm({}, { [group.id]: 5 }), ctx, tree),
      ).toBeNull();
    });

    test("refuses an add-on count above its ceiling", async () => {
      const listing = await createTestListing({ maxAttendees: 5 });
      const addOn = await insertModifier({ name: "Parking" });
      await patchModifier(addOn.id, { trigger: "optional" });
      const ctx = await ticketContext([listing.id]);
      const form = quantityForm({ [listing.id]: 1 });
      form.set(`addon_${addOn.id}`, "99");

      expect(validateFormState(form, ctx, pageBookingTree(ctx))).toBe(
        bookingError.addOnMaximum("Parking", 20),
      );
      form.set(`addon_${addOn.id}`, "20");
      expect(validateFormState(form, ctx, pageBookingTree(ctx))).toBeNull();
    });

    test("refuses a form that skipped the terms box", async () => {
      const listing = await createTestListing({ maxAttendees: 5 });
      const ctx = { ...(await ticketContext([listing.id])), terms: "/terms" };

      expect(
        validateFormState(
          quantityForm({ [listing.id]: 1 }),
          ctx,
          pageBookingTree(ctx),
        ),
      ).toBe("You must agree to the terms and conditions");
    });

    test("accepts the same form with the terms box ticked", async () => {
      const listing = await createTestListing({ maxAttendees: 5 });
      const ctx = { ...(await ticketContext([listing.id])), terms: "/terms" };
      const form = quantityForm({ [listing.id]: 1 });
      form.set("agree_terms", "1");

      expect(validateFormState(form, ctx, pageBookingTree(ctx))).toBeNull();
    });

    test("says registration closed when every listing is closed", async () => {
      const listing = await createTestListing({ maxAttendees: 5 });
      const ctx = await ticketContext([listing.id]);
      const closed = withListings(ctx, [
        buildTicketListing(ctx.listings[0]!.listing, true, undefined),
      ]);

      expect(
        validateFormState(quantityForm({}), closed, pageBookingTree(closed)),
      ).toBe("Sorry, registration closed while you were submitting.");
    });

    test("says sold out when the page has no spots left", async () => {
      const listing = await createTestListing({ maxAttendees: 5 });
      const ctx = await ticketContext([listing.id]);
      const soldOut = withListings(ctx, [
        buildTicketListing(ctx.listings[0]!.listing, false, 0),
      ]);

      expect(
        validateFormState(quantityForm({}), soldOut, pageBookingTree(soldOut)),
      ).toBe("Sorry, not enough spots available");
    });

    test("refuses a quantity chosen on a closed listing", async () => {
      const { ctx, first, second } = await twoListingContext();
      const halfClosed = withListings(ctx, [
        buildTicketListing(ctx.listings[0]!.listing, true, undefined),
        ctx.listings[1]!,
      ]);

      expect(
        validateFormState(
          quantityForm({ [first.id]: 1 }),
          halfClosed,
          pageBookingTree(halfClosed),
        ),
      ).toBe("Sorry, registration closed while you were submitting.");
      expect(
        validateFormState(
          quantityForm({ [second.id]: 1 }),
          halfClosed,
          pageBookingTree(halfClosed),
        ),
      ).toBeNull();
    });

    test("reads a quantity box that carries no number as zero", async () => {
      // A crafted or half-cleared POST must not read as a chosen quantity.
      const { ctx, first } = await twoListingContext();
      const halfClosed = withListings(ctx, [
        buildTicketListing(ctx.listings[0]!.listing, true, undefined),
        ctx.listings[1]!,
      ]);
      const form = quantityForm({});
      form.set(`quantity_${first.id}`, "abc");

      expect(
        validateFormState(form, halfClosed, pageBookingTree(halfClosed)),
      ).toBeNull();
    });
  });
});
