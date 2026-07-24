import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { processParentApiBooking } from "#routes/api/folded-booking.ts";
import { getAttendeeBalanceState } from "#shared/db/attendees/balance.ts";
import type { CheckoutIntent } from "#shared/payments.ts";
import type { Listing, ListingWithCount } from "#shared/types.ts";
import type { BookResponseBody } from "#test/routes/api/helpers.ts";
import {
  expectCapturedItemPriced,
  stubCheckout,
} from "#test-utils/checkout.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { bookableStartDates } from "#test-utils/db-helpers/listings.ts";
import {
  makeCustomisableDailyParent,
  makeParent,
} from "#test-utils/parents.ts";
import { setupStripe } from "#test-utils/settings.ts";

/** Direct, function-level tests of `processParentApiBooking` — the folded
 * parent-booking flow the JSON API's `handleBook` reaches only through the full
 * HTTP/router stack. Calling it directly pins the folded free / provider-less /
 * paid-checkout behaviour at the function boundary, covering the internal
 * `completeFoldedBooking`/`foldedIntent` through their one exported entry point.
 * The pure child-selection tests live in `folded-booking.test.ts`. */

const CHECKOUT_URL = "https://stripe.example/checkout";

/** A POST request carrying only a host header — {@link processParentApiBooking}
 * uses it solely for `getBaseUrl`, and receives the parsed body as a separate
 * record, so no body is attached here. */
const bookRequest = (): Request =>
  new Request("http://localhost/api/listings/x/book", {
    headers: { host: "localhost" },
    method: "POST",
  });

/** `makeParent` returns the parent row typed as `Listing`, but `createTestListing`
 * reads it back through `getAllListings`, which selects the full row including
 * the trigger-maintained count columns — so it is a {@link ListingWithCount} at
 * runtime. `processParentApiBooking` reads those columns, hence the downcast. */
const asWithCount = (listing: Pick<Listing, "id">): ListingWithCount =>
  listing as ListingWithCount;

/** A one-unit parent booking body selecting `child`, with the standard test
 * contact merged in; `extra` adds paid/custom-price fields per scenario. */
const parentBody = (
  child: { slug: string },
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  children: [{ quantity: 1, slug: child.slug }],
  email: "a@b.com",
  name: "Ada",
  quantity: 1,
  ...extra,
});

/** Call {@link processParentApiBooking} for one parent unit with a resolved body
 *  and date — the single shape behind every parent-flow test, so the request,
 *  cast, quantity, and date plumbing lives once. */
const bookParent = (
  parent: Pick<Listing, "id">,
  body: Record<string, unknown>,
  date: string | null = null,
): Promise<Response> =>
  processParentApiBooking(bookRequest(), asWithCount(parent), body, 1, date);

/** A free parent (£0, capacity 10) with a child priced at `childUnitPrice` —
 *  the shared provider-less scenario behind the free, full-value-owed, and
 *  one-penny-owed tests. */
const makeProviderlessParent = (childUnitPrice: number) =>
  makeParent({
    children: [{ maxAttendees: 10, unitPrice: childUnitPrice }],
    parent: { maxAttendees: 10, unitPrice: 0 },
  });

/** Book a provider-less folded order (free parent + a child priced at
 *  `childUnitPrice`, no provider configured), returning the parsed body, the
 *  created attendee, and the parent/child listings. Shared by the free,
 *  provider-less-owed, and one-penny-owed tests. */
const foldProviderless = async (childUnitPrice: number) => {
  const { parent, child } = await makeProviderlessParent(childUnitPrice);
  const response = await bookParent(parent, parentBody(child));
  expect(response.status).toBe(200);
  const body = (await response.json()) as BookResponseBody;
  const { getAttendeesByTokens } = await import(
    "#shared/db/attendees/tokens.ts"
  );
  const [attendee] = await getAttendeesByTokens([body.booking!.ticketToken!]);
  return { attendee: attendee!, body, child, parent };
};

/** Book a folded order against the stubbed checkout (provider configured),
 *  returning the parsed body, the call count, and the captured intent — the
 *  shared "inspect what the paid path would have charged" fixture. */
const stubFoldedCheckout = async (
  parent: Pick<Listing, "id">,
  body: Record<string, unknown>,
  date: string | null = null,
): Promise<{
  body: BookResponseBody;
  calls: () => number;
  intent: CheckoutIntent | undefined;
}> => {
  await setupStripe();
  const { calls, checkout, getCaptured } = stubCheckout("sess_test");
  try {
    const response = await bookParent(parent, body, date);
    expect(response.status).toBe(200);
    return {
      body: (await response.json()) as BookResponseBody,
      calls,
      intent: getCaptured(),
    };
  } finally {
    checkout.restore();
  }
};

describeWithEnv("processParentApiBooking", { db: true, triggers: true }, () => {
  test("folds a free parent+child into a booking that owes nothing", async () => {
    const { body, attendee, child, parent } = await foldProviderless(0);
    // The free path returns an owed amount of 0 and a ticket link (not a
    // checkout URL): amountOwed's exact value pins the branch taken.
    expect(body.booking?.amountOwed).toBe(0);
    expect(body.booking?.ticketUrl).toMatch(/^\/t\//);
    const childRow = attendee.bookings.find((b) => b.listing_id === child.id);
    expect(childRow?.parent_listing_id).toBe(parent.id);
  });

  test("folds a paid child into a provider-less booking that owes the full value", async () => {
    const { body, attendee } = await foldProviderless(1500);
    // amountOwed carries the full folded value — the provider-less owed path.
    expect(body.booking?.amountOwed).toBe(1500);
    expect(body.booking?.ticketUrl).toMatch(/^\/t\//);
    expect(attendee.remaining_balance).toBe(1500);
  });

  test("records even a one-penny folded order in the owed ledger", async () => {
    // The `remainingBalance > 0` gate must fire for the smallest non-zero
    // folded total (a £0.01 child): the owed ledger order is posted, so the
    // ledger-projected balance (not just the denormalized column) is 1.
    const { body, attendee } = await foldProviderless(1);
    expect(body.booking?.amountOwed).toBe(1);
    expect((await getAttendeeBalanceState(attendee.id))?.remainingBalance).toBe(
      1,
    );
  });

  test("returns a checkout URL for a folded paid order and carries the fold on the intent", async () => {
    const { parent, child } = await makeParent({
      children: [{ maxAttendees: 10, unitPrice: 500 }],
      parent: {
        maxAttendees: 10,
        thankYouUrl: "https://example.com/thanks",
        unitPrice: 1000,
      },
    });
    const { intent } = await stubFoldedCheckout(parent, parentBody(child));
    expect(intent?.date).toBe(null);
    expect(intent?.thankYouUrl).toBe("https://example.com/thanks");
    expect(intent?.allocations).toEqual([
      { childId: child.id, parentId: parent.id, qty: 1 },
    ]);
    expectCapturedItemPriced(intent, parent, 1000);
    expectCapturedItemPriced(intent, child, 500);
    // A non-customisable fold carries no dayCount on the intent.
    expect("dayCount" in (intent ?? {})).toBe(false);
  });

  test("charges a pay-more parent's custom price on the folded checkout line", async () => {
    const { parent, child } = await makeParent({
      children: [{ maxAttendees: 10, unitPrice: 500 }],
      parent: {
        canPayMore: true,
        maxAttendees: 10,
        maxPrice: 10000,
        unitPrice: 1000,
      },
    });
    const { intent } = await stubFoldedCheckout(
      parent,
      parentBody(child, { customPrice: 20 }),
    );
    expectCapturedItemPriced(intent, parent, 2000);
    expectCapturedItemPriced(intent, child, 500);
    // A parent with no configured thank-you URL omits it from the intent.
    expect("thankYouUrl" in (intent ?? {})).toBe(false);
  });

  test("carries the folded dayCount when a customisable child is folded in", async () => {
    const { parent, child } = await makeCustomisableDailyParent();
    const date = (await bookableStartDates(parent.id))[0]!;
    const { intent } = await stubFoldedCheckout(
      parent,
      parentBody(child),
      date,
    );
    expect(intent?.dayCount).toBe(3);
    expectCapturedItemPriced(intent, child, 3000);
  });

  test("books a free folded order owing nothing when a provider is configured", async () => {
    // Payments enabled but the whole folded order is free, so it takes the
    // no-charge path and owes nothing — the provider is never invoked.
    const { parent, child } = await makeProviderlessParent(0);
    const { body, calls } = await stubFoldedCheckout(parent, parentBody(child));
    expect(body.booking?.amountOwed).toBe(0);
    expect(body.booking?.ticketUrl).toMatch(/^\/t\//);
    expect(calls()).toBe(0);
  });

  test("opens checkout for a one-penny folded paid order", async () => {
    // The `total > 0` gate must fire for the smallest non-zero folded total
    // (a £0.01 child with a provider): a checkout session opens rather than
    // the order silently taking the free path.
    const { parent, child } = await makeProviderlessParent(1);
    const { body } = await stubFoldedCheckout(parent, parentBody(child));
    expect(body.booking?.checkoutUrl).toBe(CHECKOUT_URL);
  });

  test("rejects a malformed children array with a 400", async () => {
    const { parent } = await makeProviderlessParent(0);
    const response = await bookParent(parent, {
      children: "not-an-array",
      email: "a@b.com",
      name: "Ada",
      quantity: 1,
    });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/children.*array/i);
  });

  test("rejects a customisable parent with a 400 pointing to the website", async () => {
    const { parent } = await makeParent({
      children: [{ maxAttendees: 10, unitPrice: 0 }],
      parent: {
        customisableDays: true,
        dayPrices: { 1: 1000, 3: 3000 },
        durationDays: 3,
        maxAttendees: 10,
        unitPrice: 0,
      },
    });
    const response = await bookParent(parent, parentBody({ slug: "ignored" }));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(
      /booked through the website/i,
    );
  });
});
