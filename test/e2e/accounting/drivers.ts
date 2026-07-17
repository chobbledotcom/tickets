import { expect } from "@std/expect";
import { afterEach } from "@std/testing/bdd";
import { type Stub, stub } from "@std/testing/mock";
import { handleRequest } from "#routes";
import { getAttendeesRaw } from "#shared/db/attendees/queries.ts";
import { paymentsApi } from "#shared/payments.ts";
import { resetStripeClient, stripeApi } from "#shared/stripe.ts";
import { stripePaymentProvider } from "#shared/stripe-provider.ts";
import {
  expectHtmlResponse,
  expectRedirect,
  followRedirect,
} from "#test-utils/assertions.ts";
import { extractInputValue } from "#test-utils/csrf.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestAttendeeDirect } from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { signMeta, singleItem } from "#test-utils/factories.ts";
import { postListingSale } from "#test-utils/ledger.ts";
import {
  mockFormRequest,
  mockProviderType,
  mockRequest,
  withMocks,
} from "#test-utils/mocks.ts";
import {
  adminFormPost,
  adminGet,
  testCookie,
  testCsrfToken,
} from "#test-utils/session.ts";
import { stagePaymentCallback } from "#test-utils/staged-payments.ts";

/** Run the shared "e2e: accounting lifecycle" suite body under a db env,
 *  resetting the Stripe client between tests. */
export const describeAccounting = (fn: () => void): void =>
  describeWithEnv("e2e: accounting lifecycle", { db: true }, () => {
    afterEach(() => resetStripeClient());
    fn();
  });

/** GET the merge preview for `targetId` loaded with `sourceToken`, returning the
 *  `merge_version` the apply POST must echo back AND the name of the conflicting
 *  booking's decision field (`booking_<listingId>:<startAt>`) scraped from the
 *  rendered form, so the test answers the exact conflict the operator is shown
 *  rather than guessing the key. Uses the stable owner cookie — the preview
 *  decrypts the source's PII, needing the session's private key. */
export const mergePreview = async (
  targetId: number,
  sourceToken: string,
): Promise<{ version: string; bookingField: string }> => {
  const page = await adminGet(
    `/admin/attendees/${targetId}/actions?token=${encodeURIComponent(
      sourceToken,
    )}`,
  );
  expect(page.status).toBe(200);
  const html = await page.text();
  const version = extractInputValue(html, "merge_version");
  expect(version).not.toBeNull();
  const bookingField = html.match(/name="(booking_[^"]+)"/)?.[1];
  expect(bookingField).toBeDefined();
  return { bookingField: bookingField!, version: version! };
};

/** POST the merge apply form on the SAME stable owner cookie as
 *  {@link mergePreview}, so the apply decrypts the source under the same session
 *  that built the diff (the merge needs the owner's private key). */
export const mergePost = async (
  targetId: number,
  fields: Record<string, string>,
): Promise<Response> => {
  const csrf = await testCsrfToken();
  const cookie = await testCookie();
  return handleRequest(
    mockFormRequest(
      `/admin/attendees/${targetId}/merge`,
      { csrf_token: csrf, ...fields },
      cookie,
    ),
  );
};

/** Build a listing with two fully-PAID duplicate bookings (a target and a
 *  token-bearing source) on it — the same-listing conflict decision 17 must
 *  resolve. Income counts BOTH £50 tickets (£100) until the merge un-bills the
 *  discarded one. Returns the ids plus the source's merge token. */
export const twoPaidDuplicates = async (
  name: string,
): Promise<{
  listingId: number;
  targetId: number;
  sourceId: number;
  sourceToken: string;
}> => {
  const listing = await createTestListing({
    maxAttendees: 10,
    name,
    unitPrice: 5000,
  });
  const { attendee: target } = await createTestAttendeeDirect(
    listing.id,
    `${name} Target`,
    `target-${name}@example.com`,
  );
  const { attendee: source, token: sourceToken } =
    await createTestAttendeeDirect(
      listing.id,
      `${name} Source`,
      `source-${name}@example.com`,
    );
  await postListingSale({
    attendeeId: target.id,
    gross: 5000,
    listingId: listing.id,
  });
  await postListingSale({
    attendeeId: source.id,
    gross: 5000,
    listingId: listing.id,
  });
  return {
    listingId: listing.id,
    sourceId: source.id,
    sourceToken,
    targetId: target.id,
  };
};

/** The money-decision form field paired with a scraped `booking_<key>` field. */
export const moneyFieldFor = (bookingField: string): string =>
  bookingField.replace("booking_", "money_");

// -- Public-payment driver (mirrors server-payments-success.test.ts) ------ //

/** A compact modifier ref as it rides the signed metadata (`{ i: id, q: qty }`). */
export type ModRef = { i: number; q: number };

export type StripeOrder = {
  items: string;
  total: number;
  modifiers?: ModRef[];
  name: string;
  email: string;
  sessionId: string;
  paymentIntent: string;
};

/**
 * Stub the Stripe session retrieval for `order` (metadata signed exactly as
 * production — the order may span several listing lines and carry applied
 * `modifiers`) and run `body` with the REAL `/payment/success` response, then
 * restore the stub. The signed `total` MUST equal the order the handler
 * re-derives (gross + fee + modifiers) — the price oracle refunds a mismatch.
 */
export const withStripeSuccess = async (
  order: StripeOrder,
  body: (response: Response) => Promise<void>,
): Promise<void> => {
  const sessionId = order.sessionId;
  const metadata = signMeta(
    {
      email: order.email,
      items: order.items,
      name: order.name,
      ...(order.modifiers
        ? { modifiers: JSON.stringify(order.modifiers) }
        : {}),
    },
    order.total,
  );
  const mockRetrieve = stub(stripeApi, "retrieveCheckoutSession", () =>
    Promise.resolve({
      amount_total: order.total,
      id: sessionId,
      metadata,
      payment_intent: order.paymentIntent,
      payment_status: "paid",
    } as unknown as Awaited<
      ReturnType<typeof stripeApi.retrieveCheckoutSession>
    >),
  );
  try {
    await stagePaymentCallback({
      amountTotal: order.total,
      metadata,
      paymentReference: order.paymentIntent,
      sessionId,
    });
    await body(
      await handleRequest(
        mockRequest(`/payment/success?session_id=${sessionId}`),
      ),
    );
  } finally {
    mockRetrieve.restore();
  }
};

/** Drive a first-time Stripe success and assert the production thank-you
 *  redirect (the common case over {@link withStripeSuccess}). */
export const runStripeSuccess = (order: StripeOrder): Promise<void> =>
  withStripeSuccess(order, async (redirect) => {
    expectRedirect(redirect, /^\/payment\/success\?tokens=.+$/);
    await expectHtmlResponse(
      await followRedirect(redirect, handleRequest),
      200,
      "Thank you for your order",
    );
  });

/**
 * Drive a genuine single-listing Stripe success for `gross` minor units and
 * return the attendee the booking created — the common case over
 * {@link runStripeSuccess}.
 */
export const completePaidOrder = async (
  listingId: number,
  name: string,
  email: string,
  gross: number,
  sessionId = "cs_e2e",
  paymentIntent = "pi_e2e",
): Promise<number> => {
  await runStripeSuccess({
    email,
    items: singleItem(listingId, 1, gross),
    name,
    paymentIntent,
    sessionId,
    total: gross,
  });
  const attendees = await getAttendeesRaw(listingId);
  expect(attendees.length).toBe(1);
  return attendees[0]!.id;
};

// -- Refund driver (mirrors server-refunds.test.ts withRefundMock) -------- //

/** Run `body` with the payment provider resolved to a stripe provider whose
 *  `refundPayment` is stubbed, so the admin refund routes reach the ledger
 *  reversal without a real network call. `refund` is either a fixed outcome or a
 *  per-`paymentId` function — the latter lets a bulk refund decline one specific
 *  payment while the rest succeed. */
export const withRefundMock = (
  refund: boolean | ((paymentId: string) => Promise<boolean>),
  body: (mockRefund: Stub) => Promise<void>,
): Promise<void> =>
  withMocks(
    () =>
      stub(paymentsApi, "getConfiguredProvider", () =>
        mockProviderType("stripe"),
      ),
    async () => {
      const behave =
        typeof refund === "function" ? refund : () => Promise.resolve(refund);
      const mockRefund = stub(
        stripePaymentProvider,
        "refundPayment",
        async (paymentId) =>
          (await behave(paymentId)) ? "refunded" : "failed",
      );
      try {
        await body(mockRefund);
      } finally {
        mockRefund.restore();
      }
    },
  );

/** POST the real single-attendee admin refund form as the owner. */
export const submitRefund = async (
  attendeeId: number,
  confirmName: string,
): Promise<Response> => {
  const { response } = await adminFormPost(
    `/admin/attendees/${attendeeId}/refund`,
    { confirm_identifier: confirmName },
  );
  return response;
};

// -- Attendee-edit driver (scrapes the real edit form) -------------------- //

/** Extract the hidden/select fields the attendee edit form round-trips
 *  (`line_listing_*`, `qty_*`, `line_key_*`, `line_package_*`, `status_id`)
 *  from the rendered edit page, so a balance correction re-submits the EXACT
 *  booking and changes only the owed figure — exactly what a browser would
 *  post back. */
/** Move an attendee's owed balance through the ledger — the proper path now the
 *  attendee form no longer edits balances. `MANUAL_ATTENDEE_WRITEOFF` lowers what
 *  they owe (a goodwill write-off), `MANUAL_ATTENDEE_CHARGE` raises it, each by
 *  `amountMajor` pounds. Returns the route's response. */
export const postAttendeeBalanceEntry = async (
  attendeeId: number,
  entryType: string,
  amountMajor: string,
): Promise<Response> =>
  (
    await adminFormPost(`/admin/ledger/attendee/${attendeeId}/add`, {
      amount: amountMajor,
      entry_type: entryType,
      occurred_at: "2026-06-22T12:00",
      return_url: `/admin/attendees/${attendeeId}/edit`,
    })
  ).response;
