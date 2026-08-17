// jscpd:ignore-start
import { stub } from "@std/testing/mock";
import { requiredMapValue } from "#fp";
import { handleRequest } from "#routes";
import type {
  RefundAttemptResult,
  RefundRequest,
} from "#shared/payment/refund-attempt.ts";
import type { ChargeMoney } from "#shared/payment/resources.ts";
import { paymentsApi } from "#shared/payments.ts";
import { requireValue } from "#shared/required-value.ts";
import { stripeApi } from "#shared/stripe.ts";
import type { TicketsWorld } from "#test/specs/support/world.ts";
import {
  expectHtmlResponse,
  expectRedirect,
  followRedirect,
} from "#test-utils/assertions.ts";
import { signMeta, singleItem } from "#test-utils/factories.ts";
import { mockRequest } from "#test-utils/mocks.ts";
import { chargeMoney } from "#test-utils/payment-state.ts";
import { getProcessedPayment } from "#test-utils/processed-payments.ts";
import { withRefundMock } from "#test-utils/refund-routes.ts";
import type { TestBrowser } from "#test-utils/test-browser.ts";
// jscpd:ignore-end

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

const providerCharge = (world: TicketsWorld, reference: string): ChargeMoney =>
  requiredMapValue(
    world.providerCharges,
    reference,
    `The provider has no charge ${reference}`,
  );

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
      currency: "gbp",
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
export const runStripeSuccess = async (
  world: TicketsWorld,
  order: StripeOrder,
): Promise<number> => {
  world.providerCharges.set(order.paymentIntent, chargeMoney(order.total));
  await withStripeSuccess(order, async (redirect) => {
    expectRedirect(redirect, /^\/payment\/success\?tokens=.+$/);
    await expectHtmlResponse(
      await followRedirect(redirect, handleRequest),
      200,
      "Thank you for your order",
    );
  });
  const missingAttendee = `Paid session ${order.sessionId} has no attendee`;
  const payment = requireValue(
    await getProcessedPayment(order.sessionId),
    missingAttendee,
  );
  return requireValue(payment.attendee_id, missingAttendee);
};

/**
 * Drive a genuine single-listing Stripe success for `gross` minor units and
 * return the attendee the booking created — the common case over
 * {@link runStripeSuccess}.
 */
export const completePaidOrder = async (
  world: TicketsWorld,
  listingId: number,
  name: string,
  email: string,
  gross: number,
  sessionId = "cs_e2e",
  paymentIntent = "pi_e2e",
): Promise<number> =>
  await runStripeSuccess(world, {
    email,
    items: singleItem(listingId, 1, gross),
    name,
    paymentIntent,
    sessionId,
    total: gross,
  });

/** Run `body` with the site's payment provider answering as stripe. Both the
 * refund driver and the shown-code driver need that same standing-in provider,
 * so they ask for it the one way. */
export const withStripeAsProvider = async (
  body: () => Promise<void>,
): Promise<void> => {
  const { mockProviderType, withMocks } = await import("#test-utils/mocks.ts");
  await withMocks(
    () =>
      stub(paymentsApi, "getConfiguredProvider", () =>
        mockProviderType("stripe"),
      ),
    body,
  );
};

/** Ask for a refund the way the organiser does: open the page that offers it,
 * type the name it asks for into its own form, and send that form. Works the
 * same whether one person is being refunded or everyone on a listing, so both
 * ask this way. Keeps how many times the provider was asked. */
export const refundByTyping = async (
  world: TicketsWorld,
  where: { buttonText: string; page: string; typed: string },
  provider: (request: RefundRequest) => Promise<RefundAttemptResult>,
): Promise<TestBrowser> => {
  const { openAdminPage } = await import("#test/specs/support/browser.ts");
  const { fillInAndSend } = await import(
    "#test/specs/support/form-controls.ts"
  );
  const browser = await openAdminPage(world, where.page);
  await withRefundMock(
    provider,
    async (mockRefund) => {
      await fillInAndSend(
        browser,
        { confirm_identifier: where.typed },
        where.buttonText,
      );
      world.refundCalls = () => mockRefund.calls.length;
    },
    {
      charge: (reference) => Promise.resolve(providerCharge(world, reference)),
    },
  );
  return browser;
};
