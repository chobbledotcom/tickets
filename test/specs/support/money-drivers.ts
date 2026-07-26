import { expect } from "@std/expect";
import { type Stub, stub } from "@std/testing/mock";
import { handleRequest } from "#routes";
import { getAttendeesRaw } from "#shared/db/attendees/queries.ts";
import { paymentsApi } from "#shared/payments.ts";
import { stripeApi } from "#shared/stripe.ts";
import { stripePaymentProvider } from "#shared/stripe-provider.ts";
import {
  expectHtmlResponse,
  expectRedirect,
  followRedirect,
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { signMeta, singleItem } from "#test-utils/factories.ts";
import { mockProviderType, mockRequest, withMocks } from "#test-utils/mocks.ts";
import { adminFormPost } from "#test-utils/session.ts";

/** Run the shared "e2e: accounting lifecycle" suite body under a db env,
 *  resetting the Stripe client between tests. */
export const describeAccounting = (fn: () => void): void =>
  describeWithEnv("e2e: accounting lifecycle", { db: true }, () => {
    fn();
  });

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
      const mockRefund = stub(stripePaymentProvider, "refundPayment", behave);
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

// -- Attendee-balance driver ---------------------------------------------- //

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
