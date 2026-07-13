import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { CheckoutIntent } from "#shared/payments.ts";
import { stubCheckout } from "#test-utils/checkout.ts";
import { makeParent } from "#test-utils/parents.ts";
import { setupStripe } from "#test-utils/settings.ts";

import {
  bookForToken,
  bookListing,
  describePublicApi,
  withCheckoutStub,
} from "./helpers.ts";

describePublicApi(() => {
  describe("POST /api/listings/:slug/book", () => {
    /** A free parent with a paid child and its sole-child selection. */
    const parentWithPaidChild = async (): Promise<{ slug: string }> => {
      const { parent } = await makeParent({
        children: [{ maxAttendees: 10, unitPrice: 1500 }],
        parent: { maxAttendees: 10, unitPrice: 0 },
      });
      return { slug: parent.slug };
    };

    /** A free parent (£0) with a single free child (£0), both capacity 10. */
    const freeParentWithChild = () =>
      makeParent({
        children: [{ maxAttendees: 10, unitPrice: 0 }],
        parent: { maxAttendees: 10, unitPrice: 0 },
      });

    /** Book `slug` through the shared checkout stub (asserting the order is
     *  taken) and return the intent the route handed the provider so a folded
     *  field can be asserted. */
    const captureBookingIntent = async (
      slug: string,
    ): Promise<CheckoutIntent | undefined> => {
      const { checkout, getCaptured } = stubCheckout("sess_test");
      try {
        const { response } = await bookListing(slug);
        expect(response.status).toBe(200);
      } finally {
        checkout.restore();
      }
      return getCaptured();
    };

    test("returns a checkout URL for a parent whose child is paid", async () => {
      await setupStripe();
      const parent = await parentWithPaidChild();
      const { response, body } = await bookListing(parent.slug);
      expect(response.status).toBe(200);
      expect(body.booking?.checkoutUrl).toBeDefined();
    });

    test("returns 400 when the parent checkout session errors", async () => {
      await setupStripe();
      const parent = await parentWithPaidChild();
      await withCheckoutStub({ error: "Provider rejected" }, async () => {
        const { response, body } = await bookListing(parent.slug);
        expect(response.status).toBe(400);
        expect(body.error).toBe("Provider rejected");
      });
    });

    test("returns 500 when the parent checkout session can't be created", async () => {
      await setupStripe();
      const parent = await parentWithPaidChild();
      await withCheckoutStub(null, async () => {
        const { response, body } = await bookListing(parent.slug);
        expect(response.status).toBe(500);
        expect(body.error).toMatch(/payment session/i);
      });
    });

    test("books a paid-child parent owing the full value with no provider", async () => {
      // No setupStripe: payments disabled, so the parent+child booking is taken
      // without checkout and the child's value is recorded as owed.
      const parent = await parentWithPaidChild();
      const body = await bookForToken(parent.slug);
      expect(body.booking?.amountOwed).toBe(1500);
    });

    test("books a free parent+child owing nothing when a provider is configured", async () => {
      // Payments enabled but the whole order is free, so it takes the no-charge
      // path and owes nothing (the provider is never invoked).
      await setupStripe();
      const { parent } = await freeParentWithChild();
      const body = await bookForToken(parent.slug);
      expect(body.booking?.checkoutUrl).toBeUndefined();
      expect(body.booking?.amountOwed).toBe(0);
    });

    test("a free parent+child booking records the child under its parent", async () => {
      // The free path threads the fold's allocations into createFreeReservation,
      // so the auto-folded child is stored as its own row under the parent.
      const { parent, child } = await freeParentWithChild();
      const { body } = await bookListing(parent.slug);
      const { getAttendeesByTokens } = await import(
        "#shared/db/attendees/tokens.ts"
      );
      const [attendee] = await getAttendeesByTokens([
        body.booking!.ticketToken!,
      ]);
      const childRow = attendee!.bookings.find(
        (b) => b.listing_id === child.id,
      );
      expect(childRow?.parent_listing_id).toBe(parent.id);
    });

    test("carries the fold's child allocations on the paid intent for webhook edge revalidation", async () => {
      await setupStripe();
      const { parent, child } = await makeParent({
        children: [{ maxAttendees: 10, unitPrice: 500 }],
        parent: { maxAttendees: 10, unitPrice: 1000 },
      });
      const intent = await captureBookingIntent(parent.slug);
      expect(intent?.allocations).toEqual([
        { childId: child.id, parentId: parent.id, qty: 1 },
      ]);
    });

    test("accepts a pay-more child's custom price in a parent booking", async () => {
      const { parent, child } = await makeParent({
        children: [
          {
            canPayMore: true,
            maxAttendees: 10,
            maxPrice: 5000,
            unitPrice: 1000,
          },
        ],
        parent: { maxAttendees: 10, unitPrice: 0 },
      });
      // No provider configured, so the chosen £30 child price is recorded as owed.
      const { response, body } = await bookListing(parent.slug, {
        children: [{ customPrice: 30, quantity: 1, slug: child.slug }],
        email: "alice@test.com",
        name: "Alice",
      });
      expect(response.status).toBe(200);
      expect(body.booking?.amountOwed).toBe(3000);
    });

    /** A parent (2 units) + one pay-more child (2 units) — the shape where two
     * duplicate child entries (qty 1 each) sum to the parent quantity, so the
     * fold accepts the count and the only thing left to decide is the price. This
     * is the exact condition Finding 4 describes: without the conflict guard the
     * order books at whichever price was written last, not a count rejection. */
    const parentWithTwoUnitPayMoreChild = () =>
      makeParent({
        children: [
          {
            canPayMore: true,
            maxAttendees: 10,
            maxPrice: 5000,
            maxQuantity: 2,
            unitPrice: 1000,
          },
        ],
        parent: { maxAttendees: 10, maxQuantity: 2, unitPrice: 0 },
      });

    /** Book `parentSlug` with two qty-1 entries for the same child, each at its
     *  own custom price — the duplicate-entry shape the conflict guard checks. */
    const bookTwoChildEntries = (
      parentSlug: string,
      child: { slug: string },
      prices: [number, number],
    ) =>
      bookListing(parentSlug, {
        children: [
          { customPrice: prices[0], quantity: 1, slug: child.slug },
          { customPrice: prices[1], quantity: 1, slug: child.slug },
        ],
        email: "alice@test.com",
        name: "Alice",
        quantity: 2,
      });

    test("rejects duplicate pay-more child entries with conflicting prices", async () => {
      // Two entries for the same pay-more child (qty 1 each, totalling the
      // parent's 2 units) name two different prices. A single stored
      // `child_price_*` can't honour both, so rather than letting the last
      // entry's price silently win and book both units at £20, reject.
      const { parent, child } = await parentWithTwoUnitPayMoreChild();
      const { response, body } = await bookTwoChildEntries(
        parent.slug,
        child,
        [30, 20],
      );
      expect(response.status).toBe(400);
      expect(body.error).toMatch(/conflicting prices/i);
    });

    test("books no attendees when conflicting child prices are rejected", async () => {
      const { parent, child } = await parentWithTwoUnitPayMoreChild();
      await bookTwoChildEntries(parent.slug, child, [30, 20]);
      const { getAttendeesRaw } = await import(
        "#shared/db/attendees/queries.ts"
      );
      expect((await getAttendeesRaw(child.id)).length).toBe(0);
      expect((await getAttendeesRaw(parent.id)).length).toBe(0);
    });

    test("accepts repeated child entries that agree on the price", async () => {
      // Duplicate entries for the same child are fine when they agree on the
      // price: the quantities sum and the single agreed price applies.
      const { parent, child } = await parentWithTwoUnitPayMoreChild();
      const { response, body } = await bookTwoChildEntries(
        parent.slug,
        child,
        [20, 20],
      );
      expect(response.status).toBe(200);
      // 2 units of the child at the agreed £20 each = £40 owed (no provider).
      expect(body.booking?.amountOwed).toBe(4000);
    });

    test("notifies registration for a free folded parent booking", async () => {
      // A free parent+child booking takes the no-provider create path; it must
      // still log/notify the registration, exactly like the standalone API
      // booking and the web free path. The activity log is the observable proof
      // the notifier ran (it also fires the email/webhook).
      const { parent, child } = await freeParentWithChild();
      const { response } = await bookListing(parent.slug);
      expect(response.status).toBe(200);

      const { getListingActivityLog } = await import(
        "#test-utils/activity-log.ts"
      );
      const parentLog = await getListingActivityLog(parent.id);
      const childLog = await getListingActivityLog(child.id);
      expect(parentLog.some((e) => /registered/i.test(e.message))).toBe(true);
      expect(childLog.some((e) => /registered/i.test(e.message))).toBe(true);
    });

    test("carries the parent's thank-you URL on a folded paid checkout intent", async () => {
      // A single parent with a configured thank-you URL, folding in a paid child.
      // The order becomes multi-listing, so the success handler can't recover the
      // URL from the booked listing ids — the API must set it on the intent.
      await setupStripe();
      const { parent } = await makeParent({
        children: [{ maxAttendees: 10, unitPrice: 1500 }],
        parent: {
          maxAttendees: 10,
          thankYouUrl: "https://example.com/thanks",
          unitPrice: 0,
        },
      });
      const intent = await captureBookingIntent(parent.slug);
      expect(intent?.thankYouUrl).toBe("https://example.com/thanks");
    });

    test("omits the thank-you URL when the parent has none", async () => {
      // A parent without a configured URL must not set one on the intent; the
      // success handler's default single-listing rule still applies otherwise.
      await setupStripe();
      const parent = await parentWithPaidChild();
      const intent = await captureBookingIntent(parent.slug);
      expect(intent?.thankYouUrl).toBeUndefined();
    });
  });
});
