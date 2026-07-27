import { expect } from "@std/expect";
import { handleRequest } from "#routes";
import { getAttendeesRaw } from "#shared/db/attendees/queries.ts";
import {
  expectHtmlResponse,
  expectRedirect,
  followRedirect,
} from "#test-utils/assertions.ts";
import { signMeta, singleItem } from "#test-utils/factories.ts";
import { mockRequest } from "#test-utils/mocks.ts";
import { stubRetrieveCheckoutSession } from "#test-utils/webhooks.ts";

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
  const mockRetrieve = stubRetrieveCheckoutSession({
    amountTotal: order.total,
    metadata,
    paymentIntent: order.paymentIntent,
    sessionId,
  });
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
