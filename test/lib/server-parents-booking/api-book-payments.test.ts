import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { describeWithEnv } from "#test-utils/db.ts";
import { bookAttendee } from "#test-utils/db-helpers/attendee-payments.ts";
import { bookableStartDates } from "#test-utils/db-helpers/listings.ts";
import {
  apiBook,
  bookParentChild,
  makeCustomisableDailyParent,
  makeParent,
} from "#test-utils/parents.ts";
import { enablePublicApi, setupStripe } from "#test-utils/settings.ts";
import {
  expectCapturedItemPriced,
  stubCheckout,
} from "../server-reservation/helpers.ts";

/** A pay-more parent (£10 unit price, £50 max) with a free add-on child — the
 *  scenario behind both parent-`customPrice` tests (the accepted £30 and the
 *  rejected £100 over max). Hoisted as a file-local helper because the two
 *  tests spell out the identical spec. */
const makePayMoreParent = () =>
  makeParent({
    children: [{ maxAttendees: 50, unitPrice: 0 }],
    parent: {
      canPayMore: true,
      maxAttendees: 50,
      maxPrice: 5000,
      unitPrice: 1000,
    },
  });

describeWithEnv(
  "server > parents booking — JSON API paid booking",
  { db: true, triggers: true },
  () => {
    test("a paid API parent booking with a parent customPrice charges that price", async () => {
      await enablePublicApi();
      // The PARENT is pay-more; the request's `customPrice` must be parsed and
      // folded onto the parent line, so the checkout item is charged at the
      // chosen £30, not its £10 unit price (which would undercharge).
      await setupStripe();

      const { parent } = await makePayMoreParent();

      const { checkout, getCaptured } = stubCheckout("cs_parent_custom_price");
      try {
        const res = await apiBook(parent.slug, { customPrice: "30.00" });
        expect(res.status).toBe(200);
        expectCapturedItemPriced(getCaptured(), parent, 3000);
      } finally {
        checkout.restore();
      }
    });

    test("an API parent booking rejects an out-of-range parent customPrice", async () => {
      await enablePublicApi();
      // The pay-more parent's submitted price exceeds its max_price, so the
      // parent custom-price parse fails and the booking is rejected with a 400 —
      // never silently falling back to the unit price.
      const { parent } = await makePayMoreParent();
      const res = await apiBook(parent.slug, { customPrice: "100.00" });
      expect(res.status).toBe(400);
    });

    test("a paid API parent booking carries the folded dayCount for a customisable child", async () => {
      await enablePublicApi();
      // The parent is a FIXED 3-day daily listing (not customisable, so bookable
      // through the API), and its child is customisable. Folding the child flips
      // the order to customisable, so the intent must carry dayCount=3 and the
      // child must be priced for the inherited 3-day span (£30) — without it the
      // webhook reprices the child at a 1-day span (£10) and refunds the gap.
      await setupStripe();

      const { parent, child } = await makeCustomisableDailyParent();

      const date = (await bookableStartDates(parent.id))[0]!;

      const { checkout, getCaptured } = stubCheckout("cs_api_custom_child");
      try {
        const res = await apiBook(parent.slug, {
          children: [{ quantity: 1, slug: child.slug }],
          date,
        });
        expect(res.status).toBe(200);
        expect(getCaptured()?.dayCount).toBe(3);
        expectCapturedItemPriced(getCaptured(), child, 3000);
      } finally {
        checkout.restore();
      }
    });

    test("a paid API parent booking for a sold-out folded order returns 409", async () => {
      await enablePublicApi();
      // The paid path must run the folded checkAvailability preflight before
      // creating the session. A 1-capacity daily child passes the date-LESS fold
      // (a daily child's date-less aggregate is judged per-date downstream) but is
      // full on the chosen date, so the date-aware preflight rejects it: the
      // booking must return 409 instead of handing back a checkout URL.
      await setupStripe();

      const { parent, child } = await makeParent({
        children: [{ daily: true, maxAttendees: 1, unitPrice: 1000 }],
        parent: { daily: true, unitPrice: 1000 },
      });
      // Fill the child's only spot on that date so the folded order is sold out.
      const date = (await bookableStartDates(parent.id))[0]!;
      await bookAttendee(child, { date, quantity: 1 });

      const { checkout, calls } = stubCheckout("cs_should_not_be_reached");
      try {
        const res = await bookParentChild(parent, child, { date });
        expect(res.status).toBe(409);
        // The preflight rejected before the provider was ever called.
        expect(calls()).toBe(0);
      } finally {
        checkout.restore();
      }
    });
  },
);
